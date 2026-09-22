import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { randomUUID } from 'node:crypto';
import { getMedalForRaceTime } from '../../game/medals/medal-timing.js';
import { getTrackName } from '../../game/track/catalog.js';
import { DAILY_GP_REDIS_TTL_SECONDS, type DailyGpChallenge } from './daily-gp-model.js';
import {
    getServerDailyGpPlayerBest,
    getServerDailyGpPlayableChallenge,
} from './daily-gp-store.js';
import {
    readDailyGpPostRecord,
    writeDailyGpPostRecord,
    writeDailyGpPostRecordIfAbsent,
    type DailyGpPostRecord,
} from './daily-gp-post-store.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';
import {
    readUserCommentRecord,
    submitUserComment,
    type UserCommentRecord,
} from './user-comment-submit.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    startRedisLockLeaseRenewal,
    type RedisLock,
    type RedisLockLease,
} from './redis-lock.js';

export const DAILY_GP_SCORE_THREAD_TEXT = [
    '🏁 Mini Racer score thread',
    '',
    'Share your race time from the game and it will appear as a reply here from your Reddit account.',
].join('\n');

const SHARE_PREVIEW_TTL_SECONDS = 10 * 60;
const SHARE_RATE_LIMIT_SECONDS = 60;
const SHARE_RATE_LIMIT_MAX = 12;
const SHARE_LOCK_TTL_MS = 30_000;
const SHARE_LOCK_RENEWAL_INTERVAL_MS = 10_000;

type ShareSource = 'finish' | 'standings';
type MedalTier = 'author' | 'gold' | 'silver' | 'bronze' | null;

type SharePreviewRecord = {
    username: string;
    subredditName: string;
    challengeId: string;
    source: ShareSource;
    bestTimeMs: number;
    lapCount: 1 | 2 | 3;
    medal: MedalTier;
    commentText: string;
    createdAt: string;
};

type SharedResultRecord = {
    commentId: `t1_${string}`;
    commentUrl: string;
    commentText: string;
    username: string;
    createdAt: string;
};

type ShareRequestContext = {
    username?: string | null;
    subredditName?: string | null;
    appSlug?: string | null;
    preferredPostUrl?: string | null;
};

export type ShareServiceResult = {
    status: number;
    body: Record<string, unknown>;
};

export function normalizeShareName(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
    return normalizeShareName(value);
}

function createSharePreviewKey(token: string): string {
    return `dailygp:share-preview:${token}`;
}

function createSharedResultKey(record: SharePreviewRecord): string {
    return [
        'dailygp:shared-result',
        normalizeName(record.subredditName),
        record.challengeId,
        normalizeName(record.username),
        record.bestTimeMs,
    ].join(':');
}

function createShareRateLimitKey(username: string): string {
    return `dailygp:share-rate-limit:${normalizeName(username)}`;
}

function createShareLockKey(record: SharePreviewRecord): string {
    return `${createSharedResultKey(record)}:lock`;
}

function formatLapTime(bestTimeMs: number): string {
    const totalMilliseconds = Math.round(bestTimeMs);
    const seconds = Math.floor(totalMilliseconds / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatDailyGpShareComment(
    bestTimeMs: number,
    medal: MedalTier,
    trackName?: string,
    lapCount = 1,
): string {
    const time = formatLapTime(bestTimeMs);
    const where = trackName || 'Mini Racer';
    const medals: Record<Exclude<MedalTier, null>, { label: string; emoji: string }> = {
        author: { label: 'Author', emoji: '🏆' },
        gold: { label: 'Gold', emoji: '🥇' },
        silver: { label: 'Silver', emoji: '🥈' },
        bronze: { label: 'Bronze', emoji: '🥉' },
    };
    const raceDescription = lapCount === 1 ? 'lap' : `${lapCount}-lap race`;
    if (!medal) {
        return `I set a ${time} ${raceDescription} in ${where}. 🏁`;
    }
    const detail = medals[medal];
    return `I earned the ${detail.label} medal ${detail.emoji} with a ${time} ${raceDescription} in ${where}.`;
}

export function parseSharePreviewRecord(raw: string | null): SharePreviewRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SharePreviewRecord>;
        if (
            typeof parsed.username !== 'string'
            || typeof parsed.subredditName !== 'string'
            || typeof parsed.challengeId !== 'string'
            || (parsed.source !== 'finish' && parsed.source !== 'standings')
            || !Number.isFinite(parsed.bestTimeMs)
            || typeof parsed.commentText !== 'string'
        ) return null;
        return {
            ...parsed,
            lapCount: parsed.lapCount === 2 || parsed.lapCount === 3 ? parsed.lapCount : 1,
        } as SharePreviewRecord;
    } catch (_error) {
        return null;
    }
}

export function parseShareSharedResult(raw: string | null): SharedResultRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SharedResultRecord>;
        if (
            typeof parsed.commentId !== 'string'
            || !parsed.commentId.startsWith('t1_')
            || typeof parsed.commentUrl !== 'string'
            || typeof parsed.commentText !== 'string'
            || typeof parsed.username !== 'string'
        ) return null;
        return parsed as SharedResultRecord;
    } catch (_error) {
        return null;
    }
}

export function getValidShareRequestContext(input: ShareRequestContext): {
    username: string;
    subredditName: string;
    appSlug: string;
    preferredPostUrl: string | null;
} | null {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const subredditName = typeof input.subredditName === 'string' ? input.subredditName.trim() : '';
    const appSlug = typeof input.appSlug === 'string' ? input.appSlug.trim() : '';
    if (!username || !subredditName || !appSlug) return null;
    return {
        username,
        subredditName,
        appSlug,
        preferredPostUrl: typeof input.preferredPostUrl === 'string' && input.preferredPostUrl.trim()
            ? input.preferredPostUrl.trim()
            : null,
    };
}

async function acquireLock(key: string): Promise<RedisLock | null> {
    return acquireRedisLock(key, SHARE_LOCK_TTL_MS, redis);
}

async function releaseLock(lock: RedisLock | null): Promise<void> {
    await releaseRedisLock(lock, redis);
}

async function stopAndReleaseLock(lease: RedisLockLease, lock: RedisLock): Promise<void> {
    await lease.stop();
    try {
        await releaseLock(lock);
    } catch (error) {
        console.error('Daily GP share lock cleanup failed:', error);
    }
}

async function stillOwnLock(lease: RedisLockLease): Promise<boolean> {
    return lease.isOwned() && await lease.confirmOwnership();
}

async function checkRateLimit(username: string): Promise<number | null> {
    const key = createShareRateLimitKey(username);
    const attempts = await redis.incrBy(key, 1);
    if (attempts === 1) await redis.expire(key, SHARE_RATE_LIMIT_SECONDS);
    if (attempts <= SHARE_RATE_LIMIT_MAX) return null;
    const expiresAt = await redis.expireTime(key);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
    }
    await redis.expire(key, SHARE_RATE_LIMIT_SECONDS);
    return SHARE_RATE_LIMIT_SECONDS;
}

export async function registerDailyGpPost({
    subredditName,
    challengeId,
    postId,
    postUrl,
}: {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
}): Promise<DailyGpPostRecord> {
    const existing = await readDailyGpPostRecord(subredditName, challengeId);
    if (existing) {
        return existing;
    }
    const now = new Date().toISOString();
    const record: DailyGpPostRecord = {
        subredditName,
        challengeId,
        postId,
        postUrl,
        scoreThreadCommentId: null,
        createdAt: now,
        updatedAt: now,
    };
    const wrote = await writeDailyGpPostRecordIfAbsent(record);
    if (wrote) {
        return record;
    }
    const winner = await readDailyGpPostRecord(subredditName, challengeId);
    if (!winner) {
        throw new Error('Daily Mini Racer post registry race left no canonical record.');
    }
    return winner;
}

async function recoverDailyGpPost({
    subredditName,
    challengeId,
    appSlug,
    preferredPostUrl,
}: {
    subredditName: string;
    challengeId: string;
    appSlug: string;
    preferredPostUrl: string | null;
}): Promise<DailyGpPostRecord | null> {
    const listing = await (reddit as any).getPostsByUser({
        username: appSlug,
        sort: 'new',
        timeframe: 'month',
        limit: 100,
        pageSize: 100,
    });
    const posts = typeof listing?.all === 'function' ? await listing.all() : [];
    const matches: any[] = [];
    for (const post of posts) {
        if (normalizeName(post?.subredditName || '') !== normalizeName(subredditName)) continue;
        try {
            const postData = await post.getPostData();
            if (postData?.challengeId === challengeId) matches.push(post);
        } catch (_error) {
        }
    }
    if (!matches.length) return null;
    const post = matches.find((candidate) => candidate?.url === preferredPostUrl) || matches[0];
    if (typeof post?.id !== 'string' || !post.id.startsWith('t3_') || typeof post?.url !== 'string') {
        return null;
    }
    return registerDailyGpPost({
        subredditName,
        challengeId,
        postId: post.id,
        postUrl: post.url,
    });
}

export async function resolveDailyGpPostRecord({
    subredditName,
    challengeId,
    appSlug,
    preferredPostUrl = null,
}: {
    subredditName: string;
    challengeId: string;
    appSlug: string;
    preferredPostUrl?: string | null;
}): Promise<DailyGpPostRecord | null> {
    const stored = await readDailyGpPostRecord(subredditName, challengeId);
    if (stored) {
        try {
            await reddit.getPostById(stored.postId);
            return stored;
        } catch (_error) {
        }
    }
    return recoverDailyGpPost({ subredditName, challengeId, appSlug, preferredPostUrl });
}

export async function ensureDailyGpScoreThread(
    record: DailyGpPostRecord,
    appSlug: string,
): Promise<DailyGpPostRecord> {
    if (record.scoreThreadCommentId) {
        try {
            const stored = await reddit.getCommentById(record.scoreThreadCommentId);
            if (!(stored as any)?.removed) {
                await (stored as any).distinguish(true);
                return record;
            }
        } catch (_error) {
        }
    }

    const lock = await acquireLock(`dailygp:score-thread-lock:${record.postId}`);
    if (!lock) {
        const latest = await readDailyGpPostRecord(record.subredditName, record.challengeId);
        if (latest?.scoreThreadCommentId) return latest;
        throw new Error('Score thread is being prepared.');
    }
    const lease = startRedisLockLeaseRenewal(lock, SHARE_LOCK_RENEWAL_INTERVAL_MS, redis);
    try {
        if (!await stillOwnLock(lease)) throw new Error('Score thread lock ownership was lost.');
        const latest = await readDailyGpPostRecord(record.subredditName, record.challengeId) || record;
        if (latest.scoreThreadCommentId) return latest;
        const listing = await (reddit as any).getComments({
            postId: latest.postId,
            depth: 1,
            sort: 'old',
            limit: 100,
            pageSize: 100,
        });
        const comments = typeof listing?.all === 'function' ? await listing.all() : [];
        if (!await stillOwnLock(lease)) throw new Error('Score thread lock ownership was lost.');
        let anchor = comments.find((comment: any) => (
            normalizeName(comment?.authorName || '') === normalizeName(appSlug)
            && comment?.body === DAILY_GP_SCORE_THREAD_TEXT
        ));
        if (!anchor) {
            anchor = await reddit.submitComment({
                id: latest.postId,
                text: DAILY_GP_SCORE_THREAD_TEXT,
                runAs: 'APP',
            });
        }
        if (!await stillOwnLock(lease)) throw new Error('Score thread lock ownership was lost.');
        await anchor.distinguish(true);
        if (typeof anchor?.id !== 'string' || !anchor.id.startsWith('t1_')) {
            throw new Error('Reddit did not return a score-thread comment ID.');
        }
        const next: DailyGpPostRecord = {
            ...latest,
            scoreThreadCommentId: anchor.id,
            updatedAt: new Date().toISOString(),
        };
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) throw new Error('Score thread lock ownership was lost.');
        await writeDailyGpPostRecord(next, transaction);
        const transactionResults = await transaction.exec();
        if (!Array.isArray(transactionResults) || transactionResults.length === 0) {
            throw new Error('Score thread lock ownership was lost.');
        }
        return next;
    } finally {
        await stopAndReleaseLock(lease, lock);
    }
}

export async function registerDailyGpPostWithScoreThread({
    subredditName,
    challengeId,
    postId,
    postUrl,
    appSlug,
}: {
    subredditName: string;
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
    appSlug: string;
}): Promise<DailyGpPostRecord> {
    const record = await registerDailyGpPost({
        subredditName,
        challengeId,
        postId,
        postUrl,
    });
    return ensureDailyGpScoreThread(record, appSlug);
}

async function readActiveSharedResult(record: SharePreviewRecord): Promise<SharedResultRecord | null> {
    const key = createSharedResultKey(record);
    const shared = parseShareSharedResult(await redis.get(key));
    if (!shared) return null;
    try {
        const comment = await reddit.getCommentById(shared.commentId);
        if (!(comment as any)?.removed) return shared;
    } catch (_error) {
        return shared;
    }
    await redis.del(key);
    return null;
}

function alreadySharedBody(shared: UserCommentRecord): Record<string, unknown> {
    return {
        status: 'already_shared',
        username: shared.username,
        commentText: shared.commentText,
        commentUrl: shared.commentUrl ?? '',
    };
}

async function resolveShareResult(
    input: Record<string, unknown>,
    username: string,
): Promise<{ challenge: DailyGpChallenge; bestTimeMs: number } | null | 'invalid_replay'> {
    const source = input.source;
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : null;
    if (source === 'standings') {
        return getServerDailyGpPlayerBest({ challengeId, redditUsername: username });
    }
    if (source !== 'finish') return null;
    const challenge = await getServerDailyGpPlayableChallenge(challengeId);
    if (!challenge) return null;
    const outcome = validateDailyGpReplayDetailed({ challenge, replay: input.replay });
    return outcome.ok
        ? { challenge, bestTimeMs: outcome.run.bestTimeMs }
        : 'invalid_replay';
}

export async function previewDailyGpShare(
    input: Record<string, unknown>,
    requestContext: ShareRequestContext,
): Promise<ShareServiceResult> {
    const validContext = getValidShareRequestContext(requestContext);
    if (!validContext) {
        return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to share your time.' } };
    }
    const retryAfterSeconds = await checkRateLimit(validContext.username);
    if (retryAfterSeconds !== null) {
        return { status: 429, body: { status: 'rate_limited', retryAfterSeconds } };
    }
    const challengeId = typeof input.challengeId === 'string' ? input.challengeId : null;
    const [result, post] = await Promise.all([
        resolveShareResult(input, validContext.username),
        challengeId
            ? resolveDailyGpPostRecord({
                subredditName: validContext.subredditName,
                challengeId,
                appSlug: validContext.appSlug,
                preferredPostUrl: validContext.preferredPostUrl,
            })
            : Promise.resolve(null),
    ]);
    if (result === 'invalid_replay') {
        return { status: 422, body: { status: 'invalid_replay', error: 'This finished race could not be verified.' } };
    }
    if (!result) {
        return { status: 404, body: { status: 'result_unavailable', error: 'No verified result is available to share.' } };
    }
    if (!post) {
        return { status: 404, body: { status: 'post_unavailable', error: 'The post for this race day is unavailable.' } };
    }
    const lapCount = result.challenge.objectiveParams.lapCount;
    const medal = getMedalForRaceTime(
        result.challenge.trackKey,
        result.bestTimeMs / 1000,
        lapCount,
    ) as MedalTier;
    const preview: SharePreviewRecord = {
        username: validContext.username,
        subredditName: validContext.subredditName,
        challengeId: result.challenge.id,
        source: input.source as ShareSource,
        bestTimeMs: result.bestTimeMs,
        lapCount,
        medal,
        commentText: formatDailyGpShareComment(
            result.bestTimeMs,
            medal,
            getTrackName(result.challenge.trackKey, ''),
            lapCount,
        ),
        createdAt: new Date().toISOString(),
    };
    const shared = await readActiveSharedResult(preview);
    if (shared) return { status: 200, body: alreadySharedBody(shared) };

    const shareToken = randomUUID();
    const key = createSharePreviewKey(shareToken);
    const expiresAt = new Date(Date.now() + SHARE_PREVIEW_TTL_SECONDS * 1000);
    await redis.set(key, JSON.stringify(preview), { expiration: expiresAt });
    return {
        status: 200,
        body: {
            status: 'ready',
            shareToken,
            username: preview.username,
            commentText: preview.commentText,
            expiresAt: expiresAt.toISOString(),
        },
    };
}

export async function confirmDailyGpShare(
    input: Record<string, unknown>,
    requestContext: ShareRequestContext,
): Promise<ShareServiceResult> {
    const validContext = getValidShareRequestContext(requestContext);
    if (!validContext) {
        return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to share your time.' } };
    }
    const token = typeof input.shareToken === 'string' ? input.shareToken : '';
    const tokenKey = createSharePreviewKey(token);
    const preview = parseSharePreviewRecord(token ? await redis.get(tokenKey) : null);
    if (!preview) {
        return { status: 409, body: { status: 'preview_expired', error: 'This share preview expired. Try again.' } };
    }
    if (
        normalizeName(preview.username) !== normalizeName(validContext.username)
        || normalizeName(preview.subredditName) !== normalizeName(validContext.subredditName)
    ) {
        return { status: 403, body: { status: 'share_forbidden', error: 'This share preview belongs to another Reddit account.' } };
    }
    const lock = await acquireLock(createShareLockKey(preview));
    if (!lock) {
        return { status: 409, body: { status: 'share_in_progress', error: 'This result is already being shared.' } };
    }
    const lease = startRedisLockLeaseRenewal(lock, SHARE_LOCK_RENEWAL_INTERVAL_MS, redis);
    const ownershipLost = (): ShareServiceResult => ({
        status: 409,
        body: { status: 'share_in_progress', error: 'This result is already being shared.' },
    });
    try {
        if (!await stillOwnLock(lease)) return ownershipLost();
        const locked = parseSharePreviewRecord(await redis.get(tokenKey));
        if (!locked) {
            return { status: 409, body: { status: 'preview_expired', error: 'This share preview expired. Try again.' } };
        }
        if (
            normalizeName(locked.username) !== normalizeName(validContext.username)
            || normalizeName(locked.subredditName) !== normalizeName(validContext.subredditName)
        ) {
            return { status: 403, body: { status: 'share_forbidden', error: 'This share preview belongs to another Reddit account.' } };
        }
        const recordKey = createSharedResultKey(locked);
        const stored = await readUserCommentRecord(recordKey);
        if (stored?.commentId) {
            await redis.del(tokenKey);
            return { status: 200, body: alreadySharedBody(stored) };
        }
        const post = await resolveDailyGpPostRecord({
            subredditName: locked.subredditName,
            challengeId: locked.challengeId,
            appSlug: validContext.appSlug,
            preferredPostUrl: validContext.preferredPostUrl,
        });
        if (!await stillOwnLock(lease)) return ownershipLost();
        if (!post) {
            return { status: 404, body: { status: 'post_unavailable', error: 'The post for this race day is unavailable.' } };
        }
        const withThread = await ensureDailyGpScoreThread(post, validContext.appSlug);
        if (!await stillOwnLock(lease)) return ownershipLost();
        if (!withThread.scoreThreadCommentId) {
            throw new Error('The score thread is unavailable.');
        }
        const outcome = await submitUserComment({
            postId: post.postId,
            parentId: withThread.scoreThreadCommentId,
            username: locked.username,
            text: locked.commentText,
            record: { key: recordKey, ttlSeconds: DAILY_GP_REDIS_TTL_SECONDS, stored },
            fallbackCommentUrl: post.postUrl,
            confirmOwnership: () => stillOwnLock(lease),
        });
        if (outcome.status === 'lock_lost') return ownershipLost();
        if (outcome.status === 'already') {
            await redis.del(tokenKey);
            return { status: 200, body: alreadySharedBody(outcome.record) };
        }
        if (outcome.status === 'unconfirmed') {
            return {
                status: 409,
                body: {
                    status: 'comment_unconfirmed',
                    error: 'Reddit did not confirm this share. Share again to check.',
                },
            };
        }
        const published = outcome.record;
        if (normalizeName(published.authorName || '') !== normalizeName(locked.username)) {
            return {
                status: 409,
                body: {
                    status: 'user_action_unavailable',
                    error: 'Reddit user-attributed sharing is not available for this app version.',
                },
            };
        }
        if (outcome.status === 'posted_without_link') {
            return {
                status: 409,
                body: {
                    status: 'posted_without_link',
                    error: 'Reddit did not return a link to your comment.',
                },
            };
        }
        await redis.del(tokenKey).catch((error: unknown) => {
            console.error('Daily GP share preview cleanup failed:', error);
        });
        return {
            status: 200,
            body: {
                status: 'shared',
                commentText: published.commentText,
                commentUrl: published.commentUrl ?? '',
            },
        };
    } finally {
        await stopAndReleaseLock(lease, lock);
    }
}
