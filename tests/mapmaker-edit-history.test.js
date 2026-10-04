import { describe, expect, it } from 'vitest';
import {
    clearDraftRecovery,
    createEditHistory,
    loadDraftRecovery,
    saveDraftRecovery,
} from '../tools/mapmaker/edit-history.js';

const point = (x, y) => ({ x, y });
const gate = (x) => ({ p1: point(x, 0), p2: point(x, 4) });
const track = () => ({
    name: 'Draft Circuit',
    cornerRadius: 3,
    outer: [point(0, 0), point(10, 0), point(10, 10)],
    inner: [point(2, 2), point(8, 2), point(8, 8)],
    startLine: gate(1),
    startPos: point(1, 2),
    startAngle: 0,
    checkpoints: [gate(5)],
});

const recovery = () => ({
    selectedTrackKey: 'draftCircuit',
    drafts: [{
        trackKey: 'draftCircuit',
        originalTrackKey: null,
        track: track(),
        draftLoop: [point(2, 3), point(4, 6)],
    }],
});

function memoryStorage() {
    const items = new Map();
    return {
        getItem(key) { return items.get(key) ?? null; },
        setItem(key, value) { items.set(key, value); },
        removeItem(key) { items.delete(key); },
    };
}

describe('Mapmaker edit history', () => {
    it('treats a drag as one edit and isolates recorded snapshots', () => {
        const original = track();
        const history = createEditHistory(original);
        history.beginEdit(original);
        original.outer[0].x = 2;
        original.outer[0].x = 4;
        history.commitEdit(original);
        original.outer[0].x = 100;

        expect(history.undo().outer[0].x).toBe(0);
        expect(history.undo()).toBeNull();
        expect(history.redo().outer[0].x).toBe(4);
        expect(history.redo()).toBeNull();
    });

    it('drops redo after a new edit and bounds undo history', () => {
        const history = createEditHistory({ x: 0 }, { limit: 2 });
        history.recordEdit({ x: 0 }, { x: 1 });
        history.recordEdit({ x: 1 }, { x: 2 });
        history.recordEdit({ x: 2 }, { x: 3 });
        expect(history.undo()).toEqual({ x: 2 });
        expect(history.undo()).toEqual({ x: 1 });
        expect(history.undo()).toBeNull();
        expect(history.redo()).toEqual({ x: 2 });
        history.recordEdit({ x: 2 }, { x: 4 });
        expect(history.redo()).toBeNull();
        expect(history.undo()).toEqual({ x: 2 });
        expect(history.undo()).toEqual({ x: 1 });
        expect(history.undo()).toBeNull();

        history.reset({ x: 8 });
        expect(history.current()).toEqual({ x: 8 });
        expect(history.undo()).toBeNull();
    });

    it('ignores unchanged and canceled edits', () => {
        const history = createEditHistory({ x: 0 });
        history.beginEdit({ x: 0 });
        expect(history.commitEdit({ x: 0 })).toBe(false);
        history.beginEdit({ x: 0 });
        history.cancelEdit();
        expect(history.commitEdit({ x: 1 })).toBe(false);
        expect(history.undo()).toBeNull();
    });
});

describe('Mapmaker draft recovery', () => {
    it('preserves renamed cloud identity, medals and the editable road through recovery', () => {
        const storage = memoryStorage();
        const draft = recovery();
        draft.drafts[0].cloudKey = 'previousName';
        draft.drafts[0].medalRow = { author: 20, gold: 21, silver: 22, bronze: 23 };
        draft.drafts[0].pendingMedalText = { gold: '21.5' };
        draft.drafts[0].track.roadLine = {
            width: 4.455,
            points: [point(0, 0), { ...point(20, 0), width: 4.798, cornerRadius: 5 }, point(20, 20)],
        };
        expect(saveDraftRecovery(storage, draft, 'alice')).toBe(true);
        expect(loadDraftRecovery(storage, 'bob')).toBeNull();
        expect(loadDraftRecovery(storage, 'alice')).toEqual(draft);
        draft.drafts[0].track.roadLine.points[1].width = 200;
        expect(saveDraftRecovery(storage, draft, 'alice')).toBe(false);
    });
    it('preserves valid local corner radii and rejects invalid ones', () => {
        const storage = memoryStorage();
        const draft = recovery();
        draft.drafts[0].track.outer[0].cornerRadius = 5;
        expect(saveDraftRecovery(storage, draft)).toBe(true);
        expect(loadDraftRecovery(storage).drafts[0].track.outer[0].cornerRadius).toBe(5);
        draft.drafts[0].track.outer[0].cornerRadius = -1;
        expect(saveDraftRecovery(storage, draft)).toBe(false);
    });
    it('round trips multiple unsaved tracks without retaining object references', () => {
        const storage = memoryStorage();
        const draft = recovery();
        draft.drafts.push({
            trackKey: 'otherDraft',
            originalTrackKey: 'oldTrack',
            track: track(),
            draftLoop: [],
        });
        draft.selectedTrackKey = 'alreadySavedTrack';
        expect(saveDraftRecovery(storage, draft)).toBe(true);
        draft.drafts[0].track.outer[0].x = 99;
        const restored = loadDraftRecovery(storage);
        expect(restored.drafts[0].track.outer[0].x).toBe(0);
        expect(restored.drafts[1].originalTrackKey).toBe('oldTrack');
        expect(restored.drafts[0].draftLoop).toEqual([point(2, 3), point(4, 6)]);
        expect(restored.selectedTrackKey).toBe('alreadySavedTrack');
        expect(clearDraftRecovery(storage)).toBe(true);
        expect(loadDraftRecovery(storage)).toBeNull();
    });

    it('keeps a known ground and rejects an unknown ground', () => {
        const storage = memoryStorage();
        const draft = recovery();
        draft.drafts[0].track.ground = 'dirt';
        expect(saveDraftRecovery(storage, draft)).toBe(true);
        expect(loadDraftRecovery(storage).drafts[0].track.ground).toBe('dirt');

        draft.drafts[0].track.ground = 'lava';
        expect(saveDraftRecovery(storage, draft)).toBe(false);
        storage.setItem('dailygp:mapmaker:drafts:v1', JSON.stringify({ version: 1, ...draft }));
        expect(loadDraftRecovery(storage)).toBeNull();
    });

    it('rejects malformed, oversized, and invalid data safely', () => {
        const storage = memoryStorage();
        storage.setItem('dailygp:mapmaker:drafts:v1', '{broken json');
        expect(loadDraftRecovery(storage)).toBeNull();
        storage.setItem('dailygp:mapmaker:drafts:v1', JSON.stringify({ version: 2, ...recovery() }));
        expect(loadDraftRecovery(storage)).toBeNull();
        storage.setItem('dailygp:mapmaker:drafts:v1', 'x'.repeat(2_000_001));
        expect(loadDraftRecovery(storage)).toBeNull();

        const bad = recovery();
        bad.drafts[0].track.outer[0].x = Infinity;
        expect(saveDraftRecovery(storage, bad)).toBe(false);
        bad.drafts[0].track.outer[0].x = 0;
        bad.drafts[0].trackKey = '__proto__';
        expect(saveDraftRecovery(storage, bad)).toBe(false);
    });

    it('handles unavailable or quota-limited storage', () => {
        const denied = {
            getItem() { throw new Error('denied'); },
            setItem() { throw new Error('quota'); },
            removeItem() { throw new Error('denied'); },
        };
        expect(saveDraftRecovery(denied, recovery())).toBe(false);
        expect(loadDraftRecovery(denied)).toBeNull();
        expect(clearDraftRecovery(denied)).toBe(false);
    });
});
