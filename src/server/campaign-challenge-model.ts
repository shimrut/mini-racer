export const CAMPAIGN_CHALLENGE_POST_TYPE = 'campaign-challenge';
export const CAMPAIGN_CHALLENGE_ID = 'numbered-v1';

export type CampaignChallengeMedal = 'author' | 'gold' | 'silver' | 'bronze' | null;
export type CampaignChallengeSourceKind = 'campaign' | 'daily' | 'duel';

export type CampaignChallengeOrigin = {
    mode: 'campaign';
    campaignId: typeof CAMPAIGN_CHALLENGE_ID;
    raceId: string;
} | {
    mode: 'daily';
    challengeId: string;
};

export type CampaignChallengeSource = {
    sourceKind: CampaignChallengeSourceKind;
    sourceId: string;
    /** New posts use origin; legacy source producers may still provide these fields. */
    origin?: CampaignChallengeOrigin;
    campaignId?: typeof CAMPAIGN_CHALLENGE_ID;
    raceId?: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    bestTimeMs: number;
    medal: CampaignChallengeMedal;
    rulesRevision: number;
    trackFingerprint: string;
    ghost: unknown;
};

export type CampaignChallengePostData = {
    postType: typeof CAMPAIGN_CHALLENGE_POST_TYPE;
    challengeId: string;
    /** Present on new posts; absent legacy posts are treated as Campaign. */
    origin?: CampaignChallengeOrigin;
    campaignId?: typeof CAMPAIGN_CHALLENGE_ID;
    raceId?: string;
    challengerUsername: string;
    challengerAvatarUrl: string | null;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    targetTimeMs: number;
    medal: CampaignChallengeMedal;
    rulesRevision: number;
    trackFingerprint: string;
    createdAt: string;
    /** SHA-256 of the versioned replay token in the text fallback. */
    replayDataHash?: string;
};

export type CampaignChallengeRecord = CampaignChallengePostData & {
    subredditName: string;
    sourceKind: CampaignChallengeSourceKind;
    sourceId: string;
    /** Resolved from the verified Reddit post body; never persisted in Redis. */
    frozenGhost: unknown;
    postId: `t3_${string}` | null;
    postUrl: string | null;
};

export type CampaignChallengeResult = {
    challengeId: string;
    viewerUsername: string;
    /** Canonical Reddit or guest identity used for persistence and merging. */
    viewerPlayerId?: string;
    bestTimeMs: number;
    medal: CampaignChallengeMedal;
    ghost: unknown;
    verifiedAt: string;
};

export function isCampaignChallengeRaceId(value: unknown): value is string {
    return typeof value === 'string' && /^numbered-v1-(?:0[0-9]|1[0-3])$/.test(value);
}

export function isCampaignChallengeOrigin(value: unknown): value is CampaignChallengeOrigin {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const origin = value as Record<string, unknown>;
    if (origin.mode === 'campaign') {
        return origin.campaignId === CAMPAIGN_CHALLENGE_ID
            && isCampaignChallengeRaceId(origin.raceId);
    }
    return origin.mode === 'daily'
        && typeof origin.challengeId === 'string'
        && /^daily-gp-\d{4}-\d{2}-\d{2}$/.test(origin.challengeId);
}

export function getCampaignChallengeOrigin(
    value: {
        origin?: unknown;
        campaignId?: unknown;
        raceId?: unknown;
    },
): CampaignChallengeOrigin | null {
    if (isCampaignChallengeOrigin(value.origin)) return value.origin;
    if (value.campaignId === CAMPAIGN_CHALLENGE_ID && isCampaignChallengeRaceId(value.raceId)) {
        return {
            mode: 'campaign',
            campaignId: CAMPAIGN_CHALLENGE_ID,
            raceId: value.raceId,
        };
    }
    return null;
}

export function sameCampaignChallengeOrigin(
    a: CampaignChallengeOrigin | null,
    b: CampaignChallengeOrigin | null,
): boolean {
    if (a === b) return true;
    if (!a || !b || a.mode !== b.mode) return false;
    if (a.mode === 'daily' && b.mode === 'daily') return a.challengeId === b.challengeId;
    if (a.mode === 'campaign' && b.mode === 'campaign') return a.campaignId === b.campaignId && a.raceId === b.raceId;
    return false;
}
export function isCampaignChallengeMedal(value: unknown): value is CampaignChallengeMedal {
    return value === null
        || value === 'author'
        || value === 'gold'
        || value === 'silver'
        || value === 'bronze';
}

export function toCampaignChallengePostData(
    record: CampaignChallengeRecord,
): CampaignChallengePostData {
    const origin = getCampaignChallengeOrigin(record);
    const postData: CampaignChallengePostData = {
        postType: CAMPAIGN_CHALLENGE_POST_TYPE,
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
    if (typeof record.replayDataHash === 'string' && record.replayDataHash) {
        postData.replayDataHash = record.replayDataHash;
    }
    return postData;
}
