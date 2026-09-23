import {
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisChallengeStandingsRevisionKey,
    getDailyGpCompetitionTtlSeconds,
    type DailyGpChallenge,
    type DailyGpLapCount,
} from '../daily/daily-gp-model.js';
import { challengeCollectionKey } from './pb-ghost-store.js';
import { getDailyChallengeRequiredLaps } from '../../../game/daily-challenge/labels.js';
import { objectiveTypeForLapCount } from '../../../game/race/race-spec.js';

export type CompetitionMode = 'daily' | 'campaign';

export type Competition = {
    id: string;
    mode: CompetitionMode;
    trackKey: string;
    lapCount: DailyGpLapCount;
    rulesRevision: number;
    objectiveType: 'single_lap_fastest' | 'multi_lap_total';
    leaderboardKey: string;
    entryHashKey: string;
    standingsRevisionKey: string;
    pbHashKey: string;
    ttlSeconds: number | null;
    guestExpiryKey: string | null;
    guestRetentionSeconds: number | null;
    allowGuests: boolean;
};

const SHARED_STANDINGS_CACHE_VERSION = 'v1';

export function createSharedStandingsCacheKey(
    competition: Competition,
    offset: number,
    limit: number,
    revision: number,
): string {
    return [
        'mini-racer:standings-page',
        SHARED_STANDINGS_CACHE_VERSION,
        competition.mode,
        encodeURIComponent(competition.id),
        encodeURIComponent(competition.trackKey),
        `laps-${competition.lapCount}`,
        `rules-${competition.rulesRevision}`,
        `offset-${offset}`,
        `limit-${limit}`,
        `revision-${revision}`,
    ].join(':');
}

function normalizeLapCount(value: unknown): DailyGpLapCount {
    return value === 2 || value === 3 ? value : 1;
}

export function toDailyCompetition(
    challenge: DailyGpChallenge,
    now = new Date(),
): Competition {
    const lapCount = normalizeLapCount(getDailyChallengeRequiredLaps(challenge));
    return {
        id: challenge.id,
        mode: 'daily',
        trackKey: challenge.trackKey,
        lapCount,
        rulesRevision: challenge.rulesRevision,
        objectiveType: challenge.objectiveType,
        leaderboardKey: createRedisChallengeLeaderboardKey(challenge.id),
        entryHashKey: createRedisChallengeEntryHashKey(challenge.id),
        standingsRevisionKey: createRedisChallengeStandingsRevisionKey(challenge.id),
        pbHashKey: challengeCollectionKey(challenge.id),
        ttlSeconds: getDailyGpCompetitionTtlSeconds(challenge, now),
        guestExpiryKey: null,
        guestRetentionSeconds: null,
        allowGuests: true,
    };
}

export type CampaignStageLike = {
    raceId: string;
    trackKey: string;
    lapCount: number;
    rulesRevision: number;
};

export const CAMPAIGN_GUEST_TTL_SECONDS = 365 * 24 * 60 * 60;

export function toCampaignCompetition(
    campaignId: string,
    stage: CampaignStageLike,
): Competition {
    const lapCount = normalizeLapCount(stage.lapCount);
    return {
        id: stage.raceId,
        mode: 'campaign',
        trackKey: stage.trackKey,
        lapCount,
        rulesRevision: stage.rulesRevision,
        objectiveType: objectiveTypeForLapCount(lapCount),
        leaderboardKey: `campaign:${campaignId}:leaderboard:${stage.raceId}`,
        entryHashKey: `campaign:${campaignId}:leaderboard:${stage.raceId}:entries`,
        standingsRevisionKey: `campaign:${campaignId}:leaderboard:${stage.raceId}:standings-revision`,
        pbHashKey: `campaign:${campaignId}:pbs:${stage.raceId}`,
        ttlSeconds: null,
        guestExpiryKey: `campaign:${campaignId}:guest-expiry`,
        guestRetentionSeconds: CAMPAIGN_GUEST_TTL_SECONDS,
        allowGuests: true,
    };
}
