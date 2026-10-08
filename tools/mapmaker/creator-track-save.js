import { creatorApi } from './creator-api.js';
import { getMedalRowError, normalizeMedalRow } from './medal-times.js';
import { validateTrackQuality } from './track-quality.js';
import { copyPendingMedalText, hasPendingMedalText, movePendingMedalText } from './pending-medal-text.js';
import { createEditHistory } from './edit-history.js';
import { splitRoadLine, withRoadLine } from './road-line.js';
import {
    copyTrackName,
    isUncertain,
    isUncertainFailure,
    rememberUncertain,
    sameTrackContent,
    trackContent,
} from './creator-conflicts.js';

// Reads the named track even if the selection changed; the drawing and road line travel beside the walls.
export function creatorTrackContent(editor, key) {
    const medalRow = editor.medalRowByKey.get(key) ?? editor.medalTimes[key] ?? null;
    const { track, roadLine } = splitRoadLine(editor.state.tracks[key]);
    return structuredClone({
        track,
        draftLoop: key === editor.state.selectedTrackKey
            ? editor.state.draftLoop : editor.draftLoopsByKey.get(key) ?? [],
        medalRow,
        roadLine,
    });
}

// Unsaved work of dirty tracks, taken before a refresh.
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

// Restores unsaved work over the server tracks; a now-locked track keeps its new record and opens read-only.
export function restoreUnsavedCreatorWork(editor, unsaved) {
    for (const { key, content, history, record, pending } of unsaved) {
        editor.state.tracks[key] = withRoadLine(content.track, content.roadLine);
        editor.editHistories.set(key, history ?? createEditHistory(editor.state.tracks[key]));
        if (record && !editor.isCreatorLocked(key)) {
            const current = editor.creatorRecords.get(key);
            editor.creatorRecords.set(key, {
                ...record,
                ...(typeof current?.privateDraft === 'boolean' ? { privateDraft: current.privateDraft } : {}),
            });
        }
        if (content.medalRow) editor.medalRowByKey.set(key, content.medalRow);
        if (content.draftLoop.length) editor.draftLoopsByKey.set(key, content.draftLoop);
        else editor.draftLoopsByKey.delete(key);
        if (pending) editor.pendingMedalText.set(key, pending);
        editor.state.dirtyTrackKeys.add(key);
    }
}

// Each track's server version and revision; an edit back to it leaves nothing to save.
function savedContents(editor) {
    editor.savedContentByKey ??= new Map();
    return editor.savedContentByKey;
}

export function rememberSavedCreatorContent(editor, record) {
    savedContents(editor).set(record.key, {
        revision: record.revision,
        content: trackContent({
            track: record.track,
            draftLoop: record.draftLoop ?? [],
            medalRow: record.medalRow ?? null,
            roadLine: record.roadLine ?? null,
        }),
    });
}

// True when the track equals the server version and nothing is in flight, unclear, typed or newer.
export function isCreatorTrackAtSavedVersion(editor, key) {
    const saved = savedContents(editor).get(key);
    const record = editor.creatorRecords.get(key);
    if (!saved || !record || saved.revision !== record.revision) return false;
    if (!editor.state.tracks[key] || editor.creatorSavingKey === key) return false;
    if (uncertainTracks(editor).has(key)) return false;
    if (hasPendingMedalText(editor.pendingMedalText, key)) return false;
    return trackContent(creatorTrackContent(editor, key)) === saved.content;
}

export function hasCreatorUnsavedWork(editor) {
    return editor.busy || editor.state.dirtyTrackKeys.size > 0
        || editor.state.draftLoop.length > 0
        || [...editor.draftLoopsByKey.values()].some((loop) => loop.length > 0)
        || [...(editor.pendingMedalText?.values() ?? [])].some((pending) => pending.size > 0)
        || Boolean(editor.creatorPanels?.hasUnsavedChanges());
}

// Saves that ended with no clear answer, for each track key.
function uncertainTracks(editor) {
    editor.uncertainTracksByKey ??= new Map();
    return editor.uncertainTracksByKey;
}

function forgetUncertainTracks(editor, key) {
    uncertainTracks(editor).delete(key);
}

// A 2xx answer that does not name this track gives no clear answer.
function readSavedTrack(answer, key) {
    const saved = answer?.track;
    if (!saved || saved.key !== key || !Number.isInteger(saved.revision)
        || !saved.track || typeof saved.track !== 'object') {
        throw new Error('The answer of the server could not be read.');
    }
    return saved;
}

function setTrackBaseline(editor, key, track, geometrySignature) {
    editor.baselineQualityCodesByKey.set(key, new Set(
        validateTrackQuality(track).issues
            .filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    ));
    editor.baselineGeometryByKey.set(key, geometrySignature(track));
}

// The server has this version; clean unless the moderator changed it since.
function acknowledgeTrack(editor, key, saved, geometrySignature, unchanged) {
    editor.creatorRecords.set(key, editor.creatorRecordMeta(saved));
    rememberSavedCreatorContent(editor, saved);
    editor.state.originalTrackKeyByKey.set(key, key);
    if (saved.medalRow) editor.medalTimes[key] = saved.medalRow;
    else delete editor.medalTimes[key];
    setTrackBaseline(editor, key, saved.track, geometrySignature);
    if (unchanged) {
        editor.medalRowByKey.delete(key);
        editor.state.dirtyTrackKeys.delete(key);
    } else {
        editor.state.dirtyTrackKeys.add(key);
    }
    forgetUncertainTracks(editor, key);
}

function savedStatus(saved) {
    return saved.checksPassed ? `Saved ${saved.track.name}.`
        : `Saved ${saved.track.name}. ${saved.checkError} It cannot be a Daily yet.`;
}

// One save request. A 409 says the server has another revision.
async function sendCreatorTrack(editor, key, geometrySignature) {
    const snapshot = creatorTrackContent(editor, key);
    const wire = { ...snapshot, medalRow: snapshot.medalRow ? normalizeMedalRow(snapshot.medalRow) : null };
    const baseRevision = editor.creatorRecords.get(key)?.revision ?? 0;
    editor.busy = true;
    editor.creatorWriteGeneration += 1;
    editor.creatorSavingKey = key;
    editor.creatorSaveErrors.delete(key);
    editor.setCreatorSaveStatus('Saving…', 'saving');
    editor.syncActionButtons();
    try {
        const saved = readSavedTrack(await creatorApi.saveTrack(key, {
            ...wire, baseRevision,
            ...(editor.creatorUsername ? { creatorUsername: editor.creatorUsername } : {}),
        }), key);
        // Typed medal text that is not in the row yet is a newer change too.
        const unchanged = Boolean(editor.state.tracks[key])
            && JSON.stringify(creatorTrackContent(editor, key)) === JSON.stringify(snapshot)
            && !hasPendingMedalText(editor.pendingMedalText, key);
        acknowledgeTrack(editor, key, saved, geometrySignature, unchanged);
        editor.setStatus(unchanged ? savedStatus(saved)
            : `Saved the earlier changes to ${saved.track.name}. Newer changes are still unsaved.`);
        editor.scheduleQualityCheck();
        return { saved: true };
    } catch (error) {
        // The server can have a save whose answer did not come back.
        if (isUncertainFailure(error)) rememberUncertain(uncertainTracks(editor), key, trackContent(wire));
        editor.creatorSaveErrors.set(key, `Save failed: ${error.message}`);
        editor.setStatus(`Save failed: ${error.message}`, true);
        return { saved: false, status: error?.status, baseRevision };
    } finally {
        editor.creatorSavingKey = null;
        editor.creatorWriteGeneration += 1;
        editor.busy = false;
        editor.syncCreatorTrackState();
    }
}

// One save without recovery, for tests; the Creator uses saveCreatorTrackWithRecovery.
export async function saveCreatorTrackSnapshot(editor, key, geometrySignature) {
    return (await sendCreatorTrack(editor, key, geometrySignature)).saved;
}

// Saves; on another revision it finds why (lost answer, lock, deletion, other device); resends a lost answer once.
export async function saveCreatorTrackWithRecovery(editor, key, geometrySignature, attempt = 0) {
    const outcome = await sendCreatorTrack(editor, key, geometrySignature);
    if (outcome.saved || outcome.status !== 409) return outcome.saved;
    return recoverTrackConflict(editor, key, geometrySignature, outcome.baseRevision, attempt);
}

// The server record, null when gone, undefined when the read failed.
async function readServerTrack(editor, key) {
    editor.busy = true;
    editor.syncCreatorTrackState();
    try {
        return (await creatorApi.readTrack(key, editor.creatorUsername)).track ?? null;
    } catch (error) {
        if (error?.status === 404) return null;
        editor.creatorSaveErrors.set(key, `Save failed: ${error.message}`);
        editor.setStatus(`Could not read the saved version: ${error.message}`, true);
        return undefined;
    } finally {
        editor.busy = false;
        editor.syncCreatorTrackState();
    }
}

async function recoverTrackConflict(editor, key, geometrySignature, baseRevision, attempt) {
    const server = await readServerTrack(editor, key);
    if (server === undefined || !editor.state.tracks[key]) return false;
    // The same revision: another save held the track. Its message is shown.
    if (server && server.revision === baseRevision) return false;
    // The server has this work, so take its revision; uncommitted medal text keeps it unsaved.
    if (server && sameTrackContent(server, creatorTrackContent(editor, key))) {
        const typed = hasPendingMedalText(editor.pendingMedalText, key);
        acknowledgeTrack(editor, key, server, geometrySignature, !typed);
        editor.creatorSaveErrors.delete(key);
        editor.setStatus(typed ? `Saved the earlier changes to ${server.track.name}. Newer changes are still unsaved.`
            : savedStatus(server));
        editor.syncCreatorTrackState();
        return true;
    }
    // A locked track cannot change. Newer edits are never sent to it.
    if (server?.lockedAt) {
        showLockedCreatorDraft(editor, key, server);
        return false;
    }
    if (server && attempt === 0 && isUncertain(uncertainTracks(editor), key, trackContent(server))) {
        editor.creatorRecords.set(key, editor.creatorRecordMeta(server));
        forgetUncertainTracks(editor, key);
        return saveCreatorTrackWithRecovery(editor, key, geometrySignature, attempt + 1);
    }
    return askTrackConflict(editor, key, geometrySignature, server, attempt);
}

function savedAt(server) {
    const date = new Date(server.updatedAt);
    return Number.isFinite(date.getTime())
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'a moment ago';
}

async function askTrackConflict(editor, key, geometrySignature, server, attempt) {
    const name = editor.state.tracks[key]?.name ?? key;
    if (!server) {
        const appKey = editor.isAppTrackKey(key);
        const choice = await editor.chooseAction({
            title: 'Deleted on another device',
            message: appKey
                ? `${name} was deleted on another device. The game uses the app track again.`
                : `${name} was deleted on another device.`,
            choices: [
                appKey ? { value: 'copy', label: 'Keep as new track' } : { value: 'mine', label: 'Save mine' },
                { value: 'discard', label: 'Discard mine', danger: true },
            ],
        });
        if (!editor.state.tracks[key]) return false;
        if (choice === 'mine') {
            editor.creatorRecords.delete(key);
            return saveCreatorTrackWithRecovery(editor, key, geometrySignature, attempt + 1);
        }
        if (choice === 'copy') return saveCopy(editor, key, null, geometrySignature);
        if (choice === 'discard') {
            forgetUncertainTracks(editor, key);
            editor.discardCreatorTrack(key);
        }
        return false;
    }
    const choice = await editor.chooseAction({
        title: 'Saved on another device',
        message: `${server.updatedBy || 'Another moderator'} saved ${server.track?.name ?? name} at ${savedAt(server)}.`,
        choices: [
            { value: 'mine', label: 'Save mine' },
            { value: 'both', label: 'Keep both' },
            { value: 'theirs', label: 'Load theirs', danger: true },
        ],
    });
    if (!editor.state.tracks[key]) return false;
    if (choice === 'mine') {
        editor.creatorRecords.set(key, editor.creatorRecordMeta(server));
        return saveCreatorTrackWithRecovery(editor, key, geometrySignature, attempt + 1);
    }
    if (choice === 'both') return saveCopy(editor, key, server, geometrySignature);
    if (choice === 'theirs') {
        loadCreatorServerTrack(editor, key, server, geometrySignature);
        return false;
    }
    editor.setStatus(`${name} is not saved: another device saved it first.`, true);
    return false;
}

// The copy saves only with finished medals; otherwise it stays unsaved with its typed text.
async function saveCopy(editor, key, server, geometrySignature) {
    const copyKey = keepCreatorDraftAsCopy(editor, key, server, geometrySignature);
    if (!copyKey) return false;
    const name = editor.state.tracks[copyKey].name;
    if (!editor.commitPendingMedalText(copyKey)) {
        editor.setStatus(`${name} is not saved yet: finish the medal times.`, true);
        return false;
    }
    const medalRow = editor.medalRowByKey.get(copyKey) ?? null;
    const medalError = medalRow ? getMedalRowError(medalRow) : null;
    if (medalError) {
        editor.setStatus(`${name} is not saved yet: ${medalError}`, true);
        return false;
    }
    return saveCreatorTrackWithRecovery(editor, copyKey, geometrySignature);
}

// Moves unsaved work to a new key that starts from revision 0, with the medal row it shows.
export function moveCreatorDraft(editor, fromKey, toKey) {
    const medalRow = editor.medalRowByKey.get(fromKey)
        ?? editor.medalTimes[editor.state.originalTrackKeyByKey.get(fromKey) ?? fromKey] ?? null;
    const draftLoop = editor.state.selectedTrackKey === fromKey
        ? editor.state.draftLoop : editor.draftLoopsByKey.get(fromKey) ?? [];
    editor.state.tracks[toKey] = structuredClone(editor.state.tracks[fromKey]);
    editor.editHistories.set(toKey, editor.editHistories.get(fromKey) ?? createEditHistory(editor.state.tracks[toKey]));
    if (medalRow) editor.medalRowByKey.set(toKey, structuredClone(medalRow));
    if (draftLoop.length) editor.draftLoopsByKey.set(toKey, structuredClone(draftLoop));
    movePendingMedalText(editor.pendingMedalText, fromKey, toKey);
    editor.creatorRecords.delete(toKey);
    editor.state.originalTrackKeyByKey.delete(toKey);
    editor.state.dirtyTrackKeys.add(toKey);
}

// Keep both: the draft becomes "‹name› copy", and the original key shows the server version or goes.
export function keepCreatorDraftAsCopy(editor, key, server, geometrySignature) {
    const draft = editor.state.tracks[key];
    if (!draft) return null;
    const copy = copyTrackName(draft.name, (candidate) => Boolean(editor.state.tracks[candidate]
        || editor.creatorRecords.has(candidate) || editor.isAppTrackKey(candidate)));
    if (!copy) {
        editor.setStatus('No free name for a copy. Rename the track first.', true);
        return null;
    }
    const wasOpen = editor.state.selectedTrackKey === key;
    moveCreatorDraft(editor, key, copy.key);
    editor.state.tracks[copy.key].name = copy.name;
    if (wasOpen) {
        editor.state.draftLoop = [];
        editor.loadTrack(copy.key);
    }
    forgetUncertainTracks(editor, key);
    editor.creatorSaveErrors.delete(key);
    if (server) loadCreatorServerTrack(editor, key, server, geometrySignature);
    else editor.discardCreatorTrack(key);
    return copy.key;
}

// Load theirs: the server version replaces the local work of this track.
export function loadCreatorServerTrack(editor, key, server, geometrySignature) {
    editor.addCreatorRecord(server);
    setTrackBaseline(editor, key, server.track, geometrySignature);
    forgetUncertainTracks(editor, key);
    editor.creatorSaveErrors.delete(key);
    if (editor.state.selectedTrackKey === key) editor.loadTrack(key);
    else editor.syncCreatorTrackState();
    editor.setStatus(`Loaded the saved version of ${server.track?.name ?? key}.`);
}

// A raceable track shows read-only with local work, and the lock note offers two ways out.
function showLockedCreatorDraft(editor, key, server) {
    editor.creatorRecords.set(key, editor.creatorRecordMeta(server));
    editor.creatorSaveErrors.delete(key);
    editor.syncCreatorTrackState();
    editor.setStatus(`${server.track?.name ?? key} is locked now. Keep your changes as a new track, or load the locked version.`, true);
}

// Lock note buttons reread the locked version first; the editor keeps only its own work.
export async function keepLockedCreatorDraft(editor, key, geometrySignature) {
    const server = await readServerTrack(editor, key);
    if (server === undefined || !editor.state.tracks[key]) return false;
    return saveCopy(editor, key, server, geometrySignature);
}

export async function loadLockedCreatorTrack(editor, key, geometrySignature) {
    const server = await readServerTrack(editor, key);
    if (server === undefined || !editor.state.tracks[key]) return false;
    if (server) loadCreatorServerTrack(editor, key, server, geometrySignature);
    else editor.discardCreatorTrack(key);
    return true;
}
