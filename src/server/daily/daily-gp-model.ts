import { getAuthorMedalSeconds } from '../../../game/medals/medal-timing.js';
import { objectiveTypeForLapCount } from '../../../game/race/race-spec.js';
import * as utcDay from '../../../game/shared/utc-day.js';

export const DAY_MS: number = utcDay.DAY_MS;
const DEFAULT_OBJECTIVE_TYPE = 'single_lap_fastest';
export const DAILY_GP_RULES_REVISION = 1;
export const DAILY_GP_LEGACY_RULES_REVISION = 0;
export const DAILY_GP_TWO_LAP_AUTHOR_TIME_SECONDS = 10;

export type DailyGpLapCount = 1 | 2 | 3;
export type DailyGpRulesRevision = typeof DAILY_GP_LEGACY_RULES_REVISION | typeof DAILY_GP_RULES_REVISION;

const DAILY_GP_ONE_LAP_COUNTS = Object.freeze([1] as const);
const DAILY_GP_ONE_OR_TWO_LAP_COUNTS = Object.freeze([1, 2] as const);

export type DailyGpRaceContract = Pick<
    DailyGpChallenge,
    'rulesRevision' | 'objectiveType' | 'objectiveParams'
>;

export const DAILY_GP_NEARBY_RADIUS = 2;
export const DAILY_GP_DEFAULT_LIMIT = 10;
export const DAILY_GP_REDIS_TTL_SECONDS = 365 * 24 * 60 * 60;
export const DAILY_GP_GUEST_PROFILE_TTL_SECONDS = 365 * 24 * 60 * 60;
export const DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS = null;
// The Daily archive keeps every day. Devvit Redis cannot remove an expiry, so
// a day's boards, ghosts and its entry in the day list expire 50 years after
// the day. The value stays under 2^31 seconds.
export const DAILY_GP_BOARD_KEEP_SECONDS = 50 * 365 * 24 * 60 * 60;
export const DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS = DAILY_GP_BOARD_KEEP_SECONDS;
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

export function createDailyGpRecordExpiration(): Date {
    return new Date(Date.now() + (DAILY_GP_REDIS_TTL_SECONDS * 1000));
}

export function getUtcDayIndex(date: Date = new Date()): number {
    return utcDay.getUtcDayIndex(date);
}

export function getUtcDayStart(dayIndex: number): Date {
    return utcDay.getUtcDayStart(dayIndex);
}

export function isDailyGpLapCount(value: unknown): value is DailyGpLapCount {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;
}

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
    opponentRaceReady?: boolean;
};

export type DailyGpPlayerProfile = {
    playerId: string;
    leaderboardIdentity: 'constructed' | 'reddit';
    redditUsername: string | null;
    preferences: DailyGpPlayerPreferences | null;
    hasSeenGame: boolean;
    hasAnyData: boolean;
    firstSeenAt: string;
};

export type DailyGpPlayerPreferences = {
    carSkin: string;
    // The skin picked for circuit, dirt, snow, water and space tracks.
    // Absent until picked.
    carSkinGrip?: string;
    carSkinDirt?: string;
    carSkinSnow?: string;
    carSkinWater?: string;
    carSkinSpace?: string;
    trailId: string;
    musicEnabled: boolean;
    carAudioEnabled: boolean;
    crashAutoRestartEnabled: boolean;
    crashRestartDelaySec: number;
    pbGhostEnabled: boolean;
    pausePlacement: 'separate' | 'timer' | 'speedo';
    pauseOnTimerEnabled: boolean;
    hideHudEnabled: boolean;
    quickRestartEnabled: boolean;
};

export function formatUtcChallengeDate(date = new Date()): string {
    return date.toISOString().slice(0, 10);
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

export function getDailyGpEligibleLapCounts(trackKey: string, authorTime = getAuthorMedalSeconds(trackKey)): readonly DailyGpLapCount[] {
    if (!Number.isFinite(authorTime) || authorTime >= DAILY_GP_TWO_LAP_AUTHOR_TIME_SECONDS) {
        return DAILY_GP_ONE_LAP_COUNTS;
    }
    return DAILY_GP_ONE_OR_TWO_LAP_COUNTS;
}

export function selectDailyGpLapCount(
    challengeId: string,
    trackKey: string,
    rulesRevision = DAILY_GP_RULES_REVISION,
    authorTime?: number | null,
): DailyGpLapCount {
    const eligible = getDailyGpEligibleLapCounts(trackKey, authorTime);
    return eligible[deterministicSeedIndex(
        `${challengeId}:${trackKey}:${rulesRevision}`,
        eligible.length,
    )] ?? 1;
}

export function buildDailyGpChallengeForDayIndexWithTrack(
    dayIndex: number,
    trackKey: string,
    { authorTime }: { authorTime?: number | null } = {},
): DailyGpChallenge {
    const startsAt = getUtcDayStart(dayIndex);
    const challengeDate = formatUtcChallengeDate(startsAt);
    const endsAt = new Date(startsAt.getTime() + DAY_MS);
    const availableUntil = new Date(startsAt.getTime() + DAILY_GP_PLAYLIST_DAYS * DAY_MS);

    const id = createDailyChallengeId(challengeDate);
    const lapCount = selectDailyGpLapCount(id, trackKey, DAILY_GP_RULES_REVISION, authorTime);

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
    return Date.parse(challenge.startsAt) + (DAILY_GP_BOARD_KEEP_SECONDS * 1000);
}

export function getDailyGpCompetitionTtlSeconds(
    challenge: DailyGpChallenge,
    now = new Date(),
): number {
    const deadlineMs = getDailyGpCompetitionDeadlineMs(challenge);
    if (!Number.isFinite(deadlineMs)) return 0;
    return Math.max(0, Math.ceil((deadlineMs - now.getTime()) / 1000));
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

export const DAILY_GP_CHALLENGE_HISTORY_HASH_KEY = 'dailygp:challenges';
