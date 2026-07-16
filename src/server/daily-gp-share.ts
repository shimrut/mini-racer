import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { randomUUID } from 'node:crypto';
import { getMedalForLapTime } from '../../game/medals/medals.js';
import { getTrackName } from '../../game/track/catalog.js';
import { DAILY_GP_REDIS_TTL_SECONDS, type DailyGpChallenge } from './daily-gp-model.js';
import {
    getServerDailyGpPlayerBest,
    getServerDailyGpPlayableChallenge,
} from './daily-gp-store.js';
import {
    acquireDailyGpPostCreationLock,
    readDailyGpPostRecord,
    releaseDailyGpPostCreationLock,
    writeDailyGpPostRecord,
    type DailyGpPostRecord,
} from './daily-gp-post-store.js';
import { validateDailyGpReplayDetailed } from './replay-validator.js';

export const DAILY_GP_SCORE_THREAD_TEXT = [
    '🏁 Mini Racer score thread',
    '',
    'Share your lap time from the game and it will appear as a reply here from your Reddit account.',
].join('\n');

const SHARE_PREVIEW_TTL_SECONDS = 10 * 60;
const SHARE_RATE_LIMIT_SECONDS = 60;
const SHARE_RATE_LIMIT_MAX = 12;
const SHARE_LOCK_TTL_MS = 10_000;

type ShareSource = 'finish' | 'standings';
type MedalTier = 'author' | 'gold' | 'silver' | 'bronze' | null;

type SharePreviewRecord = {
    username: string;
    subredditName: string;
    challengeId: string;
    source: ShareSource;
    bestTimeMs: number;
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

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
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
    const totalCentiseconds = Math.round(bestTimeMs / 10);
    const seconds = Math.floor(totalCentiseconds / 100);
    const centiseconds = totalCentiseconds % 100;
    return `${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

export function formatDailyGpShareComment(
    bestTimeMs: number,
    medal: MedalTier,
    trackName?: string,
): string {
    const time = formatLapTime(bestTimeMs);
    const where = trackName || 'Mini Racer';
    const medals: Record<Exclude<MedalTier, null>, { label: string; emoji: string }> = {
        author: { label: 'Author', emoji: '🏆' },
        gold: { label: 'Gold', emoji: '🥇' },
        silver: { label: 'Silver', emoji: '🥈' },
        bronze: { label: 'Bronze', emoji: '🥉' },
    };
    if (!medal) {
        return `I set a ${time} lap in ${where}. 🏁`;
    }
    const detail = medals[medal];
    return `I earned the ${detail.label} medal ${detail.emoji} with a ${time} lap in ${where}.`;
}

function parsePreviewRecord(raw: string | null): SharePreviewRecord | null {
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
        return parsed as SharePreviewRecord;
    } catch (_error) {
        return null;
    }
}

function parseSharedResult(raw: string | null): SharedResultRecord | null {
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

function getValidContext(input: ShareRequestContext): {
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

async function acquireLock(key: string): Promise<{ key: string; value: string } | null> {
    const value = randomUUID();
    const acquired = await redis.set(key, value, {
        nx: true,
        expiration: new Date(Date.now() + SHARE_LOCK_TTL_MS),
    });
    return acquired ? { key, value } : null;
}

async function releaseLock(lock: { key: string; value: string } | null): Promise<void> {
    if (lock && await redis.get(lock.key) === lock.value) {
        await redis.del(lock.key);
    }
}

async function checkRateLimit(username: string): Promise<number | null> {
    const key = createShareRateLimitKey(username);
    const attempts = await redis.incrBy(key, 1);
    if (attempts === 1) await redis.expire(key, SHARE_RATE_LIMIT_SECONDS);
    if (attempts <= SHARE_RATE_LIMIT_MAX) return null;
    const expiresAt = await redis.expireTime(key);
    return Number.isFinite(expiresAt) && expiresAt > 0
        ? Math.max(1, expiresAt - Math.floor(Date.now() / 1000))
        : SHARE_RATE_LIMIT_SECONDS;
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
    const now = new Date().toISOString();
    const record: DailyGpPostRecord = {
        subredditName,
        challengeId,
        postId,
        postUrl,
        scoreThreadCommentId: existing?.postId === postId ? existing.scoreThreadCommentId : null,
        createdAt: existing?.postId === postId ? existing.createdAt : now,
        updatedAt: now,
    };
    await writeDailyGpPostRecord(record);
    return record;
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
            // Ignore unrelated or unavailable historical posts.
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
            // Recover from an older post or a stale record below.
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
            // Rebuild a missing thread below.
        }
    }

    const lock = await acquireLock(`dailygp:score-thread-lock:${record.postId}`);
    if (!lock) {
        const latest = await readDailyGpPostRecord(record.subredditName, record.challengeId);
        if (latest?.scoreThreadCommentId) return latest;
        throw new Error('Score thread is being prepared.');
    }
    try {
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
        await anchor.distinguish(true);
        if (typeof anchor?.id !== 'string' || !anchor.id.startsWith('t1_')) {
            throw new Error('Reddit did not return a score-thread comment ID.');
        }
        const next: DailyGpPostRecord = {
            ...latest,
            scoreThreadCommentId: anchor.id,
            updatedAt: new Date().toISOString(),
        };
        await writeDailyGpPostRecord(next);
        return next;
    } finally {
        await releaseLock(lock);
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
    const shared = parseSharedResult(await redis.get(key));
    if (!shared) return null;
    try {
        const comment = await reddit.getCommentById(shared.commentId);
        if (!(comment as any)?.removed) return shared;
    } catch (_error) {
        // Treat a deleted/unavailable comment as shareable again.
    }
    await redis.del(key);
    return null;
}

function alreadySharedBody(shared: SharedResultRecord): Record<string, unknown> {
    return {
        status: 'already_shared',
        username: shared.username,
        commentText: shared.commentText,
        commentUrl: shared.commentUrl,
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
    const validContext = getValidContext(requestContext);
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
        return { status: 422, body: { status: 'invalid_replay', error: 'This finished lap could not be verified.' } };
    }
    if (!result) {
        return { status: 404, body: { status: 'result_unavailable', error: 'No verified result is available to share.' } };
    }
    if (!post) {
        return { status: 404, body: { status: 'post_unavailable', error: 'The post for this race day is unavailable.' } };
    }
    const medal = getMedalForLapTime(result.challenge.trackKey, result.bestTimeMs / 1000) as MedalTier;
    const preview: SharePreviewRecord = {
        username: validContext.username,
        subredditName: validContext.subredditName,
        challengeId: result.challenge.id,
        source: input.source as ShareSource,
        bestTimeMs: result.bestTimeMs,
        medal,
        commentText: formatDailyGpShareComment(
            result.bestTimeMs,
            medal,
            getTrackName(result.challenge.trackKey, ''),
        ),
        createdAt: new Date().toISOString(),
    };
    const shared = await readActiveSharedResult(preview);
    if (shared) return { status: 200, body: alreadySharedBody(shared) };

    const shareToken = randomUUID();
    const key = createSharePreviewKey(shareToken);
    await redis.set(key, JSON.stringify(preview));
    await redis.expire(key, SHARE_PREVIEW_TTL_SECONDS);
    return {
        status: 200,
        body: {
            status: 'ready',
            shareToken,
            username: preview.username,
            commentText: preview.commentText,
            expiresAt: new Date(Date.now() + SHARE_PREVIEW_TTL_SECONDS * 1000).toISOString(),
        },
    };
}

export async function confirmDailyGpShare(
    input: Record<string, unknown>,
    requestContext: ShareRequestContext,
): Promise<ShareServiceResult> {
    const validContext = getValidContext(requestContext);
    if (!validContext) {
        return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to share your time.' } };
    }
    const token = typeof input.shareToken === 'string' ? input.shareToken : '';
    const tokenKey = createSharePreviewKey(token);
    const preview = parsePreviewRecord(token ? await redis.get(tokenKey) : null);
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
    try {
        const shared = await readActiveSharedResult(preview);
        if (shared) {
            await redis.del(tokenKey);
            return { status: 200, body: alreadySharedBody(shared) };
        }
        const post = await resolveDailyGpPostRecord({
            subredditName: preview.subredditName,
            challengeId: preview.challengeId,
            appSlug: validContext.appSlug,
            preferredPostUrl: validContext.preferredPostUrl,
        });
        if (!post) {
            return { status: 404, body: { status: 'post_unavailable', error: 'The post for this race day is unavailable.' } };
        }
        const withThread = await ensureDailyGpScoreThread(post, validContext.appSlug);
        if (!withThread.scoreThreadCommentId) {
            throw new Error('The score thread is unavailable.');
        }
        const comment = await reddit.submitComment({
            id: withThread.scoreThreadCommentId,
            text: preview.commentText,
            runAs: 'USER',
        });
        if (normalizeName((comment as any)?.authorName || '') !== normalizeName(preview.username)) {
            try {
                await (comment as any).delete();
            } catch (_error) {
                // Best effort cleanup; the share still fails closed.
            }
            return {
                status: 409,
                body: {
                    status: 'user_action_unavailable',
                    error: 'Reddit user-attributed sharing is not available for this app version.',
                },
            };
        }
        if (typeof (comment as any)?.id !== 'string' || !(comment as any).id.startsWith('t1_')) {
            throw new Error('Reddit did not return a shared-comment ID.');
        }
        const saved: SharedResultRecord = {
            commentId: (comment as any).id,
            commentUrl: typeof (comment as any)?.url === 'string' ? (comment as any).url : post.postUrl,
            commentText: preview.commentText,
            username: preview.username,
            createdAt: new Date().toISOString(),
        };
        const sharedKey = createSharedResultKey(preview);
        await redis.set(sharedKey, JSON.stringify(saved));
        await redis.expire(sharedKey, DAILY_GP_REDIS_TTL_SECONDS);
        await redis.del(tokenKey);
        return {
            status: 200,
            body: {
                status: 'shared',
                commentText: saved.commentText,
                commentUrl: saved.commentUrl,
            },
        };
    } finally {
        await releaseLock(lock);
    }
}
