import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
    BlobCallTimeoutError,
    BlobDeadlineError,
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

export type DailyGhostArchiveMode = 'off' | 'move';

// Changed by deploy. 'off' does nothing, and pauses a sweep.
export const DAILY_GHOST_ARCHIVE_MODE: DailyGhostArchiveMode = 'off';
// How many days the job may start. 1 for the first live day, then null.
export const DAILY_GHOST_ARCHIVE_DAY_LIMIT: number | null = 1;
// Raise after a rollback to an older app version: every done day is checked
// again, because an older version may change a day without raising its
// revision.
export const DAILY_GHOST_ARCHIVE_EPOCH = 1;

const KEY_PREFIX = 'dailygp:ghost-archive:v1';
export const DAILY_GHOST_ARCHIVE_LOCK_KEY = `${KEY_PREFIX}:lock`;
export const DAILY_GHOST_ARCHIVE_DAYS_KEY = `${KEY_PREFIX}:days`;
export const DAILY_GHOST_ARCHIVE_TOTALS_KEY = `${KEY_PREFIX}:totals`;

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
const WORKERS = 8;
const STEP_MARGIN_MS = 1_000;
const MAX_SLICE_COMMITS = 2;

type DayState = 'moving' | 'waiting' | 'done' | 'restoring' | 'restored';
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
    sweep: null;
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
    status: 'off' | 'busy' | 'worked' | 'lock_lost';
    moved: number;
    restored: number;
    held: number;
    failed: number;
    passesEnded: number;
};

function canStep(ctx: RunContext): boolean {
    return !ctx.lockLost && ctx.clock.now() + STEP_MARGIN_MS <= ctx.startUntilMs;
}

// A ghost needs an upload and a read-back; both must end by the deadline.
function canStartGhost(ctx: RunContext): boolean {
    return !ctx.lockLost
        && ctx.clock.now() <= ctx.startUntilMs
        && ctx.session.hasTimeFor(2);
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
    ready: Conversion[];
    // Rows that need nothing: gone, already in the wanted form, or not a run.
    drop: string[];
    failed: { name: string; code: string }[];
};

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
            if (code) outcome.failed.push({ name, code });
            return;
        }
        if (!ctx.session.hasTimeFor(1)) return;
        let copy: Uint8Array | null;
        try {
            copy = await ctx.session.get(key);
        } catch (error) {
            const code = failureCode(error, 'confirm_read');
            if (code) outcome.failed.push({ name, code });
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
        if (source === 'page') {
            remove.push(...outcome.failed.map((item) => item.name), ...signin);
            for (const name of signin) heldReasons[name] = 'signin';
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
            heldThisPass: day.heldThisPass + (source === 'page' ? signin.length : 0),
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
        ctx.report.held += signin.length;
        ctx.report.failed += outcome.failed.length;
        if (outcome.failed.length) {
            console.error(
                'Daily ghost archive failed:',
                challengeId,
                outcome.failed.map((item) => item.code).join(','),
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
    return prepareMoves(ctx, challengeId, names, raws);
}

async function endPass(ctx: RunContext, challengeId: string): Promise<boolean> {
    const day = ctx.days.get(challengeId)!;
    const revision = await readRevision(challengeId);
    const clean = revision === day.passRevision;
    const next: DailyGhostArchiveDay = clean
        ? { ...day, state: 'done', active: false, doneRevision: revision }
        : { ...day, state: 'waiting', active: false, nextPassAt: ctx.clock.now() + PASS_RETRY_MS };
    const saved = await saveDay(ctx, challengeId, next, async (transaction) => {
        await transaction.del(dailyGhostArchivePageKey(challengeId));
    });
    if (saved) {
        ctx.report.passesEnded += 1;
        console.log(
            `Daily ghost archive: ${challengeId} pass ${day.pass}: moved ${day.moved}, `
            + `held ${day.heldThisPass}, failed ${day.failedThisPass}, ${clean ? 'done' : 'again'}`,
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

function pickMoveDay(
    ctx: RunContext,
    eligible: readonly StoredDay[],
    dayLimit: number | null,
): { challengeId: string; action: PassAction } | null {
    for (const { id } of eligible) {
        if (ctx.stuck.has(id)) continue;
        const day = ctx.days.get(id);
        if (!day && dayLimit !== null && ctx.days.size >= dayLimit) continue;
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
    const outcome = await prepareMoves(ctx, challengeId, free, freeRaws);
    outcome.drop.push(...drop);
    for (let attempt = 0; attempt < MAX_SLICE_COMMITS && !ctx.lockLost; attempt += 1) {
        if (await commitSlice(ctx, challengeId, 'held', outcome)) return;
    }
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

export async function runDailyGhostArchive({
    mode = DAILY_GHOST_ARCHIVE_MODE,
    dayLimit = DAILY_GHOST_ARCHIVE_DAY_LIMIT,
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
        while (canStep(ctx) && ctx.mode === 'move') {
            const next = pickMoveDay(ctx, eligible, dayLimit);
            if (!next) break;
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
