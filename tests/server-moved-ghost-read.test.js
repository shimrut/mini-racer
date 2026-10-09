import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { TRACKS } from '../game/track/tracks.js';
import { CAMPAIGN_ID, CAMPAIGN_NUMBERS_SERIES_ID, getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { createTrackFingerprint } from '../src/server/competition/pb-ghost-trace.ts';
import { createBlobTestStore } from './helpers/blob-test-store.js';

const { mockRedis, hashes, strings, sortedSets, blobHolder } = vi.hoisted(() => {
    const hashes = new Map();
    const strings = new Map();
    const sortedSets = new Map();
    const ordered = (key) => [...(sortedSets.get(key)?.entries() || [])]
        .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));
    return {
        hashes,
        strings,
        sortedSets,
        blobHolder: { blobs: null },
        mockRedis: {
            hGet: vi.fn(async (key, field) => hashes.get(key)?.get(field) ?? null),
            hMGet: vi.fn(async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null)),
            mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
            zRange: vi.fn(async (key, start, stop, options) => {
                let rows = ordered(key);
                if (options?.by === 'score') {
                    rows = rows.filter(([, score]) => score >= Number(start) && score <= Number(stop));
                    if (options.reverse) rows = rows.slice().reverse();
                    const offset = options.limit?.offset ?? 0;
                    const count = options.limit?.count ?? rows.length;
                    return rows.slice(offset, offset + count).map(([member, score]) => ({ member, score }));
                }
                return rows.slice(start, stop + 1).map(([member, score]) => ({ member, score }));
            }),
            zRank: vi.fn(async (key, member) => {
                const index = ordered(key).findIndex(([candidate]) => candidate === member);
                return index >= 0 ? index : undefined;
            }),
            // Readers must never call these.
            hSet: vi.fn(),
            hDel: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            watch: vi.fn(),
        },
    };
});

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
    redisCompressed: mockRedis,
}));

vi.mock('../src/server/blob/blob-store.ts', async (importOriginal) => ({
    ...(await importOriginal()),
    createDevvitBlobStore: () => blobHolder.blobs.store,
}));

const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
const { createRedisPlayerProfileKey } = await import('../src/server/competition/competition-identity.ts');
const { getPlayerTrackPbRecord } = await import('../src/server/competition/pb-ghost-store.ts');
const { isMovedPbRecord } = await import('../src/server/competition/pb-ghost-archive-ref.ts');
const { isOpponentCandidateRecord } = await import('../src/server/competition/competition-leaderboard.ts');
const { prepareCompetitionOpponentRace } = await import('../src/server/competition/competition-opponent-race.ts');
const { resolveMovedPbGhost, toGamePbRecord } = await import('../src/server/blob/archived-ghost.ts');
const {
    buildGhostStub,
    ghostBlobPrefixForBoard,
    sha256Hex,
    verifyArchivedCopy,
} = await import('../src/server/blob/ghost-archive-copy.ts');
const { packPbGhostTrace } = await import('../src/server/competition/pb-ghost-pack.ts');

const stage = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID)[0];
const competition = toCampaignCompetition(CAMPAIGN_ID, stage);
const track = TRACKS[stage.trackKey];
const playerId = 'reddit:player';
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

function pbField(id) {
    return createHash('sha256').update(id, 'utf8').digest('base64url');
}

function checkpointTimes(bestTimeMs) {
    const count = track.checkpoints.length * stage.lapCount;
    return Array.from({ length: count }, (_, index) => ((index + 1) * (bestTimeMs / 1000)) / (count + 1));
}

// A valid ghost: the last sample ends at the finish time.
function ghostFor(finishTimeMs) {
    const samples = Math.ceil(finishTimeMs / 50) + 1;
    return {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs,
        origin: [0, 0, 0],
        deltas: Array.from({ length: (samples - 1) * 3 }, () => 0),
    };
}

function rowText(bestTimeMs, { packed = false, ghostFinishMs = bestTimeMs } = {}) {
    const ghost = ghostFor(ghostFinishMs);
    return JSON.stringify({
        schemaVersion: 2,
        trackKey: stage.trackKey,
        trackFingerprint: createTrackFingerprint(track),
        simulationRevision: 1,
        rulesRevision: stage.rulesRevision,
        lapCount: stage.lapCount,
        bestTimeMs,
        checkpointTimesSec: checkpointTimes(bestTimeMs),
        lapCompletionTimesSec: null,
        ghost: packed ? null : ghost,
        ...(packed ? { ghostPacked: packPbGhostTrace(ghost) } : {}),
        updatedAt: '2026-07-27T10:00:00.000Z',
    });
}

function pbs() {
    if (!hashes.has(competition.pbHashKey)) hashes.set(competition.pbHashKey, new Map());
    return hashes.get(competition.pbHashKey);
}

// What the mover does: copy the full row, then leave the stub in Redis.
async function moveRow(id, text = pbs().get(pbField(id))) {
    const sha256 = sha256Hex(text);
    const ref = { v: 1, key: `${ghostBlobPrefixForBoard(competition.pbHashKey)}${pbField(id)}-${sha256.slice(0, 16)}.gz`, sha256 };
    await blobHolder.blobs.store.put(ref.key, new Uint8Array(gzipSync(Buffer.from(text, 'utf8'))));
    pbs().set(pbField(id), buildGhostStub(text, ref));
    return ref;
}

function seedEntry(id, bestTimeMs, entryFields = {}) {
    if (!hashes.has(competition.entryHashKey)) hashes.set(competition.entryHashKey, new Map());
    hashes.get(competition.entryHashKey).set(id, JSON.stringify({
        playerId: id,
        trackKey: stage.trackKey,
        bestTimeMs,
        updatedAt: '2026-07-27T10:00:00.000Z',
        completedLaps: stage.lapCount,
        checkpointTimesSec: checkpointTimes(bestTimeMs),
        validationMethod: 'strict-replay',
        ...entryFields,
    }));
    if (!sortedSets.has(competition.leaderboardKey)) sortedSets.set(competition.leaderboardKey, new Map());
    sortedSets.get(competition.leaderboardKey).set(id, bestTimeMs);
    strings.set(createRedisPlayerProfileKey(id), JSON.stringify({
        playerId: id,
        leaderboardIdentity: 'reddit',
        redditUsername: id.slice('reddit:'.length),
        preferences: null,
        hasSeenGame: true,
        hasAnyData: true,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
    }));
}

function expectNoRedisWrites() {
    for (const name of ['hSet', 'hDel', 'set', 'del', 'watch']) expect(mockRedis[name]).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.clearAllMocks();
    hashes.clear();
    strings.clear();
    sortedSets.clear();
    blobHolder.blobs = createBlobTestStore();
    warnSpy.mockClear();
});

describe('moved ghost copy check', () => {
    it('accepts the original plain and packed rows from the stub text Redis holds', async () => {
        for (const packed of [false, true]) {
            const text = rowText(100, { packed });
            const sha256 = sha256Hex(text);
            const ref = { v: 1, key: `${ghostBlobPrefixForBoard(competition.pbHashKey)}x-${sha256.slice(0, 16)}.gz`, sha256 };
            const checked = verifyArchivedCopy({
                copy: new Uint8Array(gzipSync(Buffer.from(text, 'utf8'))),
                ref,
                stubText: buildGhostStub(text, ref),
                prefix: ghostBlobPrefixForBoard(competition.pbHashKey),
            });
            expect(checked).toMatchObject({ ok: true, fullText: text, ghost: { finishTimeMs: 100 } });
        }
    });

    it('rejects a missing copy, another board, other bytes and a changed stub field', () => {
        const text = rowText(100);
        const sha256 = sha256Hex(text);
        const prefix = ghostBlobPrefixForBoard(competition.pbHashKey);
        const ref = { v: 1, key: `${prefix}x-${sha256.slice(0, 16)}.gz`, sha256 };
        const copy = new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
        const stubText = buildGhostStub(text, ref);
        expect(verifyArchivedCopy({ copy: null, ref, stubText, prefix })).toEqual({ ok: false, code: 'missing' });
        expect(verifyArchivedCopy({ copy, ref, stubText, prefix: 'campaign-ghosts/v1/other/' }))
            .toEqual({ ok: false, code: 'mismatch' });
        const otherText = rowText(101);
        expect(verifyArchivedCopy({ copy: new Uint8Array(gzipSync(Buffer.from(otherText, 'utf8'))), ref, stubText, prefix }))
            .toEqual({ ok: false, code: 'mismatch' });
        const changedStub = stubText.replace('"bestTimeMs":100', '"bestTimeMs":99');
        expect(verifyArchivedCopy({ copy, ref, stubText: changedStub, prefix })).toEqual({ ok: false, code: 'mismatch' });
        expect(verifyArchivedCopy({ copy: new Uint8Array(gzipSync(Buffer.alloc(2 * 1024 * 1024, 32))), ref, stubText, prefix }))
            .toEqual({ ok: false, code: 'mismatch' });
    });

    it('names one blob folder per board', () => {
        expect(ghostBlobPrefixForBoard('dailygp:challenge-pbs:daily-gp-2026-09-20')).toBe('daily-ghosts/v1/daily-gp-2026-09-20/');
        expect(ghostBlobPrefixForBoard('campaign:numbered-v1:pbs:race-7')).toBe('campaign-ghosts/v1/numbered-v1/race-7/');
        expect(ghostBlobPrefixForBoard('something:else')).toBeNull();
    });
});

describe('reading a moved ghost for a race', () => {
    it('puts the original ghost back on the record for the answer and hides the reference', async () => {
        pbs().set(pbField(playerId), rowText(100, { packed: true }));
        await moveRow(playerId);
        const stored = await getPlayerTrackPbRecord({ playerId, competition, track });
        expect(isMovedPbRecord(stored)).toBe(true);
        const resolved = await resolveMovedPbGhost(stored, competition, track);
        expect(resolved.ghostUnavailable).toBe(false);
        expect(resolved.record.ghost).toEqual(ghostFor(100));
        const forGame = toGamePbRecord(resolved.record, resolved.ghostUnavailable);
        expect(forGame).not.toHaveProperty('ghostArchive');
        expect(forGame).not.toHaveProperty('ghostUnavailable');
        expectNoRedisWrites();
    });

    it('answers unavailable for a failed, missing or altered copy and changes nothing', async () => {
        pbs().set(pbField(playerId), rowText(100));
        const ref = await moveRow(playerId);
        const stub = pbs().get(pbField(playerId));
        for (const fault of ['fail', 'corrupt', 'missing']) {
            blobHolder.blobs = createBlobTestStore();
            if (fault === 'fail') blobHolder.blobs.faults.get = 'fail';
            if (fault === 'corrupt') {
                await blobHolder.blobs.store.put(ref.key, new Uint8Array(gzipSync(Buffer.from(rowText(100), 'utf8'))));
                blobHolder.blobs.faults.get = 'corrupt';
            }
            const stored = await getPlayerTrackPbRecord({ playerId, competition, track });
            const resolved = await resolveMovedPbGhost(stored, competition, track);
            expect(resolved).toMatchObject({ ghostUnavailable: true, record: { ghost: null } });
            expect(toGamePbRecord(resolved.record, true)).toMatchObject({ ghostUnavailable: true, ghost: null });
            expect(pbs().get(pbField(playerId))).toBe(stub);
        }
        expectNoRedisWrites();
    });

    it('answers unavailable when the copied ghost does not end at the best time', async () => {
        pbs().set(pbField(playerId), rowText(150, { ghostFinishMs: 100 }));
        await moveRow(playerId);
        const stored = await getPlayerTrackPbRecord({ playerId, competition, track });
        await expect(resolveMovedPbGhost(stored, competition, track)).resolves.toMatchObject({ ghostUnavailable: true });
    });

    it('passes a full row through without a blob read', async () => {
        pbs().set(pbField(playerId), rowText(100));
        const stored = await getPlayerTrackPbRecord({ playerId, competition, track });
        await expect(resolveMovedPbGhost(stored, competition, track)).resolves.toEqual({ record: stored, ghostUnavailable: false });
        expect(blobHolder.blobs.calls).toEqual([]);
    });
});

describe('moved ghosts as opponents', () => {
    const rival = 'reddit:rival';

    it('offers a moved row whose time and checkpoints match, without reading it', async () => {
        seedEntry(rival, 100);
        pbs().set(pbField(rival), rowText(100));
        await moveRow(rival);
        const entry = JSON.parse(hashes.get(competition.entryHashKey).get(rival));
        const stored = await getPlayerTrackPbRecord({ playerId: rival, competition, track });
        expect(isOpponentCandidateRecord(entry, stored, competition)).toBe(true);
        expect(isOpponentCandidateRecord({ ...entry, bestTimeMs: 99 }, stored, competition)).toBe(false);
        expect(blobHolder.blobs.calls.filter((call) => call.kind === 'get')).toEqual([]);
    });

    it('starts a chosen race with the read ghost, and refuses it when the read fails', async () => {
        seedEntry(playerId, 200);
        seedEntry(rival, 100);
        pbs().set(pbField(rival), rowText(100));
        await moveRow(rival);
        const selection = {
            kind: 'row',
            rank: 1,
            displayName: 'rival',
            bestTimeMs: 100,
            updatedAt: '2026-07-27T10:00:00.000Z',
        };
        const race = { raceId: stage.raceId };
        await expect(prepareCompetitionOpponentRace({ competition, playerId, race, selection })).resolves.toMatchObject({
            status: 200,
            body: { target: { bestTimeMs: 100, ghost: ghostFor(100) } },
        });
        blobHolder.blobs.faults.get = 'fail';
        await expect(prepareCompetitionOpponentRace({ competition, playerId, race, selection })).resolves.toMatchObject({
            status: 409,
            body: { reason: 'ghost_unavailable' },
        });
        expectNoRedisWrites();
    });

    it('tries at most two moved rivals, then takes the next full ghost', async () => {
        seedEntry(playerId, 200);
        for (const [id, time] of [['reddit:m1', 190], ['reddit:m2', 180], ['reddit:m3', 170]]) {
            seedEntry(id, time);
            pbs().set(pbField(id), rowText(time));
            await moveRow(id);
        }
        seedEntry('reddit:full', 160);
        pbs().set(pbField('reddit:full'), rowText(160));
        blobHolder.blobs.faults.get = 'fail';

        await expect(prepareCompetitionOpponentRace({
            competition,
            playerId,
            race: { raceId: stage.raceId },
            selection: { kind: 'next-faster', benchmarkTimeMs: 200 },
        })).resolves.toMatchObject({ status: 200, body: { target: { bestTimeMs: 160 } } });
        expect(blobHolder.blobs.calls.filter((call) => call.kind === 'get')).toHaveLength(2);
        expectNoRedisWrites();
    });
});
