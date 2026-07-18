export const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBJECTIVE_TYPE = 'single_lap_fastest';

export const DAILY_GP_MIN_TIME_SECONDS = 2;
export const DAILY_GP_MAX_TIME_SECONDS = 60 * 60;
export const DAILY_GP_NEARBY_RADIUS = 2;
export const DAILY_GP_DEFAULT_LIMIT = 10;
export const DAILY_GP_REDIS_TTL_SECONDS = 45 * 24 * 60 * 60;
export const DAILY_GP_GUEST_PROFILE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DAILY_GP_PLAYLIST_DAYS = 7;
export const DAILY_GP_COMPETITION_GRACE_MS = 6 * 60 * 60 * 1000;

export type DailyGpChallenge = {
    id: string;
    challengeDate: string;
    trackKey: string;
    startsAt: string;
    endsAt: string;
    availableUntil: string;
    status: 'active';
    objectiveType: typeof DEFAULT_OBJECTIVE_TYPE;
    objectiveParams: Record<string, never>;
    skin: 'default';
};

export type DailyGpLeaderboardEntry = {
    playerId: string;
    trackKey: string;
    bestTimeMs: number;
    updatedAt: string;
    completedLaps: null;
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

export function buildDailyGpChallengeForDayIndexWithTrack(
    dayIndex: number,
    trackKey: string,
): DailyGpChallenge {
    const startsAt = getUtcDayStart(dayIndex);
    const challengeDate = formatUtcChallengeDate(startsAt);
    const endsAt = new Date(startsAt.getTime() + DAY_MS);
    const availableUntil = new Date(startsAt.getTime() + DAILY_GP_PLAYLIST_DAYS * DAY_MS);

    return {
        id: createDailyChallengeId(challengeDate),
        challengeDate,
        trackKey,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        availableUntil: availableUntil.toISOString(),
        status: 'active',
        objectiveType: DEFAULT_OBJECTIVE_TYPE,
        objectiveParams: {},
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

/**
 * PBs, ghosts and leaderboard data share one fixed deadline. Redis only offers
 * relative expiry, so callers recompute the remaining duration on every write.
 */
export function getDailyGpCompetitionDeadlineMs(challenge: DailyGpChallenge): number {
    return Date.parse(challenge.availableUntil) + DAILY_GP_COMPETITION_GRACE_MS;
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
