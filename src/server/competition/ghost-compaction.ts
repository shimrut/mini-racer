import { redis } from '@devvit/redis';
import { CAMPAIGN_LIVE_STAGES } from '../../../game/campaign/manifest.js';
import { toCampaignCompetition } from './competition.js';
import { challengeCollectionKey } from './pb-ghost-store.js';
import { packPbGhostTrace } from './pb-ghost-pack.js';
import { notePackedGhostWritesOn, WRITE_PACKED_GHOSTS_KEY } from './pb-ghost-write.js';
import { isValidPbGhostTrace } from './pb-ghost-trace.js';
import { DAILY_GP_CHALLENGE_HISTORY_HASH_KEY } from '../daily/daily-gp-model.js';
import {
    guestProgressSelectionAccountPendingKeyForHash,
    guestProgressSelectionPendingKeyForHash,
} from '../player/guest-retirement.js';
import { decodeRedisCompressedValue, encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    safelyDiscard,
    safelyUnwatch,
    type RedisLock,
} from '../redis/redis-lock.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';

// Rewrites stored ghosts in the packed form, a moderator-started step at a
// time, with progress on the Storage tab. A ghost is rewritten only when its
// packed form unpacks to the same ghost, the row did not change since it was
// read, and no sign-in owns its player. Nothing else in the row changes.
//
// Steps, in order: expired Daily days, then live Campaign stages, least played
// first. Live Daily days are left out: each one expires within a week, and new
// best times are saved packed once a step has started.

export type GhostCompactionStepName = 'expired' | 'campaign';
export const GHOST_COMPACTION_STEPS: readonly GhostCompactionStepName[] = ['expired', 'campaign'];

export function isGhostCompactionStepName(value: unknown): value is GhostCompactionStepName {
    return value === 'expired' || value === 'campaign';
}

type Board = {
    // The board's ghost hash.
    key: string;
    // Rows when the step started.
    total: number;
};

export type GhostCompactionStep = {
    // Raised for every new run of the step, and kept on Resume. A request
    // saves only into the run it started on.
    runId: number;
    boards: Board[];
    index: number;
    cursor: number;
    total: number;
    checked: number;
    packed: number;
    savedBytes: number;
    // Rows left as they were for a sign-in or a change, in this run, and on
    // the current board. A board with such rows is read again by Run again.
    skipped: number;
    boardSkipped: number;
    // Boards finished with no row skipped, in any run of this step, so a new
    // run passes over them.
    doneKeys: string[];
    // False for a step saved before skipped rows were counted: its doneKeys
    // may hide skipped rows, so its next Start reads every board again.
    skipTracked: boolean;
    startedAt: string | null;
    finishedAt: string | null;
};

export type GhostCompactionState = {
    running: GhostCompactionStepName | null;
    // New best times are saved packed from the first start on.
    writePacked: boolean;
    steps: Record<GhostCompactionStepName, GhostCompactionStep>;
    lastError: string | null;
    updatedAt: string | null;
};

const KEY_PREFIX = 'dailygp:ghost-compact:v1';
export const GHOST_COMPACTION_STATE_KEY = `${KEY_PREFIX}:state`;
const LOCK_KEY = `${KEY_PREFIX}:lock`;
const LOCK_TTL_MS = 55_000;
const WORK_MS = 22_000;
const SCAN_COUNT = 200;
const GROUP_SIZE = 25;
const MAX_GROUP_COMMITS = 3;
const MAX_STATE_UPDATES = 3;

// A Start or a Pause the state does not allow. The page shows its message.
export class GhostCompactionRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GhostCompactionRefusal';
    }
}

function emptyStep(): GhostCompactionStep {
    return {
        runId: 0,
        boards: [],
        index: 0,
        cursor: 0,
        total: 0,
        checked: 0,
        packed: 0,
        savedBytes: 0,
        skipped: 0,
        boardSkipped: 0,
        doneKeys: [],
        skipTracked: false,
        startedAt: null,
        finishedAt: null,
    };
}

function emptyState(): GhostCompactionState {
    return {
        running: null,
        writePacked: false,
        steps: { expired: emptyStep(), campaign: emptyStep() },
        lastError: null,
        updatedAt: null,
    };
}

function parseState(raw: unknown): GhostCompactionState {
    const state = emptyState();
    if (typeof raw !== 'string' || !raw) return state;
    try {
        const value = JSON.parse(raw);
        return {
            ...state,
            ...value,
            steps: {
                expired: { ...emptyStep(), ...value?.steps?.expired },
                campaign: { ...emptyStep(), ...value?.steps?.campaign },
            },
        };
    } catch (_error) {
        return state;
    }
}

export async function readGhostCompactionState(): Promise<GhostCompactionState> {
    return parseState(await redis.get(GHOST_COMPACTION_STATE_KEY));
}

// Changes the state in a transaction that watches it, so a change saved in
// the meantime is never written over: `decide` gets the state as it is now and
// returns the next one, or the same object to change nothing. It may refuse by
// throwing; the watch is then dropped. With `turnOnPackedWrites`, the same
// transaction also turns on packed best-time writes, so both are saved or
// neither is.
async function updateState(
    decide: (current: GhostCompactionState) => Promise<GhostCompactionState>,
    { turnOnPackedWrites = false }: { turnOnPackedWrites?: boolean } = {},
): Promise<GhostCompactionState> {
    for (let attempt = 0; attempt < MAX_STATE_UPDATES; attempt += 1) {
        const transaction = await redis.watch(GHOST_COMPACTION_STATE_KEY);
        let current: GhostCompactionState;
        let next: GhostCompactionState;
        try {
            // Transaction-client reads queue; read the base client.
            current = parseState(await redis.get(GHOST_COMPACTION_STATE_KEY));
            next = await decide(current);
        } catch (error) {
            await safelyUnwatch(transaction);
            throw error;
        }
        if (next === current && !turnOnPackedWrites) {
            await safelyUnwatch(transaction);
            return current;
        }
        try {
            await transaction.multi();
            if (next !== current) await transaction.set(GHOST_COMPACTION_STATE_KEY, JSON.stringify(next));
            if (turnOnPackedWrites) await transaction.set(WRITE_PACKED_GHOSTS_KEY, '1');
            const results = await transaction.exec();
            if (Array.isArray(results) && results.length > 0) return next;
        } catch (error) {
            await safelyDiscard(transaction);
            if (!isRedisTransactionConflict(error)) throw error;
        }
    }
    throw new Error('Ghost compaction changed meanwhile. Try again.');
}

// The text a row is stored with when its ghost is packed, or null when the
// row holds no plain ghost, the ghost cannot be packed exactly, or packing
// would not make the row smaller.
export function packedRunText(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw) return null;
    let value: Record<string, unknown>;
    try {
        const parsed = JSON.parse(decodeRedisCompressedValue(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        value = parsed;
    } catch (_error) {
        return null;
    }
    if (!isValidPbGhostTrace(value.ghost) || value.ghostPacked !== undefined) return null;
    const ghostPacked = packPbGhostTrace(value.ghost);
    if (!ghostPacked) return null;
    const next = encodeRedisCompressedValue(JSON.stringify({ ...value, ghost: null, ghostPacked }));
    return Buffer.byteLength(next, 'utf8') < Buffer.byteLength(raw, 'utf8') ? next : null;
}

async function boardsFor(step: GhostCompactionStepName, nowMs: number, doneKeys: readonly string[]): Promise<Board[]> {
    let keys: string[];
    if (step === 'expired') {
        const raw = await redis.hGetAll(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY);
        keys = Object.values(raw ?? {})
            .map((value) => {
                try {
                    return JSON.parse(value) as { id?: unknown; availableUntil?: unknown };
                } catch (_error) {
                    return null;
                }
            })
            .filter((challenge): challenge is { id: string; availableUntil: string } => (
                typeof challenge?.id === 'string'
                && /^daily-gp-\d{4}-\d{2}-\d{2}$/.test(challenge.id)
                && Date.parse(String(challenge.availableUntil)) <= nowMs
            ))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((challenge) => challengeCollectionKey(challenge.id));
    } else {
        const stageKeys: string[] = CAMPAIGN_LIVE_STAGES.map((stage) => (
            toCampaignCompetition(stage.seriesId, stage).pbHashKey
        ));
        keys = [...new Set<string>(stageKeys)];
    }
    keys = keys.filter((key) => !doneKeys.includes(key));
    const totals = await Promise.all(keys.map(async (key) => Number(await redis.hLen(key)) || 0));
    const boards = keys.map((key, index) => ({ key, total: totals[index] }));
    // Least played first: a fault shows on a small board before a big one.
    if (step === 'campaign') boards.sort((a, b) => a.total - b.total || a.key.localeCompare(b.key));
    return boards;
}

export type GhostCompactionAction = 'start' | 'pause';

// Starts a step (or runs it again over boards it has not finished), or pauses
// the running step. A step starts only after the steps before it finished
// once, and never while another step runs. Every choice is made on the state
// as it is when it is saved. Every Start that is not refused also turns on
// packed best-time writes in the same transaction, a Start of a step already
// running too, so a switch that a failed write left off is set again.
export async function setGhostCompactionStep(
    action: GhostCompactionAction,
    step: GhostCompactionStepName,
    now = new Date(),
): Promise<GhostCompactionState> {
    if (action === 'pause') {
        return updateState(async (current) => (current.running === step
            ? { ...current, running: null, updatedAt: now.toISOString() }
            : current));
    }
    const next = await updateState(async (current) => {
        if (current.running === step) return current;
        if (current.running) throw new GhostCompactionRefusal('Another step is running.');
        const before = GHOST_COMPACTION_STEPS.slice(0, GHOST_COMPACTION_STEPS.indexOf(step));
        if (before.some((name) => !current.steps[name].finishedAt)) {
            throw new GhostCompactionRefusal('Finish the step before this one first.');
        }
        const previous = current.steps[step];
        // A step saved before skipped rows were counted starts again from the
        // first board, even when it was paused part-way.
        const resume = previous.skipTracked && Boolean(previous.startedAt && !previous.finishedAt);
        const doneKeys = previous.skipTracked ? previous.doneKeys : [];
        const boards = resume ? previous.boards : await boardsFor(step, now.getTime(), doneKeys);
        const nextStep: GhostCompactionStep = resume
            ? previous
            : {
                ...previous,
                runId: previous.runId + 1,
                boards,
                index: 0,
                cursor: 0,
                total: boards.reduce((sum, board) => sum + board.total, 0),
                checked: 0,
                packed: 0,
                savedBytes: 0,
                skipped: 0,
                boardSkipped: 0,
                doneKeys,
                skipTracked: true,
                startedAt: now.toISOString(),
                finishedAt: null,
            };
        // A run with nothing left to do is finished at once.
        if (!resume && boards.length === 0) nextStep.finishedAt = now.toISOString();
        return {
            ...current,
            running: nextStep.finishedAt ? null : step,
            writePacked: true,
            steps: { ...current.steps, [step]: nextStep },
            lastError: null,
            updatedAt: now.toISOString(),
        };
    }, { turnOnPackedWrites: true });
    // Every server reads packed ghosts by now; new best times are saved packed
    // too. This server knows it only once the switch is saved.
    notePackedGhostWritesOn(now.getTime());
    return next;
}

function markerKeys(field: string): string[] {
    return [
        guestProgressSelectionPendingKeyForHash(field),
        guestProgressSelectionAccountPendingKeyForHash(field),
    ];
}

type RunContext = {
    lock: RedisLock;
    state: GhostCompactionState;
    // The run this request works on, kept apart from the state it reads.
    runId: number;
    deadlineMs: number;
    now: () => number;
};

// True while the state still runs this step, in the run the request started on.
function isOwnRun(state: GhostCompactionState, name: GhostCompactionStepName, runId: number): boolean {
    return state.running === name && state.steps[name].runId === runId;
}

// True when a failed request's error describes the state: the failed step is
// still in the run the request started on, and that step runs, or no step is
// running. While another step runs, the error is only logged.
function errorBelongsToState(state: GhostCompactionState, name: GhostCompactionStepName, runId: number): boolean {
    return state.steps[name].runId === runId && (state.running === null || state.running === name);
}

class StepStoppedError extends Error {}

type CommitResult = 'saved' | 'conflict' | 'stopped';

// Saves the state with the given writes in one transaction that holds the
// lock. After WATCH it reads the state again, so a pause or a new run saved
// meanwhile is never written over: when the request's run is no longer
// running, nothing is saved. `check` then decides the writes.
async function commit(
    ctx: RunContext,
    name: GhostCompactionStepName,
    nextState: (state: GhostCompactionState) => GhostCompactionState,
    {
        watchedKeys = [],
        check,
        writes,
    }: {
        watchedKeys?: string[];
        check?: () => Promise<void>;
        writes?: (transaction: Awaited<ReturnType<typeof redis.watch>>) => Promise<void>;
    } = {},
): Promise<CommitResult> {
    let transaction: Awaited<ReturnType<typeof redis.watch>> | null;
    try {
        transaction = await beginOwnedRedisLockTransaction(ctx.lock, redis, {
            watchedKeys: [GHOST_COMPACTION_STATE_KEY, ...watchedKeys],
            check: async () => {
                ctx.state = parseState(await redis.get(GHOST_COMPACTION_STATE_KEY));
                if (!isOwnRun(ctx.state, name, ctx.runId)) throw new StepStoppedError();
                await check?.();
            },
        });
    } catch (error) {
        if (error instanceof StepStoppedError) return 'stopped';
        if (isRedisTransactionConflict(error)) return 'conflict';
        throw error;
    }
    if (!transaction) return 'stopped';
    const state = { ...nextState(ctx.state), updatedAt: new Date(ctx.now()).toISOString() };
    try {
        if (writes) await writes(transaction);
        await transaction.set(GHOST_COMPACTION_STATE_KEY, JSON.stringify(state));
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) return 'conflict';
    } catch (error) {
        try {
            await transaction.discard();
        } catch (_discardError) {
        }
        if (isRedisTransactionConflict(error)) return 'conflict';
        throw error;
    }
    ctx.state = state;
    return 'saved';
}

function withStep(
    state: GhostCompactionState,
    name: GhostCompactionStepName,
    change: (step: GhostCompactionStep) => GhostCompactionStep,
): GhostCompactionState {
    return { ...state, steps: { ...state.steps, [name]: change(state.steps[name]) } };
}

// Packs one group of rows. A row is rewritten only if it still holds exactly
// the text that was read and no sign-in owns its player. A row left for a
// sign-in, or one that changed and still holds a plain ghost, is skipped.
async function packGroup(
    ctx: RunContext,
    name: GhostCompactionStepName,
    key: string,
    rows: { field: string; raw: string; next: string }[],
): Promise<{ result: CommitResult; skipped: number }> {
    let writes: Record<string, string> = {};
    let saved = 0;
    let skipped = 0;
    const result = await commit(ctx, name, (state) => withStep(state, name, (step) => ({
        ...step,
        packed: step.packed + Object.keys(writes).length,
        savedBytes: step.savedBytes + saved,
    })), {
        watchedKeys: [key, ...rows.flatMap((row) => markerKeys(row.field))],
        check: async () => {
            writes = {};
            saved = 0;
            skipped = 0;
            const fields = rows.map((row) => row.field);
            const [current, marks] = await Promise.all([
                redis.hMGet(key, fields),
                redis.mGet(fields.flatMap(markerKeys)),
            ]);
            rows.forEach((row, index) => {
                if (current[index] !== row.raw) {
                    // A row now packed, gone, or without a ghost needs nothing.
                    if (packedRunText(current[index]) !== null) skipped += 1;
                    return;
                }
                if (marks[index * 2] || marks[index * 2 + 1]) {
                    skipped += 1;
                    return;
                }
                writes[row.field] = row.next;
                saved += Buffer.byteLength(row.raw, 'utf8') - Buffer.byteLength(row.next, 'utf8');
            });
        },
        writes: async (transaction) => {
            if (Object.keys(writes).length) await transaction.hSet(key, writes);
        },
    });
    return { result, skipped };
}

// One page of the current board: pack its rows in groups, then save the scan
// position. A page cut short is read again; rows already packed are skipped.
async function finishStep(ctx: RunContext, name: GhostCompactionStepName): Promise<void> {
    const result = await commit(ctx, name, (state) => withStep({ ...state, running: null }, name, (current) => ({
        ...current,
        finishedAt: current.finishedAt ?? new Date(ctx.now()).toISOString(),
    })));
    if (result !== 'saved') return;
    const finished = ctx.state.steps[name];
    console.log(
        `Ghost compaction: ${name} done: checked ${finished.checked}, packed ${finished.packed}, `
        + `skipped ${finished.skipped}, saved ${finished.savedBytes} bytes`,
    );
}

async function workPage(ctx: RunContext, name: GhostCompactionStepName): Promise<boolean> {
    const step = ctx.state.steps[name];
    const board = step.boards[step.index];
    if (!board) {
        await finishStep(ctx, name);
        return false;
    }
    const page = await redis.hScan(board.key, step.cursor, undefined, SCAN_COUNT);
    const rows = page.fieldValues
        .map(({ field, value }) => ({ field, raw: value, next: packedRunText(value) }))
        .filter((row): row is { field: string; raw: string; next: string } => row.next !== null);
    // Skipped rows are saved with the scan position, so a page cut short and
    // read again counts them once.
    let pageSkipped = 0;
    for (let index = 0; index < rows.length; index += GROUP_SIZE) {
        if (ctx.now() > ctx.deadlineMs) return false;
        const group = rows.slice(index, index + GROUP_SIZE);
        let outcome: { result: CommitResult; skipped: number } = { result: 'conflict', skipped: 0 };
        for (let attempt = 0; attempt < MAX_GROUP_COMMITS && outcome.result === 'conflict'; attempt += 1) {
            outcome = await packGroup(ctx, name, board.key, group);
        }
        if (outcome.result !== 'saved') return false;
        pageSkipped += outcome.skipped;
    }
    const finishedBoard = page.cursor === 0;
    const result = await commit(ctx, name, (state) => withStep(state, name, (current) => {
        const checked = current.checked + page.fieldValues.length;
        const skipped = current.skipped + pageSkipped;
        const boardSkipped = current.boardSkipped + pageSkipped;
        if (!finishedBoard) return { ...current, cursor: page.cursor, checked, skipped, boardSkipped };
        return {
            ...current,
            index: current.index + 1,
            cursor: 0,
            checked,
            skipped,
            boardSkipped: 0,
            // A board with skipped rows stays open for Run again.
            doneKeys: boardSkipped === 0 ? [...current.doneKeys, board.key] : current.doneKeys,
        };
    }));
    if (result !== 'saved') return false;
    if (ctx.state.steps[name].index >= ctx.state.steps[name].boards.length) {
        await finishStep(ctx, name);
        return false;
    }
    return true;
}

export type GhostCompactionReport = { status: 'idle' | 'busy' | 'worked' | 'lock_lost' };

export async function runGhostCompaction({ now = () => Date.now() }: { now?: () => number } = {}): Promise<GhostCompactionReport> {
    const state = await readGhostCompactionState();
    if (!state.running) return { status: 'idle' };
    const lock = await acquireRedisLock(LOCK_KEY, LOCK_TTL_MS, redis);
    if (!lock) return { status: 'busy' };
    const ctx: RunContext = { lock, state, runId: 0, deadlineMs: now() + WORK_MS, now };
    let name: GhostCompactionStepName | null = null;
    try {
        // The state is read again under the lock: a pause may have come in.
        ctx.state = await readGhostCompactionState();
        name = ctx.state.running;
        if (!name) return { status: 'idle' };
        ctx.runId = ctx.state.steps[name].runId;
        while (now() <= ctx.deadlineMs && isOwnRun(ctx.state, name, ctx.runId)) {
            if (!await workPage(ctx, name)) break;
        }
        return { status: 'worked' };
    } catch (error) {
        console.error('Ghost compaction failed:', error);
        const lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        const failedStep = name;
        // Only the error is added, and only when it describes the state now: a
        // Pause saved meanwhile stays, a new run does not get an old run's
        // error, and another running step does not get it either.
        if (failedStep) {
            await updateState(async (current) => (errorBelongsToState(current, failedStep, ctx.runId)
                ? { ...current, lastError }
                : current)).catch(() => {});
        }
        return { status: 'worked' };
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Ghost compaction lock cleanup failed:', error);
        });
    }
}
