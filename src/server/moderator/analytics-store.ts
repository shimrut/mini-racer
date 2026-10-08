import { redis } from '@devvit/redis';
import { readContextSubredditName } from '../request/request-context.js';
import { readPlayerProfile } from '../competition/competition-identity.js';
import {
    DAILY_GP_REDIS_TTL_SECONDS,
    DAY_MS,
    formatUtcChallengeDate,
} from '../daily/daily-gp-model.js';

export const ANALYTICS_RETENTION_DAYS = Math.round(DAILY_GP_REDIS_TTL_SECONDS / (24 * 60 * 60));
export const ANALYTICS_RETENTION_MONTHS = 13;

const MONTH_TTL_SECONDS = 400 * 24 * 60 * 60;

export const ANALYTICS_MODES = ['daily', 'campaign', 'challenge'] as const;
export type AnalyticsMode = (typeof ANALYTICS_MODES)[number];

export const ANALYTICS_ACTIONS = ['start', 'finish'] as const;
export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];

export type AnalyticsModeCounts = {
    mode: AnalyticsMode;
    starts: number;
    finishes: number;
    players: number;
};

export const PODIUM_ANALYTICS_ACTIONS = ['play', 'replay'] as const;
export type PodiumAnalyticsAction = (typeof PODIUM_ANALYTICS_ACTIONS)[number];

export type AnalyticsDay = {
    date: string;
    players: number;
    newPlayers: number;
    returningPlayers: number;
    guestPlayers: number;
    challengeCreates: number;
    podiumPlays: number;
    podiumReplays: number;
    modes: AnalyticsModeCounts[];
};

export type AnalyticsMonth = {
    month: string;
    players: number;
    newPlayers: number;
    returningPlayers: number;
    guestPlayers: number;
    challengeCreates: number;
    podiumPlays: number;
    podiumReplays: number;
    modes: AnalyticsModeCounts[];
};

export type AnalyticsSummary = {
    from: string;
    to: string;
    today: AnalyticsDay;
    days: AnalyticsDay[];
    months: AnalyticsMonth[];
    cohorts: AnalyticsCohort[];
};

export type AnalyticsCohortRetention = {
    retained: number | null;
    rate: number | null;
};

export type AnalyticsCohort = {
    date: string;
    players: number;
    d1: AnalyticsCohortRetention;
    d2: AnalyticsCohortRetention;
    d3: AnalyticsCohortRetention;
    d7: AnalyticsCohortRetention;
    d14: AnalyticsCohortRetention;
    d30: AnalyticsCohortRetention;
};

const PLAYER_NEW = 'n';
const PLAYER_RETURNING = 'r';
const PLAYER_GUEST = 'g';

type PlayerMark = typeof PLAYER_NEW | typeof PLAYER_RETURNING | typeof PLAYER_GUEST;

type LoadedBucket = {
    players: number;
    newPlayers: number;
    returningPlayers: number;
    guestPlayers: number;
    challengeCreates: number;
    podiumPlays: number;
    podiumReplays: number;
    modes: AnalyticsModeCounts[];
};

function readScopeFromContext(): string | null {
    try {
        return readContextSubredditName();
    } catch {
        return null;
    }
}

function sanitizeScope(subredditName: unknown): string {
    const name = typeof subredditName === 'string' ? subredditName.trim().toLowerCase() : '';
    const safe = name.replace(/[^a-z0-9_]/g, '');
    return safe || 'unknown';
}

function scopedKey(scope: string, ...parts: string[]): string {
    return ['dailygp', 'analytics', scope, ...parts].join(':');
}

function dayPlayersKey(scope: string, date: string): string {
    return scopedKey(scope, 'd', date, 'players');
}

function dayModePlayersKey(scope: string, date: string): string {
    return scopedKey(scope, 'd', date, 'mode-players');
}

function dayCountersKey(scope: string, date: string): string {
    return scopedKey(scope, 'd', date, 'counters');
}

function monthPlayersKey(scope: string, month: string): string {
    return scopedKey(scope, 'm', month, 'players');
}

function monthModePlayersKey(scope: string, month: string): string {
    return scopedKey(scope, 'm', month, 'mode-players');
}

function monthCountersKey(scope: string, month: string): string {
    return scopedKey(scope, 'm', month, 'counters');
}

function firstSeenKey(scope: string): string {
    return scopedKey(scope, 'first-seen');
}

function cohortStartsKey(scope: string): string {
    return scopedKey(scope, 'cohort-starts');
}

function summaryKey(scope: string): string {
    return scopedKey(scope, 'summary');
}

function summaryLockKey(scope: string): string {
    return scopedKey(scope, 'summary-lock');
}

function cohortFillLockKey(scope: string): string {
    return scopedKey(scope, 'cohort-fill-lock');
}

const SUMMARY_READY = 'ready';
const COHORT_OFFSETS = [1, 2, 3, 7, 14, 30] as const;
// Cohorts count live from the first page load of the new counting; earlier days are filled a few at a time.
const COHORTS_LIVE_FROM = 'cohorts-live-from';
const COHORTS_FILLED_THROUGH = 'cohorts-filled-through';
const COHORT_FILL_PAGE = 5000;
const COHORT_FILL_DAYS_AT_ONCE = 8;
const COHORT_FILL_BUDGET_MS = 15_000;
// A race that started before midnight can still add its counts just after midnight.
const COHORT_FILL_SETTLE_MS = 5 * 60 * 1000;
const SUMMARY_LOCK_MS = 3 * 60 * 1000;
const SUMMARY_WRITE_BATCH = 200;

const retentionMemory = new Set<string>();

export function clearAnalyticsMaintenanceMemory(): void {
    retentionMemory.clear();
}

function toMonth(date: string): string {
    return date.slice(0, 7);
}

function isUtcDate(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addUtcDays(date: string, days: number): string {
    return formatUtcChallengeDate(
        new Date(new Date(`${date}T00:00:00.000Z`).getTime() + (days * DAY_MS)),
    );
}

function addUtcMonths(month: string, months: number): string {
    const year = Number(month.slice(0, 4));
    const index = Number(month.slice(5, 7)) - 1 + months;
    const shifted = new Date(Date.UTC(year, index, 1));
    return formatUtcChallengeDate(shifted).slice(0, 7);
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

function buildMonthRange(to: string, count: number): string[] {
    const months: string[] = [];
    for (let index = count - 1; index >= 0; index -= 1) months.push(addUtcMonths(to, -index));
    return months;
}

export {
    sanitizeScope as analyticsScope,
    firstSeenKey,
    dayPlayersKey,
    dayModePlayersKey,
    dayCountersKey,
    monthPlayersKey,
    monthModePlayersKey,
    monthCountersKey,
    cohortStartsKey,
    summaryKey,
};

export function analyticsRetentionWindow(now = new Date()): { dates: string[]; months: string[] } {
    const to = formatUtcChallengeDate(now);
    return {
        dates: buildDateRange(addUtcDays(to, -(ANALYTICS_RETENTION_DAYS - 1)), to),
        months: buildMonthRange(toMonth(to), ANALYTICS_RETENTION_MONTHS),
    };
}

function normalizeMode(mode: unknown): AnalyticsMode | null {
    return ANALYTICS_MODES.includes(mode as AnalyticsMode) ? mode as AnalyticsMode : null;
}

function normalizeAction(action: unknown): AnalyticsAction | null {
    return ANALYTICS_ACTIONS.includes(action as AnalyticsAction) ? action as AnalyticsAction : null;
}

function normalizePodiumAction(action: unknown): PodiumAnalyticsAction | null {
    return PODIUM_ANALYTICS_ACTIONS.includes(action as PodiumAnalyticsAction)
        ? action as PodiumAnalyticsAction
        : null;
}

function classifyPlayerId(playerId: unknown): { id: string; isGuest: boolean } | null {
    if (typeof playerId !== 'string') return null;
    const trimmed = playerId.trim().slice(0, 120);
    if (trimmed.startsWith('reddit:') && trimmed.length > 'reddit:'.length) {
        return { id: trimmed, isGuest: false };
    }
    if (trimmed.startsWith('guest:') && trimmed.length > 'guest:'.length) {
        return { id: trimmed, isGuest: true };
    }
    return null;
}

function toCount(raw: unknown): number {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}

function logAnalyticsFailure(label: string, error: unknown): void {
    console.error(`Mini Racer analytics ${label} failed:`, error);
}

function countField(mode: AnalyticsMode, action: AnalyticsAction): string {
    return `${mode}:${action}`;
}

function emptyModes(): AnalyticsModeCounts[] {
    return ANALYTICS_MODES.map((mode) => ({ mode, starts: 0, finishes: 0, players: 0 }));
}

function emptyBucket(): LoadedBucket {
    return {
        players: 0,
        newPlayers: 0,
        returningPlayers: 0,
        guestPlayers: 0,
        challengeCreates: 0,
        podiumPlays: 0,
        podiumReplays: 0,
        modes: emptyModes(),
    };
}

export function emptyAnalyticsDay(date: string): AnalyticsDay {
    return { date, ...emptyBucket() };
}

async function claimFirstSeen(scope: string, playerId: string, date: string): Promise<boolean> {
    if (!(await redis.hSetNX(firstSeenKey(scope), playerId, date))) return false;

    let knownSince: string | null = null;
    try {
        const profile = await readPlayerProfile(playerId);
        const seen = typeof profile?.firstSeenAt === 'string' ? profile.firstSeenAt.slice(0, 10) : '';
        knownSince = /^\d{4}-\d{2}-\d{2}$/.test(seen) ? seen : null;
    } catch (error) {
        logAnalyticsFailure('first-seen backfill', error);
    }

    if (!knownSince || knownSince >= date) return true;
    await redis.hSet(firstSeenKey(scope), { [playerId]: knownSince });
    return false;
}

function daySummaryPrefix(date: string): string {
    return `d:${date}:`;
}

function monthSummaryPrefix(month: string): string {
    return `m:${month}:`;
}

function wasCreated(result: unknown): boolean {
    return result === 1 || result === true;
}

function cohortField(cohortDate: string): string {
    return `${daySummaryPrefix(cohortDate)}cohort`;
}

function cohortReturnField(cohortDate: string, offset: number): string {
    return `${daySummaryPrefix(cohortDate)}cohort:d${offset}`;
}

function utcDaysBetween(from: string, to: string): number {
    return Math.round(
        (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
    );
}

function cohortReturnFieldFor(cohortDate: unknown, date: string): string | null {
    if (!isUtcDate(cohortDate)) return null;
    const offset = utcDaysBetween(cohortDate, date);
    return (COHORT_OFFSETS as readonly number[]).includes(offset)
        ? cohortReturnField(cohortDate, offset)
        : null;
}

function summaryMetricSuffixes(): string[] {
    return [
        'players',
        'new',
        'returning',
        'guests',
        ...ANALYTICS_MODES.flatMap((mode) => [
            countField(mode, 'start'),
            countField(mode, 'finish'),
            `${mode}:players`,
        ]),
        'challenge:create',
        'podium:play',
        'podium:replay',
        'cohort',
        ...COHORT_OFFSETS.map((offset) => `cohort:d${offset}`),
    ];
}

function uniqueFields(prefix: string, mark: PlayerMark): string[] {
    if (mark === PLAYER_GUEST) return [`${prefix}guests`];
    const fields = [`${prefix}players`];
    if (mark === PLAYER_NEW) fields.push(`${prefix}new`);
    else fields.push(`${prefix}returning`);
    return fields;
}

async function incrementSummary(scope: string, fields: readonly string[]): Promise<void> {
    if (fields.length === 0) return;
    const key = summaryKey(scope);
    await Promise.all(fields.map((field) => redis.hIncrBy(key, field, 1)));
}

async function readCohortReturnField(
    scope: string,
    playerId: string,
    date: string,
): Promise<string | null> {
    try {
        return cohortReturnFieldFor(await redis.hGet(cohortStartsKey(scope), playerId), date);
    } catch (error) {
        logAnalyticsFailure('cohort return', error);
        return null;
    }
}

async function markPlayerPresence(
    scope: string,
    date: string,
    mode: AnalyticsMode,
    player: { id: string; isGuest: boolean },
    cohortStarted: boolean,
): Promise<void> {
    const month = toMonth(date);
    const modeField = `${mode}:${player.id}`;

    const mark: PlayerMark = player.isGuest
        ? PLAYER_GUEST
        : (await claimFirstSeen(scope, player.id, date))
            ? PLAYER_NEW
            : PLAYER_RETURNING;

    const [dayPlayer, dayMode, monthPlayer, monthMode] = await Promise.all([
        redis.hSetNX(dayPlayersKey(scope, date), player.id, mark),
        redis.hSetNX(dayModePlayersKey(scope, date), modeField, mark),
        redis.hSetNX(monthPlayersKey(scope, month), player.id, mark),
        redis.hSetNX(monthModePlayersKey(scope, month), modeField, mark),
    ]);

    const fields: string[] = [];
    if (wasCreated(dayPlayer)) fields.push(...uniqueFields(daySummaryPrefix(date), mark));
    if (wasCreated(monthPlayer)) fields.push(...uniqueFields(monthSummaryPrefix(month), mark));
    if (wasCreated(dayMode) && mark !== PLAYER_GUEST) {
        fields.push(`${daySummaryPrefix(date)}${mode}:players`);
    }
    if (wasCreated(monthMode) && mark !== PLAYER_GUEST) {
        fields.push(`${monthSummaryPrefix(month)}${mode}:players`);
    }
    if (wasCreated(dayPlayer) && mark !== PLAYER_GUEST && !cohortStarted) {
        const returnField = await readCohortReturnField(scope, player.id, date);
        if (returnField) fields.push(returnField);
    }
    await incrementSummary(scope, fields);
}

async function markCohortStart(
    scope: string,
    date: string,
    player: { id: string; isGuest: boolean },
): Promise<boolean> {
    if (player.isGuest) return false;
    try {
        if (!wasCreated(await redis.hSetNX(cohortStartsKey(scope), player.id, date))) return false;
        await incrementSummary(scope, [cohortField(date)]);
        return true;
    } catch (error) {
        logAnalyticsFailure('cohort start', error);
        return false;
    }
}

async function expireOnce(date: string, key: string, ttlSeconds: number): Promise<void> {
    const token = `${date}:${key}`;
    if (retentionMemory.has(token)) return;
    await redis.expire(key, ttlSeconds);
    retentionMemory.add(token);
}

function staleSummaryFields(date: string): string[] {
    const fields: string[] = [];
    const pushPrefix = (prefix: string) => {
        for (const suffix of summaryMetricSuffixes()) {
            fields.push(`${prefix}${suffix}`, `b:${prefix}${suffix}`);
        }
    };
    for (let age = ANALYTICS_RETENTION_DAYS; age < ANALYTICS_RETENTION_DAYS + 14; age += 1) {
        pushPrefix(daySummaryPrefix(addUtcDays(date, -age)));
    }
    const firstExpiredMonth = addUtcMonths(toMonth(date), -ANALYTICS_RETENTION_MONTHS);
    for (let age = 0; age < 3; age += 1) {
        pushPrefix(monthSummaryPrefix(addUtcMonths(firstExpiredMonth, -age)));
    }
    return fields;
}

async function trimSummaryOnce(scope: string, date: string): Promise<void> {
    const token = `${date}:${summaryKey(scope)}:trim`;
    if (retentionMemory.has(token)) return;
    try {
        await redis.hDel(summaryKey(scope), staleSummaryFields(date));
        retentionMemory.add(token);
    } catch (error) {
        logAnalyticsFailure('summary trim', error);
    }
}

async function refreshRollingLedgers(scope: string, date: string): Promise<void> {
    const keys = [firstSeenKey(scope), cohortStartsKey(scope)];
    await Promise.all(keys.map(async (key) => {
        const token = `${date}:${key}`;
        if (retentionMemory.has(token)) return;
        if (!await redis.exists(key)) return;
        await redis.expire(key, MONTH_TTL_SECONDS);
        retentionMemory.add(token);
    }));
}

async function finishAnalyticsWrite(
    scope: string,
    date: string,
    keys: readonly { key: string; ttl: number }[],
): Promise<void> {
    await Promise.all(keys.map(({ key, ttl }) => expireOnce(date, key, ttl)));
    await refreshRollingLedgers(scope, date);
    await trimSummaryOnce(scope, date);
}

function raceRetentionKeys(scope: string, date: string) {
    const month = toMonth(date);
    return [
        { key: dayPlayersKey(scope, date), ttl: DAILY_GP_REDIS_TTL_SECONDS },
        { key: dayModePlayersKey(scope, date), ttl: DAILY_GP_REDIS_TTL_SECONDS },
        { key: monthPlayersKey(scope, month), ttl: MONTH_TTL_SECONDS },
        { key: monthModePlayersKey(scope, month), ttl: MONTH_TTL_SECONDS },
        { key: summaryKey(scope), ttl: MONTH_TTL_SECONDS },
    ];
}

async function bumpCounter(scope: string, date: string, field: string): Promise<void> {
    await incrementSummary(scope, [
        `${daySummaryPrefix(date)}${field}`,
        `${monthSummaryPrefix(toMonth(date))}${field}`,
    ]);
}

export async function recordAnalyticsRace({
    mode,
    action,
    playerId,
    subredditName,
    now = new Date(),
}: {
    mode?: unknown;
    action?: unknown;
    playerId?: unknown;
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<void> {
    try {
        const normalizedMode = normalizeMode(mode);
        const normalizedAction = normalizeAction(action);
        const player = classifyPlayerId(playerId);
        if (!normalizedMode || !normalizedAction || !player) return;

        const scope = sanitizeScope(subredditName ?? readScopeFromContext());
        const date = formatUtcChallengeDate(now);

        const cohortStarted = await markCohortStart(scope, date, player);
        await markPlayerPresence(scope, date, normalizedMode, player, cohortStarted);
        await bumpCounter(scope, date, countField(normalizedMode, normalizedAction));
        await finishAnalyticsWrite(scope, date, raceRetentionKeys(scope, date));
    } catch (error) {
        logAnalyticsFailure('race', error);
    }
}

export function recordAnalyticsRaceBestEffort(
    mode: AnalyticsMode,
    action: AnalyticsAction,
    playerId: unknown,
): void {
    void recordAnalyticsRace({ mode, action, playerId });
}

export async function recordAnalyticsChallengeCreate({
    playerId,
    subredditName,
    now = new Date(),
}: {
    playerId?: unknown;
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<void> {
    try {
        const player = classifyPlayerId(playerId);
        if (!player) return;
        const scope = sanitizeScope(subredditName ?? readScopeFromContext());
        const date = formatUtcChallengeDate(now);
        await bumpCounter(scope, date, 'challenge:create');
        await finishAnalyticsWrite(scope, date, [
            { key: summaryKey(scope), ttl: MONTH_TTL_SECONDS },
        ]);
    } catch (error) {
        logAnalyticsFailure('challenge create', error);
    }
}

export function recordAnalyticsChallengeCreateBestEffort(playerId: unknown): void {
    void recordAnalyticsChallengeCreate({ playerId });
}

export async function recordAnalyticsPodiumEvent({
    action,
    subredditName,
    now = new Date(),
}: {
    action?: unknown;
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<void> {
    try {
        const normalizedAction = normalizePodiumAction(action);
        if (!normalizedAction) return;
        const scope = sanitizeScope(subredditName ?? readScopeFromContext());
        const date = formatUtcChallengeDate(now);
        await bumpCounter(scope, date, `podium:${normalizedAction}`);
        await finishAnalyticsWrite(scope, date, [
            { key: summaryKey(scope), ttl: MONTH_TTL_SECONDS },
        ]);
    } catch (error) {
        logAnalyticsFailure('podium', error);
    }
}

function summarizeBucket(
    rawPlayers: Record<string, string> | undefined,
    rawModePlayers: Record<string, string> | undefined,
    rawCounters: Record<string, string> | undefined,
): LoadedBucket {
    const bucket = emptyBucket();
    const counters = rawCounters || {};

    for (const mark of Object.values(rawPlayers || {})) {
        if (mark === PLAYER_GUEST) {
            bucket.guestPlayers += 1;
            continue;
        }
        bucket.players += 1;
        if (mark === PLAYER_NEW) bucket.newPlayers += 1;
        else bucket.returningPlayers += 1;
    }

    const modePlayers = new Map<AnalyticsMode, number>();
    for (const [field, mark] of Object.entries(rawModePlayers || {})) {
        if (mark === PLAYER_GUEST) continue;
        const mode = normalizeMode(field.slice(0, field.indexOf(':')));
        if (!mode) continue;
        modePlayers.set(mode, (modePlayers.get(mode) || 0) + 1);
    }

    bucket.modes = ANALYTICS_MODES.map((mode) => ({
        mode,
        starts: toCount(counters[countField(mode, 'start')]),
        finishes: toCount(counters[countField(mode, 'finish')]),
        players: modePlayers.get(mode) || 0,
    }));
    bucket.challengeCreates = toCount(counters['challenge:create']);
    bucket.podiumPlays = toCount(counters['podium:play']);
    bucket.podiumReplays = toCount(counters['podium:replay']);
    return bucket;
}

type LegacyBucket = {
    bucket: LoadedBucket;
    hasPresence: boolean;
    hasCounters: boolean;
};

function hashRecord(raw: Record<string, string> | undefined): Record<string, string> {
    return raw || {};
}

async function loadLegacyBucket(
    playersKey: string,
    modeKey: string,
    countersKey: string,
): Promise<LegacyBucket> {
    const [players, modePlayers, counters] = await Promise.all([
        redis.hGetAll(playersKey),
        redis.hGetAll(modeKey),
        redis.hGetAll(countersKey),
    ]);
    const presence = hashRecord(players);
    const modes = hashRecord(modePlayers);
    const counts = hashRecord(counters);
    return {
        bucket: summarizeBucket(presence, modes, counts),
        hasPresence: Object.keys(presence).length > 0 || Object.keys(modes).length > 0,
        hasCounters: Object.keys(counts).length > 0,
    };
}

function summaryCount(raw: Record<string, string>, field: string): number {
    return toCount(raw[field]) + toCount(raw[`b:${field}`]);
}

function readSummaryBucket(raw: Record<string, string>, prefix: string): LoadedBucket {
    const unique = (suffix: string) => toCount(raw[`${prefix}${suffix}`]);
    const count = (suffix: string) => summaryCount(raw, `${prefix}${suffix}`);
    return {
        players: unique('players'),
        newPlayers: unique('new'),
        returningPlayers: unique('returning'),
        guestPlayers: unique('guests'),
        challengeCreates: count('challenge:create'),
        podiumPlays: count('podium:play'),
        podiumReplays: count('podium:replay'),
        modes: ANALYTICS_MODES.map((mode) => ({
            mode,
            starts: count(countField(mode, 'start')),
            finishes: count(countField(mode, 'finish')),
            players: unique(`${mode}:players`),
        })),
    };
}

function counterPairs(bucket: LoadedBucket): [string, number][] {
    return [
        ['challenge:create', bucket.challengeCreates],
        ['podium:play', bucket.podiumPlays],
        ['podium:replay', bucket.podiumReplays],
        ...bucket.modes.flatMap((mode) => [
            [`${mode.mode}:start`, mode.starts],
            [`${mode.mode}:finish`, mode.finishes],
        ] as [string, number][]),
    ];
}

function copyLegacyBucket(
    fields: Record<string, string>,
    current: Record<string, string>,
    prefix: string,
    legacy: LegacyBucket,
): void {
    if (legacy.hasPresence) {
        const { bucket } = legacy;
        fields[`${prefix}players`] = String(bucket.players);
        fields[`${prefix}new`] = String(bucket.newPlayers);
        fields[`${prefix}returning`] = String(bucket.returningPlayers);
        fields[`${prefix}guests`] = String(bucket.guestPlayers);
        for (const mode of bucket.modes) {
            fields[`${prefix}${mode.mode}:players`] = String(mode.players);
        }
    }
    if (!legacy.hasCounters) return;
    for (const [suffix, legacyCount] of counterPairs(legacy.bucket)) {
        if (!legacyCount) continue;
        const baseField = `b:${prefix}${suffix}`;
        if (current[baseField] !== undefined) continue;
        fields[baseField] = String(legacyCount);
    }
}

async function writeSummaryFields(key: string, fields: Record<string, string>): Promise<void> {
    const entries = Object.entries(fields);
    for (let index = 0; index < entries.length; index += SUMMARY_WRITE_BATCH) {
        await redis.hSet(
            key,
            Object.fromEntries(entries.slice(index, index + SUMMARY_WRITE_BATCH)),
        );
    }
}

function analyticsWindow(now: Date) {
    const to = formatUtcChallengeDate(now);
    const from = addUtcDays(to, -(ANALYTICS_RETENTION_DAYS - 1));
    return {
        from,
        to,
        dates: buildDateRange(from, to),
        months: buildMonthRange(toMonth(to), ANALYTICS_RETENTION_MONTHS),
    };
}

async function migrateSummary(scope: string, now: Date): Promise<boolean> {
    const key = summaryKey(scope);
    if (await redis.hGet(key, SUMMARY_READY) === '1') return true;

    const acquired = await redis.set(summaryLockKey(scope), '1', {
        nx: true,
        expiration: new Date(Date.now() + SUMMARY_LOCK_MS),
    });
    if (!acquired) return false;

    try {
        if (await redis.hGet(key, SUMMARY_READY) === '1') return true;
        const current = hashRecord(await redis.hGetAll(key));
        const { dates, months } = analyticsWindow(now);
        const [days, monthBuckets] = await Promise.all([
            Promise.all(dates.map((date) => loadLegacyBucket(
                dayPlayersKey(scope, date),
                dayModePlayersKey(scope, date),
                dayCountersKey(scope, date),
            ))),
            Promise.all(months.map((month) => loadLegacyBucket(
                monthPlayersKey(scope, month),
                monthModePlayersKey(scope, month),
                monthCountersKey(scope, month),
            ))),
        ]);
        const fields: Record<string, string> = {};
        dates.forEach((date, index) => {
            copyLegacyBucket(fields, current, daySummaryPrefix(date), days[index]);
        });
        months.forEach((month, index) => {
            copyLegacyBucket(fields, current, monthSummaryPrefix(month), monthBuckets[index]);
        });
        if (Object.keys(fields).length > 0) await writeSummaryFields(key, fields);
        await redis.hSet(key, { [SUMMARY_READY]: '1' });
        await expireOnce(formatUtcChallengeDate(now), key, MONTH_TTL_SECONDS);
        return true;
    } finally {
        await redis.del(summaryLockKey(scope));
    }
}

function cohortFieldsOwnedBy(date: string, from: string): string[] {
    return [
        cohortField(date),
        ...COHORT_OFFSETS
            .map((offset) => ({ offset, cohortDate: addUtcDays(date, -offset) }))
            .filter(({ cohortDate }) => cohortDate >= from)
            .map(({ offset, cohortDate }) => cohortReturnField(cohortDate, offset)),
    ];
}

async function countCohortDay(
    scope: string,
    date: string,
    from: string,
): Promise<Map<string, number>> {
    const counts = new Map(cohortFieldsOwnedBy(date, from).map((field) => [field, 0]));
    const seen = new Set<string>();
    let cursor = 0;
    do {
        const page = await redis.hScan(dayPlayersKey(scope, date), cursor, undefined, COHORT_FILL_PAGE);
        // HSCAN can return a field twice.
        const players: string[] = [];
        for (const { field, value } of page.fieldValues) {
            if (value === PLAYER_GUEST || !field.startsWith('reddit:') || seen.has(field)) continue;
            seen.add(field);
            players.push(field);
        }
        for (let index = 0; index < players.length; index += COHORT_FILL_PAGE) {
            const starts = await redis.hMGet(
                cohortStartsKey(scope),
                players.slice(index, index + COHORT_FILL_PAGE),
            );
            for (const start of starts) {
                const field = start === date ? cohortField(date) : cohortReturnFieldFor(start, date);
                if (field && counts.has(field)) counts.set(field, (counts.get(field) || 0) + 1);
            }
        }
        cursor = page.cursor;
    } while (cursor !== 0);
    return counts;
}

async function fillCohortCounts(scope: string, now: Date): Promise<void> {
    const key = summaryKey(scope);
    const { from, to, dates } = analyticsWindow(now);
    const [liveFrom, filledThrough] = await redis.hMGet(key, [COHORTS_LIVE_FROM, COHORTS_FILLED_THROUGH]);
    if (!isUtcDate(liveFrom)) await redis.hSetNX(key, COHORTS_LIVE_FROM, to);
    const lastSettledDay = addUtcDays(
        formatUtcChallengeDate(new Date(now.getTime() - COHORT_FILL_SETTLE_MS)),
        -1,
    );
    const fillEnd = isUtcDate(liveFrom) && liveFrom < lastSettledDay ? liveFrom : lastSettledDay;
    if ((filledThrough ?? '') >= fillEnd) return;

    const acquired = await redis.set(cohortFillLockKey(scope), '1', {
        nx: true,
        expiration: new Date(Date.now() + SUMMARY_LOCK_MS),
    });
    if (!acquired) return;

    try {
        const done = (await redis.hGet(key, COHORTS_FILLED_THROUGH)) ?? '';
        const pending = dates.filter((date) => date > done && date <= fillEnd);
        const startedAt = Date.now();
        for (let index = 0; index < pending.length; index += COHORT_FILL_DAYS_AT_ONCE) {
            if (Date.now() - startedAt > COHORT_FILL_BUDGET_MS) return;
            const batch = pending.slice(index, index + COHORT_FILL_DAYS_AT_ONCE);
            const counts = await Promise.all(batch.map((date) => countCohortDay(scope, date, from)));
            const fields: Record<string, string> = {};
            const empty: string[] = [];
            for (const [field, count] of counts.flatMap((dayCounts) => [...dayCounts])) {
                if (count > 0) fields[field] = String(count);
                else empty.push(field);
            }
            if (Object.keys(fields).length > 0) await writeSummaryFields(key, fields);
            if (empty.length > 0) await redis.hDel(key, empty);
            await redis.hSet(key, { [COHORTS_FILLED_THROUGH]: batch[batch.length - 1] });
        }
    } finally {
        await redis.del(cohortFillLockKey(scope));
    }
}

function readCohorts(
    summary: Record<string, string>,
    dates: readonly string[],
    to: string,
): AnalyticsCohort[] {
    const filledThrough = summary[COHORTS_FILLED_THROUGH] ?? '';
    const liveFrom = summary[COHORTS_LIVE_FROM] ?? '';
    // Days the fill has not reached are partial; the first new-counting day also waits for the fill.
    const counted = (date: string) => date <= filledThrough || date > liveFrom;
    const retention = (
        cohortDate: string,
        offset: number,
        players: number,
    ): AnalyticsCohortRetention => {
        const returnDate = addUtcDays(cohortDate, offset);
        if (returnDate > to || !counted(returnDate)) return { retained: null, rate: null };
        const retained = toCount(summary[cohortReturnField(cohortDate, offset)]);
        return { retained, rate: Math.round((retained / players) * 1000) / 10 };
    };
    return dates.flatMap((date) => {
        const players = toCount(summary[cohortField(date)]);
        if (players === 0 || !counted(date)) return [];
        return [{
            date,
            players,
            d1: retention(date, 1, players),
            d2: retention(date, 2, players),
            d3: retention(date, 3, players),
            d7: retention(date, 7, players),
            d14: retention(date, 14, players),
            d30: retention(date, 30, players),
        }];
    });
}

function visibleMonth(month: AnalyticsMonth): boolean {
    return month.players > 0
        || month.guestPlayers > 0
        || month.podiumPlays > 0
        || month.podiumReplays > 0;
}

async function buildSummaryFromHash(scope: string, now: Date): Promise<AnalyticsSummary> {
    const { from, to, dates, months } = analyticsWindow(now);
    const summary = hashRecord(await redis.hGetAll(summaryKey(scope)));
    const days = dates.map((date) => ({ date, ...readSummaryBucket(summary, daySummaryPrefix(date)) }));
    return {
        from,
        to,
        today: days[days.length - 1] ?? emptyAnalyticsDay(to),
        days,
        cohorts: readCohorts(summary, dates, to),
        months: months
            .map((month) => ({ month, ...readSummaryBucket(summary, monthSummaryPrefix(month)) }))
            .filter(visibleMonth),
    };
}

async function buildLegacySummary(scope: string, now: Date): Promise<AnalyticsSummary> {
    const { from, to, dates, months } = analyticsWindow(now);
    const [days, monthBuckets, rawSummary] = await Promise.all([
        Promise.all(dates.map((date) => loadLegacyBucket(
            dayPlayersKey(scope, date),
            dayModePlayersKey(scope, date),
            dayCountersKey(scope, date),
        ))),
        Promise.all(months.map((month) => loadLegacyBucket(
            monthPlayersKey(scope, month),
            monthModePlayersKey(scope, month),
            monthCountersKey(scope, month),
        ))),
        redis.hGetAll(summaryKey(scope)),
    ]);
    const loadedDays = dates.map((date, index) => ({ date, ...days[index].bucket }));
    return {
        from,
        to,
        today: loadedDays[loadedDays.length - 1] ?? emptyAnalyticsDay(to),
        days: loadedDays,
        cohorts: readCohorts(hashRecord(rawSummary), dates, to),
        months: months
            .map((month, index) => ({ month, ...monthBuckets[index].bucket }))
            .filter(visibleMonth),
    };
}

export async function getServerAnalyticsSummary({
    subredditName,
    now = new Date(),
}: {
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<AnalyticsSummary> {
    const scope = sanitizeScope(subredditName ?? readScopeFromContext());
    const ready = await redis.hGet(summaryKey(scope), SUMMARY_READY);
    if (ready !== '1') {
        const migrated = await migrateSummary(scope, now);
        if (!migrated) return buildLegacySummary(scope, now);
    }
    try {
        await fillCohortCounts(scope, now);
    } catch (error) {
        logAnalyticsFailure('cohort fill', error);
    }
    return buildSummaryFromHash(scope, now);
}
