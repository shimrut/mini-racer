import { createHash, randomUUID } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import {
    recordAnalyticsChallengeCreateBestEffort,
    recordAnalyticsRaceBestEffort,
} from './analytics-store.js';
import { getTrackName } from '../../game/track/catalog.js';
import {
    CAMPAIGN_ID,
    HEAD_TO_HEAD_POST_TYPE,
    getHeadToHeadOrigin,
    isHeadToHeadMedal,
    toHeadToHeadPostData,
    type HeadToHeadMedal,
    type HeadToHeadOrigin,
    type HeadToHeadPostData,
    type HeadToHeadRecord,
    type HeadToHeadSource,
} from './head-to-head-model.js';
import {
    acquireHeadToHeadCreationLock,
    deleteHeadToHeadPostIdentity,
    readHeadToHeadPostIdentity,
    readHeadToHeadPostIdentityByChallengeId,
    releaseHeadToHeadCreationLock,
    releaseHeadToHeadPostSlot,
    reserveHeadToHeadPostSlot,
    writeHeadToHeadAccept,
    writeHeadToHeadPostIdentity,
    writeHeadToHeadPostIdentityByChallengeId,
} from './head-to-head-store.js';
import { resolveHeadToHeadRecord, resolveHeadToHeadRecordResult } from './head-to-head-post.js';
import {
    catalogCardFromRecord,
    pickNextHeadToHeadChallenge,
    readHeadToHeadCatalogCard,
    upsertHeadToHeadCatalogCardBestEffort,
} from './head-to-head-catalog.js';
import { resolveMiniRacerPostFlairId } from './post-flair-service.js';
import {
    encodeHeadToHeadReplay,
    formatHeadToHeadTextFallback as formatReplayTextFallback,
} from './head-to-head-replay.js';
import {
    getCarUnlockSnapshot,
    recordCompletedRace,
    recordHeadToHeadPost,
    recordHeadToHeadWin,
} from './car-unlock-store.js';
import { getCampaignResultsForCarUnlocks } from './campaign-store.js';
import { releaseRedisLock } from './redis-lock.js';
import {
    isRedditAvatarUrl,
    resolveRedditAvatarUrl,
} from './daily-podium-service.js';
import { resolveAuthorizedPlayerIdentity } from './competition-identity.js';
import { isProgressTransferPending } from './guest-retirement.js';
import type { JudgedCompetitionContract } from './competition-submit.js';
import type { ReplayValidationResult } from './replay-validator.js';

const PREVIEW_TTL_SECONDS = 10 * 60;
export const HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60;
export const HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 12;

export type HeadToHeadRequestContext = {
    username?: string | null;
    userId?: string | null;
    subredditName?: string | null;
    appSlug?: string | null;
    postId?: string | null;
    postData?: Record<string, unknown> | null;
    playerId?: string | null;
    guestToken?: string | null;
    requestRateLimitIdentity?: string | null;
};

export type HeadToHeadServiceResult = {
    status: number;
    body: Record<string, unknown>;
};

export type HeadToHeadReplayResult = {
    ok: true;
    bestTimeMs: number;
    medal: HeadToHeadMedal;
    ghost: unknown;
    run: ReplayValidationResult;
    judgedContract: JudgedCompetitionContract;
} | {
    ok: false;
    reason?: string;
};

export type HeadToHeadBestContext = {
    /** Forwarded to the mode's own submit exactly as the request carried it, so identity resolves the same way twice. */
    playerId?: string | null;
    username?: string | null;
    guestToken?: string | null;
    requestRateLimitIdentity?: string | null;
    /** Already resolved by the challenge submit; used only to read back the rank. */
    canonicalPlayerId?: string | null;
    verifiedRun?: ReplayValidationResult;
    judgedContract?: JudgedCompetitionContract;
};

export type HeadToHeadViewerBest = {
    bestTimeMs: number | null;
    medal: HeadToHeadMedal | null;
    rank: number | null;
    trackLocked: boolean;
};

export type HeadToHeadBestUpdate = {
    mode: 'campaign' | 'daily';
    improved: boolean;
    bestTimeMs: number;
    medal: HeadToHeadMedal;
    rank: number | null;
};

function bodyWithBestUpdate(
    body: Record<string, unknown>,
    bestUpdate: HeadToHeadBestUpdate | null,
): Record<string, unknown> {
    return bestUpdate ? { ...body, bestUpdate } : body;
}

export type HeadToHeadServiceDependencies = {
    resolveSource(input: Record<string, unknown>): Promise<HeadToHeadSource | null>;
    validateReplay(
        challenge: HeadToHeadRecord,
        replay: unknown,
    ): Promise<HeadToHeadReplayResult> | HeadToHeadReplayResult;
    /**
     * Sends a verified run to the mode it was minted from, so it earns the board entry, the
     * personal best and the progress a normal run earns. Returns null when the mode refuses it.
     */
    recordBest?(
        challenge: HeadToHeadRecord,
        replay: unknown,
        context: HeadToHeadBestContext,
    ): Promise<HeadToHeadBestUpdate | null> | HeadToHeadBestUpdate | null;
    /**
     * What the viewer already holds on the stage or Daily behind the challenge, so the finish can
     * tell an improvement from a run not worth sending.
     */
    readViewerBest?(
        challenge: HeadToHeadRecord,
        playerId: string | null,
    ): Promise<HeadToHeadViewerBest | null> | HeadToHeadViewerBest | null;
    now?: () => Date;
    createId?: () => string;
};

type PreviewRecord = {
    username: string;
    userId?: string;
    subredditName: string;
    source: HeadToHeadSource;
    challengeId: string;
    title: string;
    createdAt: string;
};

type PreviewTokenRecord = Omit<PreviewRecord, 'source'> & {
    sourceInput: Record<string, unknown>;
    sourceContract: {
        sourceKind: HeadToHeadSource['sourceKind'];
        sourceId: string;
        originMode: HeadToHeadOrigin['mode'];
        originId: string;
        campaignId?: typeof CAMPAIGN_ID;
        raceId?: string;
        trackKey: string;
        lapCount: 1 | 2 | 3;
        bestTimeMs: number;
        medal: HeadToHeadMedal;
        rulesRevision: number;
        trackFingerprint: string;
        ghostHash: string;
    };
    expiresAt: string;
};

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function playerIdForUsername(username: string): string {
    return `reddit:${normalizeName(username)}`;
}

type ChallengeViewer = {
    playerId: string | null;
    username: string | null;
    displayName: string;
    signedIn: boolean;
    progressSelectionPending: boolean;
    /**
     * True while this identity has an open guest transfer, guest or account alike.
     * `progressSelectionPending` only ever sees the guest side: `resolveGuestIdentityStatus`
     * answers `active` for a signed-in account, so without this a pending account could post a
     * challenge and score runs against data a transfer was midway through replacing.
     */
    transferPending: boolean;
};

async function resolveChallengeViewer(context: HeadToHeadRequestContext): Promise<ChallengeViewer> {
    const username = typeof context.username === 'string' && context.username.trim()
        ? context.username.trim()
        : null;
    const identity = await resolveAuthorizedPlayerIdentity({
        playerId: context.playerId,
        guestToken: context.guestToken,
        redditUsername: username,
    });
    return {
        playerId: identity.canonicalPlayerId,
        username,
        displayName: username || (identity.canonicalPlayerId ? 'Guest racer' : 'You'),
        signedIn: Boolean(username),
        progressSelectionPending: identity.guestStatus === 'guest_promotion_pending',
        transferPending: identity.canonicalPlayerId
            ? await isProgressTransferPending(identity.canonicalPlayerId)
            : false,
    };
}

/**
 * The same answer a Daily or Campaign submission gets while a transfer is open, so a Head to Head
 * joins the retry path the browser already has instead of needing one of its own. See the pending
 * recheck in `competition-submit.ts`.
 */
function transferPendingResult(): HeadToHeadServiceResult {
    return {
        status: 503,
        body: {
            accepted: false,
            status: 'progress_transfer_pending',
            reason: 'progress_transfer_pending',
            error: 'A progress transfer is in progress. Retrying automatically.',
            retryAfterSeconds: 1,
        },
    };
}

function submissionRateLimitIdentity(
    viewer: ChallengeViewer,
    context: HeadToHeadRequestContext,
): string {
    const requestIdentity = typeof context.requestRateLimitIdentity === 'string'
        && context.requestRateLimitIdentity.trim()
        ? context.requestRateLimitIdentity.trim()
        : null;
    return viewer.signedIn || !requestIdentity
        ? viewer.playerId as string
        : `request:${requestIdentity}`;
}

async function checkHeadToHeadSubmissionRateLimit(
    identity: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    const key = `miniracer:head-to-head:submit-rate-limit:${encodeURIComponent(identity)}`;
    const attemptCount = await redis.incrBy(key, 1);
    if (attemptCount === 1) {
        await redis.expire(key, HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (attemptCount <= HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_MAX_REQUESTS) {
        return { allowed: true };
    }
    const expiresAt = await redis.expireTime(key);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, expiresAt - Math.floor(Date.now() / 1000)),
        };
    }
    // Repair a counter left without a TTL, or this identity stays rate-limited permanently.
    await redis.expire(key, HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS);
    return {
        allowed: false,
        retryAfterSeconds: HEAD_TO_HEAD_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    };
}

async function readChallengeCarUnlocks(playerId: string) {
    return getCarUnlockSnapshot(
        playerId,
        await getCampaignResultsForCarUnlocks(playerId),
    );
}

async function recordChallengePostUnlock(playerId: string, trackKey: string) {
    await recordHeadToHeadPost(playerId, trackKey);
    return readChallengeCarUnlocks(playerId);
}

function requestUserId(context: HeadToHeadRequestContext): string | undefined {
    const id = typeof context.userId === 'string' ? context.userId.trim() : '';
    return id.startsWith('t2_') ? id : undefined;
}

function signedContext(context: HeadToHeadRequestContext): {
    username: string;
    subredditName: string;
} | null {
    const username = typeof context.username === 'string' ? context.username.trim() : '';
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return username && subredditName ? { username, subredditName } : null;
}

function challengeContext(context: HeadToHeadRequestContext): {
    subredditName: string;
} | null {
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return subredditName ? { subredditName } : null;
}

async function resolveChallengeRecord(
    challengeId: string | null,
    context: HeadToHeadRequestContext,
): Promise<{ record: HeadToHeadRecord | null; reason?: string; diff?: Record<string, unknown> }> {
    const result = await resolveHeadToHeadRecordResult(challengeId, context);
    if (result.ok) return { record: result.record };
    const diff = !result.ok ? result.diff : undefined;
    if (result.reason !== 'challenge_id_missing' && result.reason !== 'post_id_missing') {
        console.warn('Head to Head resolution failed.', {
            challengeId: challengeId || null,
            postId: context.postId || null,
            reason: result.reason,
            ...('detail' in result && result.detail ? { detail: result.detail } : {}),
        });
    }
    if (context.postId || !challengeId) return { record: null, reason: result.reason, diff };
    const identity = await readHeadToHeadPostIdentityByChallengeId(challengeId);
    if (!identity) return { record: null, reason: result.reason, diff };
    const fallback = await resolveHeadToHeadRecord(challengeId, {
        ...context,
        postId: identity.postId,
    });
    return fallback ? { record: fallback } : { record: null, reason: result.reason, diff };
}

function isValidSource(source: HeadToHeadSource | null): source is HeadToHeadSource {
    const origin = source ? getHeadToHeadOrigin(source) : null;
    return Boolean(
        source
        && (source.sourceKind === 'campaign' || source.sourceKind === 'daily')
        && typeof source.sourceId === 'string'
        && source.sourceId
        && origin
        && (source.sourceKind === 'campaign' ? origin.mode === 'campaign' : true)
        && (source.sourceKind === 'daily' ? origin.mode === 'daily' : true)
        && typeof source.trackKey === 'string'
        && source.trackKey
        && (source.lapCount === 1 || source.lapCount === 2 || source.lapCount === 3)
        && Number.isInteger(source.bestTimeMs)
        && source.bestTimeMs > 0
        && isHeadToHeadMedal(source.medal)
        && Number.isInteger(source.rulesRevision)
        && source.rulesRevision >= 0
        && typeof source.trackFingerprint === 'string'
        && source.trackFingerprint
        && source.ghost != null
    );
}

function sourceRaceId(source: {
    origin?: HeadToHeadOrigin;
    raceId?: string;
    sourceId: string;
}): string {
    const origin = getHeadToHeadOrigin(source);
    return source.raceId
        || (origin?.mode === 'daily' ? origin.challengeId : origin?.raceId)
        || source.sourceId;
}

function originContract(source: HeadToHeadSource): {
    originMode: HeadToHeadOrigin['mode'];
    originId: string;
} | null {
    const origin = getHeadToHeadOrigin(source);
    if (!origin) return null;
    return origin.mode === 'campaign'
        ? { originMode: origin.mode, originId: origin.raceId }
        : { originMode: origin.mode, originId: origin.challengeId };
}

export function formatHeadToHeadTime(timeMs: number): string {
    const seconds = Math.floor(timeMs / 1000);
    const milliseconds = timeMs % 1000;
    return `${seconds}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatHeadToHeadTitle(
    timeMs: number,
    trackKey: string,
): string {
    return `Can you beat ${formatHeadToHeadTime(timeMs)}s on ${getTrackName(trackKey, trackKey)}?`;
}

export function formatHeadToHeadTextFallback(
    postData: HeadToHeadPostData,
    ghost: unknown,
): string {
    return formatReplayTextFallback(postData, ghost);
}

function normalizeAvatarUrl(value: unknown): string | null {
    return isRedditAvatarUrl(value) ? value : null;
}

function jsonHash(value: unknown): string {
    const json = JSON.stringify(value);
    if (!json) return '';
    return createHash('sha256').update(json, 'utf8').digest('hex');
}

function sourceContract(source: HeadToHeadSource): PreviewTokenRecord['sourceContract'] {
    const origin = originContract(source);
    if (!origin) throw new Error('Challenge source has no immutable origin.');
    return {
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        ...origin,
        ...(source.campaignId ? { campaignId: source.campaignId } : {}),
        ...(source.raceId ? { raceId: source.raceId } : {}),
        trackKey: source.trackKey,
        lapCount: source.lapCount,
        bestTimeMs: source.bestTimeMs,
        medal: source.medal,
        rulesRevision: source.rulesRevision,
        trackFingerprint: source.trackFingerprint,
        ghostHash: jsonHash(source.ghost),
    };
}

function sameSourceContract(
    source: HeadToHeadSource,
    expected: PreviewTokenRecord['sourceContract'],
): boolean {
    const actual = sourceContract(source);
    return Object.entries(expected).every(([key, value]) => (
        actual[key as keyof typeof actual] === value
    ));
}

function previewKey(token: string): string {
    return `miniracer:head-to-head:preview:${token}`;
}

function parsePreview(raw: string | null): PreviewTokenRecord | null {
    if (!raw || raw.length > 16_000) return null;
    try {
        const value = JSON.parse(raw) as PreviewTokenRecord;
        if (
            !value
            || typeof value.username !== 'string'
            || typeof value.subredditName !== 'string'
            || typeof value.challengeId !== 'string'
            || typeof value.title !== 'string'
            || typeof value.createdAt !== 'string'
            || !isRecord(value.sourceInput)
            || !value.sourceContract
            || !(
                (value.sourceContract.originMode === 'campaign'
                    || value.sourceContract.originMode === 'daily')
                && typeof value.sourceContract.originId === 'string'
            )
            || !(value.sourceContract.sourceKind === 'campaign'
                || value.sourceContract.sourceKind === 'daily')
            || typeof value.sourceContract.sourceId !== 'string'
            || typeof value.sourceContract.trackKey !== 'string'
            || (value.sourceContract.lapCount !== 1
                && value.sourceContract.lapCount !== 2
                && value.sourceContract.lapCount !== 3)
            || !Number.isSafeInteger(value.sourceContract.bestTimeMs)
            || value.sourceContract.bestTimeMs <= 0
            || !isHeadToHeadMedal(value.sourceContract.medal)
            || !Number.isSafeInteger(value.sourceContract.rulesRevision)
            || value.sourceContract.rulesRevision < 0
            || typeof value.sourceContract.trackFingerprint !== 'string'
            || !value.sourceContract.trackFingerprint
            || !/^[a-f0-9]{64}$/.test(value.sourceContract.ghostHash)
            || typeof value.expiresAt !== 'string'
            || !Number.isFinite(Date.parse(value.expiresAt))
        ) {
            return null;
        }
        return value;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildRecord(
    preview: PreviewRecord,
    challengerAvatarUrl: string | null = null,
): HeadToHeadRecord {
    const origin = getHeadToHeadOrigin(preview.source);
    if (!origin) throw new Error('Challenge source has no immutable origin.');
    return {
        postType: HEAD_TO_HEAD_POST_TYPE,
        challengeId: preview.challengeId,
        origin,
        ...(origin.mode === 'campaign'
            ? { campaignId: origin.campaignId, raceId: origin.raceId }
            : {}),
        challengerUsername: preview.username,
        ...(preview.userId ? { challengerUserId: preview.userId } : {}),
        challengerAvatarUrl: normalizeAvatarUrl(challengerAvatarUrl),
        trackKey: preview.source.trackKey,
        lapCount: preview.source.lapCount,
        targetTimeMs: preview.source.bestTimeMs,
        medal: preview.source.medal,
        rulesRevision: preview.source.rulesRevision,
        trackFingerprint: preview.source.trackFingerprint,
        createdAt: preview.createdAt,
        subredditName: preview.subredditName,
        sourceKind: preview.source.sourceKind,
        sourceId: preview.source.sourceId,
        frozenGhost: preview.source.ghost,
        postId: null,
        postUrl: null,
    };
}

function buildPublicPostData(record: HeadToHeadRecord): HeadToHeadPostData {
    const postData = toHeadToHeadPostData(record);
    const replay = encodeHeadToHeadReplay(postData, record.frozenGhost);
    return { ...postData, replayDataHash: replay.hash };
}

async function resolveChallengeAvatars(
    challengerUsername: string,
    viewerUsername: string | null,
    storedChallengerAvatarUrl: unknown = null,
): Promise<{ challengerAvatarUrl: string | null; viewerAvatarUrl: string | null }> {
    const stored = normalizeAvatarUrl(storedChallengerAvatarUrl);
    const [challengerAvatarUrl, viewerAvatarUrl] = await Promise.all([
        stored ? Promise.resolve(stored) : resolveRedditAvatarUrl(challengerUsername),
        viewerUsername ? resolveRedditAvatarUrl(viewerUsername) : Promise.resolve(null),
    ]);
    return { challengerAvatarUrl, viewerAvatarUrl };
}

async function activePost(identity: {
    challengeId: string;
    postId: `t3_${string}`;
    postUrl: string;
} | null, challengerUsername: string): Promise<typeof identity> {
    if (!identity) return null;
    try {
        const post = await reddit.getPostById(identity.postId);
        return (post as any)?.removed
            || normalizeName((post as any)?.authorName || '') !== normalizeName(challengerUsername)
            ? null
            : identity;
    } catch {
        return null;
    }
}

async function recoverPost(
    preview: PreviewRecord,
): Promise<{ postId: `t3_${string}`; postUrl: string } | null> {
    const listing = await (reddit as any).getPostsByUser({
        username: preview.username,
        sort: 'new',
        timeframe: 'month',
        limit: 100,
        pageSize: 100,
    });
    const posts = typeof listing?.all === 'function' ? await listing.all() : [];
    // Reddit dates the post to the second, so the preview's own second still counts as newer.
    const previewMs = Date.parse(preview.createdAt);
    const cutoffMs = Number.isFinite(previewMs) ? Math.floor(previewMs / 1000) * 1000 : NaN;
    for (const post of posts) {
        if (normalizeName(post?.subredditName || '') !== normalizeName(preview.subredditName)) continue;
        // Only a post made from this preview can carry its challenge id, so nothing older than the
        // preview can match. The listing already carries the date; reading the post data does not.
        const createdMs = new Date(post?.createdAt ?? NaN).getTime();
        if (Number.isFinite(cutoffMs) && Number.isFinite(createdMs) && createdMs < cutoffMs) continue;
        try {
            const data = await post.getPostData();
            if (
                data?.postType === HEAD_TO_HEAD_POST_TYPE
                && data?.challengeId === preview.challengeId
                && normalizeName(post?.authorName || '') === normalizeName(preview.username)
                && typeof post.id === 'string'
                && post.id.startsWith('t3_')
                && typeof post.url === 'string'
                && !(post as any)?.removed
            ) {
                return { postId: post.id as `t3_${string}`, postUrl: post.url };
            }
        } catch {
        }
    }
    return null;
}

async function savePost(
    record: HeadToHeadRecord,
    post: { postId: `t3_${string}`; postUrl: string },
): Promise<HeadToHeadRecord> {
    const saved = { ...record, ...post };
    await upsertHeadToHeadCatalogCardBestEffort(catalogCardFromRecord(saved, post));
    await writeHeadToHeadPostIdentityByChallengeId({
        challengeId: record.challengeId,
        ...post,
    });
    await writeHeadToHeadPostIdentity(
        record.subredditName,
        record.challengerUsername,
        sourceRaceId(record),
        record.targetTimeMs,
        { challengeId: record.challengeId, ...post },
    );
    return saved;
}

export function createHeadToHeadService(
    dependencies: HeadToHeadServiceDependencies,
) {
    const now = dependencies.now ?? (() => new Date());
    const createId = dependencies.createId ?? randomUUID;

    async function preview(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to challenge other players.' } };
        }
        const source = await dependencies.resolveSource(input);
        if (!isValidSource(source)) {
            return { status: 404, body: { status: 'result_unavailable', error: 'No verified result is available for this challenge.' } };
        }
        const challengeId = createId();
        const createdAt = now().toISOString();
        const title = formatHeadToHeadTitle(source.bestTimeMs, source.trackKey);
        const challengerAvatarUrl = await resolveRedditAvatarUrl(request.username);
        const userId = requestUserId(context);
        const record: PreviewRecord = {
            username: request.username,
            ...(userId ? { userId } : {}),
            subredditName: request.subredditName,
            source,
            challengeId,
            title,
            createdAt,
        };
        const {
            ghost: _ignoredGhost,
            replay: _ignoredReplay,
            ...sourceInput
        } = input;
        const previewToken = createId();
        const expiresAt = new Date(now().getTime() + PREVIEW_TTL_SECONDS * 1000);
        const previewRecord = {
            username: request.username,
            ...(record.userId ? { userId: record.userId } : {}),
            subredditName: request.subredditName,
            challengeId,
            title,
            createdAt,
            sourceInput,
            sourceContract: sourceContract(source),
            expiresAt: expiresAt.toISOString(),
        } satisfies PreviewTokenRecord;
        await redis.set(previewKey(previewToken), JSON.stringify(previewRecord), { expiration: expiresAt });
        return {
            status: 200,
            body: {
                status: 'ready',
                challengeToken: previewToken,
                username: request.username,
                title,
                preview: buildPublicPostData(buildRecord(record, challengerAvatarUrl)),
                expiresAt: expiresAt.toISOString(),
            },
        };
    }

    async function create(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return {
                status: 401,
                body: {
                    status: 'signed_in_required',
                    error: 'Sign in to Reddit to create a Head to Head.',
                },
            };
        }
        // Before the preview is spent and before any post exists. Creating a challenge posts to
        // the subreddit and awards a Garage unlock, and neither can be taken back if the transfer
        // this account is waiting on then replaces the result the challenge was built from.
        if (await isProgressTransferPending(playerIdForUsername(request.username))) {
            return transferPendingResult();
        }
        const token = typeof input.challengeToken === 'string' ? input.challengeToken : '';
        const prepared = parsePreview(token ? await redis.get(previewKey(token)) : null);
        if (!prepared) {
            return { status: 409, body: { status: 'preview_expired', error: 'This challenge preview expired. Try again.' } };
        }
        if (Date.parse(prepared.expiresAt) <= now().getTime()) {
            return { status: 409, body: { status: 'preview_expired', error: 'This challenge preview expired. Try again.' } };
        }
        if (
            normalizeName(prepared.username) !== normalizeName(request.username)
            || normalizeName(prepared.subredditName) !== normalizeName(request.subredditName)
        ) {
            return { status: 403, body: { status: 'challenge_forbidden', error: 'This preview belongs to another Reddit account or community.' } };
        }

        const source = await dependencies.resolveSource({ ...prepared.sourceInput, replay: input.replay });
        if (!isValidSource(source) || !sameSourceContract(source, prepared.sourceContract)) {
            return {
                status: 409,
                body: {
                    status: 'preview_changed',
                    error: 'The verified result changed while this challenge was being prepared. Try again.',
                },
            };
        }
        const preparedRecord: PreviewRecord = { ...prepared, source };
        const sourceId = sourceRaceId(source);
        const lock = await acquireHeadToHeadCreationLock(
            request.subredditName,
            request.username,
            sourceId,
            source.bestTimeMs,
        );
        if (!lock) {
            return { status: 409, body: { status: 'creation_in_progress', error: 'This challenge post is already being created.' } };
        }
        let reservedAt: Date | null = null;
        try {
            const identity = await readHeadToHeadPostIdentity(
                request.subredditName,
                request.username,
                sourceId,
                source.bestTimeMs,
            );
            const existing = await activePost(identity, request.username);
            if (existing) {
                await writeHeadToHeadPostIdentityByChallengeId(existing);
                await upsertHeadToHeadCatalogCardBestEffort(catalogCardFromRecord({
                    ...preparedRecord,
                    trackKey: source.trackKey,
                    lapCount: source.lapCount,
                    targetTimeMs: source.bestTimeMs,
                    medal: source.medal,
                    challengerUsername: preparedRecord.username,
                }, existing));
                const carUnlocks = await recordChallengePostUnlock(
                    playerIdForUsername(request.username),
                    source.trackKey,
                );
                await redis.del(previewKey(token));
                return {
                    status: 200,
                    body: {
                        status: 'already_created',
                        challengeId: existing.challengeId,
                        postUrl: existing.postUrl,
                        carUnlocks,
                    },
                };
            }
            if (identity) {
                await deleteHeadToHeadPostIdentity(
                    request.subredditName,
                    request.username,
                    sourceId,
                    source.bestTimeMs,
                );
            }

            const recovered = await recoverPost(preparedRecord);
            if (recovered) {
                const challengerAvatarUrl = await resolveRedditAvatarUrl(preparedRecord.username);
                const saved = await savePost(buildRecord(preparedRecord, challengerAvatarUrl), recovered);
                const carUnlocks = await recordChallengePostUnlock(
                    playerIdForUsername(request.username),
                    saved.trackKey,
                );
                await redis.del(previewKey(token));
                return {
                    status: 200,
                    body: {
                        status: 'already_created',
                        challengeId: saved.challengeId,
                        postUrl: saved.postUrl,
                        carUnlocks,
                    },
                };
            }

            reservedAt = now();
            if (!await reserveHeadToHeadPostSlot(
                request.subredditName,
                request.username,
                source.trackKey,
                reservedAt,
            )) {
                return {
                    status: 429,
                    body: {
                        status: 'daily_limit_reached',
                        error: 'You can create up to three new Head to Head posts per track in each community each UTC day.',
                    },
                };
            }

            const challengerAvatarUrl = await resolveRedditAvatarUrl(preparedRecord.username);
            const record = buildRecord(preparedRecord, challengerAvatarUrl);
            const postData = buildPublicPostData(record);
            const flairId = await resolveMiniRacerPostFlairId(
                request.subredditName,
                HEAD_TO_HEAD_POST_TYPE,
            );
            const post = await reddit.submitCustomPost({
                subredditName: request.subredditName,
                title: preparedRecord.title,
                entry: HEAD_TO_HEAD_POST_TYPE,
                postData,
                textFallback: { text: formatHeadToHeadTextFallback(postData, record.frozenGhost) },
                runAs: 'USER',
                userGeneratedContent: { text: preparedRecord.title },
            });
            const postedAuthor = String((post as { authorName?: unknown })?.authorName || '');
            if (normalizeName(postedAuthor) !== normalizeName(request.username)) {
                if (postedAuthor.trim()) {
                    const remove = (post as { delete?: () => Promise<void> }).delete;
                    if (typeof remove === 'function') {
                        await remove.call(post).catch((error: unknown) => {
                            console.error('A challenge posted under another name could not be removed:', error);
                        });
                    }
                }
                await releaseHeadToHeadPostSlot(
                    request.subredditName,
                    request.username,
                    source.trackKey,
                    reservedAt,
                );
                reservedAt = null;
                return {
                    status: 409,
                    body: {
                        status: 'user_action_unavailable',
                        error: 'Reddit user-attributed posting is not available for this app version.',
                    },
                };
            }
            if (
                typeof post?.id !== 'string'
                || !post.id.startsWith('t3_')
                || typeof post?.url !== 'string'
                || !post.url
            ) {
                throw new Error('Reddit did not return the head-to-head post identity.');
            }
            // Reddit has accepted a valid user-authored post. Keep the quota slot even if
            // a later identity or unlock write fails; recovery will find this exact post.
            reservedAt = null;
            const saved = await savePost(record, {
                postId: post.id as `t3_${string}`,
                postUrl: post.url,
            });
            // Reddit drops the flair from a post that the player makes. The app is a moderator, so
            // it sets the flair. The post is live either way, so a failure is only logged.
            try {
                await reddit.setPostFlair({
                    subredditName: request.subredditName,
                    postId: post.id as `t3_${string}`,
                    flairTemplateId: flairId,
                });
            } catch (error) {
                console.error('Head to Head post was created without its flair:', error);
            }
            const carUnlocks = await recordChallengePostUnlock(
                playerIdForUsername(request.username),
                saved.trackKey,
            );
            await redis.del(previewKey(token));
            recordAnalyticsChallengeCreateBestEffort(playerIdForUsername(request.username));
            return {
                status: 200,
                body: {
                    status: 'created',
                    challengeId: saved.challengeId,
                    postUrl: saved.postUrl,
                    carUnlocks,
                    },
                };
        } catch (error) {
            if (reservedAt) {
                await releaseHeadToHeadPostSlot(
                    request.subredditName,
                    request.username,
                    source.trackKey,
                    reservedAt,
                );
            }
            throw error;
        } finally {
            await releaseHeadToHeadCreationLock(lock);
        }
    }

    async function get(
        challengeId: string | null,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = challengeContext(context);
        if (!request) {
            return { status: 401, body: { status: 'challenge_context_required', error: 'This challenge is unavailable outside Reddit.' } };
        }
        const { record, reason, diff } = await resolveChallengeRecord(challengeId, context);
        if (!record || normalizeName(record.subredditName) !== normalizeName(request.subredditName)) {
            return { status: 404, body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.', reason, diff } };
        }
        const viewer = await resolveChallengeViewer(context);
        if (viewer.username && normalizeName(viewer.username) === normalizeName(record.challengerUsername)) {
            const avatars = await resolveChallengeAvatars(
                record.challengerUsername,
                viewer.username,
                record.challengerAvatarUrl,
            );
            return {
                status: 403,
                body: {
                    status: 'own_challenge',
                    error: "You can't accept your own Head to Head.",
                    viewerUsername: viewer.username,
                    viewerAvatarUrl: avatars.viewerAvatarUrl,
                    challengerAvatarUrl: avatars.challengerAvatarUrl,
                },
            };
        }
        const avatars = await resolveChallengeAvatars(
            record.challengerUsername,
            viewer.username,
            record.challengerAvatarUrl,
        );
        const challenge = {
            ...toHeadToHeadPostData(record),
            challengerAvatarUrl: avatars.challengerAvatarUrl,
        };
        return {
            status: 200,
            body: {
                status: 'ready',
                challenge,
                opponentGhost: record.frozenGhost,
                viewerBest: await readViewerBest(record, viewer.playerId),
                viewerUsername: viewer.displayName,
                viewerAvatarUrl: avatars.viewerAvatarUrl,
                viewerType: viewer.signedIn
                    ? 'reddit'
                    : viewer.playerId
                        ? 'guest'
                        : 'anonymous',
            },
        };
    }

    /** Decoration on the challenge screen: a failed read must not keep the challenge from loading. */
    async function readViewerBest(
        challenge: HeadToHeadRecord,
        playerId: string | null,
    ): Promise<HeadToHeadViewerBest | null> {
        if (!dependencies.readViewerBest || !playerId) return null;
        try {
            return await dependencies.readViewerBest(challenge, playerId) ?? null;
        } catch (error) {
            console.error('Head to Head viewer best could not be read:', error);
            return null;
        }
    }

    /**
     * The challenge result never depends on this. A refusal from the mode is the rule working —
     * a locked stage, a Daily that has closed — and a failure is a lost personal best, not a lost race.
     */
    async function recordVerifiedBest(
        challenge: HeadToHeadRecord,
        replay: unknown,
        viewer: ChallengeViewer,
        context: HeadToHeadRequestContext,
        verified: Extract<HeadToHeadReplayResult, { ok: true }>,
    ): Promise<HeadToHeadBestUpdate | null> {
        if (!dependencies.recordBest) return null;
        try {
            return await dependencies.recordBest(challenge, replay, {
                playerId: context.playerId ?? null,
                username: viewer.username,
                guestToken: context.guestToken ?? null,
                requestRateLimitIdentity: context.requestRateLimitIdentity ?? null,
                canonicalPlayerId: viewer.playerId,
                verifiedRun: verified.run,
                judgedContract: verified.judgedContract,
            }) ?? null;
        } catch (error) {
            console.error('Head to Head result could not be ranked in its own mode:', error);
            return null;
        }
    }

    async function submit(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = challengeContext(context);
        const viewer = await resolveChallengeViewer(context);
        if (!request || !viewer.playerId) {
            return {
                status: 401,
                body: {
                    status: 'player_identity_required',
                    error: 'Guest identity unavailable. Reload the challenge to continue.',
                },
            };
        }
        if (viewer.progressSelectionPending) {
            return {
                status: 409,
                body: {
                    accepted: false,
                    status: 'progress_selection_required',
                    error: 'Choose which progress to keep before submitting a Head to Head result.',
                },
            };
        }
        // A signed-in account reaches here with `progressSelectionPending` false, so this is the
        // only check that stops it. It sits ahead of the rate limit so a retried submission does
        // not burn its own attempts while it waits.
        if (viewer.transferPending) {
            return transferPendingResult();
        }
        const rateLimit = await checkHeadToHeadSubmissionRateLimit(
            submissionRateLimitIdentity(viewer, context),
        );
        if (!rateLimit.allowed) {
            return {
                status: 429,
                body: {
                    accepted: false,
                    status: 'rate_limited',
                    error: 'Too many submission attempts. Try again soon.',
                    retryAfterSeconds: rateLimit.retryAfterSeconds,
                },
            };
        }
        const challengeId = typeof input.challengeId === 'string' ? input.challengeId : '';
        const { record: challenge, reason: submitReason } = await resolveChallengeRecord(challengeId, context);
        if (!challenge || normalizeName(challenge.subredditName) !== normalizeName(request.subredditName)) {
            return { status: 404, body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.', reason: submitReason } };
        }
        if (viewer.username && normalizeName(viewer.username) === normalizeName(challenge.challengerUsername)) {
            return {
                status: 403,
                body: {
                    status: 'own_challenge',
                    error: "You can't accept your own challenge.",
                },
            };
        }
        const targetNotBeaten = (differenceMs: number): HeadToHeadServiceResult => ({
            status: 422,
            body: {
                accepted: false,
                status: 'target_not_beaten',
                error: 'This run did not beat the challenge time.',
                targetTimeMs: challenge.targetTimeMs,
                differenceMs,
            },
        });
        recordAnalyticsRaceBestEffort('challenge', 'finish', viewer.playerId);

        // Every finish is verified now, win or lose: a run that misses the target can still be the
        // player's best on the stage or Daily this challenge was minted from, and that best is theirs to keep.
        const verified = await dependencies.validateReplay(challenge, input.replay);
        if (
            !verified.ok
            || !Number.isInteger(verified.bestTimeMs)
            || verified.bestTimeMs <= 0
            || !isHeadToHeadMedal(verified.medal)
            || verified.ghost == null
        ) {
            return { status: 422, body: { status: 'invalid_replay', error: 'This challenge run could not be verified.' } };
        }
        const differenceMs = verified.bestTimeMs - challenge.targetTimeMs;
        const originSave = recordVerifiedBest(
            challenge,
            input.replay,
            viewer,
            context,
            verified,
        );
        if (differenceMs >= 0) {
            const lost = targetNotBeaten(differenceMs);
            return {
                ...lost,
                body: bodyWithBestUpdate(lost.body, await originSave),
            };
        }

        // Brag, Head to Head unlocks, and the origin personal-best / place share this body so the
        // finish sheet can replace RANK. Public Daily/Campaign HTTP still cannot take this tape.
        const acceptPromise = challenge.postId
            ? (async () => {
                const acceptToken = createId();
                await writeHeadToHeadAccept(acceptToken, {
                    challengeId,
                    postId: challenge.postId,
                    playerId: viewer.playerId,
                    username: viewer.username || 'Guest racer',
                    bestTimeMs: verified.bestTimeMs,
                    targetTimeMs: challenge.targetTimeMs,
                    medal: verified.medal,
                });
                return acceptToken;
            })()
            : Promise.resolve(null);
        // After the origin save, never beside it. That save records the same completed race for the
        // same player, so the two fought over one Garage lock, and every day the loser failed either
        // the win or the rank in its own mode. The origin save never rejects.
        // The win goes first. Both writes take the same Garage lock, and a failed first write
        // would skip the second: only the win has no repair of its own beyond what it records.
        const unlockWrites = originSave.then(async () => {
            await recordHeadToHeadWin(viewer.playerId, challengeId);
            await recordCompletedRace(viewer.playerId);
        });
        // The win is verified and its origin best is saved. Nothing below can undo that, so each job
        // settles on its own: a failed brag record leaves no brag button, and a failed Garage read
        // leaves the Garage out. Before, any one of them turned a won race into a 500.
        const [accept, unlocks] = await Promise.allSettled([acceptPromise, unlockWrites]);
        const bestUpdate = await originSave;
        if (accept.status === 'rejected') {
            console.error('Head to Head win saved, but its brag record failed:', accept.reason);
        }
        if (unlocks.status === 'rejected') {
            console.error('Head to Head win saved, but its rewards failed:', unlocks.reason);
        }
        let carUnlocks: Awaited<ReturnType<typeof readChallengeCarUnlocks>> | null = null;
        try {
            carUnlocks = await readChallengeCarUnlocks(viewer.playerId);
        } catch (error) {
            console.error('Head to Head win saved, but its Garage could not be read:', error);
        }
        return {
            status: 200,
            body: bodyWithBestUpdate({
                status: 'accepted',
                accepted: true,
                outcome: 'won',
                resultLabel: 'Challenge Won',
                bestTimeMs: verified.bestTimeMs,
                targetTimeMs: challenge.targetTimeMs,
                differenceMs,
                acceptToken: accept.status === 'fulfilled' ? accept.value : null,
                ...(carUnlocks ? { carUnlocks } : {}),
            }, bestUpdate),
        };
    }

    async function next(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return {
                status: 401,
                body: {
                    status: 'signed_in_required',
                    error: 'Sign in to Reddit to open another challenge.',
                },
            };
        }
        const challengeId = typeof input.challengeId === 'string' && input.challengeId
            ? input.challengeId
            : (typeof context.postData?.challengeId === 'string' ? context.postData.challengeId : '');
        if (!challengeId) {
            return {
                status: 404,
                body: { status: 'none', error: 'No other challenge is available.' },
            };
        }
        const cataloged = await readHeadToHeadCatalogCard(request.subredditName, challengeId);
        const current = cataloged ?? (await resolveChallengeRecord(challengeId, context)).record;
        const picked = await pickNextHeadToHeadChallenge({
            subredditName: request.subredditName,
            excludeChallengeId: challengeId,
            excludeUsername: request.username,
            trackKey: current?.trackKey ?? null,
            lapCount: current?.lapCount ?? null,
            targetTimeMs: current?.targetTimeMs ?? null,
            createdAt: current?.createdAt ?? null,
        });
        if (!picked) {
            return {
                status: 200,
                body: { status: 'none' },
            };
        }
        return {
            status: 200,
            body: {
                status: 'ready',
                postUrl: picked.postUrl,
                challengeId: picked.challengeId,
            },
        };
    }

    return { preview, create, get, submit, next };
}
