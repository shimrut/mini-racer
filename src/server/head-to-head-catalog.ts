import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { TRACKS } from '../../game/track/tracks.js';
import {
    HEAD_TO_HEAD_POST_TYPE,
    isHeadToHeadMedal,
    type HeadToHeadMedal,
    type HeadToHeadRecord,
} from './head-to-head-model.js';
import { createTrackFingerprint } from './pb-ghost-trace.js';
import { acquireRedisLock, releaseRedisLock } from './redis-lock.js';
import { isRedditPostId, normalizeName, redisKeyPart } from './value-guards.js';

const PREFIX = 'miniracer:head-to-head:catalog';
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const SWEEP_BUDGET_MS = 20_000;
const SWEEP_LOCK_TTL_MS = 60_000;
// Devvit caps a score-range read at 1000.
const BAND_READ_LIMIT = 1000;
const UPVOTE_CLAMP = 500_000;
const ENGAGEMENT_BANDS = ['author', 'gold', 'silver', 'bronze'] as const;

export type HeadToHeadCatalogCard = {
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
    subredditName: string;
    challengerUsername: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    targetTimeMs: number;
    medal: HeadToHeadMedal;
    createdAt: string;
    commentCount: number;
    upvoteCount: number;
};

type EngagementBand = (typeof ENGAGEMENT_BANDS)[number];

export type HeadToHeadCatalogSweepResult = {
    scanned: number;
    saved: number;
    skipped: number;
    status: 'locked' | 'partial' | 'done';
};

type SweepPost = {
    id?: unknown;
    url?: unknown;
    authorName?: unknown;
    subredditName?: unknown;
    removed?: unknown;
    createdAt?: unknown;
    flair?: { text?: unknown } | null;
    linkFlairText?: unknown;
    numberOfComments?: unknown;
    score?: unknown;
    getPostData?: () => Promise<unknown>;
};

export function headToHeadCatalogCardsKey(subredditName: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:cards`;
}

export function headToHeadCatalogAllKey(subredditName: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:all`;
}

function headToHeadCatalogByTrackKey(subredditName: string, trackKey: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:by-track:${redisKeyPart(trackKey)}`;
}

export function headToHeadCatalogBandKey(subredditName: string, band: EngagementBand): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:by-band:${band}`;
}

export function headToHeadCatalogBandKeys(subredditName: string): string[] {
    return ENGAGEMENT_BANDS.map((band) => headToHeadCatalogBandKey(subredditName, band));
}

function sweepCursorKey(subredditName: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:sweep-cursor`;
}

function sweepLockKey(subredditName: string): string {
    return `${PREFIX}:${redisKeyPart(subredditName)}:sweep-lock`;
}

function isStoredCount(value: unknown, allowNegative: boolean): boolean {
    if (value == null) return true;
    return Number.isSafeInteger(value) && (allowNegative || Number(value) >= 0);
}

function storedListingCount(value: unknown, allowNegative: boolean): number {
    const count = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
    if (!Number.isSafeInteger(count)) return 0;
    if (!allowNegative && count < 0) return 0;
    return count;
}

function engagementBand(card: Pick<HeadToHeadCatalogCard, 'trackKey' | 'targetTimeMs' | 'lapCount'>): EngagementBand | null {
    const medal = getMedalForRaceTime(card.trackKey, card.targetTimeMs / 1000, card.lapCount);
    return medal === 'author' || medal === 'gold' || medal === 'silver' || medal === 'bronze'
        ? medal
        : null;
}

function bandRankScore(commentCount: number, upvoteCount: number): number {
    const comments = Math.max(0, commentCount);
    const upvotes = Math.min(UPVOTE_CLAMP, Math.max(-UPVOTE_CLAMP, upvoteCount));
    return comments * (UPVOTE_CLAMP * 2) + (UPVOTE_CLAMP - upvotes);
}

async function syncBandIndex(
    card: HeadToHeadCatalogCard,
    previous: HeadToHeadCatalogCard | null,
): Promise<void> {
    const band = engagementBand(card);
    const previousBand = previous ? engagementBand(previous) : null;
    if (previousBand && previousBand !== band) {
        await redis.zRem(headToHeadCatalogBandKey(card.subredditName, previousBand), [card.challengeId]);
    }
    if (!band) return;
    await redis.zAdd(headToHeadCatalogBandKey(card.subredditName, band), {
        member: card.challengeId,
        score: bandRankScore(card.commentCount, card.upvoteCount),
    });
}

function parseCard(raw: string | null): HeadToHeadCatalogCard | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<HeadToHeadCatalogCard>;
        if (
            typeof parsed.challengeId !== 'string'
            || !parsed.challengeId
            || !isRedditPostId(parsed.postId)
            || typeof parsed.postUrl !== 'string'
            || !parsed.postUrl
            || typeof parsed.subredditName !== 'string'
            || !parsed.subredditName
            || typeof parsed.challengerUsername !== 'string'
            || !parsed.challengerUsername
            || typeof parsed.trackKey !== 'string'
            || !TRACKS[parsed.trackKey]
            || (parsed.lapCount !== 1 && parsed.lapCount !== 2 && parsed.lapCount !== 3)
            || !Number.isSafeInteger(parsed.targetTimeMs)
            || Number(parsed.targetTimeMs) <= 0
            || !isHeadToHeadMedal(parsed.medal)
            || typeof parsed.createdAt !== 'string'
            || !parsed.createdAt
            || !isStoredCount(parsed.commentCount, false)
            || !isStoredCount(parsed.upvoteCount, true)
        ) {
            return null;
        }
        return {
            ...(parsed as HeadToHeadCatalogCard),
            commentCount: parsed.commentCount ?? 0,
            upvoteCount: parsed.upvoteCount ?? 0,
        };
    } catch {
        return null;
    }
}

export function catalogCardFromRecord(
    record: Pick<
        HeadToHeadRecord,
        | 'challengeId'
        | 'subredditName'
        | 'challengerUsername'
        | 'trackKey'
        | 'lapCount'
        | 'targetTimeMs'
        | 'medal'
        | 'createdAt'
    >,
    post: { postId: `t3_${string}`; postUrl: string },
): HeadToHeadCatalogCard | null {
    return parseCard(JSON.stringify({
        challengeId: record.challengeId,
        postId: post.postId,
        postUrl: post.postUrl,
        subredditName: record.subredditName,
        challengerUsername: record.challengerUsername,
        trackKey: record.trackKey,
        lapCount: record.lapCount,
        targetTimeMs: record.targetTimeMs,
        medal: record.medal,
        createdAt: record.createdAt,
        commentCount: 0,
        upvoteCount: 0,
    }));
}

function catalogCardFromPostData(
    post: SweepPost,
    postData: Record<string, unknown>,
): HeadToHeadCatalogCard | null {
    if (postData.postType !== HEAD_TO_HEAD_POST_TYPE) return null;
    const trackKey = typeof postData.trackKey === 'string' ? postData.trackKey : '';
    const track = TRACKS[trackKey];
    if (!track) return null;
    if (
        typeof postData.trackFingerprint === 'string'
        && postData.trackFingerprint
        && postData.trackFingerprint !== createTrackFingerprint(track)
    ) {
        return null;
    }
    const createdAt = typeof postData.createdAt === 'string' && postData.createdAt
        ? postData.createdAt
        : (post.createdAt instanceof Date
            ? post.createdAt.toISOString()
            : typeof post.createdAt === 'string' ? post.createdAt : '');
    return parseCard(JSON.stringify({
        challengeId: postData.challengeId,
        postId: post.id,
        postUrl: post.url,
        subredditName: typeof post.subredditName === 'string' ? post.subredditName : '',
        challengerUsername: typeof post.authorName === 'string'
            ? post.authorName
            : postData.challengerUsername,
        trackKey,
        lapCount: postData.lapCount,
        targetTimeMs: postData.targetTimeMs,
        medal: postData.medal,
        createdAt,
        commentCount: storedListingCount(post.numberOfComments, false),
        upvoteCount: storedListingCount(post.score, true),
    }));
}

export async function readHeadToHeadCatalogCard(
    subredditName: string,
    challengeId: string,
): Promise<HeadToHeadCatalogCard | null> {
    return parseCard(await redis.hGet(headToHeadCatalogCardsKey(subredditName), challengeId));
}

export async function catalogHeadToHeadSize(subredditName: string): Promise<number> {
    const size = await redis.zCard(headToHeadCatalogAllKey(subredditName));
    return Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0;
}

export async function upsertHeadToHeadCatalogCard(
    card: HeadToHeadCatalogCard,
    options?: { refreshEngagement?: boolean },
): Promise<boolean> {
    const parsed = parseCard(JSON.stringify(card));
    if (!parsed) return false;
    const cardsKey = headToHeadCatalogCardsKey(parsed.subredditName);
    const existing = parseCard(await redis.hGet(cardsKey, parsed.challengeId));
    const samePost = existing?.postId === parsed.postId;
    const stored = samePost && !options?.refreshEngagement
        ? { ...parsed, commentCount: existing.commentCount, upvoteCount: existing.upvoteCount }
        : parsed;
    const createdMs = Date.parse(stored.createdAt);
    await redis.hSet(cardsKey, { [stored.challengeId]: JSON.stringify(stored) });
    if (!samePost) {
        await redis.zAdd(headToHeadCatalogAllKey(stored.subredditName), {
            member: stored.challengeId,
            score: Number.isFinite(createdMs) ? createdMs : 0,
        });
    }
    await redis.zRem(headToHeadCatalogByTrackKey(stored.subredditName, stored.trackKey), [stored.challengeId]);
    await syncBandIndex(stored, existing);
    return !samePost;
}

export async function upsertHeadToHeadCatalogCardBestEffort(
    card: HeadToHeadCatalogCard | null,
): Promise<void> {
    if (!card) return;
    try {
        await upsertHeadToHeadCatalogCard(card);
    } catch (error) {
        console.error('Head to Head catalog was not updated:', error);
    }
}

async function readBandCards(subredditName: string, band: EngagementBand): Promise<HeadToHeadCatalogCard[]> {
    const ranked = await redis.zRange(headToHeadCatalogBandKey(subredditName, band), 0, Number.MAX_SAFE_INTEGER, {
        by: 'score',
        limit: { offset: 0, count: BAND_READ_LIMIT },
    });
    if (!ranked.length) return [];
    const rawCards = await redis.hMGet(
        headToHeadCatalogCardsKey(subredditName),
        ranked.map((row) => row.member),
    );
    return rawCards.flatMap((raw) => {
        const card = parseCard(raw);
        return card ? [card] : [];
    });
}

function adjacentBands(band: EngagementBand): EngagementBand[] {
    const index = ENGAGEMENT_BANDS.indexOf(band);
    return [ENGAGEMENT_BANDS[index - 1], ENGAGEMENT_BANDS[index + 1]].filter(
        (candidate): candidate is EngagementBand => Boolean(candidate),
    );
}

function chooseChallenge(
    cards: HeadToHeadCatalogCard[],
    excludeChallengeId: string,
    excludeName: string,
    currentMs: number,
): HeadToHeadCatalogCard | null {
    const candidates = cards
        .filter((card) => card.challengeId !== excludeChallengeId)
        .filter((card) => normalizeName(card.challengerUsername) !== excludeName)
        .sort((left, right) => (
            left.commentCount - right.commentCount
            || right.upvoteCount - left.upvoteCount
        ));
    if (!candidates.length) return null;
    const quietest = candidates.filter((card) => sameEngagement(card, candidates[0]));
    return pickByAge(quietest, currentMs);
}

function sameEngagement(left: HeadToHeadCatalogCard, right: HeadToHeadCatalogCard): boolean {
    return left.commentCount === right.commentCount && left.upvoteCount === right.upvoteCount;
}

function createdMs(card: HeadToHeadCatalogCard): number {
    const ms = Date.parse(card.createdAt);
    return Number.isFinite(ms) ? ms : 0;
}

function pickByAge(cards: HeadToHeadCatalogCard[], currentMs: number): HeadToHeadCatalogCard {
    const older = cards.filter((card) => createdMs(card) < currentMs);
    if (older.length) {
        return older.reduce((earliest, card) => (
            createdMs(card) < createdMs(earliest) ? card : earliest
        ));
    }
    const newer = cards.filter((card) => createdMs(card) > currentMs);
    if (newer.length) {
        return newer.reduce((latest, card) => (
            createdMs(card) > createdMs(latest) ? card : latest
        ));
    }
    return cards[0];
}

export async function pickNextHeadToHeadChallenge({
    subredditName,
    excludeChallengeId,
    excludeUsername,
    trackKey = null,
    lapCount = null,
    targetTimeMs = null,
    createdAt = null,
}: {
    subredditName: string;
    excludeChallengeId: string;
    excludeUsername: string;
    trackKey?: string | null;
    lapCount?: number | null;
    targetTimeMs?: number | null;
    createdAt?: string | null;
}): Promise<HeadToHeadCatalogCard | null> {
    if (!trackKey || (lapCount !== 1 && lapCount !== 2 && lapCount !== 3) || !Number.isSafeInteger(targetTimeMs)) {
        return null;
    }
    const band = engagementBand({
        trackKey,
        lapCount,
        targetTimeMs: Number(targetTimeMs),
    });
    if (!band) return null;
    const excludeName = normalizeName(excludeUsername);
    const currentMs = Date.parse(createdAt ?? '');
    const ageMs = Number.isFinite(currentMs) ? currentMs : 0;
    const sameBand = chooseChallenge(
        await readBandCards(subredditName, band),
        excludeChallengeId,
        excludeName,
        ageMs,
    );
    if (sameBand) return sameBand;
    const neighbors = (await Promise.all(
        adjacentBands(band).map((candidate) => readBandCards(subredditName, candidate)),
    )).flat();
    return chooseChallenge(neighbors, excludeChallengeId, excludeName, ageMs);
}

function postCreatedMs(post: SweepPost): number | null {
    const value = post.createdAt;
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
    return Number.isFinite(ms) ? ms : null;
}

async function listingPosts(subredditName: string, after: string | null): Promise<SweepPost[] | null> {
    try {
        const listing = await reddit.getNewPosts({
            subredditName,
            limit: SWEEP_PAGE_SIZE,
            pageSize: SWEEP_PAGE_SIZE,
            ...(after ? { after } : {}),
        });
        const posts = typeof listing?.all === 'function' ? await listing.all() : [];
        return Array.isArray(posts) ? posts.slice(0, SWEEP_PAGE_SIZE) as SweepPost[] : [];
    } catch {
        return null;
    }
}

type SweepCursor = {
    after: string | null;
};

async function readSweepCursor(subredditName: string): Promise<SweepCursor | null> {
    const raw = await redis.get(sweepCursorKey(subredditName));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SweepCursor>;
        return {
            after: typeof parsed.after === 'string' && parsed.after ? parsed.after : null,
        };
    } catch {
        return null;
    }
}

export async function sweepHeadToHeadCatalog(
    subredditName: string,
    {
        listPosts = listingPosts,
        now = Date.now,
        budgetMs = SWEEP_BUDGET_MS,
        maxPosts = null,
    }: {
        listPosts?: (subredditName: string, after: string | null) => Promise<SweepPost[] | null>;
        now?: () => number;
        budgetMs?: number;
        maxPosts?: number | null;
    } = {},
): Promise<HeadToHeadCatalogSweepResult> {
    const lock = await acquireRedisLock(sweepLockKey(subredditName), SWEEP_LOCK_TTL_MS);
    if (!lock) {
        return { scanned: 0, saved: 0, skipped: 0, status: 'locked' };
    }
    const started = now();
    const monthCutoff = started - SWEEP_MONTH_MS;
    try {
        const cursor = await readSweepCursor(subredditName);
        let after = cursor?.after ?? null;
        let scanned = 0;
        let saved = 0;
        let skipped = 0;
        const seen = new Set<string>();
        let status: 'partial' | 'done' = 'partial';
        const outOfTime = () => now() - started >= budgetMs;
        const pageFull = () => maxPosts !== null && scanned >= maxPosts;

        while (!outOfTime() && !pageFull()) {
            const page = await listPosts(subredditName, after);
            if (page === null) {
                status = 'partial';
                break;
            }
            const fresh = page.filter((post) => typeof post?.id === 'string' && !seen.has(post.id));
            if (fresh.length === 0) {
                status = 'done';
                break;
            }
            let reachedMonth = false;
            for (const post of fresh) {
                if (outOfTime() || pageFull()) break;
                seen.add(String(post.id));
                const createdMs = postCreatedMs(post);
                if (createdMs !== null && createdMs < monthCutoff) {
                    reachedMonth = true;
                    break;
                }
                after = typeof post.id === 'string' ? post.id : after;
                scanned += 1;
                if (post?.removed === true || !isRedditPostId(post?.id) || typeof post?.url !== 'string' || !post.url) {
                    skipped += 1;
                    continue;
                }
                if (
                    normalizeName(typeof post.subredditName === 'string' ? post.subredditName : subredditName)
                    !== normalizeName(subredditName)
                ) {
                    skipped += 1;
                    continue;
                }
                let postData: unknown = null;
                if (typeof post.getPostData === 'function') {
                    try {
                        postData = await post.getPostData();
                    } catch {
                        skipped += 1;
                        continue;
                    }
                }
                if (!postData || typeof postData !== 'object' || Array.isArray(postData)) {
                    skipped += 1;
                    continue;
                }
                const card = catalogCardFromPostData(post, postData as Record<string, unknown>);
                if (!card) {
                    skipped += 1;
                    continue;
                }
                const created = await upsertHeadToHeadCatalogCard({
                    ...card,
                    subredditName,
                }, { refreshEngagement: true });
                if (created) saved += 1;
                else skipped += 1;
            }
            if (reachedMonth) {
                status = 'done';
                break;
            }
            if (outOfTime() || pageFull()) {
                status = 'partial';
                break;
            }
        }

        if (status === 'done') {
            await redis.del(sweepCursorKey(subredditName));
        } else {
            await redis.set(sweepCursorKey(subredditName), JSON.stringify({ after } satisfies SweepCursor));
        }
        return { scanned, saved, skipped, status };
    } finally {
        await releaseRedisLock(lock);
    }
}
