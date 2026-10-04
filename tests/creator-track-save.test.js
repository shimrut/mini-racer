import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import {
    captureUnsavedCreatorWork,
    creatorTrackContent,
    hasCreatorUnsavedWork,
    isCreatorTrackAtSavedVersion,
    rememberSavedCreatorContent,
    restoreUnsavedCreatorWork,
    saveCreatorTrackSnapshot,
} from '../tools/mapmaker/creator-track-save.js';
import { clearPendingMedalText, setPendingMedalText } from '../tools/mapmaker/pending-medal-text.js';

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
        pendingMedalText: new Map(), editHistories: new Map(),
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
    it('keeps the server sharing status when refresh restores a newer unsaved private edit', () => {
        const editor = editorState();
        editor.creatorRecords.set('firstTrack', { revision: 3, privateDraft: true });
        const unsaved = captureUnsavedCreatorWork(editor);
        editor.creatorRecords.set('firstTrack', { revision: 4, privateDraft: false });
        editor.isCreatorLocked = () => false;
        restoreUnsavedCreatorWork(editor, unsaved);
        expect(editor.creatorRecords.get('firstTrack')).toMatchObject({ revision: 3, privateDraft: false });
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
    });

    it('binds a private draft save to the Reddit account that loaded the editor', async () => {
        const editor = editorState();
        editor.creatorUsername = 'RaceMod';
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        const sent = request.acknowledge();
        expect(sent.creatorUsername).toBe('RaceMod');
        expect(await saving).toBe(true);
    });

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

describe('Creator typed medal text', () => {
    it('keeps the track unsaved when medal text is typed during the save', async () => {
        const editor = editorState();
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'gold', '13');
        request.acknowledge();
        expect(await saving).toBe(true);
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('Newer changes are still unsaved'));
    });

    it('keeps typed text through a refresh that replaces the tracks', () => {
        const editor = editorState();
        editor.isCreatorLocked = (key) => Boolean(editor.creatorRecords.get(key)?.lockedAt);
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'gold', '');
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'silver', '1');
        const unsaved = captureUnsavedCreatorWork(editor);
        // The refresh hydrates each server record. That replaces the typed text.
        editor.state.tracks = { firstTrack: structuredClone(TRACKS.circuit) };
        editor.creatorRecords = new Map([['firstTrack', { revision: 4 }]]);
        clearPendingMedalText(editor.pendingMedalText, 'firstTrack');
        restoreUnsavedCreatorWork(editor, unsaved);
        expect(editor.pendingMedalText.get('firstTrack')).toEqual(new Map([['gold', ''], ['silver', '1']]));
        expect(editor.state.dirtyTrackKeys.has('firstTrack')).toBe(true);
        expect(editor.creatorRecords.get('firstTrack').revision).toBe(3);
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
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'gold', '1');
        expect(hasCreatorUnsavedWork(editor)).toBe(true);
        editor.pendingMedalText.clear();
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

describe('Creator track back at its saved version', () => {
    function savedEditor() {
        const editor = editorState();
        rememberSavedCreatorContent(editor, {
            key: 'firstTrack',
            revision: 3,
            track: structuredClone(TRACKS.circuit),
            draftLoop: [],
            medalRow,
        });
        return editor;
    }

    it('knows a track that an edit brought back to the saved version', () => {
        const editor = savedEditor();
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);

        const x = editor.state.tracks.firstTrack.outer[0].x;
        editor.state.tracks.firstTrack.outer[0].x = x + 1;
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        // Undo gives back a copy of the earlier track.
        editor.state.tracks.firstTrack = JSON.parse(JSON.stringify({
            ...editor.state.tracks.firstTrack,
            outer: editor.state.tracks.firstTrack.outer.map((point, index) => (index === 0 ? { ...point, x } : point)),
        }));
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);
    });

    it('counts the name, the medal times and the unfinished road', () => {
        const editor = savedEditor();
        editor.state.tracks.firstTrack.name = 'Other name';
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        editor.state.tracks.firstTrack.name = `${TRACKS.circuit.name} `;
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);

        editor.medalRowByKey.set('firstTrack', { ...medalRow, gold: 12.5 });
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        // A time typed back to its value, written another way, is the same.
        editor.medalRowByKey.set('firstTrack', { ...medalRow, gold: 12.001 });
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);

        editor.state.draftLoop = [{ x: 1, y: 2 }];
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        editor.state.draftLoop = [];
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);
    });

    it('keeps the track unsaved for typed text, a save in flight, another revision or a new track', () => {
        const editor = savedEditor();
        setPendingMedalText(editor.pendingMedalText, 'firstTrack', 'gold', '1');
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        clearPendingMedalText(editor.pendingMedalText, 'firstTrack');

        editor.creatorSavingKey = 'firstTrack';
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
        editor.creatorSavingKey = null;

        // The editor holds another revision: the saved content is not known.
        editor.creatorRecords.set('firstTrack', { revision: 4 });
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);

        expect(isCreatorTrackAtSavedVersion(editor, 'secondTrack')).toBe(false);
    });

    it('takes a save as the new saved version, and a save with no answer as unknown', async () => {
        const editor = savedEditor();
        editor.state.tracks.firstTrack.name = 'New name';
        const request = delaySave();
        const saving = saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        request.acknowledge();
        await saving;
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);
        editor.state.tracks.firstTrack.name = TRACKS.circuit.name;
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);

        // The answer is lost: the server can hold this name or the earlier one.
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
        await saveCreatorTrackSnapshot(editor, 'firstTrack', JSON.stringify);
        editor.state.tracks.firstTrack.name = 'New name';
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(false);
    });
});
