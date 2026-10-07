import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
    BlobCallTimeoutError,
    BlobDeadlineError,
    BlobListTokenRejectedError,
    createBlobSession,
    createDevvitBlobStore,
    SYSTEM_BLOB_CLOCK,
    type BlobClock,
    type BlobSession,
    type BlobStore,
} from '../blob/blob-store.js';
import { challengeCollectionKey, isPbGhostArchiveRef, type PbGhostArchiveRef } from '../competition/pb-ghost-store.js';
import { isValidPbGhostTrace } from '../competition/pb-ghost-trace.js';
import {
    guestProgressSelectionAccountPendingKeyForHash,
    guestProgressSelectionPendingKeyForHash,
} from '../player/guest-retirement.js';
import { decodeRedisCompressedValue, encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from '../redis/redis-lock.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';
import {
    createRedisChallengeStandingsRevisionKey,
    DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
} from './daily-gp-model.js';

// Moves the ghosts of old Daily days to blob storage. A day's ghosts move on
// its 8th day, after the podium window closes. A ghost leaves Redis only after
// its blob copy was read back and matched. The run keeps its time, splits and
// every other field in Redis, with `ghost: null` and a reference to the copy.
//
// Only the old-day writers can change a moved day: a sign-in copies or keeps
// rows, and the clean-ups delete them. Each of them raises the day's standings
// revision in the same transaction, so a pass that ends on the revision it
// started with has seen every row.

export type DailyGhostArchiveMode = 'off' | 'move' | 'restore';

// What a moderator picks in the subreddit menu. Each install keeps its own
// choice, because each install has its own Redis and its own blob storage.
// 'off' does nothing, and pauses a sweep. 'trial' moves one day only.
// 'restore' writes every moved ghost back to Redis and deletes nothing.
export type DailyGhostArchiveChoice = 'off' | 'trial' | 'all' | 'restore';

export const DAILY_GHOST_ARCHIVE_CHOICES: readonly { value: DailyGhostArchiveChoice; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'trial', label: 'Move one day (trial)' },
    { value: 'all', label: 'Move all old days' },
    { value: 'restore', label: 'Restore all to Redis' },
];

export function isDailyGhostArchiveChoice(value: unknown): value is DailyGhostArchiveChoice {
    return DAILY_GHOST_ARCHIVE_CHOICES.some((choice) => choice.value === value);
}

export function dailyGhostArchiveRunFor(choice: DailyGhostArchiveChoice): {
    mode: DailyGhostArchiveMode;
    dayLimit: number | null;
} {
    if (choice === 'trial') return { mode: 'move', dayLimit: 1 };
    if (choice === 'all') return { mode: 'move', dayLimit: null };
    return { mode: choice, dayLimit: null };
}

// Raise after a rollback to an older app version: every done day is checked
// again, because an older version may change a day without raising its
// revision.
export const DAILY_GHOST_ARCHIVE_EPOCH = 1;

const KEY_PREFIX = 'dailygp:ghost-archive:v1';
export const DAILY_GHOST_ARCHIVE_LOCK_KEY = `${KEY_PREFIX}:lock`;
export const DAILY_GHOST_ARCHIVE_DAYS_KEY = `${KEY_PREFIX}:days`;
export const DAILY_GHOST_ARCHIVE_TOTALS_KEY = `${KEY_PREFIX}:totals`;
export const DAILY_GHOST_ARCHIVE_SETTING_KEY = `${KEY_PREFIX}:setting`;
// The last refusal from blob storage, shown on the moderator page until a
// request goes through again.
export const DAILY_GHOST_ARCHIVE_BLOB_ERROR_KEY = `${KEY_PREFIX}:blob-error`;
const BLOB_ERROR_LOGGED_KEY = `${KEY_PREFIX}:blob-error-logged`;
const BLOB_ERROR_LOG_EVERY_MS = 60 * 60 * 1000;

export type DailyGhostArchiveSetting = {
    choice: DailyGhostArchiveChoice;
    changedAt: string | null;
    changedBy: string | null;
};

export async function readDailyGhostArchiveSetting(): Promise<DailyGhostArchiveSetting> {
    const value = parseJsonObject(await redis.get(DAILY_GHOST_ARCHIVE_SETTING_KEY));
    return {
        choice: isDailyGhostArchiveChoice(value?.choice) ? value.choice : 'off',
        changedAt: typeof value?.changedAt === 'string' ? value.changedAt : null,
        changedBy: typeof value?.changedBy === 'string' ? value.changedBy : null,
    };
}

export async function saveDailyGhostArchiveSetting(
    choice: DailyGhostArchiveChoice,
    changedBy: string,
    now = new Date(),
): Promise<DailyGhostArchiveSetting> {
    const setting = { choice, changedAt: now.toISOString(), changedBy };
    await redis.set(DAILY_GHOST_ARCHIVE_SETTING_KEY, JSON.stringify(setting));
    return setting;
}

export function dailyGhostArchivePageKey(challengeId: string): string {
    return `${KEY_PREFIX}:page:${challengeId}`;
}

export function dailyGhostArchiveHeldKey(challengeId: string): string {
    return `${KEY_PREFIX}:held:${challengeId}`;
}

export function dailyGhostArchiveSweepRefsKey(challengeId: string): string {
    return `${KEY_PREFIX}:sweep-refs:${challengeId}`;
}

const BLOB_PREFIX = 'daily-ghosts/v1';

export function dailyGhostBlobPrefix(challengeId: string): string {
    return `${BLOB_PREFIX}/${challengeId}/`;
}

export function dailyGhostBlobKey(challengeId: string, field: string, sha256: string): string {
    return `${dailyGhostBlobPrefix(challengeId)}${field}-${sha256.slice(0, 16)}.gz`;
}

const LOCK_TTL_MS = 55_000;
// Blob calls end by T + 22 s; Redis commits start by T + 25 s. Reddit stops a
// request at 30 s.
const BLOB_WORK_MS = 22_000;
const COMMIT_UNTIL_MS = 25_000;
const UPKEEP_RESERVE_MS = 6_000;
const UPKEEP_EVERY_MS = 60 * 60 * 1000;
const PASS_RETRY_MS = 60 * 60 * 1000;
// The final podium may read a closed day's top three ghosts for 6 hours.
const PODIUM_WINDOW_MS = 6 * 60 * 60 * 1000;
const SCAN_COUNT = 200;
const SLICE_SIZE = 25;
const SWEEP_LIST_PAGE = 200;
// An unreferenced object this much younger than the sweep's snapshot may be
// an upload whose stub is not committed yet, so it is kept for a later sweep.
const SWEEP_GRACE_MS = 60 * 60 * 1000;
const SWEEP_RETRY_MARGIN_MS = 5 * 60 * 1000;
// After a damaged reference, the next sweep waits this long.
const SWEEP_DAMAGED_WAIT_MS = 24 * 60 * 60 * 1000;
const WORKERS = 8;
const STEP_MARGIN_MS = 1_000;
const MAX_SLICE_COMMITS = 2;

type DayState = 'moving' | 'waiting' | 'done' | 'restoring' | 'restored';

export type DailyGhostArchiveSweep = {
    phase: 'refs' | 'list';
    modeSerial: number;
    startedAt: number;
    revision: number;
    refsCursor: number;
    pageToken: string | null;
    nextToken: string | null;
    lastKey: string | null;
    kept: number;
    keptBytes: number;
    youngOrphanUntil: number;
    deleted: number;
};
type Direction = 'move' | 'restore';

export type DailyGhostArchiveDay = {
    state: DayState;
    // True while a pass is open on the day.
    active: boolean;
    mode: Direction;
    modeSerial: number;
    pass: number;
    passRevision: number;
    cursor: number;
    scanned: boolean;
    nextPassAt: number;
    doneRevision: number | null;
    hasHeld: boolean;
    heldThisPass: number;
    failedThisPass: number;
    sweepNeeded: boolean;
    nextSweepAt: number | null;
    sweep: DailyGhostArchiveSweep | null;
    blob: { objects: number; bytes: number; measuredAt: number } | null;
    moved: number;
    restored: number;
    freed: number;
    lastError: string | null;
    updatedAt: number;
};

export type DailyGhostArchiveTotals = {
    moved: number;
    restored: number;
    freed: number;
    deleted: number;
    epoch: number;
    lastMode: DailyGhostArchiveMode | null;
    modeSerial: number;
    upkeepAt: number;
};

const EMPTY_TOTALS: DailyGhostArchiveTotals = {
    moved: 0,
    restored: 0,
    freed: 0,
    deleted: 0,
    epoch: 0,
    lastMode: null,
    modeSerial: 0,
    upkeepAt: 0,
};

function emptyDay(): DailyGhostArchiveDay {
    return {
        state: 'waiting',
        active: false,
        mode: 'move',
        modeSerial: 0,
        pass: 0,
        passRevision: 0,
        cursor: 0,
        scanned: false,
        nextPassAt: 0,
        doneRevision: null,
        hasHeld: false,
        heldThisPass: 0,
        failedThisPass: 0,
        sweepNeeded: false,
        nextSweepAt: null,
        sweep: null,
        blob: null,
        moved: 0,
        restored: 0,
        freed: 0,
        lastError: null,
        updatedAt: 0,
    };
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_error) {
        return null;
    }
}

function parseDay(raw: unknown): DailyGhostArchiveDay | null {
    const value = parseJsonObject(raw);
    return value ? { ...emptyDay(), ...value } as DailyGhostArchiveDay : null;
}

function parseTotals(raw: unknown): DailyGhostArchiveTotals {
    const value = parseJsonObject(raw);
    return value ? { ...EMPTY_TOTALS, ...value } as DailyGhostArchiveTotals : { ...EMPTY_TOTALS };
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function markerKeys(field: string): string[] {
    return [
        guestProgressSelectionPendingKeyForHash(field),
        guestProgressSelectionAccountPendingKeyForHash(field),
    ];
}

// A stored run, read through the plain client. Null when it is not a run.
function readRun(raw: unknown): { text: string; value: Record<string, unknown> } | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const text = decodeRedisCompressedValue(raw);
        const value = parseJsonObject(text);
        return value ? { text, value } : null;
    } catch (_error) {
        return null;
    }
}

function holdsFullGhost(run: { value: Record<string, unknown> } | null): boolean {
    return Boolean(run && isValidPbGhostTrace(run.value.ghost));
}

function isStub(run: { value: Record<string, unknown> } | null): boolean {
    return Boolean(run && (run.value.ghost === null || run.value.ghost === undefined)
        && isPbGhostArchiveRef(run.value.ghostArchive));
}

// The text left in Redis after the ghost moved: every field as it was, the
// ghost replaced by the reference.
export function buildDailyGhostStub(fullText: string, ref: PbGhostArchiveRef): string {
    const value = JSON.parse(fullText) as Record<string, unknown>;
    value.ghost = null;
    value.ghostArchive = ref;
    return JSON.stringify(value);
}

// A ghost so small that its stub would take as much room stays in Redis:
// moving it would save nothing.
function stubIsSmaller(challengeId: string, name: string, raw: string, text: string): boolean {
    const sha256 = sha256Hex(text);
    const stub = encodeRedisCompressedValue(
        buildDailyGhostStub(text, { v: 1, key: dailyGhostBlobKey(challengeId, name, sha256), sha256 }),
    );
    return Buffer.byteLength(stub, 'utf8') < Buffer.byteLength(raw, 'utf8');
}

type StoredDay = { id: string; availableUntilMs: number };

// Every stored day, oldest first. Only the id and the end of play matter
// here, so a day is kept even when its track is not loaded.
async function readStoredDays(): Promise<StoredDay[]> {
    const raw = await redis.hGetAll(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY);
    const days: StoredDay[] = [];
    for (const value of Object.values(raw ?? {})) {
        const challenge = parseJsonObject(value);
        const id = typeof challenge?.id === 'string' ? challenge.id : '';
        const availableUntilMs = Date.parse(String(challenge?.availableUntil ?? ''));
        if (/^daily-gp-\d{4}-\d{2}-\d{2}$/.test(id) && Number.isFinite(availableUntilMs)) {
            days.push({ id, availableUntilMs });
        }
    }
    return days.sort((a, b) => a.availableUntilMs - b.availableUntilMs || a.id.localeCompare(b.id));
}

async function readRevision(challengeId: string): Promise<number> {
    const value = Number(await redis.get(createRedisChallengeStandingsRevisionKey(challengeId)));
    return Number.isFinite(value) ? value : 0;
}

type RunContext = {
    lock: RedisLock;
    mode: Direction;
    serial: number;
    clock: BlobClock;
    session: BlobSession;
    startMs: number;
    commitUntilMs: number;
    // New work starts only until this time. Blob calls must still end by the
    // session deadline.
    startUntilMs: number;
    days: Map<string, DailyGhostArchiveDay>;
    totals: DailyGhostArchiveTotals;
    lockLost: boolean;
    stuck: Set<string>;
    report: DailyGhostArchiveReport;
};

export type DailyGhostArchiveReport = {
    status: 'off' | 'busy' | 'worked' | 'lock_lost' | 'blob_refused';
    moved: number;
    restored: number;
    held: number;
    failed: number;
    passesEnded: number;
};

function canStep(ctx: RunContext): boolean {
    return !ctx.lockLost && ctx.clock.now() + STEP_MARGIN_MS <= ctx.startUntilMs;
}

// A moved ghost needs an upload and a read-back; a restored one needs one
// read. All of a ghost's calls must end by the deadline.
function canStartGhost(ctx: RunContext, calls = ctx.mode === 'restore' ? 1 : 2): boolean {
    return !ctx.lockLost
        && ctx.clock.now() <= ctx.startUntilMs
        && ctx.session.hasTimeFor(calls);
}

function canCommit(ctx: RunContext): boolean {
    return !ctx.lockLost && ctx.clock.now() <= ctx.commitUntilMs;
}

// Runs `mutate` in a transaction that holds the job lock. Returns false when
// the lock was lost or a watched key changed.
async function commitOwned(
    ctx: RunContext,
    mutate: (transaction: Awaited<ReturnType<typeof redis.watch>>) => Promise<void>,
    {
        watchedKeys = [],
        check,
    }: { watchedKeys?: string[]; check?: () => Promise<void> } = {},
): Promise<boolean> {
    if (!canCommit(ctx)) return false;
    let transaction: Awaited<ReturnType<typeof redis.watch>> | null;
    try {
        transaction = await beginOwnedRedisLockTransaction(ctx.lock, redis, { watchedKeys, check });
    } catch (error) {
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
    if (!transaction) {
        ctx.lockLost = true;
        return false;
    }
    try {
        await mutate(transaction);
        const results = await transaction.exec();
        return Array.isArray(results) && results.length > 0;
    } catch (error) {
        try {
            await transaction.discard();
        } catch (_discardError) {
        }
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
}

async function saveDay(
    ctx: RunContext,
    challengeId: string,
    next: DailyGhostArchiveDay,
    extra?: (transaction: Awaited<ReturnType<typeof redis.watch>>) => Promise<void>,
): Promise<boolean> {
    const stamped = { ...next, updatedAt: ctx.clock.now() };
    const saved = await commitOwned(ctx, async (transaction) => {
        if (extra) await extra(transaction);
        await transaction.hSet(DAILY_GHOST_ARCHIVE_DAYS_KEY, { [challengeId]: JSON.stringify(stamped) });
    });
    if (saved) ctx.days.set(challengeId, stamped);
    return saved;
}

async function saveTotals(ctx: RunContext, next: DailyGhostArchiveTotals): Promise<boolean> {
    const saved = await commitOwned(ctx, async (transaction) => {
        await transaction.set(DAILY_GHOST_ARCHIVE_TOTALS_KEY, JSON.stringify(next));
    });
    if (saved) ctx.totals = next;
    return saved;
}

// Reopens a done day for a check pass. A sweep in progress is dropped.
async function reopenDay(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId);
    if (!day) return false;
    return saveDay(ctx, challengeId, {
        ...day,
        state: 'waiting',
        active: false,
        nextPassAt: 0,
        sweep: null,
        sweepNeeded: true,
    }, async (transaction) => {
        await transaction.del(dailyGhostArchiveSweepRefsKey(challengeId));
    });
}

async function startPass(ctx: RunContext, challengeId: string): Promise<boolean> {
    const previous = ctx.days.get(challengeId) ?? emptyDay();
    const revision = await readRevision(challengeId);
    return saveDay(ctx, challengeId, {
        ...previous,
        state: ctx.mode === 'move' ? 'moving' : 'restoring',
        active: true,
        mode: ctx.mode,
        modeSerial: ctx.serial,
        pass: previous.pass + 1,
        passRevision: revision,
        cursor: 0,
        scanned: false,
        nextPassAt: 0,
        heldThisPass: 0,
        failedThisPass: 0,
        sweep: null,
        sweepNeeded: ctx.mode === 'move' ? true : previous.sweepNeeded,
    }, async (transaction) => {
        await transaction.del(dailyGhostArchivePageKey(challengeId));
        await transaction.del(dailyGhostArchiveSweepRefsKey(challengeId));
    });
}

// A run a pass in this direction must change.
function wanted(direction: Direction, raw: unknown): boolean {
    const run = readRun(raw);
    return direction === 'move' ? holdsFullGhost(run) : isStub(run);
}

async function scanPage(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const page = await redis.hScan(challengeCollectionKey(challengeId), day.cursor, undefined, SCAN_COUNT);
    const names = page.fieldValues
        .filter((row) => wanted(day.mode, row.value))
        .map((row) => row.field);
    return saveDay(ctx, challengeId, { ...day, cursor: page.cursor, scanned: true }, async (transaction) => {
        if (names.length) {
            await transaction.hSet(
                dailyGhostArchivePageKey(challengeId),
                Object.fromEntries(names.map((name) => [name, '1'])),
            );
        }
    });
}

type Conversion = {
    name: string;
    expectedRaw: string;
    nextRaw: string;
};

type SliceOutcome = {
    // What blob storage said the first time a call failed, for the log.
    firstError?: string;
    ready: Conversion[];
    // Rows that need nothing: gone, already in the wanted form, or not a run.
    drop: string[];
    failed: { name: string; code: string }[];
    // Rows whose player had a sign-in in progress before any blob call.
    marked?: string[];
};

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function failureCode(error: unknown, step: 'upload' | 'confirm_read'): string | null {
    if (error instanceof BlobDeadlineError) return null;
    if (error instanceof BlobCallTimeoutError) return 'timeout';
    return step;
}

async function forEachWorker<Item>(items: readonly Item[], run: (item: Item) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            await run(item);
        }
    }));
}

// Uploads each full ghost, reads it back and compares it. Only a ghost whose
// copy matches byte for byte is ready to leave Redis.
async function prepareMoves(
    ctx: RunContext,
    challengeId: string,
    names: readonly string[],
    raws: readonly (string | null | undefined)[],
): Promise<SliceOutcome> {
    const outcome: SliceOutcome = { ready: [], drop: [], failed: [] };
    const candidates: { name: string; raw: string; text: string }[] = [];
    names.forEach((name, index) => {
        const raw = raws[index];
        const run = readRun(raw);
        if (typeof raw !== 'string' || !holdsFullGhost(run) || !stubIsSmaller(challengeId, name, raw, run!.text)) {
            outcome.drop.push(name);
        } else {
            candidates.push({ name, raw, text: run!.text });
        }
    });

    await forEachWorker(candidates, async ({ name, raw, text }) => {
        if (!canStartGhost(ctx)) return;
        const sha256 = sha256Hex(text);
        const key = dailyGhostBlobKey(challengeId, name, sha256);
        try {
            await ctx.session.put(key, new Uint8Array(gzipSync(Buffer.from(text, 'utf8'))));
        } catch (error) {
            const code = failureCode(error, 'upload');
            if (code) {
                outcome.failed.push({ name, code });
                outcome.firstError ??= errorText(error);
            }
            return;
        }
        if (!ctx.session.hasTimeFor(1)) return;
        let copy: Uint8Array | null;
        try {
            copy = await ctx.session.get(key);
        } catch (error) {
            const code = failureCode(error, 'confirm_read');
            if (code) {
                outcome.failed.push({ name, code });
                outcome.firstError ??= errorText(error);
            }
            return;
        }
        let copyText: string | null = null;
        try {
            copyText = copy ? gunzipSync(copy).toString('utf8') : null;
        } catch (_error) {
            copyText = null;
        }
        if (copy === null) {
            outcome.failed.push({ name, code: 'confirm_read' });
        } else if (copyText !== text || sha256Hex(copyText) !== sha256) {
            outcome.failed.push({ name, code: 'confirm_mismatch' });
        } else {
            const nextRaw = encodeRedisCompressedValue(buildDailyGhostStub(text, { v: 1, key, sha256 }));
            outcome.ready.push({ name, expectedRaw: raw, nextRaw });
        }
    });
    return outcome;
}

// Reads each stub's blob copy and checks it: the sha256 of the text, and the
// same best time and save time as the stub. Only a matching copy is ready to
// go back into Redis.
async function prepareRestores(
    ctx: RunContext,
    names: readonly string[],
    raws: readonly (string | null | undefined)[],
): Promise<SliceOutcome> {
    const outcome: SliceOutcome = { ready: [], drop: [], failed: [] };
    const candidates: { name: string; raw: string; stub: Record<string, unknown>; ref: PbGhostArchiveRef }[] = [];
    names.forEach((name, index) => {
        const raw = raws[index];
        const run = readRun(raw);
        if (typeof raw !== 'string' || !isStub(run)) {
            outcome.drop.push(name);
        } else {
            candidates.push({ name, raw, stub: run!.value, ref: run!.value.ghostArchive as PbGhostArchiveRef });
        }
    });

    await forEachWorker(candidates, async ({ name, raw, stub, ref }) => {
        if (!canStartGhost(ctx, 1)) return;
        let copy: Uint8Array | null;
        try {
            copy = await ctx.session.get(ref.key);
        } catch (error) {
            const code = failureCode(error, 'confirm_read');
            if (code) {
                outcome.failed.push({ name, code });
                outcome.firstError ??= errorText(error);
            }
            return;
        }
        if (copy === null) {
            outcome.failed.push({ name, code: 'missing' });
            return;
        }
        let text: string | null = null;
        try {
            text = gunzipSync(copy).toString('utf8');
        } catch (_error) {
            text = null;
        }
        const full = text === null ? null : parseJsonObject(text);
        if (
            text === null
            || sha256Hex(text) !== ref.sha256
            || !full
            || full.bestTimeMs !== stub.bestTimeMs
            || full.updatedAt !== stub.updatedAt
            || !isValidPbGhostTrace(full.ghost)
        ) {
            outcome.failed.push({ name, code: 'restore_mismatch' });
            return;
        }
        outcome.ready.push({ name, expectedRaw: raw, nextRaw: encodeRedisCompressedValue(text) });
    });
    return outcome;
}

// Writes the confirmed changes of one slice, with its progress and counts, in
// one transaction. A run is changed only when it still holds the text that
// was copied and no sign-in owns its player. Names that were not started stay
// in their list.
async function commitSlice(
    ctx: RunContext,
    challengeId: string,
    source: 'page' | 'held',
    outcome: SliceOutcome,
): Promise<boolean> {
    const pbKey = challengeCollectionKey(challengeId);
    const sourceKey = source === 'page' ? dailyGhostArchivePageKey(challengeId) : dailyGhostArchiveHeldKey(challengeId);
    const heldKey = dailyGhostArchiveHeldKey(challengeId);
    const readyNames = outcome.ready.map((item) => item.name);
    let writes: Record<string, string> = {};
    let changed: string[] = [];
    let signin: string[] = [];
    let freed = 0;
    let staged: { nextDay: DailyGhostArchiveDay; nextTotals: DailyGhostArchiveTotals } | null = null;

    const committed = await commitOwned(ctx, async (transaction) => {
        const day = ctx.days.get(challengeId)!;
        const converted = Object.keys(writes);
        const remove = [...outcome.drop, ...converted, ...changed];
        const heldReasons: Record<string, string> = {};
        for (const { name, code } of outcome.failed) heldReasons[name] = `failed:${code}`;
        const held = [...signin, ...(outcome.marked ?? [])];
        if (source === 'page') {
            remove.push(...outcome.failed.map((item) => item.name), ...held);
            for (const name of held) heldReasons[name] = 'signin';
        }
        if (converted.length) await transaction.hSet(pbKey, writes);
        if (remove.length) await transaction.hDel(sourceKey, remove);
        if (Object.keys(heldReasons).length) await transaction.hSet(heldKey, heldReasons);
        const counts = ctx.mode === 'move'
            ? { moved: day.moved + converted.length }
            : { restored: day.restored + converted.length };
        const nextDay: DailyGhostArchiveDay = {
            ...day,
            ...counts,
            freed: day.freed + freed,
            hasHeld: day.hasHeld || Object.keys(heldReasons).length > 0,
            heldThisPass: day.heldThisPass + (source === 'page' ? held.length : 0),
            failedThisPass: day.failedThisPass + outcome.failed.length,
            lastError: outcome.failed[0] ? `${outcome.failed[0].code}` : day.lastError,
            updatedAt: ctx.clock.now(),
        };
        const nextTotals: DailyGhostArchiveTotals = {
            ...ctx.totals,
            ...(ctx.mode === 'move'
                ? { moved: ctx.totals.moved + converted.length }
                : { restored: ctx.totals.restored + converted.length }),
            freed: ctx.totals.freed + freed,
        };
        await transaction.hSet(DAILY_GHOST_ARCHIVE_DAYS_KEY, { [challengeId]: JSON.stringify(nextDay) });
        await transaction.set(DAILY_GHOST_ARCHIVE_TOTALS_KEY, JSON.stringify(nextTotals));
        staged = { nextDay, nextTotals };
    }, {
        watchedKeys: [pbKey, ...readyNames.flatMap(markerKeys)],
        check: async () => {
            writes = {};
            changed = [];
            signin = [];
            freed = 0;
            if (!readyNames.length) return;
            const [current, marks] = await Promise.all([
                redis.hMGet(pbKey, readyNames),
                redis.mGet(readyNames.flatMap(markerKeys)),
            ]);
            outcome.ready.forEach((item, index) => {
                if (current[index] !== item.expectedRaw) {
                    changed.push(item.name);
                } else if (marks[index * 2] || marks[index * 2 + 1]) {
                    signin.push(item.name);
                } else {
                    writes[item.name] = item.nextRaw;
                    freed += Buffer.byteLength(item.expectedRaw, 'utf8') - Buffer.byteLength(item.nextRaw, 'utf8');
                }
            });
        },
    });
    if (committed && staged) {
        const { nextDay, nextTotals } = staged;
        ctx.days.set(challengeId, nextDay);
        ctx.totals = nextTotals;
        const converted = Object.keys(writes).length;
        if (ctx.mode === 'move') ctx.report.moved += converted;
        else ctx.report.restored += converted;
        ctx.report.held += signin.length + (outcome.marked?.length ?? 0);
        ctx.report.failed += outcome.failed.length;
        if (outcome.failed.length) {
            console.error(
                'Daily ghost archive failed:',
                challengeId,
                outcome.failed.map((item) => item.code).join(','),
                outcome.firstError ?? '',
            );
        }
    }
    return committed;
}

async function prepareSlice(
    ctx: RunContext,
    challengeId: string,
    names: readonly string[],
): Promise<SliceOutcome> {
    const raws = await redis.hMGet(challengeCollectionKey(challengeId), [...names]);
    // A player with a sign-in in progress is held before any blob call, so no
    // copy is made for nothing. The commit checks the marks again.
    const marks = await redis.mGet(names.flatMap(markerKeys));
    const marked = names.filter((_name, index) => marks[index * 2] || marks[index * 2 + 1]);
    const free = names.filter((name) => !marked.includes(name));
    const freeRaws = free.map((name) => raws[names.indexOf(name)]);
    const outcome = ctx.mode === 'move'
        ? await prepareMoves(ctx, challengeId, free, freeRaws)
        : await prepareRestores(ctx, free, freeRaws);
    return { ...outcome, marked };
}

// A move pass is done when the revision did not move. A restore pass ends the
// restore only when, besides, it left no stub behind and the held list is
// empty; a stub whose owner never finishes signing in keeps the day restoring.
async function endPass(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const revision = await readRevision(challengeId);
    let clean = revision === day.passRevision;
    if (day.mode === 'restore' && clean) {
        const held = await redis.hScan(dailyGhostArchiveHeldKey(challengeId), 0, undefined, 1);
        clean = day.heldThisPass === 0 && day.failedThisPass === 0 && held.fieldValues.length === 0;
    }
    const retryAt = ctx.clock.now() + PASS_RETRY_MS;
    let next: DailyGhostArchiveDay;
    if (day.mode === 'move') {
        next = clean
            ? { ...day, state: 'done', active: false, doneRevision: revision }
            : { ...day, state: 'waiting', active: false, nextPassAt: retryAt };
    } else {
        next = clean
            ? { ...day, state: 'restored', active: false }
            : { ...day, state: 'restoring', active: false, nextPassAt: retryAt };
    }
    const saved = await saveDay(ctx, challengeId, next, async (transaction) => {
        await transaction.del(dailyGhostArchivePageKey(challengeId));
    });
    if (saved) {
        ctx.report.passesEnded += 1;
        console.log(
            `Daily ghost archive: ${challengeId} ${day.mode} pass ${day.pass}: moved ${day.moved}, `
            + `restored ${day.restored}, held ${day.heldThisPass}, failed ${day.failedThisPass}, `
            + `${clean ? next.state : 'again'}`,
        );
    }
    return saved;
}

// Works on one day's open pass until it ends, time runs out, or a slice keeps
// conflicting. Returns false when no progress is possible now.
async function workPass(ctx: RunContext, challengeId: string): Promise<boolean> {
    while (canStep(ctx)) {
        const day = ctx.days.get(challengeId)!;
        const names = (await redis.hScan(dailyGhostArchivePageKey(challengeId), 0, undefined, SLICE_SIZE))
            .fieldValues.map((row) => row.field).slice(0, SLICE_SIZE);
        if (!names.length) {
            if (day.scanned && day.cursor === 0) return endPass(ctx, challengeId);
            if (!await scanPage(ctx, challengeId)) return false;
            continue;
        }
        if (!canStartGhost(ctx)) return false;
        const outcome = await prepareSlice(ctx, challengeId, names);
        // A failed commit is tried again with the same copies: the check reads
        // each run again, so a run that changed is left as it is.
        let committed = false;
        for (let attempt = 0; attempt < MAX_SLICE_COMMITS && !committed && !ctx.lockLost; attempt += 1) {
            committed = await commitSlice(ctx, challengeId, 'page', outcome);
        }
        if (!committed) {
            ctx.stuck.add(challengeId);
            return false;
        }
    }
    return false;
}

type PassAction = 'start' | 'continue';

function moveAction(day: DailyGhostArchiveDay | undefined, ctx: RunContext): PassAction | null {
    if (!day) return 'start';
    if (day.state === 'done') return null;
    if (day.state === 'restoring' || day.state === 'restored') return 'start';
    if (day.modeSerial !== ctx.serial) return 'start';
    if (day.state === 'moving' && day.active) return 'continue';
    return day.nextPassAt <= ctx.clock.now() ? 'start' : null;
}

function restoreAction(day: DailyGhostArchiveDay | undefined, ctx: RunContext): PassAction | null {
    if (!day || day.state === 'restored') return null;
    if (day.state !== 'restoring') return 'start';
    if (day.active) return day.modeSerial === ctx.serial ? 'continue' : 'start';
    return day.nextPassAt <= ctx.clock.now() ? 'start' : null;
}

function pickRestoreDay(
    ctx: RunContext,
    eligible: readonly StoredDay[],
): { challengeId: string; action: PassAction } | null {
    for (const { id } of eligible) {
        if (ctx.stuck.has(id)) continue;
        const action = restoreAction(ctx.days.get(id), ctx);
        if (action) return { challengeId: id, action };
    }
    return null;
}

// A day counts toward the day limit once it holds ghosts. A finished day where
// nothing needed moving does not count, so a one-day trial passes over empty
// old days and reaches a day with real ghosts.
function countsTowardDayLimit(day: DailyGhostArchiveDay): boolean {
    return day.active || day.state !== 'done' || day.moved > 0 || day.hasHeld || day.failedThisPass > 0;
}

function pickMoveDay(
    ctx: RunContext,
    eligible: readonly StoredDay[],
    dayLimit: number | null,
): { challengeId: string; action: PassAction } | null {
    const counted = [...ctx.days.values()].filter(countsTowardDayLimit).length;
    for (const { id } of eligible) {
        if (ctx.stuck.has(id)) continue;
        const day = ctx.days.get(id);
        if (!day && dayLimit !== null && counted >= dayLimit) continue;
        const action = moveAction(day, ctx);
        if (action) return { challengeId: id, action };
    }
    return null;
}

// The held list of one day: up to one slice of names. A name whose row is gone
// or already in the wanted form is dropped first. Only a row that still needs
// a change has its marks checked; a marked owner keeps the name.
async function workHeld(ctx: RunContext, challengeId: string): Promise<void> {
    const day = ctx.days.get(challengeId);
    if (!day || day.sweep) return;
    const heldKey = dailyGhostArchiveHeldKey(challengeId);
    const names = (await redis.hScan(heldKey, 0, undefined, SLICE_SIZE))
        .fieldValues.map((row) => row.field).slice(0, SLICE_SIZE);
    if (!names.length) {
        await saveDay(ctx, challengeId, { ...day, hasHeld: false });
        return;
    }
    const raws = await redis.hMGet(challengeCollectionKey(challengeId), names);
    const drop: string[] = [];
    const needs: string[] = [];
    names.forEach((name, index) => {
        if (wanted(ctx.mode, raws[index])) needs.push(name);
        else drop.push(name);
    });
    const marks = needs.length ? await redis.mGet(needs.flatMap(markerKeys)) : [];
    const free = needs.filter((_name, index) => !marks[index * 2] && !marks[index * 2 + 1]);
    if (!free.length) {
        if (drop.length) {
            await commitSlice(ctx, challengeId, 'held', { ready: [], drop, failed: [] });
        }
        return;
    }
    if (ctx.mode === 'move' && day.state === 'done' && !day.sweepNeeded) {
        // Set before the upload, so an upload whose commit fails still leads to a sweep.
        if (!await saveDay(ctx, challengeId, { ...day, sweepNeeded: true })) return;
    }
    if (!canStartGhost(ctx)) return;
    const freeRaws = free.map((name) => raws[names.indexOf(name)]);
    const outcome = ctx.mode === 'move'
        ? await prepareMoves(ctx, challengeId, free, freeRaws)
        : await prepareRestores(ctx, free, freeRaws);
    outcome.drop.push(...drop);
    for (let attempt = 0; attempt < MAX_SLICE_COMMITS && !ctx.lockLost; attempt += 1) {
        if (await commitSlice(ctx, challengeId, 'held', outcome)) return;
    }
}


// ---- Sweep: delete blob copies that no stub of their day points to. ----

function sweepIsDue(day: DailyGhostArchiveDay, nowMs: number): boolean {
    if (day.state !== 'done' || day.active) return false;
    if (day.sweep) return true;
    const asked = day.blob === null || day.sweepNeeded || day.nextSweepAt !== null;
    return asked && (day.nextSweepAt === null || day.nextSweepAt <= nowMs);
}

function pickSweepDay(ctx: RunContext, eligible: readonly StoredDay[]): string | null {
    for (const { id } of eligible) {
        const day = ctx.days.get(id);
        if (day && !ctx.stuck.has(id) && sweepIsDue(day, ctx.clock.now())) return id;
    }
    return null;
}

async function startSweep(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const revision = await readRevision(challengeId);
    return saveDay(ctx, challengeId, {
        ...day,
        sweep: {
            phase: 'refs',
            modeSerial: ctx.serial,
            startedAt: ctx.clock.now(),
            revision,
            refsCursor: 0,
            pageToken: null,
            nextToken: null,
            lastKey: null,
            kept: 0,
            keptBytes: 0,
            youngOrphanUntil: 0,
            deleted: 0,
        },
    }, async (transaction) => {
        await transaction.del(dailyGhostArchiveSweepRefsKey(challengeId));
    });
}

// One page of the reference scan. The refs and the scan position are saved
// together. At the end, the snapshot counts only if the day's revision did not
// move while it was taken; otherwise the scan starts again.
async function sweepRefsStep(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const sweep = day.sweep!;
    const page = await redis.hScan(challengeCollectionKey(challengeId), sweep.refsCursor, undefined, SCAN_COUNT);
    const refs: string[] = [];
    for (const row of page.fieldValues) {
        const run = readRun(row.value);
        if (!run || run.value.ghostArchive === undefined) continue;
        if (!isPbGhostArchiveRef(run.value.ghostArchive)) {
            // A reference that cannot be read could hide a live object. Delete nothing.
            console.error('Daily ghost sweep stopped: damaged reference', challengeId, row.field);
            await saveDay(ctx, challengeId, {
                ...day,
                sweep: null,
                sweepNeeded: true,
                nextSweepAt: ctx.clock.now() + SWEEP_DAMAGED_WAIT_MS,
                lastError: 'damaged_ref',
            }, async (transaction) => {
                await transaction.del(dailyGhostArchiveSweepRefsKey(challengeId));
            });
            ctx.stuck.add(challengeId);
            return false;
        }
        refs.push(run.value.ghostArchive.key);
    }
    let next: DailyGhostArchiveSweep = { ...sweep, refsCursor: page.cursor };
    let restart = false;
    if (page.cursor === 0) {
        const revision = await readRevision(challengeId);
        if (revision === sweep.revision) {
            next = { ...next, phase: 'list' };
        } else {
            restart = true;
            next = { ...next, refsCursor: 0, startedAt: ctx.clock.now(), revision };
        }
    }
    return saveDay(ctx, challengeId, { ...day, sweep: next }, async (transaction) => {
        const refsKey = dailyGhostArchiveSweepRefsKey(challengeId);
        if (restart) {
            await transaction.del(refsKey);
        } else if (refs.length) {
            await transaction.hSet(refsKey, Object.fromEntries(refs.map((key) => [key, '1'])));
        }
    });
}

async function saveSweepProgress(
    ctx: RunContext,
    challengeId: string,
    sweep: DailyGhostArchiveSweep,
    deletedNow: number,
): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const nextDay = { ...day, sweep, updatedAt: ctx.clock.now() };
    const nextTotals = { ...ctx.totals, deleted: ctx.totals.deleted + deletedNow };
    const saved = await commitOwned(ctx, async (transaction) => {
        await transaction.hSet(DAILY_GHOST_ARCHIVE_DAYS_KEY, { [challengeId]: JSON.stringify(nextDay) });
        await transaction.set(DAILY_GHOST_ARCHIVE_TOTALS_KEY, JSON.stringify(nextTotals));
    });
    if (saved) {
        ctx.days.set(challengeId, nextDay);
        ctx.totals = nextTotals;
    }
    return saved;
}

async function finishSweep(ctx: RunContext, challengeId: string, sweep: DailyGhostArchiveSweep): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const saved = await saveDay(ctx, challengeId, {
        ...day,
        sweep: null,
        sweepNeeded: false,
        nextSweepAt: sweep.youngOrphanUntil > 0 ? sweep.youngOrphanUntil + SWEEP_RETRY_MARGIN_MS : null,
        blob: { objects: sweep.kept, bytes: sweep.keptBytes, measuredAt: ctx.clock.now() },
    }, async (transaction) => {
        await transaction.del(dailyGhostArchiveSweepRefsKey(challengeId));
    });
    if (saved) {
        console.log(
            `Daily ghost sweep: ${challengeId} deleted ${sweep.deleted}, kept ${sweep.kept}`
            + ` (${sweep.keptBytes} bytes)`,
        );
    }
    return saved;
}

// One listing page, in key order. An object is kept when a stub points to it,
// or when it is not older than the snapshot by the grace time. Progress is
// saved after each batch, so a page cut short resumes after `lastKey`.
async function sweepListStep(ctx: RunContext, challengeId: string): Promise<boolean> {
    let sweep = ctx.days.get(challengeId)!.sweep!;
    if (!ctx.session.hasTimeFor(1)) return false;
    let page;
    try {
        page = await ctx.session.list(dailyGhostBlobPrefix(challengeId), sweep.pageToken, SWEEP_LIST_PAGE);
    } catch (error) {
        if (error instanceof BlobListTokenRejectedError) {
            // Start the listing again with the same refs. Deletions stay done.
            return saveSweepProgress(ctx, challengeId, {
                ...sweep,
                pageToken: null,
                nextToken: null,
                lastKey: null,
                kept: 0,
                keptBytes: 0,
                youngOrphanUntil: 0,
            }, 0);
        }
        if (!(error instanceof BlobDeadlineError)) console.error('Daily ghost sweep listing failed:', challengeId, error);
        ctx.stuck.add(challengeId);
        return false;
    }
    sweep = { ...sweep, nextToken: page.nextToken };
    const objects = page.objects.filter((object) => sweep.lastKey === null || object.key > sweep.lastKey);
    const refsKey = dailyGhostArchiveSweepRefsKey(challengeId);
    for (let index = 0; index < objects.length; index += SLICE_SIZE) {
        const batch = objects.slice(index, index + SLICE_SIZE);
        const referenced = await redis.hMGet(refsKey, batch.map((object) => object.key));
        let deletedNow = 0;
        let stopped = false;
        for (const [position, object] of batch.entries()) {
            const young = object.lastModifiedMs >= sweep.startedAt - SWEEP_GRACE_MS;
            if (referenced[position] || young) {
                sweep = {
                    ...sweep,
                    kept: sweep.kept + 1,
                    keptBytes: sweep.keptBytes + object.size,
                    youngOrphanUntil: !referenced[position]
                        ? Math.max(sweep.youngOrphanUntil, object.lastModifiedMs + SWEEP_GRACE_MS)
                        : sweep.youngOrphanUntil,
                    lastKey: object.key,
                };
                continue;
            }
            if (!ctx.session.hasTimeFor(1) || ctx.clock.now() > ctx.startUntilMs) {
                stopped = true;
                break;
            }
            try {
                await ctx.session.delete(object.key);
            } catch (error) {
                if (!(error instanceof BlobDeadlineError)) console.error('Daily ghost sweep delete failed:', challengeId, error);
                stopped = true;
                break;
            }
            deletedNow += 1;
            sweep = { ...sweep, deleted: sweep.deleted + 1, lastKey: object.key };
        }
        if (!await saveSweepProgress(ctx, challengeId, sweep, deletedNow)) return false;
        if (stopped) return false;
    }
    // The page is done: go on with the token of the response just read.
    sweep = { ...sweep, pageToken: page.nextToken, nextToken: null, lastKey: null };
    if (page.nextToken === null) return finishSweep(ctx, challengeId, sweep);
    return saveSweepProgress(ctx, challengeId, sweep, 0);
}

async function workSweep(ctx: RunContext, challengeId: string): Promise<void> {
    const day = ctx.days.get(challengeId)!;
    if (!day.sweep || day.sweep.modeSerial !== ctx.serial) {
        if (!await startSweep(ctx, challengeId)) {
            ctx.stuck.add(challengeId);
            return;
        }
    }
    while (canStep(ctx) && ctx.days.get(challengeId)?.sweep) {
        const step = ctx.days.get(challengeId)!.sweep!.phase === 'refs' ? sweepRefsStep : sweepListStep;
        if (!await step(ctx, challengeId)) return;
    }
}

// One small request before any day changes. When blob storage refuses it, the
// run stops with every day as it was, keeps the reason for the moderator page,
// and logs it at most once an hour.
async function blobStorageRefusal(ctx: RunContext): Promise<string | null> {
    try {
        await ctx.session.list(`${BLOB_PREFIX}/`, null, 1);
    } catch (error) {
        const message = errorText(error);
        await redis.set(DAILY_GHOST_ARCHIVE_BLOB_ERROR_KEY, JSON.stringify({
            message,
            at: new Date(ctx.clock.now()).toISOString(),
        }));
        // A Redis expiry runs on real time.
        const first = await redis.set(BLOB_ERROR_LOGGED_KEY, '1', {
            nx: true,
            expiration: new Date(Date.now() + BLOB_ERROR_LOG_EVERY_MS),
        });
        if (first) console.error('Daily ghost archive stopped: blob storage refused the first request:', message);
        return message;
    }
    if (await redis.get(DAILY_GHOST_ARCHIVE_BLOB_ERROR_KEY)) {
        await redis.del(DAILY_GHOST_ARCHIVE_BLOB_ERROR_KEY);
        await redis.del(BLOB_ERROR_LOGGED_KEY);
    }
    return null;
}

// Hourly: reopens done days whose revision changed, then works the held lists.
async function runUpkeep(ctx: RunContext): Promise<void> {
    if (!await saveTotals(ctx, { ...ctx.totals, upkeepAt: ctx.clock.now() })) return;
    if (ctx.mode === 'move') {
        const done = [...ctx.days.entries()].filter(([, day]) => day.state === 'done');
        if (done.length) {
            const revisions = await redis.mGet(done.map(([id]) => createRedisChallengeStandingsRevisionKey(id)));
            for (const [index, [id, day]] of done.entries()) {
                if (!canStep(ctx)) break;
                const revision = Number(revisions[index] ?? 0);
                if ((Number.isFinite(revision) ? revision : 0) !== day.doneRevision) await reopenDay(ctx, id);
            }
        }
    }
    for (const [id, day] of [...ctx.days.entries()]) {
        if (!canStep(ctx)) break;
        if (day.hasHeld) await workHeld(ctx, id);
    }
}

// With no mode given, a run follows the moderator's choice saved in Redis.
export async function runDailyGhostArchive({
    mode: givenMode,
    dayLimit: givenDayLimit,
    epoch = DAILY_GHOST_ARCHIVE_EPOCH,
    store,
    clock = SYSTEM_BLOB_CLOCK,
    maxCallsPerSecond = 40,
}: {
    mode?: DailyGhostArchiveMode;
    dayLimit?: number | null;
    epoch?: number;
    store?: BlobStore;
    clock?: BlobClock;
    maxCallsPerSecond?: number;
} = {}): Promise<DailyGhostArchiveReport> {
    const report: DailyGhostArchiveReport = {
        status: 'off', moved: 0, restored: 0, held: 0, failed: 0, passesEnded: 0,
    };
    const chosen = givenMode === undefined
        ? dailyGhostArchiveRunFor((await readDailyGhostArchiveSetting()).choice)
        : null;
    const mode = givenMode ?? chosen!.mode;
    const dayLimit = givenDayLimit !== undefined ? givenDayLimit : (chosen?.dayLimit ?? null);
    if (mode === 'off') return report;
    const lock = await acquireRedisLock(DAILY_GHOST_ARCHIVE_LOCK_KEY, LOCK_TTL_MS, redis);
    if (!lock) return { ...report, status: 'busy' };
    try {
        const startMs = clock.now();
        const [rawTotals, rawDays, storedDays] = await Promise.all([
            redis.get(DAILY_GHOST_ARCHIVE_TOTALS_KEY),
            redis.hGetAll(DAILY_GHOST_ARCHIVE_DAYS_KEY),
            readStoredDays(),
        ]);
        const days = new Map<string, DailyGhostArchiveDay>();
        for (const [id, raw] of Object.entries(rawDays ?? {})) {
            const day = parseDay(raw);
            if (day) days.set(id, day);
        }
        const ctx: RunContext = {
            lock,
            mode,
            serial: 0,
            clock,
            session: createBlobSession({
                store: store ?? createDevvitBlobStore(),
                deadlineMs: startMs + BLOB_WORK_MS,
                maxCallsPerSecond,
                clock,
            }),
            startMs,
            commitUntilMs: startMs + COMMIT_UNTIL_MS,
            startUntilMs: startMs + BLOB_WORK_MS,
            days,
            totals: parseTotals(rawTotals),
            lockLost: false,
            stuck: new Set(),
            report: { ...report, status: 'worked' },
        };

        if (await blobStorageRefusal(ctx)) return { ...report, status: 'blob_refused' };

        // A new mode cancels saved pages and sweeps as each day is touched.
        let totals = ctx.totals;
        if (totals.lastMode !== mode) totals = { ...totals, lastMode: mode, modeSerial: totals.modeSerial + 1 };
        const reopenAll = totals.epoch < epoch;
        if (reopenAll) totals = { ...totals, epoch };
        if (totals !== ctx.totals && !await saveTotals(ctx, totals)) return { ...ctx.report, status: 'lock_lost' };
        ctx.serial = ctx.totals.modeSerial;
        if (reopenAll) {
            for (const [id, day] of [...ctx.days.entries()]) {
                if (day.state === 'done') await reopenDay(ctx, id);
            }
        }

        if (clock.now() - ctx.totals.upkeepAt >= UPKEEP_EVERY_MS) {
            ctx.startUntilMs = startMs + UPKEEP_RESERVE_MS;
            await runUpkeep(ctx);
            ctx.startUntilMs = startMs + BLOB_WORK_MS;
        }

        const eligible = storedDays.filter((day) => day.availableUntilMs + PODIUM_WINDOW_MS <= clock.now());
        while (canStep(ctx)) {
            const next = ctx.mode === 'move' ? pickMoveDay(ctx, eligible, dayLimit) : pickRestoreDay(ctx, eligible);
            if (!next) {
                if (ctx.mode !== 'move') break;
                // Sweeps run only when no move pass is ready.
                const sweepDay = pickSweepDay(ctx, eligible);
                if (!sweepDay) break;
                await workSweep(ctx, sweepDay);
                if (ctx.days.get(sweepDay)?.sweep && !ctx.stuck.has(sweepDay)) break;
                continue;
            }
            if (next.action === 'start' && !await startPass(ctx, next.challengeId)) {
                ctx.stuck.add(next.challengeId);
                continue;
            }
            if (ctx.days.get(next.challengeId)?.active) await workPass(ctx, next.challengeId);
            // A pass still open on a day that is not stuck means the time is up.
            if (ctx.days.get(next.challengeId)?.active && !ctx.stuck.has(next.challengeId)) break;
        }
        return ctx.lockLost ? { ...ctx.report, status: 'lock_lost' } : ctx.report;
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Daily ghost archive lock cleanup failed:', error);
        });
    }
}

// ---- Status for the moderator page and the storage view. ----

export type DailyGhostArchiveStatus = {
    choice: DailyGhostArchiveChoice;
    mode: DailyGhostArchiveMode;
    days: Record<DayState, number>;
    // Days past their 8th-day start, and those of them not yet done.
    eligibleDays: number;
    waitingDays: number;
    moved: number;
    restored: number;
    // Payload bytes taken out of Redis by committed changes, less those put back.
    freed: number;
    deleted: number;
    // Runs on held lists (a sign-in in progress, or a copy that failed).
    held: number;
    // Measured by the last finished sweep of each day.
    blob: { bytes: number; objects: number; measuredDays: number };
    // The last refusal from blob storage, until a request goes through.
    blobError: { message: string; at: string } | null;
};

const HELD_COUNT_LIMIT = 1000;

export async function readDailyGhostArchiveStatus(nowMs = Date.now()): Promise<DailyGhostArchiveStatus> {
    const [rawTotals, rawDays, storedDays, setting, rawBlobError] = await Promise.all([
        redis.get(DAILY_GHOST_ARCHIVE_TOTALS_KEY),
        redis.hGetAll(DAILY_GHOST_ARCHIVE_DAYS_KEY),
        readStoredDays(),
        readDailyGhostArchiveSetting(),
        redis.get(DAILY_GHOST_ARCHIVE_BLOB_ERROR_KEY),
    ]);
    const blobError = parseJsonObject(rawBlobError);
    const { mode } = dailyGhostArchiveRunFor(setting.choice);
    const totals = parseTotals(rawTotals);
    const days = new Map<string, DailyGhostArchiveDay>();
    for (const [id, raw] of Object.entries(rawDays ?? {})) {
        const day = parseDay(raw);
        if (day) days.set(id, day);
    }
    const counts: Record<DayState, number> = { moving: 0, waiting: 0, done: 0, restoring: 0, restored: 0 };
    const blob = { bytes: 0, objects: 0, measuredDays: 0 };
    for (const day of days.values()) {
        counts[day.state] += 1;
        if (day.blob) {
            blob.bytes += day.blob.bytes;
            blob.objects += day.blob.objects;
            blob.measuredDays += 1;
        }
    }
    const heldCounts = await Promise.all([...days.entries()]
        .filter(([, day]) => day.hasHeld)
        .map(async ([id]) => (
            await redis.hScan(dailyGhostArchiveHeldKey(id), 0, undefined, HELD_COUNT_LIMIT)
        ).fieldValues.length));
    const eligible = storedDays.filter(({ availableUntilMs }) => availableUntilMs + PODIUM_WINDOW_MS <= nowMs);
    const waitingDays = eligible.filter(({ id }) => days.get(id)?.state !== 'done').length;
    return {
        choice: setting.choice,
        mode,
        days: counts,
        eligibleDays: eligible.length,
        waitingDays,
        moved: totals.moved,
        restored: totals.restored,
        freed: totals.freed,
        deleted: totals.deleted,
        held: heldCounts.reduce((sum, count) => sum + count, 0),
        blob,
        blobError: typeof blobError?.message === 'string'
            ? { message: blobError.message, at: String(blobError.at ?? '') }
            : null,
    };
}

// The state of each day the job touched, so the storage view can sample moved
// and unmoved days apart.
export async function readDailyGhostArchiveDayStates(): Promise<Map<string, DayState>> {
    const ids = await redis.hKeys(DAILY_GHOST_ARCHIVE_DAYS_KEY);
    const states = new Map<string, DayState>();
    if (!ids.length) return states;
    const values = await redis.hMGet(DAILY_GHOST_ARCHIVE_DAYS_KEY, ids);
    ids.forEach((id, index) => {
        const day = parseDay(values[index]);
        if (day) states.set(id, day.state);
    });
    return states;
}
