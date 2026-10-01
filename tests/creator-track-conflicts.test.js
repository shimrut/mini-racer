import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import {
    keepLockedCreatorDraft,
    loadLockedCreatorTrack,
    saveCreatorTrackWithRecovery,
} from '../tools/mapmaker/creator-track-save.js';
import {
    copyTrackName,
    fitsLiveSeries,
    sameDailyKeys,
    sameSeriesContent,
    sameTrackContent,
} from '../tools/mapmaker/creator-conflicts.js';
import {
    clearPendingMedalText,
    hasPendingMedalText,
    setPendingMedalText,
} from '../tools/mapmaker/pending-medal-text.js';

const medalRow = { author: 10, gold: 12, silver: 15, bronze: 20 };

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function json(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

// The Creator track routes, with records kept as the server keeps them.
function trackServer() {
    const records = new Map();
    const server = {
        records,
        puts: [],
        dropNextAnswer: false,
        failNextPut: null,
        holdNextRead: null,
        badNextAnswer: false,
        record(key, fields) {
            const record = { key, revision: 1, checksPassed: true, checkError: null, lockedAt: null, lockReason: null,
                origin: 'creator', updatedBy: 'OtherMod', updatedAt: '2026-10-01T09:30:00.000Z',
                draftLoop: [], medalRow, ...structuredClone(fields) };
            records.set(key, record);
            return record;
        },
        lock(key) {
            const record = records.get(key);
            records.set(key, { ...record, revision: record.revision + 1, lockedAt: '2026-10-01T10:00:00.000Z', lockReason: 'daily' });
        },
    };
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
        const key = decodeURIComponent(String(url).split('/').pop().split('?')[0]);
        if (options.method === 'PUT') {
            const body = JSON.parse(options.body);
            server.puts.push({ key, body });
            if (server.failNextPut) {
                const status = server.failNextPut;
                server.failNextPut = null;
                return json({ error: 'The track did not pass the checks.' }, status);
            }
            const existing = records.get(key);
            if ((existing?.revision ?? 0) !== body.baseRevision || existing?.lockedAt) {
                return json({ error: 'This track changed on another device.' }, 409);
            }
            const { baseRevision: _base, ...content } = body;
            const saved = { ...(existing ?? {}), key, ...content, revision: (existing?.revision ?? 0) + 1,
                checksPassed: true, checkError: null, lockedAt: null, lockReason: null,
                updatedBy: 'ModOne', updatedAt: '2026-10-01T09:45:00.000Z' };
            records.set(key, saved);
            if (server.dropNextAnswer) {
                server.dropNextAnswer = false;
                throw new TypeError('Failed to fetch');
            }
            if (server.badNextAnswer) {
                server.badNextAnswer = false;
                return json({});
            }
            return json({ track: saved });
        }
        if (server.holdNextRead) {
            const hold = server.holdNextRead;
            server.holdNextRead = null;
            await hold.promise;
        }
        const record = records.get(key);
        return record ? json({ track: structuredClone(record) }) : json({ error: 'Track not found.' }, 404);
    }));
    return server;
}

function editorState() {
    const editor = {
        state: {
            selectedTrackKey: 'firstTrack',
            tracks: { firstTrack: structuredClone(TRACKS.circuit), secondTrack: structuredClone(TRACKS.circuit) },
            draftLoop: [], dirtyTrackKeys: new Set(['firstTrack']),
            originalTrackKeyByKey: new Map([['firstTrack', 'firstTrack']]),
        },
        creatorRecords: new Map([['firstTrack', { revision: 3, lockedAt: null }]]),
        creatorSaveErrors: new Map(), creatorWriteGeneration: 0,
        medalRowByKey: new Map(), medalTimes: { firstTrack: medalRow }, draftLoopsByKey: new Map(),
        pendingMedalText: new Map(), editHistories: new Map(),
        baselineQualityCodesByKey: new Map(), baselineGeometryByKey: new Map(),
        creatorRecordMeta: (record) => ({ revision: record.revision, checksPassed: record.checksPassed,
            lockedAt: record.lockedAt ?? null, lockReason: record.lockReason ?? null }),
        setCreatorSaveStatus: vi.fn(), syncActionButtons: vi.fn(), syncCreatorTrackState: vi.fn(),
        setStatus: vi.fn(), scheduleQualityCheck: vi.fn(),
        chooseAction: vi.fn(async () => 'cancel'),
        isAppTrackKey: vi.fn((key) => Boolean(TRACKS[key])),
        commitPendingMedalText: (key) => !hasPendingMedalText(editor.pendingMedalText, key),
        loadTrack: vi.fn((key) => { editor.state.selectedTrackKey = key; }),
        discardCreatorTrack: vi.fn((key) => {
            delete editor.state.tracks[key];
            editor.creatorRecords.delete(key);
            editor.state.dirtyTrackKeys.delete(key);
        }),
        addCreatorRecord: vi.fn((record) => {
            editor.state.tracks[record.key] = structuredClone(record.track);
            editor.creatorRecords.set(record.key, editor.creatorRecordMeta(record));
            if (record.medalRow) editor.medalTimes[record.key] = record.medalRow;
            editor.medalRowByKey.delete(record.key);
            clearPendingMedalText(editor.pendingMedalText, record.key);
            editor.state.dirtyTrackKeys.delete(record.key);
        }),
    };
    editor.state.tracks.firstTrack.name = 'Night Cut';
    return editor;
}

// The content the server holds for the editor's firstTrack.
function serverCopy(editor, key = 'firstTrack', fields = {}) {
    return { track: structuredClone(editor.state.tracks[key]), draftLoop: [], medalRow, ...fields };
}

const signature = JSON.stringify;

afterEach(() => vi.unstubAllGlobals());

describe('content comparisons', () => {
    it('compares tracks in the form the server keeps', () => {
        const track = { ...structuredClone(TRACKS.circuit), name: ' Night Cut ', extra: true };
        const stored = { ...structuredClone(TRACKS.circuit), name: 'Night Cut' };
        expect(sameTrackContent({ track, medalRow }, { track: stored, draftLoop: [], medalRow })).toBe(true);
        expect(sameTrackContent({ track, medalRow: { ...medalRow, gold: 12.345 } },
            { track: stored, medalRow: { ...medalRow, gold: 12.35 } })).toBe(true);
        // A blank medal is not the same as no row, and not the saved time.
        expect(sameTrackContent({ track, medalRow: { ...medalRow, gold: 0 } }, { track: stored, medalRow })).toBe(false);
        expect(sameTrackContent({ track, medalRow: null }, { track: stored, medalRow: { ...medalRow, gold: '' } })).toBe(false);
        expect(sameTrackContent({ track: { ...stored, cornerRadius: 2 } }, { track: stored })).toBe(false);
    });

    it('compares series and Daily lists', () => {
        const series = { name: 'Night', ground: 'tarmac', stages: [{ trackKey: 'a', laps: 1, requiredMedals: 0 }] };
        expect(sameSeriesContent({ ...series, name: ' Night ' }, series)).toBe(true);
        expect(sameSeriesContent({ ...series, stages: [{ trackKey: 'a', laps: 1, requiredMedals: null, requiredMedalsText: '' }] }, series)).toBe(false);
        expect(sameDailyKeys(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameDailyKeys(['b', 'a'], ['a', 'b'])).toBe(false);
    });

    it('lets a live series take only new stages and a new name', () => {
        const server = { ground: 'tarmac', publishedStageCount: 1,
            stages: [{ trackKey: 'a', laps: 1, requiredMedals: 0 }] };
        expect(fitsLiveSeries({ ground: 'tarmac', stages: [...server.stages, { trackKey: 'b', laps: 2, requiredMedals: 2 }] }, server)).toBe(true);
        expect(fitsLiveSeries({ ground: 'tarmac', stages: [{ trackKey: 'a', laps: 3, requiredMedals: 0 }] }, server)).toBe(false);
        expect(fitsLiveSeries({ ground: 'snow', stages: server.stages }, server)).toBe(false);
    });

    it('names a copy with a free key inside the name limit', () => {
        expect(copyTrackName('Night Cut', () => false)).toEqual({ name: 'Night Cut copy', key: 'nightCutCopy' });
        expect(copyTrackName('Night Cut', (key) => key === 'nightCutCopy')).toEqual({ name: 'Night Cut copy 2', key: 'nightCutCopy2' });
        const long = copyTrackName('A very long track name that fills it', () => false);
        expect(long.name.length).toBeLessThanOrEqual(40);
        expect(long.name.endsWith(' copy')).toBe(true);
    });
});

describe('Creator track conflicts', () => {
    it('sends newer work once, with no question, when the server holds a save whose answer was lost', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 3, track: structuredClone(TRACKS.circuit) });
        // Save A reaches the server, but its answer is lost.
        server.dropNextAnswer = true;
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(server.records.get('firstTrack').revision).toBe(4);
        // The moderator edits B, then saves from the old revision.
        editor.state.tracks.firstTrack.name = 'Night Cut B';
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.chooseAction).not.toHaveBeenCalled();
        expect(server.puts.map((put) => put.body.baseRevision)).toEqual([3, 3, 4]);
        expect(server.records.get('firstTrack').track.name).toBe('Night Cut B');
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(5);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);
    });

    it('recognizes a lost save with fractional medal times by its stored form', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 3, track: structuredClone(TRACKS.circuit) });
        editor.medalRowByKey.set('firstTrack', { author: 10.004, gold: 12.345, silver: 15, bronze: 20 });
        server.dropNextAnswer = true;
        await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature);
        editor.state.tracks.firstTrack.name = 'Night Cut B';
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.chooseAction).not.toHaveBeenCalled();
    });

    it('keeps the evidence of a save whose answer cannot be read', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 3, track: structuredClone(TRACKS.circuit) });
        server.badNextAnswer = true;
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(3);
        editor.state.tracks.firstTrack.name = 'Night Cut B';
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.chooseAction).not.toHaveBeenCalled();
    });

    it('takes the server revision when the server already holds this work', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 6 });
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(server.puts).toHaveLength(1);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(6);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);

        // Typed medal text that is not in the row yet keeps it unsaved.
        editor.state.dirtyTrackKeys.add('firstTrack');
        editor.creatorRecords.set('firstTrack', { revision: 5 });
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'gold', '1');
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(6);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
    });

    it('asks when another device saved, and each answer does what it says', async () => {
        const server = trackServer();
        const theirs = (editor) => server.record('firstTrack', {
            ...serverCopy(editor), revision: 7, track: { ...structuredClone(TRACKS.circuit), name: 'Their Cut' } });

        let editor = editorState();
        theirs(editor);
        editor.chooseAction.mockResolvedValueOnce('mine');
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.chooseAction.mock.calls[0][0].choices.map((choice) => choice.value)).toEqual(['mine', 'both', 'theirs']);
        expect(editor.chooseAction.mock.calls[0][0].message).toContain('OtherMod');
        expect(server.puts.at(-1).body.baseRevision).toBe(7);
        expect(server.records.get('firstTrack').track.name).toBe('Night Cut');

        editor = editorState();
        theirs(editor);
        editor.chooseAction.mockResolvedValueOnce('theirs');
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(editor.state.tracks.firstTrack.name).toBe('Their Cut');
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);

        editor = editorState();
        theirs(editor);
        const putsBefore = server.puts.length;
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(server.puts).toHaveLength(putsBefore + 1);
        expect(editor.state.tracks.firstTrack.name).toBe('Night Cut');
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(3);
        // The next Save asks again.
        await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature);
        expect(editor.chooseAction).toHaveBeenCalledTimes(2);
    });

    it('keeps both: the draft becomes a new track with its medal times, and the original shows theirs', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 7, track: { ...structuredClone(TRACKS.circuit), name: 'Their Cut' } });
        editor.chooseAction.mockResolvedValueOnce('both');
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        const copy = server.records.get('nightCutCopy');
        expect(copy).toMatchObject({ revision: 1, medalRow, track: { name: 'Night Cut copy' } });
        expect(server.puts.at(-1)).toMatchObject({ key: 'nightCutCopy', body: { baseRevision: 0 } });
        expect(editor.state.selectedTrackKey).toBe('nightCutCopy');
        expect(editor.state.tracks.firstTrack.name).toBe('Their Cut');
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);
    });

    it('keeps the copy as an unsaved track when its save fails, or its medal text is not finished', async () => {
        const server = trackServer();
        let editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 7, track: { ...structuredClone(TRACKS.circuit), name: 'Their Cut' } });
        editor.chooseAction.mockResolvedValueOnce('both');
        server.failNextPut = null;
        const realFetch = globalThis.fetch;
        let puts = 0;
        globalThis.fetch = vi.fn(async (url, options) => {
            if (options?.method === 'PUT' && ++puts === 2) return json({ error: 'The track did not pass the checks.' }, 400);
            return realFetch(url, options);
        });
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(editor.state.tracks.nightCutCopy.name).toBe('Night Cut copy');
        expect(editor.state.dirtyTrackKeys.has('nightCutCopy')).toBe(true);
        expect(editor.creatorRecords.has('nightCutCopy')).toBe(false);
        globalThis.fetch = realFetch;

        editor = editorState();
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'author', '');
        editor.chooseAction.mockResolvedValueOnce('both');
        const putsBefore = server.puts.length;
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        expect(server.puts).toHaveLength(putsBefore + 1);
        expect(hasPendingMedalText(editor.pendingMedalText, 'nightCutCopy')).toBe(true);
        expect(editor.state.dirtyTrackKeys.has('nightCutCopy')).toBe(true);
    });

    it('saves the draft that was saved, even when another track is open during the read', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 7, track: { ...structuredClone(TRACKS.circuit), name: 'Their Cut' } });
        const read = deferred();
        server.holdNextRead = read;
        editor.chooseAction.mockResolvedValueOnce('mine');
        const saving = saveCreatorTrackWithRecovery(editor, 'firstTrack', signature);
        await vi.waitFor(() => expect(server.puts).toHaveLength(1));
        editor.state.selectedTrackKey = 'secondTrack';
        editor.state.tracks.secondTrack.name = 'Second Edit';
        editor.state.dirtyTrackKeys.add('secondTrack');
        read.resolve();
        expect(await saving).toBe(true);
        expect(server.puts.at(-1).key).toBe('firstTrack');
        expect(server.puts.at(-1).body.track.name).toBe('Night Cut');
        expect(editor.state.dirtyTrackKeys.has('secondTrack')).toBe(true);
        expect(editor.creatorRecords.has('secondTrack')).toBe(false);
    });

    it('never sends newer work to a track that locked after the conflict read', async () => {
        const server = trackServer();
        const editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 3, track: structuredClone(TRACKS.circuit) });
        server.dropNextAnswer = true;
        await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature);
        editor.state.tracks.firstTrack.name = 'Night Cut B';
        // The automatic retry reaches the server after the Daily locked it.
        const realFetch = globalThis.fetch;
        let reads = 0;
        globalThis.fetch = vi.fn(async (url, options) => {
            if (options?.method === 'GET' && ++reads === 1) {
                const answer = await realFetch(url, options);
                server.lock('firstTrack');
                return answer;
            }
            return realFetch(url, options);
        });
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(false);
        const stored = server.records.get('firstTrack');
        expect(stored).toMatchObject({ revision: 5, lockReason: 'daily' });
        expect(stored.track.name).toBe('Night Cut');
        expect(editor.creatorRecords.get('firstTrack').lockedAt).toBeTruthy();
        expect(editor.state.tracks.firstTrack.name).toBe('Night Cut B');
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.chooseAction).not.toHaveBeenCalled();
    });

    it('lets a locked track with unsaved work become a new track, or show the locked version', async () => {
        const server = trackServer();
        let editor = editorState();
        server.record('firstTrack', { ...serverCopy(editor), revision: 8, lockedAt: '2026-10-01T10:00:00.000Z',
            track: { ...structuredClone(TRACKS.circuit), name: 'Locked Cut' } });
        editor.creatorRecords.set('firstTrack', { revision: 8, lockedAt: '2026-10-01T10:00:00.000Z' });
        expect(await keepLockedCreatorDraft(editor, 'firstTrack', signature)).toBe(true);
        expect(server.records.get('nightCutCopy').track.name).toBe('Night Cut copy');
        expect(editor.state.tracks.firstTrack.name).toBe('Locked Cut');
        expect(server.records.get('firstTrack').revision).toBe(8);

        editor = editorState();
        editor.creatorRecords.set('firstTrack', { revision: 8, lockedAt: '2026-10-01T10:00:00.000Z' });
        expect(await loadLockedCreatorTrack(editor, 'firstTrack', signature)).toBe(true);
        expect(editor.state.tracks.firstTrack.name).toBe('Locked Cut');
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);
    });

    it('offers a new track, not a save, for a deleted copy of an app track', async () => {
        trackServer();
        const editor = editorState();
        editor.state.tracks.circuit = editor.state.tracks.firstTrack;
        delete editor.state.tracks.firstTrack;
        editor.state.selectedTrackKey = 'circuit';
        editor.state.dirtyTrackKeys = new Set(['circuit']);
        editor.creatorRecords = new Map([['circuit', { revision: 2, lockedAt: null }]]);
        editor.medalTimes = { circuit: medalRow };
        editor.chooseAction.mockResolvedValueOnce('copy');
        expect(await saveCreatorTrackWithRecovery(editor, 'circuit', signature)).toBe(true);
        expect(editor.chooseAction.mock.calls[0][0].choices.map((choice) => choice.value)).toEqual(['copy', 'discard']);
        expect(editor.discardCreatorTrack).toHaveBeenCalledWith('circuit');
        expect(editor.state.tracks.nightCutCopy).toBeTruthy();
    });

    it('creates a deleted custom track again from revision 0 when asked', async () => {
        const server = trackServer();
        const editor = editorState();
        editor.chooseAction.mockResolvedValueOnce('mine');
        expect(await saveCreatorTrackWithRecovery(editor, 'firstTrack', signature)).toBe(true);
        expect(server.puts.map((put) => put.body.baseRevision)).toEqual([3, 0]);
        expect(server.records.get('firstTrack').revision).toBe(1);
    });
});
