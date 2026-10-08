import { isTrackGroundKey } from '../../game/track/grounds.js';
import { MEDAL_TIERS, normalizeMedalRow } from './medal-times.js';
import { isValidRoadLine } from './road-line.js';

// One history per track, holding only authored data; the editor rebuilds pointer and canvas state.
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

function validCloudKey(key) {
    if (validKey(key)) return true;
    if (typeof key !== 'string') return false;
    const parts = key.split(':');
    return parts.length === 2 && /^[A-Za-z0-9_-]{1,64}$/.test(parts[0]) && validKey(parts[1]);
}

function validPoint(point) {
    return point !== null && typeof point === 'object'
        && Number.isFinite(point.x) && Number.isFinite(point.y)
        && (point.cornerRadius === undefined
            || (Number.isFinite(point.cornerRadius) && point.cornerRadius >= 0 && point.cornerRadius <= 100));
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
        && ['cornerRadius'].every(
            (key) => track[key] === undefined || Number.isFinite(track[key]),
        )
        && (track.ground === undefined || isTrackGroundKey(track.ground))
        && (track.roadLine === undefined || isValidRoadLine(track.roadLine));
}

// A draft: { trackKey, originalTrackKey, track, draftLoop }, for browser recovery and cloud maps.
export function isValidDraft(draft) {
    return Boolean(draft) && validKey(draft.trackKey)
        && (draft.originalTrackKey === null || validKey(draft.originalTrackKey))
        && validTrack(draft.track) && validPoints(draft.draftLoop);
}

function normalizeRecovery(recovery) {
    if (!recovery || typeof recovery !== 'object' || !Array.isArray(recovery.drafts)
        || recovery.drafts.length > MAX_DRAFTS) return null;
    const selectedTrackKey = recovery.selectedTrackKey ?? null;
    if (selectedTrackKey !== null && !validKey(selectedTrackKey)) return null;
    const keys = new Set();
    const drafts = [];
    for (const draft of recovery.drafts) {
        if (!isValidDraft(draft) || keys.has(draft.trackKey)
            || (draft.cloudKey !== undefined && draft.cloudKey !== null && !validCloudKey(draft.cloudKey))) return null;
        if (draft.pendingMedalText !== undefined && (!draft.pendingMedalText
            || typeof draft.pendingMedalText !== 'object' || Array.isArray(draft.pendingMedalText)
            || !Object.entries(draft.pendingMedalText).every(([tier, text]) => (
                MEDAL_TIERS.includes(tier) && typeof text === 'string' && text.length <= 100
            )))) return null;
        keys.add(draft.trackKey);
        drafts.push({
            trackKey: draft.trackKey,
            originalTrackKey: draft.originalTrackKey,
            track: copySnapshot(draft.track),
            draftLoop: copySnapshot(draft.draftLoop),
            ...(draft.cloudKey !== undefined ? { cloudKey: draft.cloudKey } : {}),
            ...(draft.medalRow !== undefined ? { medalRow: normalizeMedalRow(draft.medalRow) } : {}),
            ...(draft.pendingMedalText !== undefined ? { pendingMedalText: copySnapshot(draft.pendingMedalText) } : {}),
        });
    }
    // The selected track may be clean while another track has an unsaved draft.
    return { selectedTrackKey, drafts };
}

// Pass a Storage explicitly; access can throw, so callers get a status.
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
