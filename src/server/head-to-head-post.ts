import { reddit } from '@devvit/web/server';
import {
    CAMPAIGN_ID,
    HEAD_TO_HEAD_POST_TYPE,
    getHeadToHeadOrigin,
    isHeadToHeadMedal,
    isHeadToHeadRaceId,
    isHeadToHeadOrigin,
    type HeadToHeadPostData,
    type HeadToHeadRecord,
} from './head-to-head-model.js';
import { decodeHeadToHeadReplay } from './head-to-head-replay.js';

export type HeadToHeadPostContext = {
    postId?: string | null;
    postData?: Record<string, unknown> | null;
};

export type HeadToHeadResolutionFailureReason =
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
    | 'post_author_mismatch'
    | 'post_identity_invalid';

export type HeadToHeadResolution = {
    ok: true;
    record: HeadToHeadRecord;
} | {
    ok: false;
    reason: HeadToHeadResolutionFailureReason;
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
): value is HeadToHeadPostData {
    if (!isRecord(value)) return false;
    const origin = getHeadToHeadOrigin(value as HeadToHeadPostData);
    return value.postType === HEAD_TO_HEAD_POST_TYPE
        && value.challengeId === challengeId
        && origin !== null
        && (
            isHeadToHeadOrigin(value.origin)
            || (
                value.campaignId === CAMPAIGN_ID
                && isHeadToHeadRaceId(value.raceId)
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
        && isHeadToHeadMedal(value.medal)
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
    postData: HeadToHeadPostData,
    replayGhost: unknown,
    post: unknown,
    contextPostId: string | null | undefined,
): HeadToHeadRecord | null {
    const postObject = isRecord(post) ? post : {};
    const postId = validPostId(contextPostId)
        ? contextPostId
        : validPostId(postObject.id) ? postObject.id : null;
    const postUrl = validPostUrl(postObject.url) ? postObject.url : null;
    const subredditName = typeof postObject.subredditName === 'string'
        ? postObject.subredditName
        : null;
    const origin = getHeadToHeadOrigin(postData);
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

export async function resolveHeadToHeadRecordResult(
    challengeId: string | null,
    context: HeadToHeadPostContext = {},
): Promise<HeadToHeadResolution> {
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
    if (
        typeof (post as any)?.authorName !== 'string'
        || (post as any).authorName.trim().toLowerCase()
            !== rawPostData.challengerUsername.trim().toLowerCase()
    ) {
        return { ok: false, reason: 'post_author_mismatch' };
    }
    const fallbackTexts = postFallbackTexts(post);
    let lastReplayReason: HeadToHeadResolutionFailureReason | undefined;
    let lastReplayDiff: Record<string, unknown> | undefined;
    for (const fallbackText of fallbackTexts) {
        const { decoded: replay, reason: replayReason, diff: replayDiff } = decodeHeadToHeadReplay(fallbackText, rawPostData);
        if (!replay) {
            lastReplayReason = (replayReason as HeadToHeadResolutionFailureReason) || 'replay_validation_failed';
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
    // The post body is the only source of the frozen replay, so a post that cannot produce one is unusable.
    return {
        ok: false,
        reason: fallbackTexts.length > 0
            ? (lastReplayReason || 'replay_validation_failed')
            : 'replay_fallback_missing',
        diff: lastReplayDiff,
    };
}

export async function resolveHeadToHeadRecord(
    challengeId: string | null,
    context: HeadToHeadPostContext = {},
): Promise<HeadToHeadRecord | null> {
    const result = await resolveHeadToHeadRecordResult(challengeId, context);
    if (result.ok) return result.record;
    if (result.reason !== 'challenge_id_missing' && result.reason !== 'post_id_missing') {
        console.warn('Head to Head resolution failed.', {
            challengeId: challengeId || null,
            postId: validPostId(context.postId) ? context.postId : null,
            reason: result.reason,
        });
    }
    return null;
}
