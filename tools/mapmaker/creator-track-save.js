import { creatorApi } from './creator-api.js';
import { normalizeMedalRow } from './medal-times.js';
import { validateTrackQuality } from './track-quality.js';
import { copyPendingMedalText, hasPendingMedalText } from './pending-medal-text.js';
import { createEditHistory } from './edit-history.js';

// Read the named track, even when another track is selected by the time a
// request finishes. The open drawing lives separately from its wall shape.
export function creatorTrackContent(editor, key) {
    const medalRow = editor.medalRowByKey.get(key) ?? editor.medalTimes[key] ?? null;
    return structuredClone({
        track: editor.state.tracks[key],
        draftLoop: key === editor.state.selectedTrackKey
            ? editor.state.draftLoop : editor.draftLoopsByKey.get(key) ?? [],
        medalRow,
    });
}

// The unsaved work of each dirty track, taken before a refresh replaces the
// tracks with the server's.
export function captureUnsavedCreatorWork(editor) {
    return [...editor.state.dirtyTrackKeys]
        .filter((key) => editor.state.tracks[key])
        .map((key) => ({
            key,
            content: creatorTrackContent(editor, key),
            history: editor.editHistories.get(key),
            record: editor.creatorRecords.get(key),
            pending: copyPendingMedalText(editor.pendingMedalText, key),
        }));
}

// Puts the unsaved work back over the server's tracks. A track that is locked
// now keeps its new record, so it opens read-only.
export function restoreUnsavedCreatorWork(editor, unsaved) {
    for (const { key, content, history, record, pending } of unsaved) {
        editor.state.tracks[key] = content.track;
        editor.editHistories.set(key, history ?? createEditHistory(content.track));
        if (record && !editor.isCreatorLocked(key)) editor.creatorRecords.set(key, record);
        if (content.medalRow) editor.medalRowByKey.set(key, content.medalRow);
        if (content.draftLoop.length) editor.draftLoopsByKey.set(key, content.draftLoop);
        else editor.draftLoopsByKey.delete(key);
        if (pending) editor.pendingMedalText.set(key, pending);
        editor.state.dirtyTrackKeys.add(key);
    }
}

export function hasCreatorUnsavedWork(editor) {
    return editor.busy || editor.state.dirtyTrackKeys.size > 0
        || editor.state.draftLoop.length > 0
        || [...editor.draftLoopsByKey.values()].some((loop) => loop.length > 0)
        || [...(editor.pendingMedalText?.values() ?? [])].some((pending) => pending.size > 0)
        || Boolean(editor.creatorPanels?.hasUnsavedChanges());
}

export async function saveCreatorTrackSnapshot(editor, key, geometrySignature) {
    const snapshot = creatorTrackContent(editor, key);
    const baseRevision = editor.creatorRecords.get(key)?.revision ?? 0;
    editor.busy = true;
    editor.creatorWriteGeneration += 1;
    editor.creatorSavingKey = key;
    editor.creatorSaveErrors.delete(key);
    editor.setCreatorSaveStatus('Saving…', 'saving');
    editor.syncActionButtons();
    try {
        const { track: saved } = await creatorApi.saveTrack(key, { ...snapshot,
            medalRow: snapshot.medalRow ? normalizeMedalRow(snapshot.medalRow) : null, baseRevision });
        // Typed medal text that is not in the row yet is a newer change too.
        const unchanged = Boolean(editor.state.tracks[key])
            && JSON.stringify(creatorTrackContent(editor, key)) === JSON.stringify(snapshot)
            && !hasPendingMedalText(editor.pendingMedalText, key);
        editor.creatorRecords.set(key, editor.creatorRecordMeta(saved));
        editor.state.originalTrackKeyByKey.set(key, key);
        if (saved.medalRow) editor.medalTimes[key] = saved.medalRow;
        else delete editor.medalTimes[key];
        editor.baselineQualityCodesByKey.set(key, new Set(
            validateTrackQuality(saved.track).issues
                .filter((issue) => issue.severity === 'error').map((issue) => issue.code),
        ));
        editor.baselineGeometryByKey.set(key, geometrySignature(saved.track));
        if (unchanged) {
            editor.medalRowByKey.delete(key);
            editor.state.dirtyTrackKeys.delete(key);
        } else {
            editor.state.dirtyTrackKeys.add(key);
        }
        editor.setStatus(unchanged
            ? (saved.checksPassed ? `Saved ${saved.track.name}.`
                : `Saved ${saved.track.name}. ${saved.checkError} It cannot be a Daily yet.`)
            : `Saved the earlier changes to ${saved.track.name}. Newer changes are still unsaved.`);
        editor.scheduleQualityCheck();
        return true;
    } catch (error) {
        editor.creatorSaveErrors.set(key, `Save failed: ${error.message}`);
        editor.setStatus(`Save failed: ${error.message}`, true);
        return false;
    } finally {
        editor.creatorSavingKey = null;
        editor.creatorWriteGeneration += 1;
        editor.busy = false;
        editor.syncCreatorTrackState();
    }
}
