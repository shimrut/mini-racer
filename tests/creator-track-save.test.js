import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { creatorTrackContent, hasCreatorUnsavedWork, saveCreatorTrackSnapshot } from '../tools/mapmaker/creator-track-save.js';

const medalRow = { author: 10, gold: 12, silver: 15, bronze: 20 };

function editorState() {
    return {
        state: {
            selectedTrackKey: 'firstTrack',
            tracks: { firstTrack: structuredClone(TRACKS.circuit), secondTrack: structuredClone(TRACKS.circuit) },
            draftLoop: [], dirtyTrackKeys: new Set(['firstTrack', 'secondTrack']),
            originalTrackKeyByKey: new Map(),
        },
        creatorRecords: new Map([['firstTrack', { revision: 3 }]]),
        creatorSaveErrors: new Map(), creatorWriteGeneration: 0,
        medalRowByKey: new Map(), medalTimes: { firstTrack: medalRow }, draftLoopsByKey: new Map(),
        baselineQualityCodesByKey: new Map(), baselineGeometryByKey: new Map(),
        creatorRecordMeta: (record) => ({ revision: record.revision, checksPassed: record.checksPassed }),
        setCreatorSaveStatus: vi.fn(), syncActionButtons: vi.fn(), syncCreatorTrackState: vi.fn(),
        setStatus: vi.fn(), scheduleQualityCheck: vi.fn(),
    };
}

function delaySave() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const fetchMock = vi.fn(() => promise);
    vi.stubGlobal('fetch', fetchMock);
    return {
        fetchMock,
        acknowledge() {
            const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
            resolve({ ok: true, json: async () => ({ track: {
                key: 'firstTrack', ...sent, revision: 4, checksPassed: true,
            } }) });
            return sent;
        },
        fail() { resolve({ ok: false, status: 409, json: async () => ({ error: 'Track changed. Reload before saving.' }) }); },
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('Creator track save acknowledgements', () => {
    it('acknowledges the submitted key after selecting another unsaved track', async () => {
        const editor = editorState();
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        expect(editor.creatorSavingKey).toBe('firstTrack');
        editor.state.selectedTrackKey = 'secondTrack';
        request.acknowledge();
        expect(await saving).toBe(true);
        expect(editor.state.dirtyTrackKeys).toEqual(new Set(['secondTrack']));
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(4);
        expect(editor.creatorRecords.has('secondTrack')).toBe(false);
    });

    it('keeps name, geometry, medal and drawing edits made during the request unsaved', async () => {
        const editor = editorState();
        const request = delaySave();
        const original = structuredClone(editor.state.tracks.firstTrack);
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        editor.state.tracks.firstTrack.name = 'Later name';
        editor.state.tracks.firstTrack.outer[0].x += 1;
        editor.medalRowByKey.set('firstTrack', { ...medalRow, bronze: 25 });
        editor.state.draftLoop = [{ x: 3, y: 4 }];
        const sent = request.acknowledge();
        await saving;
        expect(sent.track).toEqual(original);
        expect(sent.draftLoop).toEqual([]);
        expect(sent.medalRow.bronze).toBe(20);
        expect(editor.state.tracks.firstTrack.name).toBe('Later name');
        expect(editor.medalRowByKey.get('firstTrack').bronze).toBe(25);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.baselineGeometryByKey.get('firstTrack')).toBe(JSON.stringify(original));
        expect(editor.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('still unsaved'));

        const retry = delaySave();
        const resaving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        const retried = retry.acknowledge();
        await resaving;
        expect(retried.baseRevision).toBe(4);
        expect(retried.track.name).toBe('Later name');
        expect(retried.draftLoop).toEqual([{ x: 3, y: 4 }]);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(false);
    });

    it('retains a switched track’s newer drawing and a conflicting save’s data and revision', async () => {
        const editor = editorState();
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        editor.draftLoopsByKey.set('firstTrack', [{ x: 1, y: 2 }]);
        editor.state.selectedTrackKey = 'secondTrack';
        request.acknowledge();
        await saving;
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);

        const failed = delaySave();
        const retry = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        failed.fail();
        expect(await retry).toBe(false);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(4);
        expect(editor.draftLoopsByKey.get('firstTrack')).toEqual([{ x: 1, y: 2 }]);
        expect(editor.creatorSaveErrors.get('firstTrack')).toContain('Reload before saving');
        expect(editor.creatorSavingKey).toBeNull();
        expect(editor.busy).toBe(false);
    });

    it('preserves a partial medal edit during refresh snapshots and a draft save', async () => {
        const editor = editorState();
        editor.medalRowByKey.set('firstTrack', { ...medalRow, gold: 0 });
        expect(creatorTrackContent(editor, 'firstTrack').medalRow.gold).toBe(0);
        editor.medalRowByKey.clear();
        delete editor.medalTimes.firstTrack;
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        editor.medalRowByKey.set('firstTrack', { author: 10, gold: 0, silver: 0, bronze: 0 });
        request.acknowledge();
        await saving;
        expect(editor.medalRowByKey.get('firstTrack').author).toBe(10);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
    });
});

describe('Creator navigation guard', () => {
    it('checks all tracks, drawings, panel changes and pending writes', () => {
        const editor = editorState();
        editor.state.dirtyTrackKeys = new Set(['secondTrack']);
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
        editor.state.dirtyTrackKeys.clear();
        expect(hasCreatorUnsavedWork(editor)).toBe(false);
        editor.draftLoopsByKey.set('secondTrack', [{ x: 1, y: 1 }]);
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
        editor.draftLoopsByKey.clear();
        editor.state.draftLoop = [{ x: 1, y: 1 }];
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
        editor.state.draftLoop = [];
        editor.creatorPanels = { hasUnsavedChanges: () => true };
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
        editor.creatorPanels = null;
        editor.busy = true;
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
    });
});
