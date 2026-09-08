import { getAuthorMedalSeconds } from '../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../game/race/race-spec.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBJECTIVE_TYPE = 'single_lap_fastest';
export const DAILY_GP_RULES_REVISION = 1;
export const DAILY_GP_LEGACY_RULES_REVISION = 0;
/** Tracks strictly under this author time can publish 1 or 2 laps; at or above, always 1 lap. */
export const DAILY_GP_TWO_LAP_AUTHOR_TIME_SECONDS = 10;

export type DailyGpLapCount = 1 | 2 | 3;
export type DailyGpRulesRevision = typeof DAILY_GP_LEGACY_RULES_REVISION | typeof DAILY_GP_RULES_REVISION;

const DAILY_GP_ONE_LAP_COUNTS = Object.freeze([1] as const);
const DAILY_GP_ONE_OR_TWO_LAP_COUNTS = Object.freeze([1, 2] as const);

export type DailyGpRaceContract = Pick<
    DailyGpChallenge,
    'rulesRevision' | 'objectiveType' | 'objectiveParams'
>;

export const DAILY_GP_MIN_TIME_SECONDS = 2;
export const DAILY_GP_MAX_TIME_SECONDS = 60 * 60;
export const DAILY_GP_NEARBY_RADIUS = 2;
export const DAILY_GP_DEFAULT_LIMIT = 10;
export const DAILY_GP_REDIS_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Matches `CAMPAIGN_GUEST_TTL_SECONDS`: a profile must outlive the progress it names. `tests/reddit-daily-gp-model.test.js` holds the two together. */
export const DAILY_GP_GUEST_PROFILE_TTL_SECONDS = 365 * 24 * 60 * 60;
export const DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS = null;
export const DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS = DAILY_GP_REDIS_TTL_SECONDS;
export const DAILY_GP_PLAYLIST_DAYS = 7;

export type DailyGpChallenge = {
    id: string;
    challengeDate: string;
    trackKey: string;
    startsAt: string;
    endsAt: string;
    availableUntil: string;
    status: 'active';
    rulesRevision: DailyGpRulesRevision;
    objectiveType: typeof DEFAULT_OBJECTIVE_TYPE | 'multi_lap_total';
    objectiveParams: { lapCount: DailyGpLapCount };
    skin: 'default';
};

export function isDailyGpLapCount(value: unknown): value is DailyGpLapCount {
    return Number.isInteger(value) && value >= 1 && value <= 3;
}

/** Revision 0 predates the race contract and is always one lap; revision 1 is strict so a malformed record cannot become a different competition. */
export function normalizeDailyGpRaceContract(value: unknown): DailyGpRaceContract | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, 'rulesRevision')) {
        const hasExplicitLapContract = record.objectiveParams
            && typeof record.objectiveParams === 'object'
            && !Array.isArray(record.objectiveParams)
            && Object.hasOwn(record.objectiveParams, 'lapCount');
        if (hasExplicitLapContract) {
            return normalizeDailyGpRaceContract({
                ...record,
                rulesRevision: DAILY_GP_RULES_REVISION,
            });
        }
        return {
            rulesRevision: DAILY_GP_LEGACY_RULES_REVISION,
            objectiveType: DEFAULT_OBJECTIVE_TYPE,
            objectiveParams: { lapCount: 1 },
        };
    }

    if (record.rulesRevision === DAILY_GP_LEGACY_RULES_REVISION) {
        if (
            record.objectiveType !== DEFAULT_OBJECTIVE_TYPE
            || !record.objectiveParams
            || typeof record.objectiveParams !== 'object'
            || Array.isArray(record.objectiveParams)
            || (record.objectiveParams as Record<string, unknown>).lapCount !== 1
        ) {
            return null;
        }
        return {
            rulesRevision: DAILY_GP_LEGACY_RULES_REVISION,
            objectiveType: DEFAULT_OBJECTIVE_TYPE,
            objectiveParams: { lapCount: 1 },
        };
    }

    if (record.rulesRevision !== DAILY_GP_RULES_REVISION) return null;
    if (
        (record.objectiveType !== DEFAULT_OBJECTIVE_TYPE && record.objectiveType !== 'multi_lap_total')
        || !record.objectiveParams
        || typeof record.objectiveParams !== 'object'
        || Array.isArray(record.objectiveParams)
    ) {
        return null;
    }

    const lapCount = (record.objectiveParams as Record<string, unknown>).lapCount;
    if (!isDailyGpLapCount(lapCount)) return null;
    if (
        (lapCount === 1 && record.objectiveType !== DEFAULT_OBJECTIVE_TYPE)
        || (lapCount > 1 && record.objectiveType !== 'multi_lap_total')
    ) {
        return null;
    }

    return {
        rulesRevision: DAILY_GP_RULES_REVISION,
        objectiveType: record.objectiveType,
        objectiveParams: { lapCount },
    };
}

export type DailyGpLeaderboardEntry = {
    playerId: string;
    trackKey: string;
    bestTimeMs: number;
    updatedAt: string;
    completedLaps: DailyGpLapCount | null;
    checkpointTimesSec: number[] | null;
    validationMethod?: 'strict-replay';
    strictReplayFailureReason?: string | null;
};

export type DailyGpPlayerProfile = {
    playerId: string;
    leaderboardIdentity: 'constructed' | 'reddit';
    redditUsername: string | null;
    preferences: DailyGpPlayerPreferences | null;
    hasSeenGame: boolean;
    hasAnyData: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    updatedAt: string;
};

export type DailyGpPlayerPreferences = {
    carSkin: string;
    trailId: string;
    musicEnabled: boolean;
    carAudioEnabled: boolean;
    crashAutoRestartEnabled: boolean;
    crashRestartDelaySec: number;
    pbGhostEnabled: boolean;
    pausePlacement: 'separate' | 'timer' | 'speedo';
    pauseOnTimerEnabled: boolean;
    hideHudEnabled: boolean;
};

export function getUtcDayIndex(date = new Date()): number {
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ) / DAY_MS);
}

export function formatUtcChallengeDate(date = new Date()): string {
    return date.toISOString().slice(0, 10);
}

function getUtcDayStart(dayIndex: number): Date {
    return new Date(dayIndex * DAY_MS);
}

export function createDailyChallengeId(challengeDate: string): string {
    return `daily-gp-${challengeDate}`;
}

function deterministicSeedIndex(seed: string, length: number): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
        hash ^= seed.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % length;
}

/** New Daily publication: under 10s author time is 1 or 2 laps; 10s+ is 1 lap. Validator stays 1-3 for history and Campaign. */
export function getDailyGpEligibleLapCounts(trackKey: string): readonly DailyGpLapCount[] {
    const authorTime = getAuthorMedalSeconds(trackKey);
    if (!Number.isFinite(authorTime) || authorTime >= DAILY_GP_TWO_LAP_AUTHOR_TIME_SECONDS) {
        return DAILY_GP_ONE_LAP_COUNTS;
    }
    return DAILY_GP_ONE_OR_TWO_LAP_COUNTS;
}

export function selectDailyGpLapCount(
    challengeId: string,
    trackKey: string,
    rulesRevision = DAILY_GP_RULES_REVISION,
): DailyGpLapCount {
    const eligible = getDailyGpEligibleLapCounts(trackKey);
    return eligible[deterministicSeedIndex(
        `${challengeId}:${trackKey}:${rulesRevision}`,
        eligible.length,
    )] ?? 1;
}

export function buildDailyGpChallengeForDayIndexWithTrack(
    dayIndex: number,
    trackKey: string,
): DailyGpChallenge {
    const startsAt = getUtcDayStart(dayIndex);
    const challengeDate = formatUtcChallengeDate(startsAt);
    const endsAt = new Date(startsAt.getTime() + DAY_MS);
    const availableUntil = new Date(startsAt.getTime() + DAILY_GP_PLAYLIST_DAYS * DAY_MS);

    const id = createDailyChallengeId(challengeDate);
    const lapCount = selectDailyGpLapCount(id, trackKey);

    return {
        id,
        challengeDate,
        trackKey,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        availableUntil: availableUntil.toISOString(),
        status: 'active',
        rulesRevision: DAILY_GP_RULES_REVISION,
        objectiveType: objectiveTypeForLapCount(lapCount),
        objectiveParams: { lapCount },
        skin: 'default',
    };
}

export function isDailyGpChallengePlayable(challenge: DailyGpChallenge, now = new Date()): boolean {
    const startsMs = Date.parse(challenge.startsAt);
    const availableUntilMs = Date.parse(challenge.availableUntil);
    const nowMs = now.getTime();
    return Number.isFinite(startsMs)
        && Number.isFinite(availableUntilMs)
        && nowMs >= startsMs
        && nowMs < availableUntilMs;
}

export function getDailyGpCompetitionDeadlineMs(challenge: DailyGpChallenge): number {
    return Date.parse(challenge.startsAt) + (DAILY_GP_REDIS_TTL_SECONDS * 1000);
}

export function getDailyGpCompetitionTtlSeconds(
    challenge: DailyGpChallenge,
    now = new Date(),
): number {
    const deadlineMs = getDailyGpCompetitionDeadlineMs(challenge);
    if (!Number.isFinite(deadlineMs)) return 0;
    return Math.max(0, Math.ceil((deadlineMs - now.getTime()) / 1000));
}

export function isValidDailyGpTime(bestTimeSeconds: unknown): bestTimeSeconds is number {
    return Number.isFinite(bestTimeSeconds)
        && Number(bestTimeSeconds) >= DAILY_GP_MIN_TIME_SECONDS
        && Number(bestTimeSeconds) <= DAILY_GP_MAX_TIME_SECONDS;
}

export function toBestTimeMs(bestTimeSeconds: number): number {
    return Math.round(bestTimeSeconds * 1000);
}

export function encodeDailyGpLeaderboardScore(bestTimeMs: number): number {
    return bestTimeMs;
}

export function formatRankLabel(rank: number | null | undefined): string | null {
    return Number.isFinite(rank) && Number(rank) > 0 ? `#${Math.trunc(Number(rank))}` : null;
}

export function createRedisChallengeLeaderboardKey(challengeId: string): string {
    return `dailygp:leaderboard:${challengeId}`;
}

export function createRedisChallengeEntryHashKey(challengeId: string): string {
    return `dailygp:leaderboard:${challengeId}:entries`;
}

export function createRedisChallengeStandingsRevisionKey(challengeId: string): string {
    return `${createRedisChallengeLeaderboardKey(challengeId)}:standings-revision`;
}

/** The one hash that names every live challenge, so a walk of Daily storage can start from it. */
export const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
