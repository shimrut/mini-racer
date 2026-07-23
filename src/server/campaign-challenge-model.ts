export const CAMPAIGN_CHALLENGE_POST_TYPE = 'campaign-challenge';
export const CAMPAIGN_CHALLENGE_ID = 'numbered-v1';

export type CampaignChallengeMedal = 'author' | 'gold' | 'silver' | 'bronze' | null;
export type CampaignChallengeSourceKind = 'campaign' | 'duel';

export type CampaignChallengeSource = {
    sourceKind: CampaignChallengeSourceKind;
    sourceId: string;
    campaignId: typeof CAMPAIGN_CHALLENGE_ID;
    raceId: string;
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
    campaignId: typeof CAMPAIGN_CHALLENGE_ID;
    raceId: string;
    challengerUsername: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    targetTimeMs: number;
    medal: CampaignChallengeMedal;
    rulesRevision: number;
    trackFingerprint: string;
    createdAt: string;
};

export type CampaignChallengeRecord = CampaignChallengePostData & {
    subredditName: string;
    sourceKind: CampaignChallengeSourceKind;
    sourceId: string;
    frozenGhost: unknown;
    postId: `t3_${string}` | null;
    postUrl: string | null;
};

export type CampaignChallengeResult = {
    challengeId: string;
    viewerUsername: string;
    bestTimeMs: number;
    medal: CampaignChallengeMedal;
    ghost: unknown;
    verifiedAt: string;
};

export function isCampaignChallengeRaceId(value: unknown): value is string {
    return typeof value === 'string' && /^numbered-v1-0[0-9]$/.test(value);
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
    return {
        postType: CAMPAIGN_CHALLENGE_POST_TYPE,
        challengeId: record.challengeId,
        campaignId: record.campaignId,
        raceId: record.raceId,
        challengerUsername: record.challengerUsername,
        trackKey: record.trackKey,
        lapCount: record.lapCount,
        targetTimeMs: record.targetTimeMs,
        medal: record.medal,
        rulesRevision: record.rulesRevision,
        trackFingerprint: record.trackFingerprint,
        createdAt: record.createdAt,
    };
}
