import { isTrackGroundKey } from '../../game/track/grounds.js';

// A history instance belongs to one selected track. Keep only authored data in
// snapshots; pointer/canvas state is rebuilt by the editor after restoration.
function copySnapshot(value) {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new TypeError('Edit history needs a JSON-serializable snapshot.');
    }
    return JSON.parse(json);
}

export function createEditHistory(initialSnapshot, { limit = 50 } = {}) {
    const maxEntries = Number.isInteger(limit) && limit > 0 ? limit + 1 : 51;
    let entries = [copySnapshot(initialSnapshot)];
    let index = 0;
    let beforeEdit = null;

    function append(snapshot) {
        if (JSON.stringify(entries[index]) === JSON.stringify(snapshot)) {
            return false;
        }
        entries = entries.slice(0, index + 1);
        entries.push(snapshot);
        if (entries.length > maxEntries) {
            entries.shift();
        }
        index = entries.length - 1;
        return true;
    }

    return {
        get canUndo() { return index > 0; },
        get canRedo() { return index < entries.length - 1; },
        current() { return copySnapshot(entries[index]); },
        reset(snapshot) {
            entries = [copySnapshot(snapshot)];
            index = 0;
            beforeEdit = null;
        },
        beginEdit(snapshot) {
            if (beforeEdit === null) {
                beforeEdit = copySnapshot(snapshot);
            }
        },
        commitEdit(snapshot) {
            if (beforeEdit === null) return false;
            const before = beforeEdit;
            beforeEdit = null;
            const after = copySnapshot(snapshot);
            if (JSON.stringify(before) === JSON.stringify(after)) return false;
            // Preserve edits made since the previous checkpoint, if any.
            append(before);
            return append(after);
        },
        cancelEdit() { beforeEdit = null; },
        recordEdit(before, after) {
            this.beginEdit(before);
            return this.commitEdit(after);
        },
        undo() {
            beforeEdit = null;
            return index > 0 ? copySnapshot(entries[--index]) : null;
        },
        redo() {
            beforeEdit = null;
            return index < entries.length - 1 ? copySnapshot(entries[++index]) : null;
        },
    };
}

export const DRAFT_RECOVERY_KEY = 'dailygp:mapmaker:drafts:v1';
const MAX_RECOVERY_CHARS = 2_000_000;
const MAX_DRAFTS = 20;
const MAX_POINTS = 10_000;
const MAX_CHECKPOINTS = 100;
const TRACK_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function validKey(key) {
    return typeof key === 'string'
        && TRACK_KEY_RE.test(key)
        && !['__proto__', 'constructor', 'prototype'].includes(key);
}

function validPoint(point) {
    return point !== null && typeof point === 'object'
        && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validPoints(points) {
    return Array.isArray(points) && points.length <= MAX_POINTS && points.every(validPoint);
}

function validGate(gate) {
    return gate !== null && typeof gate === 'object'
        && validPoint(gate.p1) && validPoint(gate.p2);
}

function validTrack(track) {
    return track !== null && typeof track === 'object'
        && typeof track.name === 'string' && track.name.length <= 200
        && validPoints(track.outer) && validPoints(track.inner)
        && validGate(track.startLine) && validPoint(track.startPos)
        && Number.isFinite(track.startAngle)
        && Array.isArray(track.checkpoints)
        && track.checkpoints.length <= MAX_CHECKPOINTS
        && track.checkpoints.every(validGate)
        && ['cornerRadius', 'drawWidth', 'lineSmoothing'].every(
            (key) => track[key] === undefined || Number.isFinite(track[key]),
        )
        && (track.ground === undefined || isTrackGroundKey(track.ground));
}

function normalizeRecovery(recovery) {
    if (!recovery || typeof recovery !== 'object' || !Array.isArray(recovery.drafts)
        || recovery.drafts.length > MAX_DRAFTS) return null;
    const selectedTrackKey = recovery.selectedTrackKey ?? null;
    if (selectedTrackKey !== null && !validKey(selectedTrackKey)) return null;
    const keys = new Set();
    const drafts = [];
    for (const draft of recovery.drafts) {
        if (!draft || !validKey(draft.trackKey) || keys.has(draft.trackKey)
            || (draft.originalTrackKey !== null && !validKey(draft.originalTrackKey))
            || !['daily', 'campaign'].includes(draft.destination)
            || !validTrack(draft.track) || !validPoints(draft.draftLoop)) return null;
        keys.add(draft.trackKey);
        drafts.push({
            trackKey: draft.trackKey,
            originalTrackKey: draft.originalTrackKey,
            destination: draft.destination,
            track: copySnapshot(draft.track),
            draftLoop: copySnapshot(draft.draftLoop),
        });
    }
    // The selected track may be clean while another track has an unsaved draft.
    return { selectedTrackKey, drafts };
}

// Supply window.sessionStorage or window.localStorage explicitly. Storage access
// can throw (private mode, quota, disabled storage), so callers receive status.
export function saveDraftRecovery(storage, recovery, key = DRAFT_RECOVERY_KEY) {
    try {
        const normalized = normalizeRecovery(recovery);
        if (!normalized) return false;
        const json = JSON.stringify({ version: 1, ...normalized });
        if (json.length > MAX_RECOVERY_CHARS) return false;
        storage.setItem(key, json);
        return true;
    } catch {
        return false;
    }
}

export function loadDraftRecovery(storage, key = DRAFT_RECOVERY_KEY) {
    try {
        const json = storage.getItem(key);
        if (!json || json.length > MAX_RECOVERY_CHARS) return null;
        const stored = JSON.parse(json);
        if (stored.version !== 1) return null;
        return normalizeRecovery(stored);
    } catch {
        return null;
    }
}

export function clearDraftRecovery(storage, key = DRAFT_RECOVERY_KEY) {
    try {
        storage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}
