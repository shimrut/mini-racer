import { redis } from '@devvit/redis';
import { CAMPAIGN_LIVE_STAGES } from '../../../game/campaign/manifest.js';
import {
    BlobListTokenRejectedError,
    createBlobSession,
    createDevvitBlobStore,
    SYSTEM_BLOB_CLOCK,
    type BlobClock,
    type BlobSession,
    type BlobStore,
} from '../blob/blob-store.js';
import {
    buildGhostStub,
    CAMPAIGN_GHOST_BLOB_ROOT,
    ghostBlobPrefixForBoard,
    ghostCopyKey,
    sha256Hex,
    stubSavesSpace,
    uploadAndConfirmCopy,
    verifyArchivedCopy,
} from '../blob/ghost-archive-copy.js';
import { toCampaignCompetition } from '../competition/competition.js';
import { isPbGhostArchiveRef, type PbGhostArchiveRef } from '../competition/pb-ghost-archive-ref.js';
import { storedRunGhost } from '../competition/pb-ghost-pack.js';
import { formatUtcChallengeDate } from '../daily/daily-gp-model.js';
import {
    DAILY_GHOST_ARCHIVE_DAYS_KEY,
    DAILY_GHOST_ARCHIVE_LOCK_KEY,
    readDailyGhostArchiveSetting,
} from '../daily/daily-ghost-archive.js';
import {
    guestProgressSelectionAccountPendingKeyForHash,
    guestProgressSelectionPendingKeyForHash,
} from '../player/guest-retirement.js';
import { lastRacedBucketKeysFor, readLastRacedDays } from '../player/last-raced.js';
import { LAST_RACED_FILL_READY_KEY } from '../player/last-raced-fill.js';
import { decodeRedisCompressedValue, encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    safelyDiscard,
    safelyUnwatch,
    type RedisLock,
} from '../redis/redis-lock.js';
import { playerFieldHash } from '../redis/redis-names.js';
import { isRedisTransactionConflict } from '../redis/redis-transaction-conflict.js';

// Moves Campaign ghosts to blob storage, and back with Restore; started from the Storage tab, worked every minute.
// Rules: a ghost leaves Redis only after its copy reads back the same, in a watched commit that sees the row
// unchanged, no sign-in and (for Away) the player still away. Every write checks the run's generation.
// No code deletes a Campaign copy, so a row can always be read or restored again.

export type CampaignGhostMoveChoice = 'mine' | 'away60' | 'away30' | 'restore';
export const CAMPAIGN_GHOST_MOVE_CHOICES: readonly CampaignGhostMoveChoice[] = ['mine', 'away60', 'away30', 'restore'];
const AWAY_DAYS: Record<string, number> = { away60: 60, away30: 30 };

export function isCampaignGhostMoveChoice(value: unknown): value is CampaignGhostMoveChoice {
    return CAMPAIGN_GHOST_MOVE_CHOICES.includes(value as CampaignGhostMoveChoice);
}

const KEY_PREFIX = 'miniracer:campaign-ghost-move:v1';
export const CAMPAIGN_GHOST_MOVE_STATE_KEY = `${KEY_PREFIX}:state`;
// Every PB hash that has held a moved row; Restore walks these, also after a stage leaves the live list.
export const CAMPAIGN_GHOST_MOVE_BOARDS_KEY = `${KEY_PREFIX}:boards`;
const LOCK_KEY = `${KEY_PREFIX}:lock`;
const LOCK_TTL_MS = 55_000;
// Blob calls end by T + 20 s and commits start by T + 23 s; Reddit stops a request at 30 s.
const BLOB_WORK_MS = 20_000;
const COMMIT_UNTIL_MS = 23_000;
// Devvit allows 100 blob requests a second; this job keeps to 30, so race reads keep room.
const BLOB_CALLS_PER_SECOND = 30;
const SCAN_COUNT = 200;
const GROUP_SIZE = 25;
const GROUP_MAX_BYTES = 1024 * 1024;
const MAX_GROUP_COMMITS = 3;
const WORKERS = 8;
const MEASURE_PAGE = 1000;

type Board = { key: string; total: number };

export type CampaignGhostMoveState = {
    // New on every Run and Pause; a request writes only while the state still has its generation.
    generation: number;
    choice: CampaignGhostMoveChoice | null;
    running: boolean;
    // My ghosts: the PB row key of the moderator who pressed Run.
    ownerField: string | null;
    // Away: a player whose last race day is on or before this day counts as away.
    cutoffDay: string | null;
    boards: Board[];
    index: number;
    cursor: number;
    total: number;
    checked: number;
    moved: number;
    restored: number;
    // Committed Redis payload removed by moves in this run (not Redis memory).
    freedBytes: number;
    uploadedBytes: number;
    skipped: Record<string, number>;
    // Restore runs passes until one restores nothing.
    pass: number;
    passFound: number;
    passRestored: number;
    outcome: 'done' | 'incomplete' | null;
    // Payload of every row still moved, over all runs: what a full Restore would write back.
    movedPayloadBytes: number;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
    updatedAt: string | null;
    // Blob space under the Campaign folder, listed in steps across ticks.
    measure: { token: string | null; objects: number; bytes: number } | null;
    measured: { objects: number; bytes: number; at: string } | null;
};

function emptyState(): CampaignGhostMoveState {
    return {
        generation: 0,
        choice: null,
        running: false,
        ownerField: null,
        cutoffDay: null,
        boards: [],
        index: 0,
        cursor: 0,
        total: 0,
        checked: 0,
        moved: 0,
        restored: 0,
        freedBytes: 0,
        uploadedBytes: 0,
        skipped: {},
        pass: 0,
        passFound: 0,
        passRestored: 0,
        outcome: null,
        movedPayloadBytes: 0,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        updatedAt: null,
        measure: null,
        measured: null,
    };
}

function parseState(raw: unknown): CampaignGhostMoveState {
    if (typeof raw !== 'string' || !raw) return emptyState();
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? { ...emptyState(), ...value } : emptyState();
    } catch (_error) {
        return emptyState();
    }
}

export async function readCampaignGhostMoveState(): Promise<CampaignGhostMoveState> {
    return parseState(await redis.get(CAMPAIGN_GHOST_MOVE_STATE_KEY));
}

export class CampaignGhostMoveRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CampaignGhostMoveRefusal';
    }
}

// Watched read-decide-write of the state; `decide` returns the same object for no change.
async function updateState(
    decide: (current: CampaignGhostMoveState) => Promise<CampaignGhostMoveState>,
): Promise<CampaignGhostMoveState> {
    for (let attempt = 0; attempt < MAX_GROUP_COMMITS; attempt += 1) {
        const transaction = await redis.watch(CAMPAIGN_GHOST_MOVE_STATE_KEY);
        let current: CampaignGhostMoveState;
        let next: CampaignGhostMoveState;
        try {
            // Transaction-client reads queue; read the base client.
            current = parseState(await redis.get(CAMPAIGN_GHOST_MOVE_STATE_KEY));
            next = await decide(current);
        } catch (error) {
            await safelyUnwatch(transaction);
            throw error;
        }
        if (next === current) {
            await safelyUnwatch(transaction);
            return current;
        }
        try {
            await transaction.multi();
            await transaction.set(CAMPAIGN_GHOST_MOVE_STATE_KEY, JSON.stringify(next));
            const results = await transaction.exec();
            if (Array.isArray(results) && results.length > 0) return next;
        } catch (error) {
            await safelyDiscard(transaction);
            if (!isRedisTransactionConflict(error)) throw error;
        }
    }
    throw new Error('The Campaign ghost move changed meanwhile. Try again.');
}

function liveBoardKeys(): string[] {
    return [...new Set<string>(CAMPAIGN_LIVE_STAGES.map((stage) => toCampaignCompetition(stage.seriesId, stage).pbHashKey))];
}

async function boardsWithTotals(keys: readonly string[]): Promise<Board[]> {
    const totals = await Promise.all(keys.map(async (key) => Number(await redis.hLen(key)) || 0));
    return keys.map((key, index) => ({ key, total: totals[index] }));
}

function cutoffDayFor(choice: CampaignGhostMoveChoice, nowMs: number): string | null {
    const days = AWAY_DAYS[choice];
    return days ? formatUtcChallengeDate(new Date(nowMs - days * 24 * 60 * 60 * 1000)) : null;
}

// Run starts the picked choice or resumes the same paused one; Pause stops at the next write. Both start a new generation.
export async function setCampaignGhostMove(
    action: 'run' | 'pause',
    choice: unknown,
    { ownerPlayerId = null, now = new Date() }: { ownerPlayerId?: string | null; now?: Date } = {},
): Promise<CampaignGhostMoveState> {
    if (action === 'pause') {
        return updateState(async (current) => (current.running
            ? { ...current, running: false, generation: current.generation + 1, updatedAt: now.toISOString() }
            : current));
    }
    if (!isCampaignGhostMoveChoice(choice)) throw new CampaignGhostMoveRefusal('Unknown Campaign ghost move choice.');
    const ownerField = choice === 'mine' && ownerPlayerId ? playerFieldHash(ownerPlayerId) : null;
    if (choice === 'mine' && !ownerField) throw new CampaignGhostMoveRefusal('Sign in to move your own ghosts.');
    if (AWAY_DAYS[choice] && !await redis.get(LAST_RACED_FILL_READY_KEY)) {
        throw new CampaignGhostMoveRefusal('Last race days are not ready yet.');
    }
    const boards = await boardsWithTotals(choice === 'restore'
        ? (await redis.hKeys(CAMPAIGN_GHOST_MOVE_BOARDS_KEY)).sort()
        : liveBoardKeys());
    return updateState(async (current) => {
        if (current.running && current.choice === choice && current.ownerField === ownerField) return current;
        if (current.running) throw new CampaignGhostMoveRefusal('Pause the running choice first.');
        const resume = current.choice === choice
            && current.ownerField === ownerField
            && Boolean(current.startedAt && !current.finishedAt);
        if (resume) {
            return { ...current, running: true, generation: current.generation + 1, lastError: null, updatedAt: now.toISOString() };
        }
        const fresh: CampaignGhostMoveState = {
            ...emptyState(),
            generation: current.generation + 1,
            choice,
            running: true,
            ownerField,
            cutoffDay: cutoffDayFor(choice, now.getTime()),
            // A fresh run finds its boards again; no board is passed over because an older run finished it.
            boards,
            total: choice === 'mine' ? boards.length : boards.reduce((sum, board) => sum + board.total, 0),
            pass: 1,
            movedPayloadBytes: current.movedPayloadBytes,
            measured: current.measured,
            startedAt: now.toISOString(),
            updatedAt: now.toISOString(),
        };
        return fresh;
    });
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
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? { text, value } : null;
    } catch (_error) {
        return null;
    }
}

function isStub(run: { value: Record<string, unknown> } | null): boolean {
    return Boolean(run && (run.value.ghost === null || run.value.ghost === undefined)
        && run.value.ghostPacked === undefined
        && isPbGhostArchiveRef(run.value.ghostArchive));
}

class StoppedError extends Error {}

type RunContext = {
    lock: RedisLock;
    state: CampaignGhostMoveState;
    generation: number;
    session: BlobSession;
    clock: BlobClock;
    startMs: number;
};

function ownsRun(state: CampaignGhostMoveState, ctx: RunContext, { running = true } = {}): boolean {
    return state.generation === ctx.generation && (!running || state.running);
}

function canCommit(ctx: RunContext): boolean {
    return ctx.clock.now() <= ctx.startMs + COMMIT_UNTIL_MS;
}

function canUseBlob(ctx: RunContext, calls: number): boolean {
    return ctx.clock.now() <= ctx.startMs + BLOB_WORK_MS && ctx.session.hasTimeFor(calls);
}

function bytes(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function addSkips(skipped: Record<string, number>, reasons: readonly string[]): Record<string, number> {
    const next = { ...skipped };
    for (const reason of reasons) next[reason] = (next[reason] ?? 0) + 1;
    return next;
}

// Saves a state change under the lock and the generation; false when the run is no longer this request's.
async function saveProgress(
    ctx: RunContext,
    change: (state: CampaignGhostMoveState) => CampaignGhostMoveState,
    { running = true }: { running?: boolean } = {},
): Promise<boolean> {
    if (!canCommit(ctx)) return false;
    let next: CampaignGhostMoveState | null = null;
    let transaction;
    try {
        transaction = await beginOwnedRedisLockTransaction(ctx.lock, redis, {
            watchedKeys: [CAMPAIGN_GHOST_MOVE_STATE_KEY],
            check: async () => {
                const current = parseState(await redis.get(CAMPAIGN_GHOST_MOVE_STATE_KEY));
                if (!ownsRun(current, ctx, { running })) throw new StoppedError();
                next = { ...change(current), updatedAt: new Date(ctx.clock.now()).toISOString() };
            },
        });
    } catch (error) {
        if (error instanceof StoppedError || isRedisTransactionConflict(error)) return false;
        throw error;
    }
    if (!transaction || !next) return false;
    try {
        await transaction.set(CAMPAIGN_GHOST_MOVE_STATE_KEY, JSON.stringify(next));
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) return false;
    } catch (error) {
        await safelyDiscard(transaction);
        if (isRedisTransactionConflict(error)) return false;
        throw error;
    }
    ctx.state = next;
    return true;
}

type Row = { field: string; raw: string };
type Prepared = {
    field: string;
    expectedRaw: string;
    nextRaw: string;
    // Payload removed from Redis (negative for a restore).
    freed: number;
    uploaded: number;
};
type GroupWork = { ready: Prepared[]; failed: string[]; outOfTime: boolean };

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

type MoveCandidate = Row & { text: string; ref: PbGhostArchiveRef };

// Rows with a full ghost whose stub saves space; Away keeps only players away since the cutoff day.
async function movableRows(ctx: RunContext, rows: readonly Row[], prefix: string): Promise<MoveCandidate[]> {
    const candidates: MoveCandidate[] = [];
    for (const row of rows) {
        const run = readRun(row.raw);
        if (!run || !storedRunGhost(run.value)) continue;
        const sha256 = sha256Hex(run.text);
        const ref: PbGhostArchiveRef = { v: 1, key: ghostCopyKey(prefix, row.field, sha256), sha256 };
        if (stubSavesSpace(row.raw, run.text, ref)) candidates.push({ ...row, text: run.text, ref });
    }
    if (!ctx.state.cutoffDay || !candidates.length) return candidates;
    const days = await readLastRacedDays(candidates.map((row) => row.field));
    return candidates.filter((row) => isAway(days.get(row.field), ctx.state.cutoffDay!));
}

function isAway(day: string | null | undefined, cutoffDay: string): boolean {
    return typeof day !== 'string' || day <= cutoffDay;
}

async function prepareMoves(ctx: RunContext, group: readonly MoveCandidate[]): Promise<GroupWork> {
    const work: GroupWork = { ready: [], failed: [], outOfTime: false };
    await forEachWorker(group, async (row) => {
        if (!canUseBlob(ctx, 2)) {
            work.outOfTime = true;
            return;
        }
        const upload = await uploadAndConfirmCopy(ctx.session, row.ref.key, row.text);
        if (upload.status === 'deadline') {
            work.outOfTime = true;
        } else if (upload.status === 'ok') {
            const nextRaw = encodeRedisCompressedValue(buildGhostStub(row.text, row.ref));
            work.ready.push({
                field: row.field,
                expectedRaw: row.raw,
                nextRaw,
                freed: bytes(row.raw) - bytes(nextRaw),
                uploaded: upload.bytes,
            });
        } else {
            work.failed.push(upload.status === 'upload' ? 'upload failed' : 'copy differed');
        }
    });
    return work;
}

type MovedRow = Row & { stubText: string; ref: PbGhostArchiveRef };

function movedRows(rows: readonly Row[], prefix: string): MovedRow[] {
    return rows.flatMap((row) => {
        const run = readRun(row.raw);
        if (!run || !isStub(run)) return [];
        const ref = run.value.ghostArchive as PbGhostArchiveRef;
        return ref.key.startsWith(prefix) ? [{ ...row, stubText: run.text, ref }] : [];
    });
}

// Only a copy that rebuilds the stub exactly goes back; no live stage or track is needed.
async function prepareRestores(ctx: RunContext, group: readonly MovedRow[], prefix: string): Promise<GroupWork> {
    const work: GroupWork = { ready: [], failed: [], outOfTime: false };
    await forEachWorker(group, async (row) => {
        if (!canUseBlob(ctx, 1)) {
            work.outOfTime = true;
            return;
        }
        let copy: Uint8Array | null;
        try {
            copy = await ctx.session.get(row.ref.key);
        } catch (_error) {
            work.failed.push('copy read failed');
            return;
        }
        const checked = verifyArchivedCopy({ copy, ref: row.ref, stubText: row.stubText, prefix });
        if (checked.ok === false) {
            work.failed.push(checked.code === 'missing' ? 'copy missing' : 'copy differed');
            return;
        }
        const nextRaw = encodeRedisCompressedValue(checked.fullText);
        work.ready.push({ field: row.field, expectedRaw: row.raw, nextRaw, freed: bytes(row.raw) - bytes(nextRaw), uploaded: 0 });
    });
    return work;
}

type CommitResult = 'saved' | 'conflict' | 'stopped';

// One watched commit for a group: rows change only if unchanged, unowned and (Away) still away; counts go with them.
async function commitGroup(
    ctx: RunContext,
    boardKey: string,
    work: GroupWork,
    restoring: boolean,
): Promise<CommitResult> {
    const fields = work.ready.map((item) => item.field);
    const away = !restoring && Boolean(ctx.state.cutoffDay);
    let writes: Record<string, string> = {};
    let skips: string[] = [];
    let freed = 0;
    let uploaded = 0;
    let transaction;
    try {
        transaction = await beginOwnedRedisLockTransaction(ctx.lock, redis, {
            watchedKeys: [
                CAMPAIGN_GHOST_MOVE_STATE_KEY,
                boardKey,
                ...fields.flatMap(markerKeys),
                ...(away ? lastRacedBucketKeysFor(fields) : []),
            ],
            check: async () => {
                const current = parseState(await redis.get(CAMPAIGN_GHOST_MOVE_STATE_KEY));
                if (!ownsRun(current, ctx)) throw new StoppedError();
                ctx.state = current;
                writes = {};
                skips = [...work.failed];
                freed = 0;
                uploaded = 0;
                if (!fields.length) return;
                const [raws, marks, days] = await Promise.all([
                    redis.hMGet(boardKey, fields),
                    redis.mGet(fields.flatMap(markerKeys)),
                    away ? readLastRacedDays(fields) : Promise.resolve(null),
                ]);
                work.ready.forEach((item, index) => {
                    uploaded += item.uploaded;
                    if (raws[index] !== item.expectedRaw) skips.push('row changed');
                    else if (marks[index * 2] || marks[index * 2 + 1]) skips.push('sign-in');
                    else if (days && !isAway(days.get(item.field), current.cutoffDay!)) skips.push('player raced');
                    else {
                        writes[item.field] = item.nextRaw;
                        freed += item.freed;
                    }
                });
            },
        });
    } catch (error) {
        if (error instanceof StoppedError) return 'stopped';
        if (isRedisTransactionConflict(error)) return 'conflict';
        throw error;
    }
    if (!transaction) return 'stopped';
    const count = Object.keys(writes).length;
    const next: CampaignGhostMoveState = {
        ...ctx.state,
        moved: ctx.state.moved + (restoring ? 0 : count),
        restored: ctx.state.restored + (restoring ? count : 0),
        freedBytes: ctx.state.freedBytes + (restoring ? 0 : freed),
        uploadedBytes: ctx.state.uploadedBytes + uploaded,
        movedPayloadBytes: Math.max(0, ctx.state.movedPayloadBytes + freed),
        skipped: addSkips(ctx.state.skipped, skips),
        passFound: ctx.state.passFound + (restoring ? work.ready.length + work.failed.length : 0),
        passRestored: ctx.state.passRestored + (restoring ? count : 0),
        updatedAt: new Date(ctx.clock.now()).toISOString(),
    };
    try {
        if (count) {
            await transaction.hSet(boardKey, writes);
            if (!restoring) await transaction.hSet(CAMPAIGN_GHOST_MOVE_BOARDS_KEY, { [boardKey]: '1' });
        }
        await transaction.set(CAMPAIGN_GHOST_MOVE_STATE_KEY, JSON.stringify(next));
        const results = await transaction.exec();
        if (!Array.isArray(results) || results.length === 0) return 'conflict';
    } catch (error) {
        await safelyDiscard(transaction);
        if (isRedisTransactionConflict(error)) return 'conflict';
        throw error;
    }
    ctx.state = next;
    return 'saved';
}

function groupsOf<Item extends { raw: string }>(items: readonly Item[]): Item[][] {
    const groups: Item[][] = [];
    let group: Item[] = [];
    let groupBytes = 0;
    for (const item of items) {
        const size = bytes(item.raw);
        if (group.length && (group.length >= GROUP_SIZE || groupBytes + size > GROUP_MAX_BYTES)) {
            groups.push(group);
            group = [];
            groupBytes = 0;
        }
        group.push(item);
        groupBytes += size;
    }
    if (group.length) groups.push(group);
    return groups;
}

// Ends a pass: a move stops; a restore starts another pass while the last one restored rows.
async function finishPass(ctx: RunContext): Promise<boolean> {
    const state = ctx.state;
    const finishedAt = new Date(ctx.clock.now()).toISOString();
    if (state.choice === 'restore' && state.passRestored > 0) {
        return saveProgress(ctx, (current) => ({
            ...current, index: 0, cursor: 0, pass: current.pass + 1, passFound: 0, passRestored: 0,
        }));
    }
    const outcome = state.choice === 'restore' && state.passFound > 0 ? 'incomplete' : 'done';
    const saved = await saveProgress(ctx, (current) => ({
        ...current,
        running: false,
        finishedAt,
        outcome,
        measure: { token: null, objects: 0, bytes: 0 },
    }));
    if (saved) {
        console.log(`Campaign ghost move: ${state.choice} ${outcome}: moved ${state.moved}, restored ${state.restored}, `
            + `skipped ${JSON.stringify(state.skipped)}`);
    }
    return false;
}

// One page of one board; false when this request should stop (time, a fence, or the run ended).
async function workPage(ctx: RunContext): Promise<boolean> {
    const state = ctx.state;
    const board = state.boards[state.index];
    if (!board) return finishPass(ctx);
    const restoring = state.choice === 'restore';
    const prefix = ghostBlobPrefixForBoard(board.key);
    let rows: Row[];
    let nextCursor: number;
    if (!prefix) {
        rows = [];
        nextCursor = 0;
    } else if (state.choice === 'mine') {
        const raw = await redis.hGet(board.key, state.ownerField!);
        rows = typeof raw === 'string' && raw ? [{ field: state.ownerField!, raw }] : [];
        nextCursor = 0;
    } else {
        const page = await redis.hScan(board.key, state.cursor, undefined, SCAN_COUNT);
        rows = page.fieldValues.map(({ field, value }) => ({ field, raw: value }));
        nextCursor = page.cursor;
    }
    const candidates = !prefix ? [] : restoring ? movedRows(rows, prefix) : await movableRows(ctx, rows, prefix);
    for (const group of groupsOf<Row & (MoveCandidate | MovedRow)>(candidates as (Row & (MoveCandidate | MovedRow))[])) {
        const work = restoring
            ? await prepareRestores(ctx, group as MovedRow[], prefix!)
            : await prepareMoves(ctx, group as MoveCandidate[]);
        let result: CommitResult = 'conflict';
        for (let attempt = 0; attempt < MAX_GROUP_COMMITS && result === 'conflict'; attempt += 1) {
            if (!canCommit(ctx)) return false;
            result = await commitGroup(ctx, board.key, work, restoring);
        }
        if (result === 'stopped') return false;
        // A group still in conflict is counted as skipped only if that count saves; else the page is read again.
        if (result === 'conflict') {
            const reasons = [...work.failed, ...work.ready.map(() => 'busy row')];
            const saved = await saveProgress(ctx, (current) => ({
                ...current,
                skipped: addSkips(current.skipped, reasons),
                passFound: current.passFound + (restoring ? reasons.length : 0),
            }));
            if (!saved) return false;
        }
        // Rows not reached in time stay as they are; the page is read again next tick.
        if (work.outOfTime) return false;
    }
    const finishedBoard = nextCursor === 0;
    return saveProgress(ctx, (current) => ({
        ...current,
        checked: current.checked + (current.choice === 'mine' ? 1 : rows.length),
        index: finishedBoard ? current.index + 1 : current.index,
        cursor: finishedBoard ? 0 : nextCursor,
    }));
}

// Lists the Campaign folder in steps; the total is published only after the last page.
async function measureStep(ctx: RunContext): Promise<void> {
    while (ctx.state.measure && canUseBlob(ctx, 1)) {
        const measure = ctx.state.measure;
        let page;
        try {
            page = await ctx.session.list(CAMPAIGN_GHOST_BLOB_ROOT, measure.token, MEASURE_PAGE);
        } catch (error) {
            if (error instanceof BlobListTokenRejectedError) {
                if (!await saveProgress(ctx, (current) => ({
                    ...current, measure: { token: null, objects: 0, bytes: 0 },
                }), { running: false })) return;
                continue;
            }
            return;
        }
        const objects = measure.objects + page.objects.length;
        const pageBytes = page.objects.reduce((sum, object) => sum + object.size, 0);
        const total = measure.bytes + pageBytes;
        const at = new Date(ctx.clock.now()).toISOString();
        const saved = await saveProgress(ctx, (current) => (page.nextToken
            ? { ...current, measure: { token: page.nextToken, objects, bytes: total } }
            : { ...current, measure: null, measured: { objects, bytes: total, at } }), { running: false });
        if (!saved) return;
    }
}

export type CampaignGhostMoveReport = { status: 'idle' | 'waiting' | 'busy' | 'worked' | 'blob_refused' };

export async function runCampaignGhostMove({
    store,
    clock = SYSTEM_BLOB_CLOCK,
}: {
    store?: BlobStore;
    clock?: BlobClock;
} = {}): Promise<CampaignGhostMoveReport> {
    const state = await readCampaignGhostMoveState();
    if (!state.running && !state.measure) return { status: 'idle' };
    // Both moves share the blob request budget, so this one waits while the Daily move is on or working.
    const daily = await readDailyGhostArchiveSetting();
    if (daily.choice !== 'off' || await redis.get(DAILY_GHOST_ARCHIVE_LOCK_KEY)) return { status: 'waiting' };
    const lock = await acquireRedisLock(LOCK_KEY, LOCK_TTL_MS, redis);
    if (!lock) return { status: 'busy' };
    const startMs = clock.now();
    const ctx: RunContext = {
        lock,
        state,
        generation: 0,
        clock,
        startMs,
        session: createBlobSession({
            store: store ?? createDevvitBlobStore(),
            deadlineMs: startMs + BLOB_WORK_MS,
            maxCallsPerSecond: BLOB_CALLS_PER_SECOND,
            clock,
        }),
    };
    try {
        // Read again under the lock: a Pause may have come in.
        ctx.state = await readCampaignGhostMoveState();
        ctx.generation = ctx.state.generation;
        if (ctx.state.running) {
            try {
                await ctx.session.list(CAMPAIGN_GHOST_BLOB_ROOT, null, 1);
            } catch (error) {
                const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
                await saveProgress(ctx, (current) => ({
                    ...current, running: false, lastError: `Blob storage refused: ${message}`,
                }));
                return { status: 'blob_refused' };
            }
            while (ownsRun(ctx.state, ctx) && canCommit(ctx)) {
                if (!await workPage(ctx)) break;
            }
        }
        if (!ctx.state.running && ownsRun(ctx.state, ctx, { running: false })) await measureStep(ctx);
        return { status: 'worked' };
    } catch (error) {
        console.error('Campaign ghost move failed:', error);
        const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        await saveProgress(ctx, (current) => ({ ...current, lastError }), { running: false }).catch(() => false);
        return { status: 'worked' };
    } finally {
        await releaseRedisLock(lock, redis).catch((error) => {
            console.error('Campaign ghost move lock cleanup failed:', error);
        });
    }
}

export type CampaignGhostMoveStatus = CampaignGhostMoveState & {
    // Why a running choice does no work now.
    waiting: 'daily' | null;
    lastRacedReady: boolean;
    // Blob bytes the Daily move measured, so the card can show both against the grant.
    dailyBlobBytes: number;
};

// Sums each Daily day's last measured blob size; days never measured count as 0.
async function readDailyBlobBytes(): Promise<number> {
    const days = await redis.hGetAll(DAILY_GHOST_ARCHIVE_DAYS_KEY);
    return Object.values(days ?? {}).reduce((sum, raw) => {
        try {
            const blobBytes = Number(JSON.parse(raw)?.blob?.bytes);
            return sum + (Number.isFinite(blobBytes) && blobBytes > 0 ? blobBytes : 0);
        } catch (_error) {
            return sum;
        }
    }, 0);
}

export async function readCampaignGhostMoveStatus(): Promise<CampaignGhostMoveStatus> {
    const [state, daily, dailyLock, lastRacedReady, dailyBlobBytes] = await Promise.all([
        readCampaignGhostMoveState(),
        readDailyGhostArchiveSetting(),
        redis.get(DAILY_GHOST_ARCHIVE_LOCK_KEY),
        redis.get(LAST_RACED_FILL_READY_KEY),
        readDailyBlobBytes(),
    ]);
    return {
        ...state,
        waiting: state.running && (daily.choice !== 'off' || Boolean(dailyLock)) ? 'daily' : null,
        lastRacedReady: Boolean(lastRacedReady),
        dailyBlobBytes,
    };
}
