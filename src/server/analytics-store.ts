import { redis } from '@devvit/redis';
import { readContextSubredditName } from './request-context.js';
import { readPlayerProfile } from './competition-identity.js';
import {
    DAILY_GP_REDIS_TTL_SECONDS,
    DAY_MS,
    formatUtcChallengeDate,
} from './daily-gp-model.js';

export const ANALYTICS_RETENTION_DAYS = Math.round(DAILY_GP_REDIS_TTL_SECONDS / (24 * 60 * 60));
export const ANALYTICS_RETENTION_MONTHS = 13;

// Months outlive the daily keys: a month-over-month comparison is worthless if the
// history evaporates after six weeks.
const MONTH_TTL_SECONDS = 400 * 24 * 60 * 60;

export const ANALYTICS_MODES = ['daily', 'campaign', 'challenge'] as const;
export type AnalyticsMode = (typeof ANALYTICS_MODES)[number];

/** Every mode reports the same two events, so the modes can be compared to each other. */
export const ANALYTICS_ACTIONS = ['start', 'finish'] as const;
export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];

export type AnalyticsModeCounts = {
    mode: AnalyticsMode;
    starts: number;
    finishes: number;
    players: number;
};

export type AnalyticsDay = {
    date: string;
    players: number;
    newPlayers: number;
    returningPlayers: number;
    guestPlayers: number;
    challengeCreates: number;
    modes: AnalyticsModeCounts[];
};

export type AnalyticsMonth = {
    month: string;
    players: number;
    newPlayers: number;
    returningPlayers: number;
    guestPlayers: number;
    challengeCreates: number;
    modes: AnalyticsModeCounts[];
};

export type AnalyticsSummary = {
    from: string;
    to: string;
    today: AnalyticsDay;
    days: AnalyticsDay[];
    months: AnalyticsMonth[];
};

// A signed-in account is the only identity that survives a new device, a cleared
// browser, or a partitioned webview, so it is the only one allowed to be "a player".
// Signed-out visitors are counted separately and never folded into the total.
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
    modes: AnalyticsModeCounts[];
};

// Reading the request context throws outside a request. A default parameter would evaluate
// before the try block and take the caller down with it, so the lookup is guarded here.
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

function toMonth(date: string): string {
    return date.slice(0, 7);
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

function normalizeMode(mode: unknown): AnalyticsMode | null {
    return ANALYTICS_MODES.includes(mode as AnalyticsMode) ? mode as AnalyticsMode : null;
}

function normalizeAction(action: unknown): AnalyticsAction | null {
    return ANALYTICS_ACTIONS.includes(action as AnalyticsAction) ? action as AnalyticsAction : null;
}

/**
 * Only a canonical id is usable here. A raw uuid from browser storage is not an
 * identity, and folding one into the player count is what made the old number junk.
 */
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
        modes: emptyModes(),
    };
}

export function emptyAnalyticsDay(date: string): AnalyticsDay {
    return { date, ...emptyBucket() };
}

/**
 * The ledger is the authority on new vs returning, not the player profile: a profile is
 * recreated when a guest signs in, which booked month-old players as brand new. But an
 * empty ledger would report every established player as new on the day it ships, so the
 * first claim backfills itself from the account's own first-seen date.
 *
 * Returns true only for a player with no earlier history anywhere.
 */
async function claimFirstSeen(scope: string, playerId: string, date: string): Promise<boolean> {
    if (!(await redis.hSetNX(firstSeenKey(scope), playerId, date))) return false;

    let knownSince: string | null = null;
    try {
        const profile = await readPlayerProfile(playerId);
        const seen = typeof profile?.firstSeenAt === 'string' ? profile.firstSeenAt.slice(0, 10) : '';
        knownSince = /^\d{4}-\d{2}-\d{2}$/.test(seen) ? seen : null;
    } catch (error) {
        // An unreadable profile only costs this player a "new" label, never their race.
        logAnalyticsFailure('first-seen backfill', error);
    }

    if (!knownSince || knownSince >= date) return true;
    await redis.hSet(firstSeenKey(scope), { [playerId]: knownSince });
    return false;
}

/**
 * A player is marked once per bucket. The mark itself carries the new/returning verdict,
 * so every figure on the page derives from one hash and the totals cannot drift apart.
 */
async function markPlayerPresence(
    scope: string,
    date: string,
    mode: AnalyticsMode,
    player: { id: string; isGuest: boolean },
): Promise<void> {
    const month = toMonth(date);
    const modeField = `${mode}:${player.id}`;

    const mark: PlayerMark = player.isGuest
        ? PLAYER_GUEST
        : (await claimFirstSeen(scope, player.id, date))
            ? PLAYER_NEW
            : PLAYER_RETURNING;

    await Promise.all([
        redis.hSetNX(dayPlayersKey(scope, date), player.id, mark),
        redis.hSetNX(dayModePlayersKey(scope, date), modeField, mark),
        redis.hSetNX(monthPlayersKey(scope, month), player.id, mark),
        redis.hSetNX(monthModePlayersKey(scope, month), modeField, mark),
    ]);
}

async function applyRetention(scope: string, date: string): Promise<void> {
    const month = toMonth(date);
    await Promise.all([
        redis.expire(dayPlayersKey(scope, date), DAILY_GP_REDIS_TTL_SECONDS),
        redis.expire(dayModePlayersKey(scope, date), DAILY_GP_REDIS_TTL_SECONDS),
        redis.expire(dayCountersKey(scope, date), DAILY_GP_REDIS_TTL_SECONDS),
        redis.expire(monthPlayersKey(scope, month), MONTH_TTL_SECONDS),
        redis.expire(monthModePlayersKey(scope, month), MONTH_TTL_SECONDS),
        redis.expire(monthCountersKey(scope, month), MONTH_TTL_SECONDS),
        redis.expire(firstSeenKey(scope), MONTH_TTL_SECONDS),
    ]);
}

async function bumpCounter(scope: string, date: string, field: string): Promise<void> {
    await Promise.all([
        redis.hIncrBy(dayCountersKey(scope, date), field, 1),
        redis.hIncrBy(monthCountersKey(scope, toMonth(date)), field, 1),
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

        // A finish also marks presence: it proves the player raced even if the start write was lost.
        await markPlayerPresence(scope, date, normalizedMode, player);
        await bumpCounter(scope, date, countField(normalizedMode, normalizedAction));
        await applyRetention(scope, date);
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
        await applyRetention(scope, date);
    } catch (error) {
        logAnalyticsFailure('challenge create', error);
    }
}

export function recordAnalyticsChallengeCreateBestEffort(playerId: unknown): void {
    void recordAnalyticsChallengeCreate({ playerId });
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
    return bucket;
}

async function loadAnalyticsDay(scope: string, date: string): Promise<AnalyticsDay> {
    const [players, modePlayers, counters] = await Promise.all([
        redis.hGetAll(dayPlayersKey(scope, date)),
        redis.hGetAll(dayModePlayersKey(scope, date)),
        redis.hGetAll(dayCountersKey(scope, date)),
    ]);
    return { date, ...summarizeBucket(players, modePlayers, counters) };
}

async function loadAnalyticsMonth(scope: string, month: string): Promise<AnalyticsMonth> {
    const [players, modePlayers, counters] = await Promise.all([
        redis.hGetAll(monthPlayersKey(scope, month)),
        redis.hGetAll(monthModePlayersKey(scope, month)),
        redis.hGetAll(monthCountersKey(scope, month)),
    ]);
    return { month, ...summarizeBucket(players, modePlayers, counters) };
}

export async function getServerAnalyticsSummary({
    subredditName,
    now = new Date(),
}: {
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<AnalyticsSummary> {
    const scope = sanitizeScope(subredditName ?? readScopeFromContext());
    const to = formatUtcChallengeDate(now);
    const from = addUtcDays(to, -(ANALYTICS_RETENTION_DAYS - 1));
    const [days, months] = await Promise.all([
        Promise.all(buildDateRange(from, to).map((date) => loadAnalyticsDay(scope, date))),
        Promise.all(
            buildMonthRange(toMonth(to), ANALYTICS_RETENTION_MONTHS)
                .map((month) => loadAnalyticsMonth(scope, month)),
        ),
    ]);

    return {
        from,
        to,
        today: days[days.length - 1] ?? emptyAnalyticsDay(to),
        days,
        months: months.filter((month) => month.players > 0 || month.guestPlayers > 0),
    };
}
