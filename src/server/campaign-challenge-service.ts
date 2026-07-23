import { randomUUID } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import { redis } from '@devvit/redis';
import { getTrackName } from '../../game/track/catalog.js';
import {
    CAMPAIGN_CHALLENGE_ID,
    CAMPAIGN_CHALLENGE_POST_TYPE,
    isCampaignChallengeMedal,
    isCampaignChallengeRaceId,
    toCampaignChallengePostData,
    type CampaignChallengeMedal,
    type CampaignChallengePostData,
    type CampaignChallengeRecord,
    type CampaignChallengeResult,
    type CampaignChallengeSource,
} from './campaign-challenge-model.js';
import {
    acquireCampaignChallengeCreationLock,
    acquireCampaignChallengeResultLock,
    deleteCampaignChallengePostIdentity,
    readCampaignChallenge,
    readCampaignChallengePostIdentity,
    readCampaignChallengeResult,
    releaseCampaignChallengeCreationLock,
    releaseCampaignChallengePostSlot,
    reserveCampaignChallengePostSlot,
    writeCampaignChallenge,
    writeCampaignChallengePostIdentity,
    writeCampaignChallengeResult,
} from './campaign-challenge-store.js';
import { releaseRedisLock } from './redis-lock.js';

const PREVIEW_TTL_SECONDS = 10 * 60;

export type CampaignChallengeRequestContext = {
    username?: string | null;
    subredditName?: string | null;
    appSlug?: string | null;
};

export type CampaignChallengeServiceResult = {
    status: number;
    body: Record<string, unknown>;
};

export type CampaignChallengeReplayResult = {
    ok: true;
    bestTimeMs: number;
    medal: CampaignChallengeMedal;
    ghost: unknown;
} | {
    ok: false;
    reason?: string;
};

export type CampaignChallengeServiceDependencies = {
    resolveSource(
        input: Record<string, unknown>,
        username: string,
    ): Promise<CampaignChallengeSource | null>;
    validateReplay(
        challenge: CampaignChallengeRecord,
        replay: unknown,
    ): Promise<CampaignChallengeReplayResult> | CampaignChallengeReplayResult;
    now?: () => Date;
    createId?: () => string;
};

type PreviewRecord = {
    username: string;
    subredditName: string;
    source: CampaignChallengeSource;
    challengeId: string;
    title: string;
    createdAt: string;
};

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function previewKey(token: string): string {
    return `miniracer:campaign-challenge:preview:${token}`;
}

function signedContext(context: CampaignChallengeRequestContext): {
    username: string;
    subredditName: string;
} | null {
    const username = typeof context.username === 'string' ? context.username.trim() : '';
    const subredditName = typeof context.subredditName === 'string'
        ? context.subredditName.trim()
        : '';
    return username && subredditName ? { username, subredditName } : null;
}

function creationContext(context: CampaignChallengeRequestContext): {
    username: string;
    subredditName: string;
    appSlug: string;
} | null {
    const signed = signedContext(context);
    const appSlug = typeof context.appSlug === 'string' ? context.appSlug.trim() : '';
    return signed && appSlug ? { ...signed, appSlug } : null;
}

function isValidSource(source: CampaignChallengeSource | null): source is CampaignChallengeSource {
    return Boolean(
        source
        && (source.sourceKind === 'campaign' || source.sourceKind === 'duel')
        && typeof source.sourceId === 'string'
        && source.sourceId
        && source.campaignId === CAMPAIGN_CHALLENGE_ID
        && isCampaignChallengeRaceId(source.raceId)
        && typeof source.trackKey === 'string'
        && source.trackKey
        && (source.lapCount === 1 || source.lapCount === 2 || source.lapCount === 3)
        && Number.isInteger(source.bestTimeMs)
        && source.bestTimeMs > 0
        && isCampaignChallengeMedal(source.medal)
        && Number.isInteger(source.rulesRevision)
        && source.rulesRevision >= 0
        && typeof source.trackFingerprint === 'string'
        && source.trackFingerprint
        && source.ghost != null
    );
}

export function formatCampaignChallengeTime(timeMs: number): string {
    const seconds = Math.floor(timeMs / 1000);
    const milliseconds = timeMs % 1000;
    return `${seconds}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatCampaignChallengeTitle(
    username: string,
    timeMs: number,
    trackKey: string,
): string {
    return `u/${username} challenges you: beat ${formatCampaignChallengeTime(timeMs)} on ${getTrackName(trackKey, trackKey)}`;
}

export function formatCampaignChallengeTextFallback(postData: CampaignChallengePostData): string {
    const laps = postData.lapCount === 1 ? '1 lap' : `${postData.lapCount} laps`;
    return [
        `# ${postData.challengerUsername} challenges you`,
        '',
        `Beat **${formatCampaignChallengeTime(postData.targetTimeMs)}** on **${getTrackName(postData.trackKey, postData.trackKey)}** (${laps}).`,
        '',
        'Open Mini Racer and accept the challenge to race the frozen verified ghost.',
    ].join('\n');
}

function parsePreview(raw: string | null): PreviewRecord | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as PreviewRecord;
        return value
            && typeof value.username === 'string'
            && typeof value.subredditName === 'string'
            && typeof value.challengeId === 'string'
            && typeof value.title === 'string'
            && typeof value.createdAt === 'string'
            && isValidSource(value.source)
            ? value
            : null;
    } catch {
        return null;
    }
}

function buildRecord(preview: PreviewRecord): CampaignChallengeRecord {
    return {
        postType: CAMPAIGN_CHALLENGE_POST_TYPE,
        challengeId: preview.challengeId,
        campaignId: CAMPAIGN_CHALLENGE_ID,
        raceId: preview.source.raceId,
        challengerUsername: preview.username,
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
                data?.postType === CAMPAIGN_CHALLENGE_POST_TYPE
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
    record: CampaignChallengeRecord,
    post: { postId: `t3_${string}`; postUrl: string },
): Promise<CampaignChallengeRecord> {
    const saved = { ...record, ...post };
    await writeCampaignChallenge(saved);
    await writeCampaignChallengePostIdentity(
        record.subredditName,
        record.challengerUsername,
        record.raceId,
        record.targetTimeMs,
        { challengeId: record.challengeId, ...post },
    );
    return saved;
}

function publicChallengeBody(
    record: CampaignChallengeRecord,
    result: CampaignChallengeResult | null = null,
): Record<string, unknown> {
    return {
        challenge: toCampaignChallengePostData(record),
        opponentGhost: record.frozenGhost,
        bestResult: result,
    };
}

export function createCampaignChallengeService(
    dependencies: CampaignChallengeServiceDependencies,
) {
    const now = dependencies.now ?? (() => new Date());
    const createId = dependencies.createId ?? randomUUID;

    async function preview(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to challenge other players.' } };
        }
        const source = await dependencies.resolveSource(input, request.username);
        if (!isValidSource(source)) {
            return { status: 404, body: { status: 'result_unavailable', error: 'No verified result is available for this challenge.' } };
        }
        const challengeId = createId();
        const createdAt = now().toISOString();
        const title = formatCampaignChallengeTitle(request.username, source.bestTimeMs, source.trackKey);
        const record: PreviewRecord = {
            username: request.username,
            subredditName: request.subredditName,
            source,
            challengeId,
            title,
            createdAt,
        };
        const token = createId();
        await redis.set(previewKey(token), JSON.stringify(record));
        await redis.expire(previewKey(token), PREVIEW_TTL_SECONDS);
        return {
            status: 200,
            body: {
                status: 'ready',
                challengeToken: token,
                username: request.username,
                title,
                preview: toCampaignChallengePostData(buildRecord(record)),
                expiresAt: new Date(now().getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
            },
        };
    }

    async function create(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult> {
        const request = creationContext(context);
        if (!request) {
            return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to create a challenge.' } };
        }
        const token = typeof input.challengeToken === 'string' ? input.challengeToken : '';
        const tokenKey = previewKey(token);
        const prepared = parsePreview(token ? await redis.get(tokenKey) : null);
        if (!prepared) {
            return { status: 409, body: { status: 'preview_expired', error: 'This challenge preview expired. Try again.' } };
        }
        if (
            normalizeName(prepared.username) !== normalizeName(request.username)
            || normalizeName(prepared.subredditName) !== normalizeName(request.subredditName)
        ) {
            return { status: 403, body: { status: 'challenge_forbidden', error: 'This preview belongs to another Reddit account or community.' } };
        }

        const source = prepared.source;
        const lock = await acquireCampaignChallengeCreationLock(
            request.subredditName,
            request.username,
            source.raceId,
            source.bestTimeMs,
        );
        if (!lock) {
            return { status: 409, body: { status: 'creation_in_progress', error: 'This challenge post is already being created.' } };
        }
        let reservedAt: Date | null = null;
        try {
            const identity = await readCampaignChallengePostIdentity(
                request.subredditName,
                request.username,
                source.raceId,
                source.bestTimeMs,
            );
            const existing = await activePost(identity);
            if (existing) {
                await redis.del(tokenKey);
                return {
                    status: 200,
                    body: { status: 'already_created', challengeId: existing.challengeId, postUrl: existing.postUrl },
                };
            }
            if (identity) {
                await deleteCampaignChallengePostIdentity(
                    request.subredditName,
                    request.username,
                    source.raceId,
                    source.bestTimeMs,
                );
            }

            const recovered = await recoverPost(prepared, request.appSlug);
            if (recovered) {
                const saved = await savePost(buildRecord(prepared), recovered);
                await redis.del(tokenKey);
                return {
                    status: 200,
                    body: { status: 'already_created', challengeId: saved.challengeId, postUrl: saved.postUrl },
                };
            }

            reservedAt = now();
            if (!await reserveCampaignChallengePostSlot(
                request.subredditName,
                request.username,
                reservedAt,
            )) {
                return {
                    status: 429,
                    body: {
                        status: 'daily_limit_reached',
                        error: 'You can create up to three new challenge posts per community each UTC day.',
                    },
                };
            }

            const record = buildRecord(prepared);
            const postData = toCampaignChallengePostData(record);
            const post = await reddit.submitCustomPost({
                subredditName: request.subredditName,
                title: prepared.title,
                entry: CAMPAIGN_CHALLENGE_POST_TYPE,
                postData,
                textFallback: { text: formatCampaignChallengeTextFallback(postData) },
            });
            if (
                typeof post?.id !== 'string'
                || !post.id.startsWith('t3_')
                || typeof post?.url !== 'string'
                || !post.url
            ) {
                throw new Error('Reddit did not return the campaign challenge post identity.');
            }
            const saved = await savePost(record, {
                postId: post.id as `t3_${string}`,
                postUrl: post.url,
            });
            reservedAt = null;
            await redis.del(tokenKey);
            return {
                status: 200,
                body: { status: 'created', challengeId: saved.challengeId, postUrl: saved.postUrl },
            };
        } catch (error) {
            if (reservedAt) {
                await releaseCampaignChallengePostSlot(
                    request.subredditName,
                    request.username,
                    reservedAt,
                );
            }
            throw error;
        } finally {
            await releaseCampaignChallengeCreationLock(lock);
        }
    }

    async function get(
        challengeId: string | null,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to accept this challenge.' } };
        }
        const record = challengeId ? await readCampaignChallenge(challengeId) : null;
        if (!record || normalizeName(record.subredditName) !== normalizeName(request.subredditName)) {
            return { status: 404, body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' } };
        }
        const result = await readCampaignChallengeResult(record.challengeId, request.username);
        return { status: 200, body: { status: 'ready', ...publicChallengeBody(record, result) } };
    }

    async function submit(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult> {
        const request = signedContext(context);
        if (!request) {
            return { status: 401, body: { status: 'signed_in_required', error: 'Sign in to Reddit to race this challenge.' } };
        }
        const challengeId = typeof input.challengeId === 'string' ? input.challengeId : '';
        const challenge = challengeId ? await readCampaignChallenge(challengeId) : null;
        if (!challenge || normalizeName(challenge.subredditName) !== normalizeName(request.subredditName)) {
            return { status: 404, body: { status: 'challenge_unavailable', error: 'This challenge is unavailable.' } };
        }
        const verified = await dependencies.validateReplay(challenge, input.replay);
        if (
            !verified.ok
            || !Number.isInteger(verified.bestTimeMs)
            || verified.bestTimeMs <= 0
            || !isCampaignChallengeMedal(verified.medal)
            || verified.ghost == null
        ) {
            return { status: 422, body: { status: 'invalid_replay', error: 'This challenge run could not be verified.' } };
        }
        const lock = await acquireCampaignChallengeResultLock(challengeId, request.username);
        if (!lock) {
            return { status: 409, body: { status: 'submission_in_progress', error: 'This challenge run is already being submitted.' } };
        }
        try {
            const previous = await readCampaignChallengeResult(challengeId, request.username);
            const improved = !previous || verified.bestTimeMs < previous.bestTimeMs;
            const bestResult: CampaignChallengeResult = improved
                ? {
                    challengeId,
                    viewerUsername: request.username,
                    bestTimeMs: verified.bestTimeMs,
                    medal: verified.medal,
                    ghost: verified.ghost,
                    verifiedAt: now().toISOString(),
                }
                : previous;
            if (improved) await writeCampaignChallengeResult(bestResult);

            const differenceMs = verified.bestTimeMs - challenge.targetTimeMs;
            const outcome = differenceMs < 0 ? 'won' : differenceMs === 0 ? 'tie' : 'lost';
            return {
                status: 200,
                body: {
                    status: 'accepted',
                    accepted: true,
                    improved,
                    outcome,
                    resultLabel: outcome === 'won'
                        ? 'Challenge Won'
                        : outcome === 'tie'
                            ? 'Tie'
                            : 'Challenge Lost',
                    bestTimeMs: verified.bestTimeMs,
                    targetTimeMs: challenge.targetTimeMs,
                    differenceMs,
                    bestResult,
                },
            };
        } finally {
            await releaseRedisLock(lock, redis);
        }
    }

    return { preview, create, get, submit };
}
