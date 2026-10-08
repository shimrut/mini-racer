import { redis } from '@devvit/redis';
import { reddit } from '@devvit/web/server';
import { randomUUID } from 'node:crypto';
import { formatCampaignPlace, formatCampaignTotalTime, readCampaignPlace } from '../../../game/campaign/aggregate.js';
import { buildCampaignFinishedScreen } from '../../../game/campaign/finished-screen.js';
import { getCampaignFinalStage, getCampaignSeries, getCampaignStage } from '../../../game/campaign/manifest.js';
import { isTrackGroundKey } from '../../../game/track/grounds.js';
import { sanitizeRedditUsername } from '../../../game/shared/leaderboard-identity.js';
import { resolveAuthorizedPlayerIdentity } from '../competition/competition-identity.js';
import { resolveRedditAvatarUrl } from '../player/reddit-avatar.js';
import { isProgressTransferPending } from '../player/guest-retirement.js';
import { isUserActionRefusedBeforePosting } from '../posts/user-comment-submit.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    commitOwnedRedisLockTransaction,
    isRedisLockOwned,
    releaseRedisLock,
    type RedisLock,
} from '../redis/redis-lock.js';
import { playerFieldHash, redisKeyPart } from '../redis/redis-names.js';
import { normalizeName } from '../shared/value-guards.js';
import { campaignAggregateKeys } from './campaign-aggregate-store.js';
import { getCampaignResultsForSeries } from './campaign-store.js';

type ShareRecord = { createdAt: string; postId?: string; postUrl?: string; refreshPending?: boolean };
type SharedPost = { id?: string; url?: string; authorName?: string };
type CampaignShareContext = { redditUsername?: unknown; subredditName?: string | null };
type CampaignSharePreview = {
    username: string;
    subredditName: string;
    seriesId: string;
    seriesName: string;
    title: string;
    medalDistribution: { author: number; gold: number; silver: number; bronze: number };
    stageCount: number;
    medalSummary: string;
    totalTimeMs?: number | null;
    trackKey?: string;
    ground?: string;
    grounds?: string[];
    place: { rank: number; total: number } | null;
    expiresAt: string;
};
const SHARE_PREVIEW_TTL_SECONDS = 10 * 60;
const previewKey = (token: string) => `campaign:share-preview:${token}`;
const resultKey = (seriesId: string, subredditName: string, playerId: string) => (
    `campaign:${seriesId}:shared-result:${redisKeyPart(subredditName)}:${playerFieldHash(playerId)}`
);

function failure(status: number, reason: string, error: string) {
    return { status, body: { status: reason, error } };
}

// Artwork metadata comes only from the manifest; a poster never reads viewer progress or standings.
export async function getServerCampaignPoster({ seriesId }: { seriesId?: unknown } = {}) {
    const series = getCampaignSeries(seriesId);
    const finalStage = series ? getCampaignFinalStage(series.id) : null;
    if (!series || !finalStage) return failure(404, 'campaign_unavailable', 'This Campaign is unavailable.');
    return {
        status: 200,
        body: { seriesId: series.id, trackKey: finalStage.trackKey, ground: series.ground, grounds: [...series.grounds] },
    };
}

const unconfirmed = () => failure(409, 'share_unconfirmed', 'Reddit has not confirmed this post yet. Check your profile before trying again.');

function campaignShareCopy(
    title: string,
    medalDistribution: CampaignSharePreview['medalDistribution'],
    place: CampaignSharePreview['place'],
    totalTimeMs: CampaignSharePreview['totalTimeMs'] = null,
) {
    const medalSummary = Object.entries(medalDistribution).map(([tier, count]) => `${count} ${tier}`).join(' · ');
    const placeSummary = place ? `Overall place ${formatCampaignPlace(place)}` : '';
    const time = formatCampaignTotalTime(totalTimeMs);
    const timeSummary = time ? `Total best time ${time}` : '';
    const details = [medalSummary, timeSummary, placeSummary].filter(Boolean).join('\n');
    return {
        medalSummary,
        placeSummary,
        timeSummary,
        text: `${title}.\n\n${details}\n\nOpen this post on Reddit and select Play Campaign to race this Campaign.`,
    };
}

async function readCampaignSharePlace(seriesId: string, playerId: string): Promise<CampaignSharePreview['place']> {
    const finalStage = getCampaignFinalStage(seriesId);
    if (!finalStage) return null;
    const keys = campaignAggregateKeys(seriesId);
    try {
        if (await redis.get(keys.fillReady) !== finalStage.raceId) return null;
        const [rankZero, total] = await Promise.all([
            redis.zRank(keys.leaderboard, playerId),
            redis.zCard(keys.leaderboard),
        ]);
        return readCampaignPlace({
            rank: Number.isFinite(rankZero) ? Number(rankZero) + 1 : null,
            total: Number(total),
        });
    } catch (error) {
        console.error('Campaign share place could not be read:', error);
        return null;
    }
}

async function markRefreshPending(key: string): Promise<void> {
    try {
        const current = await readRecord(key);
        if (!current?.postId || current.refreshPending) return;
        await redis.set(key, JSON.stringify({ ...current, refreshPending: true }));
    } catch (error) {
        console.error('A Campaign post refresh could not be marked for retry:', error);
    }
}

async function clearRefreshPending(key: string, record: ShareRecord): Promise<void> {
    if (!record.refreshPending) return;
    const { refreshPending: _pending, ...rest } = record;
    await redis.set(key, JSON.stringify(rest));
}
const unavailable = () => failure(409, 'user_action_unavailable', 'Reddit user-attributed posting is not available for this app version.');

function shared(record: ShareRecord, alreadyShared: boolean) {
    return { status: 200, body: { status: alreadyShared ? 'already_shared' : 'shared', postId: record.postId, postUrl: record.postUrl } };
}

function postIdentity(post: SharedPost, username: string): { postId: string; postUrl: string } | null {
    return normalizeName(post.authorName ?? '') === normalizeName(username)
        && typeof post.id === 'string' && post.id.startsWith('t3_')
        && typeof post.url === 'string' && Boolean(post.url)
        ? { postId: post.id, postUrl: post.url }
        : null;
}

async function readRecord(key: string): Promise<ShareRecord | null> {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as ShareRecord;
        if (typeof parsed?.createdAt === 'string') return parsed;
    } catch { /* An unreadable existing claim must never permit a second post. */ }
    return { createdAt: new Date(0).toISOString() };
}

async function savePublication(key: string, claim: ShareRecord, post: { postId: string; postUrl: string }) {
    const saved = { ...claim, ...post };
    await redis.set(key, JSON.stringify(saved)).catch((error: unknown) => {
        // The pre-submit claim remains, so a later request recovers the live post.
        console.error('A shared Campaign post could not be recorded:', error);
    });
    return saved;
}

async function clearClaim(key: string, lock: RedisLock): Promise<void> {
    const transaction = await beginOwnedRedisLockTransaction(lock, redis);
    if (!transaction) return;
    await transaction.del(key);
    await commitOwnedRedisLockTransaction(transaction);
}

// A pending claim is permanent, because an unclear Reddit reply may have posted; retry searches, never reposts.
async function recoverPublication(claim: ShareRecord, subredditName: string, username: string, seriesId: string) {
    try {
        const posts = await reddit.getPostsByUser({ username, sort: 'new', limit: 100, pageSize: 100 }).all();
        const since = Math.floor(Date.parse(claim.createdAt) / 1000) * 1000;
        for (const post of posts) {
            if (post.removed || normalizeName(post.subredditName) !== normalizeName(subredditName)
                || post.createdAt.getTime() < since) continue;
            const identity = postIdentity(post, username);
            if (!identity) continue;
            try {
                const data = await post.getPostData();
                if (data?.postType === 'campaign-finished' && data.seriesId === seriesId) return identity;
            } catch { /* Other user posts do not belong to this app. */ }
        }
    } catch (error) {
        console.error('A shared Campaign post could not be confirmed:', error);
    }
    return null;
}

async function authorizedRequest({ redditUsername, subredditName }: CampaignShareContext) {
    const username = sanitizeRedditUsername(redditUsername);
    if (!username) return failure(401, 'sign_in_required', 'Sign in to Reddit to share your Campaign results.');
    if (!subredditName) return failure(400, 'community_required', 'Open Mini Racer in its Reddit community to share.');
    const { canonicalPlayerId } = await resolveAuthorizedPlayerIdentity({ redditUsername: username });
    if (!canonicalPlayerId?.startsWith('reddit:')) return failure(401, 'sign_in_required', 'Sign in to Reddit to share your Campaign results.');
    return { username, subredditName, canonicalPlayerId };
}

export async function markServerCampaignResultsSharePending({
    raceId,
    redditUsername,
    subredditName,
}: CampaignShareContext & { raceId?: unknown } = {}): Promise<void> {
    const request = await authorizedRequest({ redditUsername, subredditName });
    if ('status' in request) return;
    const stage = getCampaignStage(raceId);
    if (!stage) return;
    await markRefreshPending(resultKey(stage.seriesId, request.subredditName, request.canonicalPlayerId));
}

// Read saved results after taking the lock, not an older snapshot from a concurrent submission.
export async function refreshServerCampaignResultsShare({
    raceId,
    seriesId,
    redditUsername,
    subredditName,
    onlyIfPending,
}: CampaignShareContext & { raceId?: unknown; seriesId?: unknown; onlyIfPending?: boolean } = {}): Promise<void> {
    const request = await authorizedRequest({ redditUsername, subredditName });
    if ('status' in request) return;
    const stage = getCampaignStage(raceId);
    const series = getCampaignSeries(seriesId) ?? (stage ? getCampaignSeries(stage.seriesId) : null);
    if (!series) return;
    const { username, canonicalPlayerId } = request;
    const key = resultKey(series.id, request.subredditName, canonicalPlayerId);
    const stored = await readRecord(key);
    if (!stored?.postId || (onlyIfPending && stored.refreshPending !== true)) return;
    let lock: RedisLock | null = null;
    for (let attempt = 0; attempt < 30 && !lock; attempt++) {
        lock = await acquireRedisLock(`${key}:lock`, 30_000, redis);
        if (!lock) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!lock) throw new Error('Campaign post refresh is busy.');
    try {
        const current = await readRecord(key);
        if (!current?.postId || (onlyIfPending && current.refreshPending !== true)) return;
        if (await isProgressTransferPending(canonicalPlayerId)) return;
        const post = await reddit.getPostById(current.postId as `t3_${string}`);
        const data = await post.getPostData();
        const owned = normalizeName(post.authorName) === normalizeName(username)
            && normalizeName(post.subredditName) === normalizeName(request.subredditName)
            && data?.postType === 'campaign-finished' && data.seriesId === series.id;
        const screen = owned
            ? buildCampaignFinishedScreen(series.id, await getCampaignResultsForSeries(canonicalPlayerId, series.id))
            : null;
        if (!owned || !screen) {
            await clearRefreshPending(key, current);
            return;
        }
        const counts = data.medalDistribution as Record<string, unknown> | undefined;
        const medalsMatch = data.stageCount === screen.stageCount
            && Object.entries(screen.medalDistribution).every(([tier, count]) => counts?.[tier] === count);
        const totalTimeChanged = data.totalTimeMs !== screen.totalTimeMs;
        const trackKey = getCampaignFinalStage(series.id)?.trackKey;
        const grounds = [...series.grounds];
        const postedGrounds = data.grounds;
        const groundsMatch = Array.isArray(postedGrounds) && postedGrounds.length === grounds.length
            && grounds.every((ground) => postedGrounds.includes(ground));
        const artChanged = data.trackKey !== trackKey || data.ground !== series.ground || !groundsMatch;
        const livePlace = await readCampaignSharePlace(series.id, canonicalPlayerId);
        const postedPlace = readCampaignPlace(data.place);
        const placeChanged = livePlace !== null
            && (postedPlace?.rank !== livePlace.rank || postedPlace?.total !== livePlace.total);
        if (medalsMatch && !totalTimeChanged && !artChanged && !placeChanged && current.refreshPending !== true) return;
        if (!await isRedisLockOwned(lock, redis)) throw new Error('Campaign post refresh lost its lock.');
        const copy = campaignShareCopy(
            `I finished the ${screen.title} campaign`,
            screen.medalDistribution,
            livePlace ?? postedPlace,
            screen.totalTimeMs,
        );
        const updates: {
            medalDistribution?: typeof screen.medalDistribution;
            stageCount?: number;
            totalTimeMs?: number | null;
            trackKey?: string;
            ground?: string;
            grounds?: string[];
            place?: NonNullable<CampaignSharePreview['place']>;
        } = {};
        if (!medalsMatch) {
            updates.medalDistribution = screen.medalDistribution;
            updates.stageCount = screen.stageCount;
        }
        if (totalTimeChanged) updates.totalTimeMs = screen.totalTimeMs;
        if (artChanged) {
            updates.trackKey = trackKey;
            updates.ground = series.ground;
            updates.grounds = grounds;
        }
        if (placeChanged && livePlace) updates.place = livePlace;
        if (Object.keys(updates).length > 0) await post.mergePostData(updates);
        await post.setTextFallback({ text: copy.text });
        await clearRefreshPending(key, current);
    } catch (error) {
        await markRefreshPending(key);
        throw error;
    } finally {
        await releaseRedisLock(lock, redis);
    }
}

export async function previewServerCampaignResultsShare({
    seriesId,
    redditUsername,
    subredditName,
}: CampaignShareContext & { seriesId?: unknown } = {}) {
    const request = await authorizedRequest({ redditUsername, subredditName });
    if ('status' in request) return request;
    const { username, canonicalPlayerId } = request;
    const series = getCampaignSeries(seriesId);
    if (!series) return failure(404, 'campaign_unavailable', 'This Campaign is unavailable.');
    const stored = await readRecord(resultKey(series.id, request.subredditName, canonicalPlayerId));
    if (stored?.postId && stored.postUrl) return shared(stored, true);
    if (await isProgressTransferPending(canonicalPlayerId)) {
        return failure(409, 'progress_transfer_pending', 'Finish choosing your saved progress before sharing.');
    }
    const screen = buildCampaignFinishedScreen(series.id, await getCampaignResultsForSeries(canonicalPlayerId, series.id));
    if (!screen) return failure(409, 'campaign_incomplete', 'Finish this Campaign before sharing your results.');
    const title = `I finished the ${screen.title} campaign`;
    const place = await readCampaignSharePlace(series.id, canonicalPlayerId);
    const copy = campaignShareCopy(title, screen.medalDistribution, place, screen.totalTimeMs);
    const preview: CampaignSharePreview = {
        username,
        subredditName: request.subredditName,
        seriesId: series.id,
        seriesName: screen.title,
        title,
        medalDistribution: screen.medalDistribution,
        stageCount: screen.stageCount,
        totalTimeMs: screen.totalTimeMs,
        trackKey: getCampaignFinalStage(series.id)?.trackKey,
        ground: series.ground,
        grounds: [...series.grounds],
        medalSummary: copy.medalSummary,
        place,
        expiresAt: new Date(Date.now() + SHARE_PREVIEW_TTL_SECONDS * 1000).toISOString(),
    };
    const shareToken = randomUUID();
    await redis.set(previewKey(shareToken), JSON.stringify(preview), { expiration: new Date(preview.expiresAt) });
    return {
        status: 200,
        body: {
            status: 'ready', shareToken, title: preview.title, username,
            medalDistribution: preview.medalDistribution, stageCount: preview.stageCount,
            medalSummary: preview.medalSummary,
            totalTimeMs: preview.totalTimeMs,
            timeSummary: copy.timeSummary,
            trackKey: preview.trackKey,
            ground: preview.ground,
            grounds: preview.grounds,
            ...(place ? { place, placeSummary: copy.placeSummary } : {}),
            expiresAt: preview.expiresAt,
        },
    };
}

async function readPreview(token: unknown): Promise<CampaignSharePreview | null> {
    if (typeof token !== 'string' || !token) return null;
    const raw = await redis.get(previewKey(token));
    if (!raw) return null;
    try {
        const preview = JSON.parse(raw) as CampaignSharePreview;
        if (typeof preview?.username !== 'string' || typeof preview.subredditName !== 'string'
            || typeof preview.seriesId !== 'string' || typeof preview.seriesName !== 'string'
            || typeof preview.title !== 'string' || typeof preview.medalSummary !== 'string'
            || (preview.totalTimeMs != null && (!Number.isSafeInteger(preview.totalTimeMs) || preview.totalTimeMs <= 0))
            || (preview.trackKey != null && (typeof preview.trackKey !== 'string' || !preview.trackKey))
            || (preview.ground != null && (typeof preview.ground !== 'string' || !preview.ground))
            || (preview.grounds != null && (!Array.isArray(preview.grounds) || !preview.grounds.every(isTrackGroundKey)))
            || (preview.place != null && !readCampaignPlace(preview.place))
            || !Number.isInteger(preview.stageCount) || preview.stageCount <= 0
            || !preview.medalDistribution
            || !['author', 'gold', 'silver', 'bronze'].every((tier) => {
                const count = preview.medalDistribution[tier as keyof typeof preview.medalDistribution];
                return Number.isInteger(count) && count >= 0;
            })
            || !(Date.parse(preview.expiresAt) > Date.now())) return null;
        preview.place = readCampaignPlace(preview.place);
        return preview;
    } catch { return null; }
}

export async function confirmServerCampaignResultsShare({
    shareToken,
    redditUsername,
    subredditName,
}: CampaignShareContext & { shareToken?: unknown } = {}) {
    const request = await authorizedRequest({ redditUsername, subredditName });
    if ('status' in request) return request;
    const preview = await readPreview(shareToken);
    if (!preview) return failure(409, 'preview_expired', 'This share preview expired. Close it and share again.');
    if (normalizeName(preview.username) !== normalizeName(request.username)
        || normalizeName(preview.subredditName) !== normalizeName(request.subredditName)) {
        return failure(403, 'share_forbidden', 'This share preview belongs to another Reddit account or community.');
    }
    const { username, canonicalPlayerId } = request;
    const series = getCampaignSeries(preview.seriesId);
    if (!series) return failure(404, 'campaign_unavailable', 'This Campaign is unavailable.');
    const key = resultKey(series.id, request.subredditName, canonicalPlayerId);
    let stored = await readRecord(key);
    if (stored?.postId && stored.postUrl) return shared(stored, true);
    const lock = await acquireRedisLock(`${key}:lock`, 30_000, redis);
    if (!lock) return failure(409, 'share_in_progress', 'Your Campaign results are being shared. Try again in a moment.');

    try {
        stored = await readRecord(key);
        if (stored?.postId && stored.postUrl) return shared(stored, true);
        if (stored) {
            const recovered = await recoverPublication(stored, request.subredditName, username, series.id);
            return recovered ? shared(await savePublication(key, stored, recovered), true) : unconfirmed();
        }
        if (await isProgressTransferPending(canonicalPlayerId)) {
            return failure(409, 'progress_transfer_pending', 'Finish choosing your saved progress before sharing.');
        }
        const screen = buildCampaignFinishedScreen(series.id, await getCampaignResultsForSeries(canonicalPlayerId, series.id));
        if (!screen) return failure(409, 'campaign_incomplete', 'Finish this Campaign before sharing your results.');
        if (screen.title !== preview.seriesName || screen.stageCount !== preview.stageCount) {
            return failure(409, 'preview_expired', 'This Campaign changed. Close this preview and share again.');
        }
        const playerAvatarUrl = await resolveRedditAvatarUrl(username);
        const title = preview.title;
        const postData = {
            postType: 'campaign-finished',
            launchMode: 'campaign',
            seriesId: series.id,
            seriesName: preview.seriesName,
            playerUsername: username,
            playerAvatarUrl,
            medalDistribution: preview.medalDistribution,
            stageCount: preview.stageCount,
            totalTimeMs: preview.totalTimeMs ?? null,
            trackKey: preview.trackKey ?? getCampaignFinalStage(series.id)?.trackKey,
            ground: preview.ground ?? series.ground,
            grounds: preview.grounds ?? [...series.grounds],
            ...(preview.place ? { place: preview.place } : {}),
        };
        const claim: ShareRecord = { createdAt: new Date().toISOString() };
        if (!await isRedisLockOwned(lock, redis)
            || !await redis.set(key, JSON.stringify(claim), { nx: true })) return unconfirmed();

        let post;
        try {
            post = await reddit.submitCustomPost({
                subredditName: request.subredditName,
                title,
                entry: 'campaign',
                postData,
                textFallback: { text: campaignShareCopy(title, preview.medalDistribution, preview.place, preview.totalTimeMs).text },
                runAs: 'USER',
                userGeneratedContent: { text: title },
            });
        } catch (error) {
            if (isUserActionRefusedBeforePosting(error)) {
                await clearClaim(key, lock);
                return unavailable();
            }
            const recovered = await recoverPublication(claim, request.subredditName, username, series.id);
            return recovered ? shared(await savePublication(key, claim, recovered), false) : unconfirmed();
        }
        const identity = postIdentity(post, username);
        if (identity) return shared(await savePublication(key, claim, identity), false);
        if (post.authorName?.trim() && normalizeName(post.authorName) !== normalizeName(username)) {
            try {
                await post.delete();
                await clearClaim(key, lock);
            } catch (error) {
                console.error('A Campaign post made under another name could not be removed:', error);
            }
            return unavailable();
        }
        const recovered = await recoverPublication(claim, request.subredditName, username, series.id);
        return recovered ? shared(await savePublication(key, claim, recovered), false) : unconfirmed();
    } finally {
        await releaseRedisLock(lock, redis).catch((error: unknown) => {
            console.error('Campaign share lock cleanup failed:', error);
        });
    }
}
