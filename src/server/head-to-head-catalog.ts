import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { TRACKS } from '../../game/track/tracks.js';
import {
    HEAD_TO_HEAD_POST_TYPE,
    isHeadToHeadMedal,
    type HeadToHeadMedal,
    type HeadToHeadRecord,
} from './head-to-head-model.js';
import { createTrackFingerprint } from './pb-ghost-trace.js';
import { acquireRedisLock, releaseRedisLock } from './redis-lock.js';

const PREFIX = 'miniracer:head-to-head:catalog';
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const SWEEP_BUDGET_MS = 20_000;
const SWEEP_LOCK_TTL_MS = 60_000;
const SWEPT_MARKER_TTL_SECONDS = 60 * 60;
const PICK_ATTEMPTS = 8;
const EASIER_SCORE_CEILING = Number.MAX_SAFE_INTEGER;

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
};

export type HeadToHeadCatalogSweepResult = {
    scanned: number;
    saved: number;
    skipped: number;
    /** locked: another collect is running. partial: click again. done: the month is covered. */
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
    getPostData?: () => Promise<unknown>;
};

function keyPart(value: string): string {
    return encodeURIComponent(value.trim().toLowerCase());
}

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

export function headToHeadCatalogCardsKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:cards`;
}

export function headToHeadCatalogPostsKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:posts`;
}

export function headToHeadCatalogAllKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:all`;
}

export function headToHeadCatalogByTrackKey(subredditName: string, trackKey: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:by-track:${keyPart(trackKey)}`;
}

export function headToHeadCatalogTrackKeys(subredditName: string): string[] {
    return Object.keys(TRACKS).map((trackKey) => headToHeadCatalogByTrackKey(subredditName, trackKey));
}

function sweptMarkerKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:swept-at`;
}

function sweepCursorKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:sweep-cursor`;
}

function sweepLockKey(subredditName: string): string {
    return `${PREFIX}:${keyPart(subredditName)}:sweep-lock`;
}

function validPostId(value: unknown): value is `t3_${string}` {
    return typeof value === 'string' && value.startsWith('t3_');
}

function parseCard(raw: string | null): HeadToHeadCatalogCard | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<HeadToHeadCatalogCard>;
        if (
            typeof parsed.challengeId !== 'string'
            || !parsed.challengeId
            || !validPostId(parsed.postId)
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
        ) {
            return null;
        }
        return parsed as HeadToHeadCatalogCard;
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

export async function upsertHeadToHeadCatalogCard(card: HeadToHeadCatalogCard): Promise<boolean> {
    const parsed = parseCard(JSON.stringify(card));
    if (!parsed) return false;
    const cardsKey = headToHeadCatalogCardsKey(parsed.subredditName);
    const existing = parseCard(await redis.hGet(cardsKey, parsed.challengeId));
    if (existing?.postId === parsed.postId) {
        await redis.hSet(cardsKey, { [parsed.challengeId]: JSON.stringify(parsed) });
        return false;
    }
    const createdMs = Date.parse(parsed.createdAt);
    await redis.hSet(cardsKey, { [parsed.challengeId]: JSON.stringify(parsed) });
    await redis.hSet(headToHeadCatalogPostsKey(parsed.subredditName), {
        [parsed.postId]: parsed.challengeId,
    });
    await redis.zAdd(headToHeadCatalogAllKey(parsed.subredditName), {
        member: parsed.challengeId,
        score: Number.isFinite(createdMs) ? createdMs : 0,
    });
    await redis.zAdd(headToHeadCatalogByTrackKey(parsed.subredditName, parsed.trackKey), {
        member: parsed.challengeId,
        score: parsed.targetTimeMs,
    });
    return true;
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

async function dropCatalogCard(
    subredditName: string,
    card: Pick<HeadToHeadCatalogCard, 'challengeId' | 'postId' | 'trackKey'>,
): Promise<void> {
    await redis.hDel(headToHeadCatalogCardsKey(subredditName), [card.challengeId]);
    await redis.hDel(headToHeadCatalogPostsKey(subredditName), [card.postId]);
    await redis.zRem(headToHeadCatalogAllKey(subredditName), [card.challengeId]);
    await redis.zRem(headToHeadCatalogByTrackKey(subredditName, card.trackKey), [card.challengeId]);
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
                if (post?.removed === true || !validPostId(post?.id) || typeof post?.url !== 'string' || !post.url) {
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
                });
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
            await redis.set(sweptMarkerKey(subredditName), new Date(started).toISOString(), {
                expiration: new Date(started + SWEPT_MARKER_TTL_SECONDS * 1000),
            });
        } else {
            await redis.set(sweepCursorKey(subredditName), JSON.stringify({ after } satisfies SweepCursor));
        }
        return { scanned, saved, skipped, status };
    } finally {
        await releaseRedisLock(lock);
    }
}

async function postStillRaces(postId: `t3_${string}`): Promise<boolean> {
    try {
        const post = await reddit.getPostById(postId);
        return Boolean(post) && (post as { removed?: unknown }).removed !== true;
    } catch {
        return false;
    }
}

async function nextCandidate(
    key: string,
    minScore: number,
    maxScore: number,
    reverse = false,
): Promise<string[]> {
    const ranked = await redis.zRange(key, minScore, maxScore, {
        by: 'score',
        reverse,
    });
    return ranked.map((row) => row.member);
}

export async function pickNextHeadToHeadChallenge({
    subredditName,
    excludeChallengeId,
    excludeUsername,
    trackKey = null,
    targetTimeMs = null,
}: {
    subredditName: string;
    excludeChallengeId: string;
    excludeUsername: string;
    trackKey?: string | null;
    targetTimeMs?: number | null;
}): Promise<HeadToHeadCatalogCard | null> {
    const excludeName = normalizeName(excludeUsername);
    const seen = new Set<string>([excludeChallengeId]);
    const queues: string[][] = [];
    if (trackKey && Number.isSafeInteger(targetTimeMs) && Number(targetTimeMs) > 0) {
        queues.push(await nextCandidate(
            headToHeadCatalogByTrackKey(subredditName, trackKey),
            Number(targetTimeMs) + 1,
            EASIER_SCORE_CEILING,
        ));
    }
    queues.push(await nextCandidate(
        headToHeadCatalogAllKey(subredditName),
        0,
        EASIER_SCORE_CEILING,
        true,
    ));

    let attempts = 0;
    for (const members of queues) {
        for (const challengeId of members) {
            if (seen.has(challengeId)) continue;
            seen.add(challengeId);
            const card = await readHeadToHeadCatalogCard(subredditName, challengeId);
            if (!card) {
                await redis.zRem(headToHeadCatalogAllKey(subredditName), [challengeId]);
                if (trackKey) {
                    await redis.zRem(headToHeadCatalogByTrackKey(subredditName, trackKey), [challengeId]);
                }
                continue;
            }
            if (normalizeName(card.challengerUsername) === excludeName) continue;
            attempts += 1;
            if (attempts > PICK_ATTEMPTS) return null;
            if (!await postStillRaces(card.postId)) {
                await dropCatalogCard(subredditName, card);
                continue;
            }
            return card;
        }
    }
    return null;
}
