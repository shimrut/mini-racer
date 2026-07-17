import { redis } from '@devvit/redis';

const ANALYTICS_TTL_SECONDS = 180 * 24 * 60 * 60;

type AnalyticsEventName =
    | 'game_opened'
    | 'game_closed'
    | 'race_started'
    | 'race_ended'
    | 'race_restarted'
    | 'game_playtime_chunk'
    | 'pb_ghost_readiness';

type AnalyticsContext = {
    redditUsername?: string | null;
    postId?: string | null;
    subredditName?: string | null;
};

type SubmitAnalyticsEventInput = {
    eventName?: unknown;
    playerId?: unknown;
    sessionId?: unknown;
    payload?: unknown;
    context?: AnalyticsContext;
};

type AnalyticsSummaryDay = {
    date: string;
    activePlayers: number;
    sessions: number;
    gameOpened: number;
    gameClosed: number;
    totalPlaytimeMs: number;
    context: {
        platforms: Record<string, number>;
        clientVersions: Record<string, number>;
        languages: Record<string, number>;
        timezones: Record<string, number>;
        screenBuckets: Record<string, number>;
        orientations: Record<string, number>;
    };
    raceStarts: {
        total: number;
        mainMenu: number;
        trackModal: number;
        leaderboardModal: number;
        unknown: number;
    };
    raceEnds: {
        total: number;
        crash: number;
        finish: number;
        unknown: number;
    };
    restarts: {
        total: number;
        autoCrash: number;
        manualCrash: number;
        improveWin: number;
        unknown: number;
    };
    ghostReadiness: {
        total: number;
        readyBeforeGo: number;
        ghostlessAtGo: number;
        noticeShown: number;
        finishToGhostReadyBuckets: Record<string, number>;
        finishToGhostReadyByPlatform: Record<string, number>;
        finishToGhostReadyByClientVersion: Record<string, number>;
        goSafetyMarginBuckets: Record<string, number>;
        platforms: Record<string, number>;
        clientVersions: Record<string, number>;
    };
    tracks: Record<string, {
        played: number;
        raceStarts: Record<string, number>;
        raceEnds: Record<string, number>;
        restarts: Record<string, number>;
        runTimeMsTotal: Record<string, number>;
    }>;
};

type AnalyticsSummary = {
    from: string;
    to: string;
    granularity: 'day' | 'hour';
    label: string;
    days: AnalyticsSummaryDay[];
    totals: AnalyticsSummaryDay;
};

const EVENT_NAMES = new Set<AnalyticsEventName>([
    'game_opened',
    'game_closed',
    'race_started',
    'race_ended',
    'race_restarted',
    'game_playtime_chunk',
    'pb_ghost_readiness',
]);

const RACE_START_SOURCES = new Set([
    'main_menu',
    'track_modal',
    'leaderboard_modal',
]);

const RACE_END_CAUSES = new Set([
    'crash',
    'finish',
]);

const RESTART_SOURCES = new Set([
    'auto_restart_after_collision',
    'auto_restart_after_crash',
    'manual_restart_after_crash',
    'improve_restart_after_win',
]);

function getAnalyticsDate(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

function getAnalyticsHour(now = new Date()): string {
    return now.toISOString().slice(0, 13);
}

function parseAnalyticsDate(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function addUtcDays(date: string, days: number): string {
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
}

function addUtcHours(hour: string, hours: number): string {
    const next = new Date(`${hour}:00:00.000Z`);
    next.setUTCHours(next.getUTCHours() + hours);
    return next.toISOString().slice(0, 13);
}

function buildDateRange(from: string, to: string): string[] {
    const dates: string[] = [];
    let current = from;
    for (let index = 0; index < 31 && current <= to; index += 1) {
        dates.push(current);
        current = addUtcDays(current, 1);
    }
    return dates;
}

function buildHourRange(to: string, count: number): string[] {
    const hours: string[] = [];
    for (let index = count - 1; index >= 0; index -= 1) {
        hours.push(addUtcHours(to, -index));
    }
    return hours;
}

function createDailyAnalyticsCountersKey(date: string): string {
    return `dailygp:analytics:${date}:counters`;
}

function createDailyAnalyticsPlayersKey(date: string): string {
    return `dailygp:analytics:${date}:players`;
}

function createDailyAnalyticsSessionsKey(date: string): string {
    return `dailygp:analytics:${date}:sessions`;
}

function createHourlyAnalyticsCountersKey(hour: string): string {
    return `dailygp:analytics:${hour}:counters`;
}

function createHourlyAnalyticsPlayersKey(hour: string): string {
    return `dailygp:analytics:${hour}:players`;
}

function createHourlyAnalyticsSessionsKey(hour: string): string {
    return `dailygp:analytics:${hour}:sessions`;
}

function normalizeString(value: unknown, maxLength = 80): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}

function normalizeDimensionValue(
    value: unknown,
    {
        maxLength = 64,
        fallback = null,
    }: {
        maxLength?: number;
        fallback?: string | null;
    } = {},
): string | null {
    const normalized = normalizeString(value, maxLength)?.toLowerCase() || '';
    if (!normalized) {
        return fallback;
    }

    const sanitized = normalized
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9/_.-]+/g, '');

    return sanitized || fallback;
}

function normalizeFiniteNumber(value: unknown, {
    min = 0,
    max = 24 * 60 * 60,
}: { min?: number; max?: number } = {}): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(n, min), max);
}

function normalizeEnum(value: unknown, allowed: Set<string>): string | null {
    const normalized = normalizeString(value);
    return normalized && allowed.has(normalized) ? normalized : null;
}

function normalizePayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
}

function resolveAnalyticsPlayerId(playerId: unknown, redditUsername?: string | null): string | null {
    const username = normalizeString(redditUsername, 40);
    if (username) {
        return `reddit:${username.toLowerCase()}`;
    }

    const browserPlayerId = normalizeString(playerId, 120);
    return browserPlayerId ? `guest:${browserPlayerId}` : null;
}

function addIncrement(increments: Map<string, number>, field: string, value = 1): void {
    increments.set(field, (increments.get(field) || 0) + value);
}

function secondsToMs(value: number): number {
    return Math.max(0, Math.round(value * 1000));
}

function getFinishToGhostReadyBucket(value: unknown): string | null {
    const seconds = normalizeFiniteNumber(value, { max: 24 * 60 * 60 });
    if (seconds == null) return null;
    if (seconds < 0.25) return 'under_250ms';
    if (seconds < 0.5) return '250_to_500ms';
    if (seconds < 0.75) return '500_to_750ms';
    if (seconds < 1) return '750_to_1000ms';
    if (seconds < 1.2) return '1000_to_1200ms';
    if (seconds < 1.4) return '1200_to_1400ms';
    if (seconds < 2) return '1400_to_2000ms';
    if (seconds < 5) return '2_to_5s';
    return 'over_5s';
}

function getGoSafetyMarginBucket(value: unknown): string | null {
    const seconds = normalizeFiniteNumber(value, {
        min: -24 * 60 * 60,
        max: 24 * 60 * 60,
    });
    if (seconds == null) return null;
    if (seconds < 0) return 'late';
    if (seconds < 0.1) return 'under_100ms';
    if (seconds < 0.25) return '100_to_250ms';
    if (seconds < 0.5) return '250_to_500ms';
    if (seconds < 1) return '500_to_1000ms';
    return 'over_1000ms';
}

function addTrackFields(
    increments: Map<string, number>,
    trackKey: string | null,
    fieldSuffix: string,
): void {
    if (!trackKey) return;
    addIncrement(increments, `track:${trackKey}:${fieldSuffix}`);
}

function toCount(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
}

function createEmptySummaryDay(date: string): AnalyticsSummaryDay {
    return {
        date,
        activePlayers: 0,
        sessions: 0,
        gameOpened: 0,
        gameClosed: 0,
        totalPlaytimeMs: 0,
        context: {
            platforms: {},
            clientVersions: {},
            languages: {},
            timezones: {},
            screenBuckets: {},
            orientations: {},
        },
        raceStarts: {
            total: 0,
            mainMenu: 0,
            trackModal: 0,
            leaderboardModal: 0,
            unknown: 0,
        },
        raceEnds: {
            total: 0,
            crash: 0,
            finish: 0,
            unknown: 0,
        },
        restarts: {
            total: 0,
            autoCrash: 0,
            manualCrash: 0,
            improveWin: 0,
            unknown: 0,
        },
        ghostReadiness: {
            total: 0,
            readyBeforeGo: 0,
            ghostlessAtGo: 0,
            noticeShown: 0,
            finishToGhostReadyBuckets: {},
            finishToGhostReadyByPlatform: {},
            finishToGhostReadyByClientVersion: {},
            goSafetyMarginBuckets: {},
            platforms: {},
            clientVersions: {},
        },
        tracks: {},
    };
}

function getTrackSummary(day: AnalyticsSummaryDay, trackKey: string) {
    if (!day.tracks[trackKey]) {
        day.tracks[trackKey] = {
            played: 0,
            raceStarts: {},
            raceEnds: {},
            restarts: {},
            runTimeMsTotal: {},
        };
    }
    return day.tracks[trackKey];
}

function assignTrackMetric(day: AnalyticsSummaryDay, field: string, value: number): boolean {
    const parts = field.split(':');
    if (parts.length < 3 || parts[0] !== 'track') return false;

    const [, trackKey, metric, detailType, detailValue, extra] = parts;
    const track = getTrackSummary(day, trackKey);

    if (metric === 'played') {
        track.played = value;
        return true;
    }

    if (metric === 'race_started' && detailType === 'source' && detailValue) {
        track.raceStarts[detailValue] = value;
        return true;
    }

    if (metric === 'race_ended' && detailType === 'cause' && detailValue) {
        if (extra === 'run_time_ms_total') {
            track.runTimeMsTotal[detailValue] = value;
        } else {
            track.raceEnds[detailValue] = value;
        }
        return true;
    }

    if (metric === 'race_restarted' && detailType === 'source' && detailValue) {
        track.restarts[detailValue] = value;
        return true;
    }

    return false;
}

function assignContextMetric(day: AnalyticsSummaryDay, field: string, value: number): boolean {
    const parts = field.split(':');
    if (parts.length !== 3 || parts[0] !== 'context') return false;

    const [, metric, detailValue] = parts;
    if (!detailValue) return false;

    if (metric === 'platform') {
        day.context.platforms[detailValue] = value;
        return true;
    }

    if (metric === 'client_version') {
        day.context.clientVersions[detailValue] = value;
        return true;
    }

    if (metric === 'language') {
        day.context.languages[detailValue] = value;
        return true;
    }

    if (metric === 'timezone') {
        day.context.timezones[detailValue] = value;
        return true;
    }

    if (metric === 'screen_bucket') {
        day.context.screenBuckets[detailValue] = value;
        return true;
    }

    if (metric === 'orientation') {
        day.context.orientations[detailValue] = value;
        return true;
    }

    return false;
}

function assignGhostReadinessMetric(day: AnalyticsSummaryDay, field: string, value: number): boolean {
    if (field === 'pb_ghost_readiness') {
        day.ghostReadiness.total = value;
        return true;
    }
    if (field === 'pb_ghost_readiness:ready_before_go') {
        day.ghostReadiness.readyBeforeGo = value;
        return true;
    }
    if (field === 'pb_ghost_readiness:ghostless_at_go') {
        day.ghostReadiness.ghostlessAtGo = value;
        return true;
    }
    if (field === 'pb_ghost_readiness:notice_shown') {
        day.ghostReadiness.noticeShown = value;
        return true;
    }

    const parts = field.split(':');
    if (parts.length !== 4 || parts[0] !== 'pb_ghost_readiness') return false;
    const [, metric, detailType, detailValue] = parts;
    if (!detailValue) return false;
    if (metric === 'finish_to_ready' && detailType === 'bucket') {
        day.ghostReadiness.finishToGhostReadyBuckets[detailValue] = value;
        return true;
    }
    if (metric === 'finish_to_ready_platform' && detailType === 'bucket') {
        day.ghostReadiness.finishToGhostReadyByPlatform[detailValue] = value;
        return true;
    }
    if (metric === 'finish_to_ready_client_version' && detailType === 'bucket') {
        day.ghostReadiness.finishToGhostReadyByClientVersion[detailValue] = value;
        return true;
    }
    if (metric === 'go_safety_margin' && detailType === 'bucket') {
        day.ghostReadiness.goSafetyMarginBuckets[detailValue] = value;
        return true;
    }
    if (metric === 'context' && detailType === 'platform') {
        day.ghostReadiness.platforms[detailValue] = value;
        return true;
    }
    if (metric === 'context' && detailType === 'client_version') {
        day.ghostReadiness.clientVersions[detailValue] = value;
        return true;
    }
    return false;
}

function buildSummaryDay(date: string, rawCounters: Record<string, string>): AnalyticsSummaryDay {
    const day = createEmptySummaryDay(date);

    for (const [field, rawValue] of Object.entries(rawCounters)) {
        const value = toCount(rawValue);
        if (assignTrackMetric(day, field, value)) continue;
        if (assignContextMetric(day, field, value)) continue;
        if (assignGhostReadinessMetric(day, field, value)) continue;

        if (field === 'active_players') day.activePlayers = value;
        else if (field === 'sessions') day.sessions = value;
        else if (field === 'game_opened') day.gameOpened = value;
        else if (field === 'game_closed') day.gameClosed = value;
        else if (field === 'game_session_duration_ms_total') day.totalPlaytimeMs = value;
        else if (field === 'race_started') day.raceStarts.total = value;
        else if (field === 'race_started:source:main_menu') day.raceStarts.mainMenu = value;
        else if (field === 'race_started:source:track_modal') day.raceStarts.trackModal = value;
        else if (field === 'race_started:source:leaderboard_modal') day.raceStarts.leaderboardModal = value;
        else if (field === 'race_started:source:unknown') day.raceStarts.unknown = value;
        else if (field === 'race_ended') day.raceEnds.total = value;
        else if (field === 'race_ended:cause:crash') day.raceEnds.crash = value;
        else if (field === 'race_ended:cause:finish') day.raceEnds.finish = value;
        else if (field === 'race_ended:cause:unknown') day.raceEnds.unknown = value;
        else if (field === 'race_restarted') day.restarts.total = value;
        else if (
            field === 'race_restarted:source:auto_restart_after_collision'
            || field === 'race_restarted:source:auto_restart_after_crash'
        ) day.restarts.autoCrash += value;
        else if (field === 'race_restarted:source:manual_restart_after_crash') day.restarts.manualCrash = value;
        else if (field === 'race_restarted:source:improve_restart_after_win') day.restarts.improveWin = value;
        else if (field === 'race_restarted:source:unknown') day.restarts.unknown = value;
    }

    return day;
}

function mergeSummaryDays(
    label: string,
    days: AnalyticsSummaryDay[],
    overrides: Partial<Pick<AnalyticsSummaryDay, 'activePlayers' | 'sessions'>> = {},
): AnalyticsSummaryDay {
    const total = createEmptySummaryDay(label);

    for (const day of days) {
        total.activePlayers += day.activePlayers;
        total.sessions += day.sessions;
        total.gameOpened += day.gameOpened;
        total.gameClosed += day.gameClosed;
        total.totalPlaytimeMs += day.totalPlaytimeMs;

        for (const [platform, value] of Object.entries(day.context.platforms)) {
            total.context.platforms[platform] = (total.context.platforms[platform] || 0) + value;
        }
        for (const [clientVersion, value] of Object.entries(day.context.clientVersions)) {
            total.context.clientVersions[clientVersion] = (total.context.clientVersions[clientVersion] || 0) + value;
        }
        for (const [language, value] of Object.entries(day.context.languages)) {
            total.context.languages[language] = (total.context.languages[language] || 0) + value;
        }
        for (const [timezone, value] of Object.entries(day.context.timezones)) {
            total.context.timezones[timezone] = (total.context.timezones[timezone] || 0) + value;
        }
        for (const [screenBucket, value] of Object.entries(day.context.screenBuckets)) {
            total.context.screenBuckets[screenBucket] = (total.context.screenBuckets[screenBucket] || 0) + value;
        }
        for (const [orientation, value] of Object.entries(day.context.orientations)) {
            total.context.orientations[orientation] = (total.context.orientations[orientation] || 0) + value;
        }

        for (const key of Object.keys(total.raceStarts) as Array<keyof AnalyticsSummaryDay['raceStarts']>) {
            total.raceStarts[key] += day.raceStarts[key];
        }
        for (const key of Object.keys(total.raceEnds) as Array<keyof AnalyticsSummaryDay['raceEnds']>) {
            total.raceEnds[key] += day.raceEnds[key];
        }
        for (const key of Object.keys(total.restarts) as Array<keyof AnalyticsSummaryDay['restarts']>) {
            total.restarts[key] += day.restarts[key];
        }

        total.ghostReadiness.total += day.ghostReadiness.total;
        total.ghostReadiness.readyBeforeGo += day.ghostReadiness.readyBeforeGo;
        total.ghostReadiness.ghostlessAtGo += day.ghostReadiness.ghostlessAtGo;
        total.ghostReadiness.noticeShown += day.ghostReadiness.noticeShown;
        for (const [bucket, value] of Object.entries(day.ghostReadiness.finishToGhostReadyBuckets)) {
            total.ghostReadiness.finishToGhostReadyBuckets[bucket] = (total.ghostReadiness.finishToGhostReadyBuckets[bucket] || 0) + value;
        }
        for (const [bucket, value] of Object.entries(day.ghostReadiness.finishToGhostReadyByPlatform)) {
            total.ghostReadiness.finishToGhostReadyByPlatform[bucket] = (total.ghostReadiness.finishToGhostReadyByPlatform[bucket] || 0) + value;
        }
        for (const [bucket, value] of Object.entries(day.ghostReadiness.finishToGhostReadyByClientVersion)) {
            total.ghostReadiness.finishToGhostReadyByClientVersion[bucket] = (total.ghostReadiness.finishToGhostReadyByClientVersion[bucket] || 0) + value;
        }
        for (const [bucket, value] of Object.entries(day.ghostReadiness.goSafetyMarginBuckets)) {
            total.ghostReadiness.goSafetyMarginBuckets[bucket] = (total.ghostReadiness.goSafetyMarginBuckets[bucket] || 0) + value;
        }
        for (const [platform, value] of Object.entries(day.ghostReadiness.platforms)) {
            total.ghostReadiness.platforms[platform] = (total.ghostReadiness.platforms[platform] || 0) + value;
        }
        for (const [clientVersion, value] of Object.entries(day.ghostReadiness.clientVersions)) {
            total.ghostReadiness.clientVersions[clientVersion] = (total.ghostReadiness.clientVersions[clientVersion] || 0) + value;
        }

        for (const [trackKey, track] of Object.entries(day.tracks)) {
            const target = getTrackSummary(total, trackKey);
            target.played += track.played;
            for (const [source, value] of Object.entries(track.raceStarts)) {
                target.raceStarts[source] = (target.raceStarts[source] || 0) + value;
            }
            for (const [cause, value] of Object.entries(track.raceEnds)) {
                target.raceEnds[cause] = (target.raceEnds[cause] || 0) + value;
            }
            for (const [source, value] of Object.entries(track.restarts)) {
                target.restarts[source] = (target.restarts[source] || 0) + value;
            }
            for (const [cause, value] of Object.entries(track.runTimeMsTotal)) {
                target.runTimeMsTotal[cause] = (target.runTimeMsTotal[cause] || 0) + value;
            }
        }
    }

    return {
        ...total,
        ...overrides,
    };
}

function buildEventIncrements(
    eventName: AnalyticsEventName,
    payload: Record<string, unknown>,
): Map<string, number> {
    const increments = new Map<string, number>();
    const trackKey = normalizeString(payload.trackKey, 80);

    const isPbGhostReadyFollowup = eventName === 'pb_ghost_readiness'
        && payload.sampleType === 'ready_followup';
    if (!isPbGhostReadyFollowup) addIncrement(increments, eventName);

    if (eventName === 'game_closed') {
        return increments;
    }

    if (eventName === 'game_playtime_chunk') {
        const durationSec = normalizeFiniteNumber(payload.durationSec);
        if (durationSec != null && durationSec > 0) {
            addIncrement(increments, 'game_session_duration_ms_total', secondsToMs(durationSec));
        }
        return increments;
    }

    if (eventName === 'game_opened') {
        const clientPlatform = normalizeDimensionValue(payload.clientPlatform, { fallback: 'unknown' });
        const clientVersion = normalizeDimensionValue(payload.clientVersion, { maxLength: 24 });
        const language = normalizeDimensionValue(payload.language);
        const timezone = normalizeDimensionValue(payload.timezone);
        const screenBucket = normalizeDimensionValue(payload.screenBucket);
        const orientation = normalizeDimensionValue(payload.orientation);

        if (clientPlatform) addIncrement(increments, `context:platform:${clientPlatform}`);
        if (clientVersion) addIncrement(increments, `context:client_version:${clientVersion}`);
        if (language) addIncrement(increments, `context:language:${language}`);
        if (timezone) addIncrement(increments, `context:timezone:${timezone}`);
        if (screenBucket) addIncrement(increments, `context:screen_bucket:${screenBucket}`);
        if (orientation) addIncrement(increments, `context:orientation:${orientation}`);
        return increments;
    }

    if (eventName === 'race_started') {
        const source = normalizeEnum(payload.source, RACE_START_SOURCES) || 'unknown';
        addIncrement(increments, `race_started:source:${source}`);
        addTrackFields(increments, trackKey, 'played');
        addTrackFields(increments, trackKey, `race_started:source:${source}`);
        return increments;
    }

    if (eventName === 'race_ended') {
        const cause = normalizeEnum(payload.cause, RACE_END_CAUSES) || 'unknown';
        addIncrement(increments, `race_ended:cause:${cause}`);
        addTrackFields(increments, trackKey, `race_ended:cause:${cause}`);
        const runTimeSec = normalizeFiniteNumber(payload.runTimeSec);
        if (runTimeSec != null) {
            addIncrement(increments, `race_ended:cause:${cause}:run_time_ms_total`, secondsToMs(runTimeSec));
            addTrackFields(increments, trackKey, `race_ended:cause:${cause}:run_time_ms_total`);
        }
        return increments;
    }

    if (eventName === 'race_restarted') {
        const source = normalizeEnum(payload.source, RESTART_SOURCES) || 'unknown';
        addIncrement(increments, `race_restarted:source:${source}`);
        addTrackFields(increments, trackKey, `race_restarted:source:${source}`);
    }

    if (eventName === 'pb_ghost_readiness') {
        const finishToGhostReadyBucket = getFinishToGhostReadyBucket(payload.finishToGhostReadySec);
        const goSafetyMarginBucket = getGoSafetyMarginBucket(payload.goSafetyMarginSec);
        const readyBeforeGo = payload.readyBeforeGo === true;
        const ghostlessAtGo = payload.ghostlessAtGo === true;
        const noticeShown = payload.noticeShown === true;
        const clientPlatform = normalizeDimensionValue(payload.clientPlatform, { fallback: 'unknown' });
        const clientVersion = normalizeDimensionValue(payload.clientVersion, { maxLength: 24 });

        if (readyBeforeGo) addIncrement(increments, 'pb_ghost_readiness:ready_before_go');
        if (ghostlessAtGo) addIncrement(increments, 'pb_ghost_readiness:ghostless_at_go');
        if (noticeShown) addIncrement(increments, 'pb_ghost_readiness:notice_shown');
        if (finishToGhostReadyBucket) {
            addIncrement(increments, `pb_ghost_readiness:finish_to_ready:bucket:${finishToGhostReadyBucket}`);
            if (clientPlatform) {
                addIncrement(increments, `pb_ghost_readiness:finish_to_ready_platform:bucket:${clientPlatform}__${finishToGhostReadyBucket}`);
            }
            if (clientVersion) {
                addIncrement(increments, `pb_ghost_readiness:finish_to_ready_client_version:bucket:${clientVersion}__${finishToGhostReadyBucket}`);
            }
        }
        if (goSafetyMarginBucket) addIncrement(increments, `pb_ghost_readiness:go_safety_margin:bucket:${goSafetyMarginBucket}`);
        if (!isPbGhostReadyFollowup && clientPlatform) addIncrement(increments, `pb_ghost_readiness:context:platform:${clientPlatform}`);
        if (!isPbGhostReadyFollowup && clientVersion) addIncrement(increments, `pb_ghost_readiness:context:client_version:${clientVersion}`);
    }

    return increments;
}

export async function submitServerAnalyticsEvent({
    eventName,
    playerId,
    sessionId,
    payload,
    context = {},
}: SubmitAnalyticsEventInput): Promise<{ accepted: boolean }> {
    if (typeof eventName !== 'string' || !EVENT_NAMES.has(eventName as AnalyticsEventName)) {
        return { accepted: false };
    }

    const normalizedEventName = eventName as AnalyticsEventName;
    const analyticsPlayerId = resolveAnalyticsPlayerId(playerId, context.redditUsername);
    const normalizedSessionId = normalizeString(sessionId, 120);
    const normalizedPayload = normalizePayload(payload);
    const date = getAnalyticsDate();
    const hour = getAnalyticsHour();
    const dailyCountersKey = createDailyAnalyticsCountersKey(date);
    const hourlyCountersKey = createHourlyAnalyticsCountersKey(hour);
    const dailyIncrements = buildEventIncrements(normalizedEventName, normalizedPayload);
    const hourlyIncrements = buildEventIncrements(normalizedEventName, normalizedPayload);

    // PB ghost readiness is intentionally aggregate-only: do not associate it
    // with player or session identity sets, even though the common client
    // transport includes those fields for other analytics events.
    if (analyticsPlayerId && normalizedEventName !== 'pb_ghost_readiness') {
        const [dailyPlayerWasNew, hourlyPlayerWasNew] = await Promise.all([
            redis.hSetNX(createDailyAnalyticsPlayersKey(date), analyticsPlayerId, '1'),
            redis.hSetNX(createHourlyAnalyticsPlayersKey(hour), analyticsPlayerId, '1'),
        ]);
        if (dailyPlayerWasNew) addIncrement(dailyIncrements, 'active_players');
        if (hourlyPlayerWasNew) addIncrement(hourlyIncrements, 'active_players');
    }

    if (normalizedSessionId && normalizedEventName === 'game_opened') {
        const [dailySessionWasNew, hourlySessionWasNew] = await Promise.all([
            redis.hSetNX(createDailyAnalyticsSessionsKey(date), normalizedSessionId, '1'),
            redis.hSetNX(createHourlyAnalyticsSessionsKey(hour), normalizedSessionId, '1'),
        ]);
        if (dailySessionWasNew) addIncrement(dailyIncrements, 'sessions');
        if (hourlySessionWasNew) addIncrement(hourlyIncrements, 'sessions');
    }

    await Promise.all([
        ...Array.from(dailyIncrements.entries()).map(([field, value]) => (
            redis.hIncrBy(dailyCountersKey, field, value)
        )),
        ...Array.from(hourlyIncrements.entries()).map(([field, value]) => (
            redis.hIncrBy(hourlyCountersKey, field, value)
        )),
        redis.expire(dailyCountersKey, ANALYTICS_TTL_SECONDS),
        redis.expire(hourlyCountersKey, ANALYTICS_TTL_SECONDS),
        redis.expire(createDailyAnalyticsPlayersKey(date), ANALYTICS_TTL_SECONDS),
        redis.expire(createDailyAnalyticsSessionsKey(date), ANALYTICS_TTL_SECONDS),
        redis.expire(createHourlyAnalyticsPlayersKey(hour), ANALYTICS_TTL_SECONDS),
        redis.expire(createHourlyAnalyticsSessionsKey(hour), ANALYTICS_TTL_SECONDS),
    ]);

    return { accepted: true };
}

export async function getServerAnalyticsSummary({
    from,
    to,
    range,
}: {
    from?: unknown;
    to?: unknown;
    range?: unknown;
} = {}): Promise<AnalyticsSummary> {
    if (range === 'last24h') {
        const currentHour = getAnalyticsHour();
        const hours = buildHourRange(currentHour, 24);
        const playerIds = new Set<string>();
        const sessionIds = new Set<string>();

        const days = await Promise.all(
            hours.map(async (hour) => {
                const [rawCounters, rawPlayers, rawSessions] = await Promise.all([
                    redis.hGetAll(createHourlyAnalyticsCountersKey(hour)),
                    redis.hGetAll(createHourlyAnalyticsPlayersKey(hour)),
                    redis.hGetAll(createHourlyAnalyticsSessionsKey(hour)),
                ]);
                for (const playerId of Object.keys(rawPlayers || {})) playerIds.add(playerId);
                for (const sessionId of Object.keys(rawSessions || {})) sessionIds.add(sessionId);
                return buildSummaryDay(hour, rawCounters || {});
            }),
        );

        const totals = mergeSummaryDays('Last 24h', days, {
            activePlayers: playerIds.size,
            sessions: sessionIds.size,
        });

        return {
            from: hours[0],
            to: hours[hours.length - 1],
            granularity: 'hour',
            label: 'Last 24h',
            days,
            totals,
        };
    }

    const today = getAnalyticsDate();
    const normalizedTo = parseAnalyticsDate(to) || today;
    const normalizedFrom = parseAnalyticsDate(from) || addUtcDays(normalizedTo, -6);
    const start = normalizedFrom <= normalizedTo ? normalizedFrom : normalizedTo;
    const end = normalizedFrom <= normalizedTo ? normalizedTo : normalizedFrom;
    const dates = buildDateRange(start, end);

    const days = await Promise.all(
        dates.map(async (date) => {
            const rawCounters = await redis.hGetAll(createDailyAnalyticsCountersKey(date));
            return buildSummaryDay(date, rawCounters || {});
        }),
    );

    return {
        from: start,
        to: end,
        granularity: 'day',
        label: start === end ? start : `${start} to ${end}`,
        days,
        totals: mergeSummaryDays(start === end ? start : `${start} to ${end}`, days),
    };
}
