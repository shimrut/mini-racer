import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import {
    captureUnsavedCreatorWork,
    creatorTrackContent,
    isCreatorTrackAtSavedVersion,
    restoreUnsavedCreatorWork,
    saveCreatorTrackSnapshot,
} from '../tools/mapmaker/creator-track-save.js';
import { sameTrackContent } from '../tools/mapmaker/creator-conflicts.js';
import { buildRoadLine, isValidRoadLine, splitRoadLine, withRoadLine } from '../tools/mapmaker/road-line.js';

const medalRow = { author: 10, gold: 12, silver: 15, bronze: 20 };
const roadLine = {
    points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }],
    width: 4.8,
};

function editorState() {
    return {
        state: {
            selectedTrackKey: 'firstTrack',
            tracks: { firstTrack: { ...structuredClone(TRACKS.circuit), roadLine: structuredClone(roadLine) } },
            draftLoop: [], dirtyTrackKeys: new Set(['firstTrack']),
            originalTrackKeyByKey: new Map(),
        },
        creatorRecords: new Map([['firstTrack', { revision: 3 }]]),
        creatorSaveErrors: new Map(), creatorWriteGeneration: 0,
        medalRowByKey: new Map(), medalTimes: { firstTrack: medalRow }, draftLoopsByKey: new Map(),
        pendingMedalText: new Map(), editHistories: new Map(),
        baselineQualityCodesByKey: new Map(), baselineGeometryByKey: new Map(),
        creatorRecordMeta: (record) => ({ revision: record.revision, checksPassed: record.checksPassed }),
        isCreatorLocked: () => false,
        setCreatorSaveStatus: vi.fn(), syncActionButtons: vi.fn(), syncCreatorTrackState: vi.fn(),
        setStatus: vi.fn(), scheduleQualityCheck: vi.fn(),
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('road line helpers', () => {
    it('moves the drawn points by the offset of the walls, and keeps the width', () => {
        const drawn = roadLine.points.map(({ x, y }) => ({ x: x - 6, y: y + 2 }));
        expect(buildRoadLine(drawn, { x: 6, y: -2 }, 4.8)).toEqual(roadLine);
    });

    it('keeps no line that the server would refuse', () => {
        const many = Array.from({ length: 161 }, (_, index) => ({ x: index, y: index % 2 }));
        expect(buildRoadLine(many, { x: 0, y: 0 }, 4.8)).toBeNull();
        expect(buildRoadLine(roadLine.points.slice(0, 2), { x: 0, y: 0 }, 4.8)).toBeNull();
        expect(buildRoadLine(roadLine.points, { x: 0, y: 0 }, 25)).toBeNull();
        expect(isValidRoadLine({ points: roadLine.points, width: 4.8 })).toBe(true);
        const rounded = (cornerRadius) => ({ ...roadLine, points: [{ ...roadLine.points[0], cornerRadius }, ...roadLine.points.slice(1)] });
        expect(isValidRoadLine(rounded(5))).toBe(true);
        expect(isValidRoadLine(rounded(21))).toBe(false);
        expect(isValidRoadLine(rounded(-1))).toBe(false);
    });

    it('takes the line off the track, and puts it back', () => {
        const track = { ...structuredClone(TRACKS.circuit), roadLine };
        const split = splitRoadLine(track);
        expect(split.track).not.toHaveProperty('roadLine');
        expect(split.roadLine).toEqual(roadLine);
        expect(withRoadLine(split.track, split.roadLine)).toEqual(track);
        expect(withRoadLine(track, null)).not.toHaveProperty('roadLine');
        expect(splitRoadLine(undefined)).toEqual({ track: undefined, roadLine: null });
    });
});

describe('Creator road line', () => {
    it('sends the road line beside the track, not in it', async () => {
        const editor = editorState();
        const fetchMock = vi.fn(async (_url, request) => {
            const sent = JSON.parse(request.body);
            return { ok: true, json: async () => ({ track: { key: 'firstTrack', ...sent, revision: 4, checksPassed: true } }) };
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(saveCreatorTrackSnapshot(editor, 'firstTrack', () => 'signature')).resolves.toBe(true);
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.roadLine).toEqual(roadLine);
        expect(sent.track).not.toHaveProperty('roadLine');
        // The server answer with the same line is the saved version.
        expect(isCreatorTrackAtSavedVersion(editor, 'firstTrack')).toBe(true);
        expect(editor.state.tracks.firstTrack.roadLine).toEqual(roadLine);
    });

    it('sees a changed road line as unsaved work', () => {
        const editor = editorState();
        const saved = { key: 'firstTrack', ...creatorTrackContent(editor, 'firstTrack') };
        expect(sameTrackContent(saved, creatorTrackContent(editor, 'firstTrack'))).toBe(true);
        editor.state.tracks.firstTrack.roadLine.points[2].cornerRadius = 5;
        expect(sameTrackContent(saved, creatorTrackContent(editor, 'firstTrack'))).toBe(false);
        delete editor.state.tracks.firstTrack.roadLine.points[2].cornerRadius;
        expect(sameTrackContent(saved, creatorTrackContent(editor, 'firstTrack'))).toBe(true);
        editor.state.tracks.firstTrack.roadLine.width = 6;
        expect(sameTrackContent(saved, creatorTrackContent(editor, 'firstTrack'))).toBe(false);
        expect(sameTrackContent({ ...saved, roadLine: null }, { ...saved, roadLine: undefined })).toBe(true);
    });

    it('puts the road line back on the track after a refresh', () => {
        const editor = editorState();
        const unsaved = captureUnsavedCreatorWork(editor);
        editor.state.tracks.firstTrack = structuredClone(TRACKS.circuit);
        restoreUnsavedCreatorWork(editor, unsaved);
        expect(editor.state.tracks.firstTrack.roadLine).toEqual(roadLine);
    });
});
