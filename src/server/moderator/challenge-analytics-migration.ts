import { redis } from '@devvit/redis';
import { readHeadToHeadCatalogPage, type HeadToHeadCatalogCard } from '../head-to-head/head-to-head-catalog.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';
import { TRACK_KEY_RE } from '../tracks/track-store.js';
import {
    challengeAnalyticsCountsKey,
    challengeAnalyticsCounterFields,
    challengeAnalyticsViewersKey,
    challengeTrackAnalyticsIndexKey,
    challengeTrackAnalyticsCountsKey,
    challengeTrackAnalyticsCounterFields,
    challengeTrackAnalyticsViewersKey,
} from './challenge-analytics-store.js';

const PAGE_SIZE = 25;
const VIEWER_BATCH_SIZE = 100;
const IMPORT_ATTEMPTS = 3;
const IMPORT_ERROR = 'Earlier challenge totals could not be imported. Try again.';

type LegacyReceipt = {
    trackKey: string;
    views: number;
    clicks: number;
    viewerCount: number;
    startedAt: string | null;
};

export function challengeAnalyticsMigrationKeys(subredditName: string) {
    const indexKey = challengeTrackAnalyticsIndexKey(subredditName);
    const prefix = indexKey.slice(0, -':tracks'.length);
    return { complete: `${prefix}:legacy-v1:complete`, receipts: `${prefix}:legacy-v1:receipts` };
}

function count(value: unknown): number {
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function timestamp(value: unknown): string | null {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseReceipt(raw: string | null | undefined): LegacyReceipt {
    try {
        const value = JSON.parse(raw ?? 'null');
        if (typeof value?.trackKey === 'string' && TRACK_KEY_RE.test(value.trackKey)
            && ['views', 'clicks', 'viewerCount'].every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)) {
            return { ...value, startedAt: timestamp(value.startedAt) };
        }
    } catch { }
    throw new Error(IMPORT_ERROR);
}

// Seed the fixed post-to-track map, including posts whose first v1 view may
// still be in flight. NX preserves any receipt another request already used.
async function addMappings(subredditName: string, cards: HeadToHeadCatalogCard[]): Promise<boolean> {
    if (!cards.length) return true;
    const keys = challengeAnalyticsMigrationKeys(subredditName);
    for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt += 1) {
        const transaction = await redis.watch(keys.complete);
        try {
            if (await redis.get(keys.complete)) return false;
            await transaction.multi();
            for (const card of cards) {
                const receipt: LegacyReceipt = { trackKey: card.trackKey, views: 0, clicks: 0, viewerCount: 0, startedAt: null };
                await transaction.hSetNX(keys.receipts, card.postId, JSON.stringify(receipt));
            }
            const result = await transaction.exec();
            if (Array.isArray(result) && result.length) return true;
        } catch (error) {
            if (!isRedisTransactionConflict(error)) throw error;
        } finally {
            try { await transaction.discard(); } catch { }
            try { await transaction.unwatch(); } catch { }
        }
    }
    throw new Error(IMPORT_ERROR);
}

async function initializeMappings(subredditName: string): Promise<void> {
    const keys = challengeAnalyticsMigrationKeys(subredditName);
    if (await redis.get(keys.complete)) return;
    let offset = 0;
    while (true) {
        const page = await readHeadToHeadCatalogPage(subredditName, offset, PAGE_SIZE);
        if (!await addMappings(subredditName, page.items)) return;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
    }
    await redis.set(keys.complete, '1', { nx: true });
}

// Raw deltas, viewer unions, and the imported source snapshot commit together.
// A lost acknowledgement or competing request cannot import an event twice.
async function reconcilePost(subredditName: string, postId: string): Promise<void> {
    const keys = challengeAnalyticsMigrationKeys(subredditName);
    const oldCountsKey = challengeAnalyticsCountsKey(subredditName);
    const oldViewersKey = challengeAnalyticsViewersKey(subredditName, postId);
    const oldFields = challengeAnalyticsCounterFields(postId);
    for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt += 1) {
        const transaction = await redis.watch(keys.receipts, oldCountsKey, oldViewersKey);
        try {
            const receipt = parseReceipt(await redis.hGet(keys.receipts, postId));
            const raw = await redis.hMGet(oldCountsKey, [oldFields.views, oldFields.clicks, oldFields.trackingStartedAt]);
            const viewerCount = count(await redis.hLen(oldViewersKey));
            const next: LegacyReceipt = {
                trackKey: receipt.trackKey,
                views: Math.max(receipt.views, count(raw[0])),
                clicks: Math.max(receipt.clicks, count(raw[1])),
                viewerCount,
                startedAt: timestamp(raw[2]),
            };
            const viewDelta = next.views - receipt.views;
            const clickDelta = next.clicks - receipt.clicks;
            const viewersChanged = viewerCount !== receipt.viewerCount;
            if (!viewDelta && !clickDelta && !viewersChanged && next.startedAt === receipt.startedAt) return;

            const newCountsKey = challengeTrackAnalyticsCountsKey(subredditName);
            const newViewersKey = challengeTrackAnalyticsViewersKey(subredditName, receipt.trackKey);
            const fields = challengeTrackAnalyticsCounterFields(receipt.trackKey);
            // A live v2 event can insert its timestamp between our read and
            // EXEC. Fence only timestamp changes so we preserve the earliest
            // date without making membership-only reconciliation watch totals.
            if (next.startedAt && next.startedAt !== receipt.startedAt) {
                await transaction.watch(newCountsKey);
            }
            const currentStart = next.startedAt ? await redis.hGet(newCountsKey, fields.trackingStartedAt) : null;
            await transaction.multi();
            if (next.views || next.clicks) {
                await transaction.zAdd(challengeTrackAnalyticsIndexKey(subredditName), { member: receipt.trackKey, score: 0 });
                if (viewDelta) await transaction.hIncrBy(newCountsKey, fields.views, viewDelta);
                // The previous version only reported Accept taps, never author opens.
                if (clickDelta) await transaction.hIncrBy(newCountsKey, fields.acceptClicks, clickDelta);
                if (next.startedAt && (!currentStart || Date.parse(next.startedAt) < Date.parse(currentStart))) {
                    await transaction.hSet(newCountsKey, { [fields.trackingStartedAt]: next.startedAt });
                }
                if (next.views && viewersChanged && viewerCount) {
                    let cursor = 0;
                    do {
                        const batch = await redis.hScan(oldViewersKey, cursor, undefined, VIEWER_BATCH_SIZE);
                        const viewers = batch.fieldValues.filter(({ field }) => /^[A-Za-z0-9_-]{43}$/.test(field));
                        // HSCAN COUNT is a hint; also bound each queued HSET.
                        for (let index = 0; index < viewers.length; index += VIEWER_BATCH_SIZE) {
                            await transaction.hSet(newViewersKey, Object.fromEntries(viewers.slice(index, index + VIEWER_BATCH_SIZE).map(({ field }) => [field, '1'])));
                        }
                        cursor = batch.cursor;
                    } while (cursor !== 0);
                }
            }
            await transaction.hSet(keys.receipts, { [postId]: JSON.stringify(next) });
            const result = await transaction.exec();
            if (Array.isArray(result) && result.length) return;
        } catch (error) {
            if (!isRedisTransactionConflict(error)) throw error;
        } finally {
            try { await transaction.discard(); } catch { }
            try { await transaction.unwatch(); } catch { }
        }
    }
    throw new Error(IMPORT_ERROR);
}

async function reconcileBatch(subredditName: string, posts: { postId: string; receipt: LegacyReceipt }[]): Promise<void> {
    const raw = await redis.hMGet(challengeAnalyticsCountsKey(subredditName), posts.flatMap(({ postId }) => {
        const fields = challengeAnalyticsCounterFields(postId);
        return [fields.views, fields.clicks, fields.trackingStartedAt];
    }));
    const viewerCounts = await Promise.all(posts.map(({ postId }) => redis.hLen(challengeAnalyticsViewersKey(subredditName, postId))));
    for (let index = 0; index < posts.length; index += 1) {
        const { postId, receipt } = posts[index]!;
        if (count(raw[index * 3]) !== receipt.views || count(raw[index * 3 + 1]) !== receipt.clicks
            || count(viewerCounts[index]) !== receipt.viewerCount || timestamp(raw[index * 3 + 2]) !== receipt.startedAt) {
            await reconcilePost(subredditName, postId);
        }
    }
}

// The marker freezes catalogue mappings, not v1 data: requests from the old
// version can still finish afterward. Recheck only the mapped sources, adding
// new lifetime deltas and identities without inventing historical Today data.
export async function migrateLegacyChallengeAnalytics(subredditName: string): Promise<void> {
    await initializeMappings(subredditName);
    const keys = challengeAnalyticsMigrationKeys(subredditName);
    let cursor = 0;
    do {
        const batch = await redis.hScan(keys.receipts, cursor, undefined, PAGE_SIZE);
        const posts = batch.fieldValues.map(({ field, value }) => ({ postId: field, receipt: parseReceipt(value) }));
        // HSCAN may return more than COUNT; all follow-up reads stay bounded.
        for (let index = 0; index < posts.length; index += PAGE_SIZE) {
            await reconcileBatch(subredditName, posts.slice(index, index + PAGE_SIZE));
        }
        cursor = batch.cursor;
    } while (cursor !== 0);
}
