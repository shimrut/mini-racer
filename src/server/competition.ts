/**
 * One "ranked race" descriptor shared by every mode (Daily, Campaign): the
 * race itself plus the storage policy the shared leaderboard/PB/submit
 * modules need. Redis keys are pre-built strings from each mode's own key
 * builders, never templated from a prefix here — Daily's address live rows.
 */
import {
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    getDailyGpCompetitionTtlSeconds,
    type DailyGpChallenge,
    type DailyGpLapCount,
} from './daily-gp-model.js';
import { challengeCollectionKey } from './pb-ghost-store.js';
import { getDailyChallengeRequiredLaps } from '../../game/daily-challenge/labels.js';
import { objectiveTypeForLapCount } from '../../game/race/race-spec.js';

export type CompetitionMode = 'daily' | 'campaign';

export type Competition = {
    /** challengeId for Daily, raceId for Campaign. */
    id: string;
    mode: CompetitionMode;
    trackKey: string;
    lapCount: DailyGpLapCount;
    rulesRevision: number;
    objectiveType: 'single_lap_fastest' | 'multi_lap_total';
    leaderboardKey: string;
    entryHashKey: string;
    /** Increments with each improved entry so shared standings pages miss immediately. */
    standingsRevisionKey: string;
    pbHashKey: string;
    /** null means the competition is permanent and its keys never expire. */
    ttlSeconds: number | null;
    allowGuests: boolean;
};

const SHARED_STANDINGS_CACHE_VERSION = 'v1';

/**
 * Only immutable competition contract and the atomically bumped board revision
 * participate in a shared standings-page key. Viewer identity is deliberately
 * absent because it is overlaid after the public page is read.
 */
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

/**
 * Daily's storage view. Every key comes from the builders that already address
 * production rows, and the TTL is the same competition deadline the challenge
 * has always used, so this is a view over Daily rather than a change to it.
 */
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
        standingsRevisionKey: `${createRedisChallengeLeaderboardKey(challenge.id)}:standings-revision`,
        pbHashKey: challengeCollectionKey(challenge.id),
        ttlSeconds: getDailyGpCompetitionTtlSeconds(challenge, now),
        allowGuests: true,
    };
}

export type CampaignStageLike = {
    raceId: string;
    trackKey: string;
    lapCount: number;
    rulesRevision: number;
};

/**
 * Campaign progression is permanent for a signed-in player, so those keys carry
 * no expiry. A guest's keys do: their progress must outlive the 7-day guest
 * profile (losing unlocks would be a regression) without accumulating forever,
 * so it gets a long window refreshed on every submit.
 */
export const CAMPAIGN_GUEST_TTL_SECONDS = 90 * 24 * 60 * 60;

export function toCampaignCompetition(
    campaignId: string,
    stage: CampaignStageLike,
    { playerId = null }: { playerId?: string | null } = {},
): Competition {
    const lapCount = normalizeLapCount(stage.lapCount);
    const isGuest = typeof playerId === 'string' && playerId.startsWith('guest:');
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
        ttlSeconds: isGuest ? CAMPAIGN_GUEST_TTL_SECONDS : null,
        allowGuests: true,
    };
}
