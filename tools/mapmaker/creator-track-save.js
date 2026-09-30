import { creatorApi } from './creator-api.js';
import { normalizeMedalRow } from './medal-times.js';
import { validateTrackQuality } from './track-quality.js';

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

export function hasCreatorUnsavedWork(editor) {
    return editor.busy || editor.state.dirtyTrackKeys.size > 0
        || editor.state.draftLoop.length > 0
        || [...editor.draftLoopsByKey.values()].some((loop) => loop.length > 0)
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
        const unchanged = Boolean(editor.state.tracks[key])
            && JSON.stringify(creatorTrackContent(editor, key)) === JSON.stringify(snapshot);
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
