import { CAMPAIGN_ID, getCampaignStage } from '../../../game/campaign/manifest.js';

export { CAMPAIGN_ID };

// A Campaign origin names the series and one of its stages. Posts made before
// there were series name Numbers.
export function isCampaignStageOfSeries(campaignId: unknown, raceId: unknown): boolean {
    return typeof campaignId === 'string' && getCampaignStage(raceId)?.seriesId === campaignId;
}

export const HEAD_TO_HEAD_POST_TYPE = 'head-to-head';

export type HeadToHeadMedal = 'author' | 'gold' | 'silver' | 'bronze' | null;
export type HeadToHeadSourceKind = 'campaign' | 'daily';

export type HeadToHeadOrigin = {
    mode: 'campaign';
    campaignId: string;
    raceId: string;
} | {
    mode: 'daily';
    challengeId: string;
};

export type HeadToHeadSource = {
    sourceKind: HeadToHeadSourceKind;
    sourceId: string;
    origin?: HeadToHeadOrigin;
    campaignId?: string;
    raceId?: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    bestTimeMs: number;
    medal: HeadToHeadMedal;
    rulesRevision: number;
    trackFingerprint: string;
    ghost: unknown;
};

export type HeadToHeadPostData = {
    postType: typeof HEAD_TO_HEAD_POST_TYPE;
    challengeId: string;
    origin?: HeadToHeadOrigin;
    campaignId?: string;
    raceId?: string;
    challengerUsername: string;
    challengerUserId?: string;
    challengerAvatarUrl: string | null;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    targetTimeMs: number;
    medal: HeadToHeadMedal;
    rulesRevision: number;
    trackFingerprint: string;
    createdAt: string;
    replayDataHash?: string;
};

export type HeadToHeadRecord = HeadToHeadPostData & {
    subredditName: string;
    sourceKind: HeadToHeadSourceKind;
    sourceId: string;
    frozenGhost: unknown;
    postId: `t3_${string}` | null;
    postUrl: string | null;
};

export function isHeadToHeadOrigin(value: unknown): value is HeadToHeadOrigin {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const origin = value as Record<string, unknown>;
    if (origin.mode === 'campaign') {
        return isCampaignStageOfSeries(origin.campaignId, origin.raceId);
    }
    return origin.mode === 'daily'
        && typeof origin.challengeId === 'string'
        && /^daily-gp-\d{4}-\d{2}-\d{2}$/.test(origin.challengeId);
}

export function getHeadToHeadOrigin(
    value: {
        origin?: unknown;
        campaignId?: unknown;
        raceId?: unknown;
    },
): HeadToHeadOrigin | null {
    if (isHeadToHeadOrigin(value.origin)) return value.origin;
    if (isCampaignStageOfSeries(value.campaignId, value.raceId)) {
        return {
            mode: 'campaign',
            campaignId: value.campaignId as string,
            raceId: value.raceId as string,
        };
    }
    return null;
}

export function sameHeadToHeadOrigin(
    a: HeadToHeadOrigin | null,
    b: HeadToHeadOrigin | null,
): boolean {
    if (a === b) return true;
    if (!a || !b || a.mode !== b.mode) return false;
    if (a.mode === 'daily' && b.mode === 'daily') return a.challengeId === b.challengeId;
    if (a.mode === 'campaign' && b.mode === 'campaign') return a.campaignId === b.campaignId && a.raceId === b.raceId;
    return false;
}
export function isHeadToHeadMedal(value: unknown): value is HeadToHeadMedal {
    return value === null
        || value === 'author'
        || value === 'gold'
        || value === 'silver'
        || value === 'bronze';
}

export function toHeadToHeadPostData(
    record: HeadToHeadRecord,
): HeadToHeadPostData {
    const origin = getHeadToHeadOrigin(record);
    const postData: HeadToHeadPostData = {
        postType: HEAD_TO_HEAD_POST_TYPE,
        challengeId: record.challengeId,
        challengerUsername: record.challengerUsername,
        challengerAvatarUrl: typeof record.challengerAvatarUrl === 'string'
            ? record.challengerAvatarUrl
            : null,
        trackKey: record.trackKey,
        lapCount: record.lapCount,
        targetTimeMs: record.targetTimeMs,
        medal: record.medal,
        rulesRevision: record.rulesRevision,
        trackFingerprint: record.trackFingerprint,
        createdAt: record.createdAt,
    };
    if (origin) postData.origin = origin;
    if (record.campaignId) postData.campaignId = record.campaignId;
    if (record.raceId) postData.raceId = record.raceId;
    if (typeof record.challengerUserId === 'string' && record.challengerUserId.startsWith('t2_')) {
        postData.challengerUserId = record.challengerUserId;
    }
    if (typeof record.replayDataHash === 'string' && record.replayDataHash) {
        postData.replayDataHash = record.replayDataHash;
    }
    return postData;
}
