import { createHash, randomUUID } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
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
import { formatChallengeBragComment } from './head-to-head-brag.js';
import { resolveHeadToHeadRecord, resolveHeadToHeadRecordResult } from './head-to-head-post.js';
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

const PREVIEW_TTL_SECONDS = 10 * 60;

export type HeadToHeadRequestContext = {
    username?: string | null;
    subredditName?: string | null;
    appSlug?: string | null;
    postId?: string | null;
    postData?: Record<string, unknown> | null;
    playerId?: string | null;
    guestToken?: string | null;
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
} | {
    ok: false;
    reason?: string;
};

export type HeadToHeadServiceDependencies = {
    resolveSource(
        input: Record<string, unknown>,
        username: string,
        context?: HeadToHeadRequestContext,
    ): Promise<HeadToHeadSource | null>;
    validateReplay(
        challenge: HeadToHeadRecord,
        replay: unknown,
    ): Promise<HeadToHeadReplayResult> | HeadToHeadReplayResult;
    now?: () => Date;
    createId?: () => string;
};

type PreviewRecord = {
    username: string;
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

function creationContext(context: HeadToHeadRequestContext): {
    username: string;
    subredditName: string;
    appSlug: string;
} | null {
    const signed = signedContext(context);
    const appSlug = typeof context.appSlug === 'string' ? context.appSlug.trim() : '';
    return signed && appSlug ? { ...signed, appSlug } : null;
}

function challengeContext(context: HeadToHeadRequestContext): {
    subredditName: string;
} | null {
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return subredditName ? { subredditName } : null;
}

/**
 * New requests resolve the immutable contract and frozen replay from the
 * Reddit post. If the client cannot provide post context, the challenge ID
 * resolves only to the stored Reddit post identity; the post body is still
 * fetched and validated. A supplied post context must pass post-bound
 * validation and is never silently replaced by another post.
 */
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
    username: string,
    timeMs: number,
    trackKey: string,
): string {
    return `u/${username} · Head to Head: beat ${formatHeadToHeadTime(timeMs)} on ${getTrackName(trackKey, trackKey)}`;
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
} | null): Promise<typeof identity> {
    if (!identity) return null;
    try {
        const post = await reddit.getPostById(identity.postId);
        return (post as any)?.removed ? null : identity;
    } catch {
        return null;
    }
}

async function recoverPost(
    preview: PreviewRecord,
    appSlug: string,
): Promise<{ postId: `t3_${string}`; postUrl: string } | null> {
    const listing = await (reddit as any).getPostsByUser({
        username: appSlug,
        sort: 'new',
        timeframe: 'month',
        limit: 100,
        pageSize: 100,
    });
    const posts = typeof listing?.all === 'function' ? await listing.all() : [];
    for (const post of posts) {
        if (normalizeName(post?.subredditName || '') !== normalizeName(preview.subredditName)) continue;
        try {
            const data = await post.getPostData();
            if (
                data?.postType === HEAD_TO_HEAD_POST_TYPE
                && data?.challengeId === preview.challengeId
                && typeof post.id === 'string'
                && post.id.startsWith('t3_')
                && typeof post.url === 'string'
                && !(post as any)?.removed
            ) {
                return { postId: post.id as `t3_${string}`, postUrl: post.url };
            }
        } catch {
            // Ignore unrelated or unavailable posts.
        }
    }
    return null;
}

async function savePost(
    record: HeadToHeadRecord,
    post: { postId: `t3_${string}`; postUrl: string },
): Promise<HeadToHeadRecord> {
    const saved = { ...record, ...post };
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
        const source = await dependencies.resolveSource(input, request.username, context);
        if (!isValidSource(source)) {
            return { status: 404, body: { status: 'result_unavailable', error: 'No verified result is available for this challenge.' } };
        }
        const challengeId = createId();
        const createdAt = now().toISOString();
        const title = formatHeadToHeadTitle(request.username, source.bestTimeMs, source.trackKey);
        const challengerAvatarUrl = await resolveRedditAvatarUrl(request.username);
        const record: PreviewRecord = {
            username: request.username,
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
        const previewRecord = {
            username: request.username,
            subredditName: request.subredditName,
            challengeId,
            title,
            createdAt,
            sourceInput,
            sourceContract: sourceContract(source),
            expiresAt: new Date(now().getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
        } satisfies PreviewTokenRecord;
        await redis.set(previewKey(previewToken), JSON.stringify(previewRecord));
        await redis.expire(previewKey(previewToken), PREVIEW_TTL_SECONDS);
        return {
            status: 200,
            body: {
                status: 'ready',
                challengeToken: previewToken,
                username: request.username,
                title,
                preview: buildPublicPostData(buildRecord(record, challengerAvatarUrl)),
                expiresAt: new Date(now().getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
            },
        };
    }

    async function create(
        input: Record<string, unknown>,
        context: HeadToHeadRequestContext,
    ): Promise<HeadToHeadServiceResult> {
        const request = creationContext(context);
        if (!request) {
            return {
                status: 401,
                body: {
                    status: 'signed_in_required',
                    error: 'Sign in to Reddit to create a Head to Head.',
                },
            };
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

        const sourceInput = {
            ...prepared.sourceInput,
            ...(prepared.sourceContract.originMode === 'daily'
                ? { replay: input.replay }
                : {}),
        };
        const source = await dependencies.resolveSource(
            sourceInput,
            request.username,
            context,
        );
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
            const existing = await activePost(identity);
            if (existing) {
                await writeHeadToHeadPostIdentityByChallengeId(existing);
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

            const recovered = await recoverPost(preparedRecord, request.appSlug);
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
                reservedAt,
            )) {
                return {
                    status: 429,
                    body: {
                        status: 'daily_limit_reached',
                        error: 'You can create up to three new Head to Head posts per community each UTC day.',
                    },
                };
            }

            const challengerAvatarUrl = await resolveRedditAvatarUrl(preparedRecord.username);
            const record = buildRecord(preparedRecord, challengerAvatarUrl);
            const postData = buildPublicPostData(record);
            const post = await reddit.submitCustomPost({
                subredditName: request.subredditName,
                title: preparedRecord.title,
                entry: HEAD_TO_HEAD_POST_TYPE,
                postData,
                textFallback: { text: formatHeadToHeadTextFallback(postData, record.frozenGhost) },
            });
            if (
                typeof post?.id !== 'string'
                || !post.id.startsWith('t3_')
                || typeof post?.url !== 'string'
                || !post.url
            ) {
                throw new Error('Reddit did not return the head-to-head post identity.');
            }
            const saved = await savePost(record, {
                postId: post.id as `t3_${string}`,
                postUrl: post.url,
            });
            const carUnlocks = await recordChallengePostUnlock(
                playerIdForUsername(request.username),
                saved.trackKey,
            );
            reservedAt = null;
            await redis.del(previewKey(token));
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
        const outcome = differenceMs < 0 ? 'won' : differenceMs === 0 ? 'tie' : 'lost';
        await recordCompletedRace(viewer.playerId);
        if (outcome === 'won') {
            await recordHeadToHeadWin(viewer.playerId, challengeId);
        }

        // The run is the only thing that proves this win, and nothing about a
        // Head to Head is kept past its post. A short-lived receipt carries the
        // verified time to the brag comment it earns and then expires, so the
        // comment quotes this run rather than anything read back later.
        let acceptToken: string | null = null;
        if (challenge.postId && outcome === 'won') {
            acceptToken = createId();
            await writeHeadToHeadAccept(acceptToken, {
                challengeId,
                postId: challenge.postId,
                playerId: viewer.playerId,
                username: viewer.username || 'Guest racer',
                bestTimeMs: verified.bestTimeMs,
                targetTimeMs: challenge.targetTimeMs,
                medal: verified.medal,
                commentText: formatChallengeBragComment(
                    verified.bestTimeMs,
                    challenge.trackKey,
                ),
            });
        }
        return {
            status: 200,
            body: {
                status: 'accepted',
                accepted: true,
                outcome,
                resultLabel: outcome === 'won'
                    ? 'Challenge Won'
                    : outcome === 'tie'
                        ? 'Tie'
                        : 'Challenge Lost',
                bestTimeMs: verified.bestTimeMs,
                targetTimeMs: challenge.targetTimeMs,
                differenceMs,
                acceptToken,
                carUnlocks: await readChallengeCarUnlocks(viewer.playerId),
            },
        };
    }

    return { preview, create, get, submit };
}
