import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { RedisTestDouble } from './redis-test-double.js';
import { createBlobTestStore } from './helpers/blob-test-store.js';

const redis = new RedisTestDouble();

vi.mock('@devvit/redis', () => ({ redis, redisCompressed: redis }));

const move = await import('../src/server/campaign/campaign-ghost-move.ts');
const { CAMPAIGN_LIVE_STAGES } = await import('../game/campaign/manifest.js');
const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
const { decodeRedisCompressedValue, encodeRedisCompressedValue } = await import('../src/server/redis/redis-compressed-value.ts');
const { buildGhostStub, ghostBlobPrefixForBoard, ghostCopyKey, sha256Hex } = await import('../src/server/blob/ghost-archive-copy.ts');
const { lastRacedBucketKey } = await import('../src/server/player/last-raced.ts');
const { LAST_RACED_FILL_READY_KEY } = await import('../src/server/player/last-raced-fill.ts');
const { DAILY_GHOST_ARCHIVE_SETTING_KEY } = await import('../src/server/daily/daily-ghost-archive.ts');
const { guestProgressSelectionPendingKeyForHash } = await import('../src/server/player/guest-retirement.ts');

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const boards = [...new Set(CAMPAIGN_LIVE_STAGES.map((stage) => toCampaignCompetition(stage.seriesId, stage).pbHashKey))];
const [boardA, boardB] = boards;

function field(playerId) {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

function dayAgo(days) {
    return new Date(NOW - days * DAY_MS).toISOString().slice(0, 10);
}

// A stored run whose ghost compresses about as much as a real one.
function fullRunText(bestTimeMs, seed = 0) {
    let state = 12345 + seed * 7919;
    const deltas = Array.from({ length: 300 }, () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return (state % 401) - 200;
    });
    return JSON.stringify({
        schemaVersion: 2,
        trackKey: 'circuit',
        trackFingerprint: 'f'.repeat(43),
        simulationRevision: 1,
        rulesRevision: 1,
        lapCount: 1,
        bestTimeMs,
        checkpointTimesSec: [10.5, 21.25],
        lapCompletionTimesSec: null,
        ghost: { schemaVersion: 2, sampleIntervalMs: 50, finishTimeMs: 5000, origin: [1000, 2000, 50 + seed], deltas },
        updatedAt: '2026-09-21T12:00:00.000Z',
    });
}

async function seedRun(board, playerId, seed = 0) {
    const text = fullRunText(5000, seed);
    await redis.hSet(board, { [field(playerId)]: encodeRedisCompressedValue(text) });
    return text;
}

async function rowValue(board, playerId) {
    const raw = await redis.hGet(board, field(playerId));
    return raw ? JSON.parse(decodeRedisCompressedValue(raw)) : null;
}

async function rowText(board, playerId) {
    const raw = await redis.hGet(board, field(playerId));
    return raw ? decodeRedisCompressedValue(raw) : null;
}

function isMoved(value) {
    return value?.ghost === null && Boolean(value?.ghostArchive);
}

function createClock(startMs) {
    let nowMs = startMs;
    return {
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; },
        advance(ms) { nowMs += ms; },
    };
}

let blobs;
let clock;

async function tick() {
    const report = await move.runCampaignGhostMove({ store: blobs.store, clock });
    clock.advance(60_000);
    return report;
}

async function runUntilIdle(limit = 20) {
    for (let index = 0; index < limit; index += 1) {
        const report = await tick();
        if (report.status === 'idle') return;
    }
    throw new Error('The Campaign ghost move did not end.');
}

function state() {
    return move.readCampaignGhostMoveState();
}

function start(choice, ownerPlayerId = null) {
    return move.setCampaignGhostMove('run', choice, { ownerPlayerId, now: new Date(clock.now()) });
}

beforeEach(() => {
    redis.reset();
    blobs = createBlobTestStore({ now: () => clock.now() });
    clock = createClock(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Campaign ghost move: My ghosts and Restore', () => {
    it('moves only the runner\'s rows, keeps every other field, and Restore brings them back exactly', async () => {
        const mineA = await seedRun(boardA, 'reddit:me', 1);
        const mineB = await seedRun(boardB, 'reddit:me', 2);
        await seedRun(boardA, 'reddit:other', 3);

        await start('mine', 'reddit:me');
        await runUntilIdle();

        const movedA = await rowValue(boardA, 'reddit:me');
        expect(isMoved(movedA)).toBe(true);
        expect(movedA.bestTimeMs).toBe(5000);
        expect(isMoved(await rowValue(boardB, 'reddit:me'))).toBe(true);
        expect(isMoved(await rowValue(boardA, 'reddit:other'))).toBe(false);
        expect(Object.keys(await redis.hGetAll(move.CAMPAIGN_GHOST_MOVE_BOARDS_KEY)).sort()).toEqual([boardA, boardB].sort());
        const ref = movedA.ghostArchive;
        expect(ref.key.startsWith(ghostBlobPrefixForBoard(boardA))).toBe(true);
        expect(sha256Hex(mineA)).toBe(ref.sha256);
        expect(await state()).toMatchObject({ running: false, outcome: 'done', moved: 2, measured: { objects: 2 } });

        await start('restore');
        await runUntilIdle();
        expect(await rowText(boardA, 'reddit:me')).toBe(mineA);
        expect(await rowText(boardB, 'reddit:me')).toBe(mineB);
        // The first pass restores both rows; the second finds none and ends the run as done.
        expect(await state()).toMatchObject({ running: false, outcome: 'done', restored: 2, pass: 2, movedPayloadBytes: 0 });
        // No code deletes a Campaign copy.
        expect(blobs.count('delete')).toBe(0);
    });

    it('restores a board from the list of moved boards after its stage left the live list', async () => {
        const gone = 'campaign:old-series:pbs:gone-stage';
        const text = fullRunText(5000, 9);
        const sha256 = sha256Hex(text);
        const ref = { v: 1, key: ghostCopyKey(ghostBlobPrefixForBoard(gone), field('reddit:me'), sha256), sha256 };
        await blobs.store.put(ref.key, new Uint8Array(gzipSync(Buffer.from(text, 'utf8'))));
        await redis.hSet(gone, { [field('reddit:me')]: encodeRedisCompressedValue(buildGhostStub(text, ref)) });
        await redis.hSet(move.CAMPAIGN_GHOST_MOVE_BOARDS_KEY, { [gone]: '1' });

        await start('restore');
        await runUntilIdle();
        expect(await rowText(gone, 'reddit:me')).toBe(text);
    });

    it('ends a Restore as incomplete when a copy is missing, and keeps that row moved', async () => {
        await seedRun(boardA, 'reddit:me', 1);
        await start('mine', 'reddit:me');
        await runUntilIdle();
        const ref = (await rowValue(boardA, 'reddit:me')).ghostArchive;
        blobs.objects.delete(ref.key);

        await start('restore');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:me'))).toBe(true);
        expect(await state()).toMatchObject({ running: false, outcome: 'incomplete', skipped: { 'copy missing': 1 } });
    });

    it('keeps a row moved and the error when Redis refuses the Restore write', async () => {
        await seedRun(boardA, 'reddit:me', 1);
        await start('mine', 'reddit:me');
        await runUntilIdle();
        await start('restore');
        const hSet = redis.hSet.bind(redis);
        vi.spyOn(redis, 'hSet').mockImplementation(async (key, values) => {
            if (key === boardA) throw new Error('quota exceeded');
            return hSet(key, values);
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await tick();
        expect(isMoved(await rowValue(boardA, 'reddit:me'))).toBe(true);
        expect(await state()).toMatchObject({ running: true, lastError: 'quota exceeded', restored: 0 });
    });
});

describe('Campaign ghost move: Away', () => {
    async function setDay(playerId, day) {
        await redis.hSet(lastRacedBucketKey(field(playerId)), { [field(playerId)]: day });
    }

    beforeEach(async () => {
        await redis.set(LAST_RACED_FILL_READY_KEY, '{}');
    });

    it('refuses Away until the last race days are ready', async () => {
        await redis.del(LAST_RACED_FILL_READY_KEY);
        await expect(start('away60')).rejects.toThrow('Last race days are not ready yet.');
    });

    it('moves players away since the cutoff and players with no day, not recent players', async () => {
        await seedRun(boardA, 'reddit:away', 1);
        await seedRun(boardA, 'reddit:unknown', 2);
        await seedRun(boardA, 'reddit:recent', 3);
        await setDay('reddit:away', dayAgo(70));
        await setDay('reddit:recent', dayAgo(2));

        await start('away60');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:away'))).toBe(true);
        expect(isMoved(await rowValue(boardA, 'reddit:unknown'))).toBe(true);
        expect(isMoved(await rowValue(boardA, 'reddit:recent'))).toBe(false);
    });

    it('skips a player who raced while the copy was made', async () => {
        await seedRun(boardA, 'reddit:away', 1);
        await setDay('reddit:away', dayAgo(70));
        const bucket = lastRacedBucketKey(field('reddit:away'));
        redis.setBeforeExec((keys) => {
            if (!keys.includes(bucket)) return;
            redis.hashes.get(bucket).set(field('reddit:away'), dayAgo(0));
            redis.touch(bucket);
            redis.setBeforeExec(null);
        });

        await start('away60');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:away'))).toBe(false);
        expect(await state()).toMatchObject({ moved: 0, skipped: { 'player raced': 1 } });
    });

    it('keeps a best time saved between copy and commit', async () => {
        await seedRun(boardA, 'reddit:away', 1);
        const newer = encodeRedisCompressedValue(fullRunText(4000, 5));
        redis.setBeforeExec((keys) => {
            if (!keys.includes(boardA)) return;
            redis.hashes.get(boardA).set(field('reddit:away'), newer);
            redis.touch(boardA);
            redis.setBeforeExec(null);
        });

        await start('away60');
        await runUntilIdle();
        expect(await redis.hGet(boardA, field('reddit:away'))).toBe(newer);
        expect(await state()).toMatchObject({ moved: 0, skipped: { 'row changed': 1 } });
    });

    it('skips a player whose sign-in is in progress', async () => {
        await seedRun(boardA, 'reddit:away', 1);
        await redis.set(guestProgressSelectionPendingKeyForHash(field('reddit:away')), 'transfer');

        await start('away60');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:away'))).toBe(false);
        expect(await state()).toMatchObject({ skipped: { 'sign-in': 1 } });
    });

    it('lets a fresh Away 30 run revisit boards that an Away 60 run finished', async () => {
        await seedRun(boardA, 'reddit:long', 1);
        await seedRun(boardA, 'reddit:mid', 2);
        await setDay('reddit:long', dayAgo(70));
        await setDay('reddit:mid', dayAgo(40));

        await start('away60');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:mid'))).toBe(false);
        await start('away30');
        await runUntilIdle();
        expect(isMoved(await rowValue(boardA, 'reddit:mid'))).toBe(true);
    });
});

describe('Campaign ghost move: fences and waits', () => {
    it('refuses every write of a worker whose run was paused', async () => {
        await seedRun(boardA, 'reddit:me', 1);
        await start('mine', 'reddit:me');
        redis.setBeforeExec((keys) => {
            if (!keys.includes(boardA)) return;
            const current = JSON.parse(redis.strings.get(move.CAMPAIGN_GHOST_MOVE_STATE_KEY));
            redis.strings.set(move.CAMPAIGN_GHOST_MOVE_STATE_KEY, JSON.stringify({
                ...current, running: false, generation: current.generation + 1,
            }));
            redis.touch(move.CAMPAIGN_GHOST_MOVE_STATE_KEY);
            redis.setBeforeExec(null);
        });
        await tick();
        expect(isMoved(await rowValue(boardA, 'reddit:me'))).toBe(false);
        expect(await state()).toMatchObject({ running: false, moved: 0 });
    });

    it('waits while the Daily move is on', async () => {
        await seedRun(boardA, 'reddit:me', 1);
        await start('mine', 'reddit:me');
        await redis.set(DAILY_GHOST_ARCHIVE_SETTING_KEY, JSON.stringify({ choice: 'all' }));
        await expect(tick()).resolves.toEqual({ status: 'waiting' });
        expect(isMoved(await rowValue(boardA, 'reddit:me'))).toBe(false);
        await expect(move.readCampaignGhostMoveStatus()).resolves.toMatchObject({ waiting: 'daily' });
    });

    it('stops with the reason when blob storage refuses', async () => {
        await seedRun(boardA, 'reddit:me', 1);
        await start('mine', 'reddit:me');
        blobs.faults.list = 'fail';
        await expect(tick()).resolves.toEqual({ status: 'blob_refused' });
        expect(isMoved(await rowValue(boardA, 'reddit:me'))).toBe(false);
        expect(await state()).toMatchObject({ running: false, lastError: expect.stringContaining('Blob storage refused') });
    });

    it('measures blob space in steps, restarts on a refused token, and publishes only a complete total', async () => {
        for (let index = 0; index < 1500; index += 1) {
            await blobs.store.put(`campaign-ghosts/v1/s/r/${String(index).padStart(5, '0')}.gz`, new Uint8Array(10));
        }
        await redis.set(move.CAMPAIGN_GHOST_MOVE_STATE_KEY, JSON.stringify({
            generation: 3, running: false, measure: { token: null, objects: 0, bytes: 0 }, measured: null,
        }));
        // The first listing uses up the request's blob time but leaves time to save it.
        const list = blobs.store.list.bind(blobs.store);
        let lists = 0;
        vi.spyOn(blobs.store, 'list').mockImplementation(async (...args) => {
            lists += 1;
            if (lists === 1) clock.advance(17_000);
            return list(...args);
        });
        await tick();
        expect(await state()).toMatchObject({ measure: { objects: 1000, bytes: 10_000 }, measured: null });

        blobs.rejectListTokens(true);
        await tick();
        blobs.rejectListTokens(false);
        await runUntilIdle();
        expect(await state()).toMatchObject({ measure: null, measured: { objects: 1500, bytes: 15_000 } });
    });
});
