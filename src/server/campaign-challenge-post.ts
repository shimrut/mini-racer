import { reddit } from '@devvit/web/server';
import {
    CAMPAIGN_CHALLENGE_ID,
    CAMPAIGN_CHALLENGE_POST_TYPE,
    getCampaignChallengeOrigin,
    isCampaignChallengeMedal,
    isCampaignChallengeRaceId,
    isCampaignChallengeOrigin,
    sameCampaignChallengeOrigin,
    type CampaignChallengePostData,
    type CampaignChallengeRecord,
} from './campaign-challenge-model.js';
import { decodeCampaignChallengeReplay } from './campaign-challenge-replay.js';
import { readCampaignChallenge } from './campaign-challenge-store.js';

export type CampaignChallengePostContext = {
    postId?: string | null;
    postData?: Record<string, unknown> | null;
};

export type CampaignChallengeResolutionFailureReason =
    | 'challenge_id_missing'
    | 'post_id_missing'
    | 'post_fetch_failed'
    | 'post_removed'
    | 'post_data_fetch_failed'
    | 'post_data_invalid'
    | 'replay_fallback_missing'
    | 'replay_validation_failed'
    | 'replay_token_not_found'
    | 'replay_hash_mismatch'
    | 'replay_decompress_failed'
    | 'replay_envelope_invalid'
    | 'replay_contract_mismatch'
    | 'legacy_record_missing'
    | 'legacy_contract_mismatch'
    | 'post_identity_invalid';

export type CampaignChallengeResolution = {
    ok: true;
    record: CampaignChallengeRecord;
} | {
    ok: false;
    reason: CampaignChallengeResolutionFailureReason;
    diff?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validPostId(value: unknown): value is `t3_${string}` {
    return typeof value === 'string' && value.startsWith('t3_');
}

function validPostUrl(value: unknown): value is string {
    return typeof value === 'string' && Boolean(value);
}

function validPostData(
    value: unknown,
    challengeId: string,
): value is CampaignChallengePostData {
    if (!isRecord(value)) return false;
    const origin = getCampaignChallengeOrigin(value as CampaignChallengePostData);
    return value.postType === CAMPAIGN_CHALLENGE_POST_TYPE
        && value.challengeId === challengeId
        && origin !== null
        && (
            isCampaignChallengeOrigin(value.origin)
            || (
                value.campaignId === CAMPAIGN_CHALLENGE_ID
                && isCampaignChallengeRaceId(value.raceId)
            )
        )
        && typeof value.challengerUsername === 'string'
        && Boolean(value.challengerUsername)
        && (value.challengerAvatarUrl === null || typeof value.challengerAvatarUrl === 'string')
        && typeof value.trackKey === 'string'
        && Boolean(value.trackKey)
        && (value.lapCount === 1 || value.lapCount === 2 || value.lapCount === 3)
        && Number.isSafeInteger(value.targetTimeMs)
        && Number(value.targetTimeMs) > 0
        && isCampaignChallengeMedal(value.medal)
        && Number.isSafeInteger(value.rulesRevision)
        && Number(value.rulesRevision) >= 0
        && typeof value.trackFingerprint === 'string'
        && Boolean(value.trackFingerprint)
        && typeof value.createdAt === 'string'
        && Boolean(value.createdAt)
        && (
            value.replayDataHash === undefined
            || (
                typeof value.replayDataHash === 'string'
                && /^[a-f0-9]{64}$/.test(value.replayDataHash)
            )
        );
}

function matchesStoredChallengeContract(
    postData: CampaignChallengePostData,
    stored: CampaignChallengeRecord,
): boolean {
    const postOrigin = getCampaignChallengeOrigin(postData);
    const storedOrigin = getCampaignChallengeOrigin(stored);
    return postOrigin !== null
        && storedOrigin !== null
        && sameCampaignChallengeOrigin(postOrigin, storedOrigin)
        && postData.challengeId === stored.challengeId
        && postData.challengerUsername === stored.challengerUsername
        && postData.trackKey === stored.trackKey
        && postData.lapCount === stored.lapCount
        && postData.targetTimeMs === stored.targetTimeMs
        && postData.medal === stored.medal
        && postData.rulesRevision === stored.rulesRevision
        && postData.trackFingerprint === stored.trackFingerprint
        && postData.createdAt === stored.createdAt;
}

const FALLBACK_TEXT_KEYS = [
    'text',
    'markdown',
    'raw',
    'value',
    'body',
    'selftext',
    'textFallback',
    'richtextFallback',
] as const;

function collectFallbackTexts(value: unknown, texts: string[], depth = 0): void {
    if (depth > 4) return;
    if (typeof value === 'string') {
        if (value && !texts.includes(value)) texts.push(value);
        const first = value.trimStart()[0];
        if (first === '{' || first === '[' || first === '"') {
            try {
                collectFallbackTexts(JSON.parse(value), texts, depth + 1);
            } catch {
                // Ordinary Markdown is the expected shape, not JSON.
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFallbackTexts(item, texts, depth + 1);
        return;
    }
    if (!isRecord(value)) return;
    for (const key of FALLBACK_TEXT_KEYS) {
        if (key in value) collectFallbackTexts(value[key], texts, depth + 1);
    }
}

function postFallbackTexts(post: unknown): string[] {
    if (!isRecord(post)) return [];
    const texts: string[] = [];
    for (const key of ['body', 'selftext', 'textFallback', 'richtextFallback'] as const) {
        collectFallbackTexts(post[key], texts);
    }
    if (typeof post.toJSON === 'function') {
        try {
            collectFallbackTexts((post.toJSON as () => unknown)(), texts);
        } catch {
            // Direct Post fields remain authoritative when serialization is unavailable.
        }
    }
    return texts;
}

async function getPostData(
    post: unknown,
    contextPostData: Record<string, unknown> | null | undefined,
    challengeId: string,
): Promise<{
    data: Record<string, unknown> | null;
    fetchFailed: boolean;
}> {
    let fetchFailed = false;
    if (isRecord(post) && typeof post.getPostData === 'function') {
        try {
            const fetched = await (post.getPostData as () => Promise<unknown>)();
            if (validPostData(fetched, challengeId)) {
                return { data: fetched, fetchFailed: false };
            }
        } catch {
            fetchFailed = true;
        }
    }
    return {
        data: validPostData(contextPostData, challengeId) ? contextPostData : null,
        fetchFailed,
    };
}

function toChallengeRecord(
    postData: CampaignChallengePostData,
    replayGhost: unknown,
    post: unknown,
    contextPostId: string | null | undefined,
): CampaignChallengeRecord | null {
    const postObject = isRecord(post) ? post : {};
    const postId = validPostId(contextPostId)
        ? contextPostId
        : validPostId(postObject.id) ? postObject.id : null;
    const postUrl = validPostUrl(postObject.url) ? postObject.url : null;
    const subredditName = typeof postObject.subredditName === 'string'
        ? postObject.subredditName
        : null;
    const origin = getCampaignChallengeOrigin(postData);
    if (!postId || !postUrl || !subredditName || !origin) return null;
    return {
        ...postData,
        subredditName,
        sourceKind: origin.mode,
        sourceId: postData.challengeId,
        frozenGhost: replayGhost,
        postId,
        postUrl,
    };
}

/**
 * Resolves the immutable challenge contract from the Reddit custom post.
 * Posts created before replay data was embedded may use their matching stored
 * record during migration. New posts remain fully post-bound.
 */
export async function resolveCampaignChallengeRecordResult(
    challengeId: string | null,
    context: CampaignChallengePostContext = {},
): Promise<CampaignChallengeResolution> {
    if (!challengeId) return { ok: false, reason: 'challenge_id_missing' };
    if (!validPostId(context.postId)) return { ok: false, reason: 'post_id_missing' };
    let post: unknown;
    try {
        post = await reddit.getPostById(context.postId);
    } catch {
        return { ok: false, reason: 'post_fetch_failed' };
    }
    if ((post as any)?.removed) return { ok: false, reason: 'post_removed' };

    const postDataResult = await getPostData(post, context.postData, challengeId);
    if (!validPostData(postDataResult.data, challengeId)) {
        return {
            ok: false,
            reason: postDataResult.fetchFailed ? 'post_data_fetch_failed' : 'post_data_invalid',
        };
    }
    const rawPostData = postDataResult.data;
    const fallbackTexts = postFallbackTexts(post);
    let lastReplayReason: CampaignChallengeResolutionFailureReason | undefined;
    let lastReplayDiff: Record<string, unknown> | undefined;
    for (const fallbackText of fallbackTexts) {
        const { decoded: replay, reason: replayReason, diff: replayDiff } = decodeCampaignChallengeReplay(fallbackText, rawPostData);
        if (!replay) {
            lastReplayReason = (replayReason as CampaignChallengeResolutionFailureReason) || 'replay_validation_failed';
            lastReplayDiff = replayDiff;
            continue;
        }
        const record = toChallengeRecord(
            rawPostData,
            replay.envelope.ghost,
            post,
            context.postId,
        );
        return record
            ? { ok: true, record }
            : { ok: false, reason: 'post_identity_invalid' as const };
    }
    const origin = getCampaignChallengeOrigin(rawPostData);
    if (!origin || rawPostData.replayDataHash !== undefined) {
        return {
            ok: false,
            reason: fallbackTexts.length > 0
                ? (lastReplayReason || 'replay_validation_failed')
                : 'replay_fallback_missing',
            diff: lastReplayDiff,
        };
    }
    let stored: CampaignChallengeRecord | null;
    try {
        stored = await readCampaignChallenge(challengeId);
    } catch {
        return { ok: false, reason: 'legacy_record_missing' };
    }
    if (!stored) return { ok: false, reason: 'legacy_record_missing' };
    if (!matchesStoredChallengeContract(rawPostData, stored)) {
        return { ok: false, reason: 'legacy_contract_mismatch' };
    }
    const record = toChallengeRecord(
        rawPostData,
        stored.frozenGhost,
        post,
        context.postId,
    );
    return record
        ? { ok: true, record }
        : { ok: false, reason: 'post_identity_invalid' };
}

export async function resolveCampaignChallengeRecord(
    challengeId: string | null,
    context: CampaignChallengePostContext = {},
): Promise<CampaignChallengeRecord | null> {
    const result = await resolveCampaignChallengeRecordResult(challengeId, context);
    if (result.ok) return result.record;
    if (result.reason !== 'challenge_id_missing' && result.reason !== 'post_id_missing') {
        console.warn('Campaign challenge resolution failed.', {
            challengeId: challengeId || null,
            postId: validPostId(context.postId) ? context.postId : null,
            reason: result.reason,
        });
    }
    return null;
}
