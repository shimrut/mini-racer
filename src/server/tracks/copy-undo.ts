import { redis } from '@devvit/redis';
import { TRACK_SCHEDULE_KEYS } from '../../../game/track/catalog.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { readDailySchedule, restoreAppDailySchedule } from '../daily/daily-schedule-store.js';
import {
    isLiveAppSeries,
    listAppSeriesDefinitions,
    listStoredSeries,
    removeSeriesCopy,
    type StoredSeriesRecord,
} from '../campaign/series-store.js';
import { COPY_LOG_PREFIX } from './copy-check.js';
import { matchesAppTrack } from './track-copy.js';
import { runCopy } from './track-migration.js';
import { listStoredTrackRecords, removeTrackCopy, type StoredTrackRecord } from './track-store.js';

// Undo of a copy. The app still has every track and series until the release
// that removes them, so an undo removes only Redis copies that are still
// exactly the app version: players then race the same tracks from the app,
// and saved times, ghosts and leaderboards stay valid. A copy that changed
// since stays, and the report says why.

export type CopyUndoKind = 'unplayed' | 'played-dailies' | 'live-campaign';

export type CopyUndoReport = {
    kind: CopyUndoKind;
    dryRun: boolean;
    ranAt: string;
    ranBy: string;
    // Track keys, and series keys for the series.
    removed: string[];
    removedSeries: string[];
    kept: { key: string; reason: string }[];
    // Only the undo of the unplayed copy changes the Daily list.
    dailyList: 'restored' | 'would-restore' | 'kept' | 'app' | null;
};

export const COPY_UNDO_KINDS: readonly CopyUndoKind[] = ['unplayed', 'played-dailies', 'live-campaign'];

const UNDO_REPORT_KEYS: Record<CopyUndoKind, string> = {
    unplayed: 'dailygp:tracks:v1:undo-report:unplayed:v1',
    'played-dailies': 'dailygp:tracks:v1:undo-report:played-dailies:v1',
    'live-campaign': 'dailygp:tracks:v1:undo-report:live-campaign:v1',
};

const CHANGED = 'Changed since the copy, so it stays.';
const NOT_APP = 'It differs from the app version, so it stays.';

type AppSeries = ReturnType<typeof listAppSeriesDefinitions>[number];

function isAppTrack(trackKey: string): boolean {
    return Object.hasOwn(BUILT_IN_TRACKS, trackKey);
}

// A track that a locked copy wrote: locked at once, and never saved again.
function isLockedCopy(record: StoredTrackRecord, reason: 'daily' | 'series'): boolean {
    return record.origin === 'migrated' && record.lockReason === reason && record.revision === 1;
}

function sameAsAppSeries(record: StoredSeriesRecord, definition: AppSeries): boolean {
    const stages = definition.stages ?? [];
    return record.name === (definition.name ?? definition.id)
        && record.ground === (definition.ground ?? 'tarmac')
        && record.stages.length === stages.length
        && stages.every((stage, index) => record.stages[index].trackKey === stage.trackKey
            && record.stages[index].laps === stage.laps
            && record.stages[index].requiredMedals === stage.requiredMedals);
}

function sameAsAppList(keys: string[]): boolean {
    return keys.length === TRACK_SCHEDULE_KEYS.length && keys.every((key, index) => key === TRACK_SCHEDULE_KEYS[index]);
}

function newReport(kind: CopyUndoKind, dryRun: boolean, username: string, now: Date): CopyUndoReport {
    return { kind, dryRun, ranAt: now.toISOString(), ranBy: username, removed: [], removedSeries: [], kept: [], dailyList: null };
}

// Removes each track that `canRemove` accepts; a dry run only reports it.
async function undoTracks(
    report: CopyUndoReport,
    records: StoredTrackRecord[],
    canRemove: (record: StoredTrackRecord) => boolean,
): Promise<void> {
    for (const record of records) {
        if (!canRemove(record)) {
            report.kept.push({ key: record.key, reason: matchesAppTrack(record) ? CHANGED : NOT_APP });
            continue;
        }
        if (report.dryRun) {
            report.removed.push(record.key);
            continue;
        }
        const result = await removeTrackCopy(record.key, canRemove);
        if (result === 'removed') report.removed.push(record.key);
        else if (result === 'kept') report.kept.push({ key: record.key, reason: CHANGED });
    }
}

// The unplayed copy: the app Daily list first, then the hidden series
// drafts, then each track copy that is not one of the locked copies.
async function undoUnplayed(report: CopyUndoReport): Promise<void> {
    const canRestore = (schedule: { keys: string[] }) => sameAsAppList(schedule.keys);
    const schedule = await readDailySchedule();
    if (schedule.source === 'app') report.dailyList = 'app';
    else if (!canRestore(schedule)) report.dailyList = 'kept';
    else report.dailyList = report.dryRun ? 'would-restore' : await restoreAppDailySchedule(canRestore);
    if (report.dailyList === 'kept') report.kept.push({ key: 'dailyList', reason: CHANGED });

    const storedSeries = new Map((await listStoredSeries()).map((record) => [record.id, record]));
    for (const definition of listAppSeriesDefinitions()) {
        const record = storedSeries.get(definition.id);
        if (!record || isLiveAppSeries(definition) || record.origin !== 'migrated') continue;
        const canRemoveSeries = (current: StoredSeriesRecord) => current.status === 'draft'
            && current.publishedStageCount === 0 && sameAsAppSeries(current, definition);
        if (!canRemoveSeries(record)) {
            report.kept.push({ key: definition.id, reason: CHANGED });
        } else if (report.dryRun) {
            report.removedSeries.push(definition.id);
        } else {
            const { result } = await removeSeriesCopy(definition.id, { canRemoveSeries, canRemoveTrack: () => false });
            if (result === 'removed') report.removedSeries.push(definition.id);
            else if (result === 'kept') report.kept.push({ key: definition.id, reason: CHANGED });
        }
    }

    const records = (await listStoredTrackRecords())
        .filter((record) => record.origin === 'migrated' && isAppTrack(record.key)
            && !isLockedCopy(record, 'daily') && !isLockedCopy(record, 'series'))
        .sort((a, b) => a.key.localeCompare(b.key));
    // A copy that a Daily locked since is still exactly the app track, so it
    // can go too: players raced the same track.
    await undoTracks(report, records, (record) => record.origin === 'migrated'
        && !isLockedCopy(record, 'daily') && !isLockedCopy(record, 'series') && matchesAppTrack(record));
}

async function undoPlayedDailies(report: CopyUndoReport): Promise<void> {
    const records = (await listStoredTrackRecords())
        .filter((record) => isLockedCopy(record, 'daily'))
        .sort((a, b) => a.key.localeCompare(b.key));
    await undoTracks(report, records, (record) => isLockedCopy(record, 'daily') && matchesAppTrack(record));
}

async function undoLiveCampaign(report: CopyUndoReport): Promise<void> {
    const storedSeries = new Map((await listStoredSeries()).map((record) => [record.id, record]));
    const storedTracks = report.dryRun
        ? new Map((await listStoredTrackRecords()).map((record) => [record.key, record])) : null;
    for (const definition of listAppSeriesDefinitions()) {
        const record = storedSeries.get(definition.id);
        if (!record || !isLiveAppSeries(definition) || record.origin !== 'migrated') continue;
        const stageKeys = new Set((definition.stages ?? []).map((stage) => stage.trackKey));
        const canRemoveSeries = (current: StoredSeriesRecord) => current.status === 'published'
            && current.publishedStageCount === (definition.stages ?? []).length && sameAsAppSeries(current, definition);
        const canRemoveTrack = (track: StoredTrackRecord) => stageKeys.has(track.key)
            && isLockedCopy(track, 'series') && matchesAppTrack(track);
        if (!canRemoveSeries(record)) {
            report.kept.push({ key: definition.id, reason: CHANGED });
            continue;
        }
        if (report.dryRun) {
            report.removedSeries.push(definition.id);
            for (const stage of record.stages) {
                const track = storedTracks?.get(stage.trackKey);
                if (track && canRemoveTrack(track)) report.removed.push(track.key);
            }
            continue;
        }
        const { result, tracks } = await removeSeriesCopy(definition.id, { canRemoveSeries, canRemoveTrack });
        if (result === 'removed') {
            report.removedSeries.push(definition.id);
            report.removed.push(...tracks);
        } else if (result === 'kept') {
            report.kept.push({ key: definition.id, reason: CHANGED });
        }
    }
}

function logUndo(report: CopyUndoReport): void {
    console.log(`${COPY_LOG_PREFIX} undo ${report.kind} by u/${report.ranBy}: removed ${report.removed.length} tracks`
        + ` and ${report.removedSeries.length} series, kept ${report.kept.length}`
        + `${report.dailyList ? `, Daily list ${report.dailyList}` : ''}.`);
    for (const { key, reason } of report.kept) console.log(`${COPY_LOG_PREFIX} undo kept ${key}: ${reason}`);
}

export async function runCopyUndo(kind: CopyUndoKind, {
    username,
    dryRun = false,
    now = new Date(),
}: {
    username: string;
    dryRun?: boolean;
    now?: Date;
}): Promise<CopyUndoReport> {
    if (!COPY_UNDO_KINDS.includes(kind)) throw new Error(`There is no copy called ${kind}.`);
    return runCopy({ dryRun, now, reportKey: UNDO_REPORT_KEYS[kind] }, async () => {
        const report = newReport(kind, dryRun, username, now);
        if (kind === 'unplayed') await undoUnplayed(report);
        else if (kind === 'played-dailies') await undoPlayedDailies(report);
        else await undoLiveCampaign(report);
        if (!dryRun) logUndo(report);
        return report;
    });
}

export async function readCopyUndoReport(kind: CopyUndoKind): Promise<CopyUndoReport | null> {
    const raw = await redis.get(UNDO_REPORT_KEYS[kind]);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as CopyUndoReport;
    } catch {
        return null;
    }
}
