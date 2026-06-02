import { TRACKS } from '../../game/track/tracks.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBJECTIVE_TYPE = 'single_lap_fastest';
const SUPPORTED_TRACK_KEYS = Object.keys(TRACKS);
const DAILY_TRACK_STEP_SEED = 17;

export const DAILY_GP_MIN_TIME_SECONDS = 2;
export const DAILY_GP_MAX_TIME_SECONDS = 60 * 60;
export const DAILY_GP_TOP_ROWS_LIMIT = 5;
export const DAILY_GP_NEARBY_RADIUS = 2;
export const DAILY_GP_DEFAULT_LIMIT = 10;
export const DAILY_GP_REDIS_TTL_SECONDS = 45 * 24 * 60 * 60;
export const DAILY_GP_PLAYER_PROFILE_TTL_SECONDS = 180 * 24 * 60 * 60;
export const DAILY_GP_PLAYLIST_DAYS = 7;
export const DAILY_GP_TRACK_COOLDOWN_DAYS = 30;

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
    bestTimeMs: number;
    updatedAt: string;
    completedLaps: null;
    checkpointTimesSec: number[] | null;
    validationMethod?: 'strict-replay' | 'basic-sanity';
    strictReplayFailureReason?: string | null;
};

export type DailyGpPlayerProfile = {
    playerId: string;
    leaderboardIdentity: 'constructed' | 'reddit';
    redditUsername: string | null;
    hasSeenGame: boolean;
    hasAnyData: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    updatedAt: string;
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

function getStepForTrackCount(trackCount: number): number {
    if (trackCount <= 1) return 1;
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    let step = Math.min(DAILY_TRACK_STEP_SEED, trackCount - 1);
    while (step > 1 && gcd(step, trackCount) !== 1) {
        step -= 1;
    }
    return Math.max(1, step);
}

export function createDailyChallengeId(challengeDate: string): string {
    return `daily-gp-${challengeDate}`;
}

export function getDailyGpTrackKeyForDayIndex(dayIndex: number): string {
    const trackKeys = SUPPORTED_TRACK_KEYS.length ? SUPPORTED_TRACK_KEYS : ['circuit'];
    const step = getStepForTrackCount(trackKeys.length);
    const index = Math.abs(dayIndex * step) % trackKeys.length;
    return trackKeys[index] || 'circuit';
}

export function buildDailyGpChallenge(date = new Date()): DailyGpChallenge {
    const dayIndex = getUtcDayIndex(date);
    const startsAt = getUtcDayStart(dayIndex);
    const challengeDate = formatUtcChallengeDate(startsAt);
    const trackKey = getDailyGpTrackKeyForDayIndex(dayIndex);
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

export function buildDailyGpChallengeById(challengeId: string | null | undefined): DailyGpChallenge | null {
    if (typeof challengeId !== 'string') return null;
    const match = /^daily-gp-(\d{4}-\d{2}-\d{2})$/.exec(challengeId);
    if (!match) return null;
    const date = new Date(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime())) return null;
    return buildDailyGpChallenge(date);
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

export function buildDailyGpPlaylist(now = new Date()): DailyGpChallenge[] {
    const todayIndex = getUtcDayIndex(now);
    return Array.from({ length: DAILY_GP_PLAYLIST_DAYS }, (_, index) => {
        return buildDailyGpChallenge(getUtcDayStart(todayIndex - index));
    }).filter((challenge) => isDailyGpChallengePlayable(challenge, now));
}

export function getDailyGpPlayableChallengeById(
    challengeId: string | null | undefined,
    now = new Date(),
): DailyGpChallenge | null {
    const challenge = buildDailyGpChallengeById(challengeId);
    if (!challenge || !isDailyGpChallengePlayable(challenge, now)) return null;
    return challenge;
}

export function assertDailyGpTrackCooldown(
    days = DAILY_GP_TRACK_COOLDOWN_DAYS,
    startDate = new Date('2026-01-01T00:00:00.000Z'),
): boolean {
    const startDay = getUtcDayIndex(startDate);
    const seen = new Map<string, number>();
    for (let offset = 0; offset < days + SUPPORTED_TRACK_KEYS.length; offset += 1) {
        const dayIndex = startDay + offset;
        const trackKey = getDailyGpTrackKeyForDayIndex(dayIndex);
        const lastSeen = seen.get(trackKey);
        if (lastSeen != null && dayIndex - lastSeen <= days) {
            return false;
        }
        seen.set(trackKey, dayIndex);
    }
    return true;
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

export function createRedisPlayerProfileHashKey(): string {
    return 'dailygp:player-profiles';
}
