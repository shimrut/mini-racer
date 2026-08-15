import { redis } from '@devvit/redis';
import { getTrackName, hasTrack } from '../../game/track/catalog.js';
import {
    DAILY_GP_REDIS_TTL_SECONDS,
    DAY_MS,
    formatUtcChallengeDate,
} from './daily-gp-model.js';

export const ANALYTICS_RETENTION_DAYS = Math.round(DAILY_GP_REDIS_TTL_SECONDS / (24 * 60 * 60));

export type AnalyticsPlayMode = 'daily' | 'campaign' | 'challenge';
export type AnalyticsPlayAction = 'start' | 'finish' | 'create';

type AnalyticsPlay =
    | { mode: 'daily'; action: 'finish' }
    | { mode: 'campaign'; action: 'start' }
    | { mode: 'challenge'; action: 'create' }
    | { mode: 'challenge'; action: 'finish' };

export type AnalyticsTrackCount = {
    trackKey: string;
    trackName: string;
    count: number;
};

export type AnalyticsDay = {
    date: string;
    uniquePlayers: number;
    newPlayers: number;
    returningPlayers: number;
    dailyFinishes: number;
    campaignStarts: number;
    challengeCreates: number;
    challengeFinishes: number;
};

export type AnalyticsWindow = {
    days: number;
    from: string;
    to: string;
    uniquePlayers: number;
    playerDays: number;
};

export type AnalyticsSummary = {
    from: string;
    to: string;
    today: AnalyticsDay;
    windows: AnalyticsWindow[];
    days: AnalyticsDay[];
    tracks: {
        daily: AnalyticsTrackCount[];
        campaign: AnalyticsTrackCount[];
        challenge: AnalyticsTrackCount[];
    };
};

type LoadedAnalyticsDay = AnalyticsDay & {
    playerIds: string[];
    trackCounts: Map<string, number>;
};

const WINDOW_LENGTHS = [7, 14, 30] as const;

function createDailyAnalyticsCountersKey(date: string): string {
    return `dailygp:analytics:${date}:counters`;
}

function createDailyAnalyticsPlayersKey(date: string): string {
    return `dailygp:analytics:${date}:players`;
}

function parseAnalyticsDate(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || formatUtcChallengeDate(date) !== `${match[1]}-${match[2]}-${match[3]}`) {
        return null;
    }
    return formatUtcChallengeDate(date);
}

function addUtcDays(date: string, days: number): string {
    return formatUtcChallengeDate(
        new Date(new Date(`${date}T00:00:00.000Z`).getTime() + (days * DAY_MS)),
    );
}

function buildDateRange(from: string, to: string): string[] {
    const dates: string[] = [];
    let current = from;
    for (let index = 0; index < ANALYTICS_RETENTION_DAYS && current <= to; index += 1) {
        dates.push(current);
        current = addUtcDays(current, 1);
    }
    return dates;
}

function normalizePlayerId(playerId: unknown): string | null {
    if (typeof playerId !== 'string') return null;
    const trimmed = playerId.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 120);
}

function firstSeenDate(firstSeenAt: unknown): string | null {
    if (typeof firstSeenAt !== 'string' || !firstSeenAt.trim()) return null;
    return parseAnalyticsDate(firstSeenAt.trim().slice(0, 10));
}

function normalizeTrackKey(trackKey: unknown): string | null {
    return typeof trackKey === 'string' && hasTrack(trackKey) ? trackKey : null;
}

function normalizePlay(mode: unknown, action: unknown): AnalyticsPlay | null {
    if (mode === 'daily' && action === 'finish') return { mode, action };
    if (mode === 'campaign' && action === 'start') return { mode, action };
    if (mode === 'challenge' && (action === 'create' || action === 'finish')) {
        return { mode, action };
    }
    return null;
}

function playCounterField(play: AnalyticsPlay): string {
    switch (play.mode) {
        case 'daily':
            return `mode:daily:${play.action}`;
        case 'campaign':
            return `mode:campaign:${play.action}`;
        case 'challenge':
            return `mode:challenge:${play.action}`;
        default: {
            const exhaustive: never = play;
            return exhaustive;
        }
    }
}

function trackCounterField(play: AnalyticsPlay, trackKey: string): string {
    return `track:${play.mode}:${trackKey}:${play.action}`;
}

function toCount(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
}

function emptyDay(date: string): AnalyticsDay {
    return {
        date,
        uniquePlayers: 0,
        newPlayers: 0,
        returningPlayers: 0,
        dailyFinishes: 0,
        campaignStarts: 0,
        challengeCreates: 0,
        challengeFinishes: 0,
    };
}

function parseTrackCounterField(field: string): { mode: AnalyticsPlayMode; trackKey: string } | null {
    const match = /^track:(daily|campaign|challenge):([^:]+):(finish|start|create)$/.exec(field);
    if (!match || !hasTrack(match[2])) return null;
    return {
        mode: match[1] as AnalyticsPlayMode,
        trackKey: match[2],
    };
}

function compareTrackCounts(left: AnalyticsTrackCount, right: AnalyticsTrackCount): number {
    return right.count - left.count || left.trackName.localeCompare(right.trackName);
}

function uniquePlayersInRange(days: LoadedAnalyticsDay[], from: string, to: string): number {
    const playerIds = new Set<string>();
    for (const day of days) {
        if (day.date < from || day.date > to) continue;
        for (const playerId of day.playerIds) playerIds.add(playerId);
    }
    return playerIds.size;
}

function playerDaysInRange(days: LoadedAnalyticsDay[], from: string, to: string): number {
    return days.reduce((total, day) => (
        day.date >= from && day.date <= to ? total + day.uniquePlayers : total
    ), 0);
}

function logAnalyticsFailure(label: string, error: unknown): void {
    console.error(`Mini Racer analytics ${label} failed:`, error);
}

async function loadAnalyticsDay(date: string): Promise<LoadedAnalyticsDay> {
    const [rawCounters, rawPlayers] = await Promise.all([
        redis.hGetAll(createDailyAnalyticsCountersKey(date)),
        redis.hGetAll(createDailyAnalyticsPlayersKey(date)),
    ]);
    const counters = rawCounters || {};
    const playerIds = Object.keys(rawPlayers || {});
    const trackCounts = new Map<string, number>();
    for (const [field, value] of Object.entries(counters)) {
        const parsed = parseTrackCounterField(field);
        if (!parsed) continue;
        const count = toCount(value);
        if (count <= 0) continue;
        trackCounts.set(`${parsed.mode}:${parsed.trackKey}`, (
            (trackCounts.get(`${parsed.mode}:${parsed.trackKey}`) || 0) + count
        ));
    }
    return {
        date,
        uniquePlayers: playerIds.length || toCount(counters.active_players),
        newPlayers: toCount(counters.new_players),
        returningPlayers: toCount(counters.returning_players),
        dailyFinishes: toCount(counters['mode:daily:finish']),
        campaignStarts: toCount(counters['mode:campaign:start']),
        challengeCreates: toCount(counters['mode:challenge:create']),
        challengeFinishes: toCount(counters['mode:challenge:finish']),
        playerIds,
        trackCounts,
    };
}

export async function recordAnalyticsPresence({
    playerId,
    firstSeenAt,
    now = new Date(),
}: {
    playerId?: unknown;
    firstSeenAt?: unknown;
    now?: Date;
} = {}): Promise<void> {
    try {
        const analyticsPlayerId = normalizePlayerId(playerId);
        if (!analyticsPlayerId) return;

        const date = formatUtcChallengeDate(now);
        const playersKey = createDailyAnalyticsPlayersKey(date);
        const countersKey = createDailyAnalyticsCountersKey(date);
        const wasNewToday = await redis.hSetNX(playersKey, analyticsPlayerId, '1');
        const increments = new Map<string, number>();
        if (wasNewToday) {
            increments.set('active_players', 1);
            const seenDate = firstSeenDate(firstSeenAt);
            increments.set(seenDate && seenDate < date ? 'returning_players' : 'new_players', 1);
        }

        await Promise.all([
            ...Array.from(increments.entries()).map(([field, value]) => (
                redis.hIncrBy(countersKey, field, value)
            )),
            redis.expire(countersKey, DAILY_GP_REDIS_TTL_SECONDS),
            redis.expire(playersKey, DAILY_GP_REDIS_TTL_SECONDS),
        ]);
    } catch (error) {
        logAnalyticsFailure('presence', error);
    }
}

export function recordAnalyticsPresenceBestEffort(
    playerId: unknown,
    firstSeenAt?: unknown,
): void {
    void recordAnalyticsPresence({ playerId, firstSeenAt });
}

export async function recordAnalyticsPlay({
    mode,
    action,
    trackKey,
    now = new Date(),
}: {
    mode?: unknown;
    action?: unknown;
    trackKey?: unknown;
    now?: Date;
} = {}): Promise<void> {
    try {
        const play = normalizePlay(mode, action);
        const normalizedTrackKey = normalizeTrackKey(trackKey);
        if (!play || !normalizedTrackKey) return;

        const date = formatUtcChallengeDate(now);
        const countersKey = createDailyAnalyticsCountersKey(date);
        await Promise.all([
            redis.hIncrBy(countersKey, playCounterField(play), 1),
            redis.hIncrBy(countersKey, trackCounterField(play, normalizedTrackKey), 1),
            redis.expire(countersKey, DAILY_GP_REDIS_TTL_SECONDS),
        ]);
    } catch (error) {
        logAnalyticsFailure('play', error);
    }
}

export function recordAnalyticsPlayBestEffort(
    mode: AnalyticsPlayMode,
    action: AnalyticsPlayAction,
    trackKey: unknown,
): void {
    void recordAnalyticsPlay({ mode, action, trackKey });
}

export async function getServerAnalyticsSummary({
    now = new Date(),
}: {
    now?: Date;
} = {}): Promise<AnalyticsSummary> {
    const to = formatUtcChallengeDate(now);
    const from = addUtcDays(to, -(ANALYTICS_RETENTION_DAYS - 1));
    const dates = buildDateRange(from, to);
    const loadedDays = await Promise.all(dates.map((date) => loadAnalyticsDay(date)));
    const days = loadedDays.map(({ playerIds: _playerIds, trackCounts: _trackCounts, ...day }) => day);
    const today = days[days.length - 1] ?? emptyDay(to);
    const tracks = {
        daily: [] as AnalyticsTrackCount[],
        campaign: [] as AnalyticsTrackCount[],
        challenge: [] as AnalyticsTrackCount[],
    };
    const totals = {
        daily: new Map<string, number>(),
        campaign: new Map<string, number>(),
        challenge: new Map<string, number>(),
    };

    for (const day of loadedDays) {
        for (const [key, count] of day.trackCounts) {
            const separator = key.indexOf(':');
            const mode = key.slice(0, separator);
            const trackKey = key.slice(separator + 1);
            if (mode !== 'daily' && mode !== 'campaign' && mode !== 'challenge') continue;
            totals[mode].set(trackKey, (totals[mode].get(trackKey) || 0) + count);
        }
    }

    for (const mode of ['daily', 'campaign', 'challenge'] as const) {
        tracks[mode] = Array.from(totals[mode].entries())
            .map(([trackKey, count]) => ({
                trackKey,
                trackName: getTrackName(trackKey, trackKey),
                count,
            }))
            .sort(compareTrackCounts);
    }

    return {
        from,
        to,
        today,
        windows: WINDOW_LENGTHS.map((daysCount) => {
            const windowFrom = addUtcDays(to, -(daysCount - 1));
            const boundedFrom = windowFrom < from ? from : windowFrom;
            return {
                days: daysCount,
                from: boundedFrom,
                to,
                uniquePlayers: uniquePlayersInRange(loadedDays, boundedFrom, to),
                playerDays: playerDaysInRange(loadedDays, boundedFrom, to),
            };
        }),
        days,
        tracks,
    };
}
