import { redis } from '@devvit/redis';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../../../game/shared/daily-gp-history-backfill.js';
import { TRACK_SCHEDULE_KEYS } from '../../../game/track/catalog.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { readDailyChallengeHistory } from '../daily/daily-gp-store.js';
import { readDailySchedule } from '../daily/daily-schedule-store.js';
import {
    isLiveAppSeries,
    listAppSeriesDefinitions,
    listStoredSeries,
    toSeriesDefinition,
    type StoredSeriesRecord,
    type StoredSeriesStage,
} from '../campaign/series-store.js';
import { matchesAppTrack } from './track-copy.js';
import { listStoredTrackRecords, type StoredTrackRecord } from './track-store.js';

// Reads Redis again and compares each copy of an app track and app series
// with the app. Players race the Redis copy, so a copy must race exactly like
// the app version that players raced before. A copy that a moderator changed
// before anyone raced it is allowed.

export type CopyProblem = { key: string; problem: string };

export type CopyCheckReport = {
    checkedAt: string;
    checkedBy: string;
    tracks: {
        exact: string[];
        locked: number;
        // Changed in the Creator before anyone raced it. This is allowed.
        changed: string[];
        problems: CopyProblem[];
        // Raced app tracks that have no copy yet.
        notCopied: string[];
    };
    series: {
        exact: string[];
        changed: string[];
        problems: CopyProblem[];
        notCopied: string[];
    };
    dailyList: 'app' | 'exact' | 'changed';
};

export const COPY_LOG_PREFIX = '[track-copy]';
const COPY_CHECK_KEY = 'dailygp:tracks:v1:copy-check:v1';

type AppSeries = ReturnType<typeof listAppSeriesDefinitions>[number];

function isAppTrack(trackKey: string): boolean {
    return Object.hasOwn(BUILT_IN_TRACKS, trackKey);
}

function sameStage(a: StoredSeriesStage | undefined, b: StoredSeriesStage | undefined): boolean {
    return Boolean(a && b) && a!.trackKey === b!.trackKey && Number(a!.laps) === Number(b!.laps)
        && Number(a!.requiredMedals) === Number(b!.requiredMedals);
}

function appStages(definition: AppSeries): StoredSeriesStage[] {
    return (definition.stages ?? []).map(({ trackKey, laps, requiredMedals }) => ({ trackKey, laps, requiredMedals }));
}

// The first time players raced each app track as a Daily.
async function firstDailyByTrack(): Promise<Map<string, number>> {
    const first = new Map<string, number>();
    const note = (trackKey: string, startsAt: number) => {
        if (!Number.isFinite(startsAt)) return;
        first.set(trackKey, Math.min(first.get(trackKey) ?? Infinity, startsAt));
    };
    for (const [date, trackKey] of Object.entries(PUBLISHED_DAILY_GP_TRACKS_BY_DATE)) {
        note(String(trackKey), Date.parse(`${date}T00:00:00.000Z`));
    }
    for (const challenge of await readDailyChallengeHistory()) note(challenge.trackKey, Date.parse(challenge.startsAt));
    return first;
}

function checkTrack(
    record: StoredTrackRecord,
    racedBeforeCopy: boolean,
    report: CopyCheckReport,
): void {
    if (matchesAppTrack(record)) {
        report.tracks.exact.push(record.key);
        if (record.lockedAt) report.tracks.locked += 1;
    } else if (racedBeforeCopy) {
        report.tracks.problems.push({
            key: record.key,
            problem: 'Players raced the app track, but the Redis copy differs from it.',
        });
    } else {
        report.tracks.changed.push(record.key);
    }
}

function checkSeries(definition: AppSeries, record: StoredSeriesRecord, report: CopyCheckReport): void {
    const stages = appStages(definition);
    const finalStageId = definition.finalStageId ?? null;
    const publishedFinalStageId = toSeriesDefinition(record).finalStageId;
    const declaredFinalStageId = Object.hasOwn(record, 'finalStageId') ? record.finalStageId : publishedFinalStageId;
    const sameContent = record.name === (definition.name ?? definition.id)
        && record.ground === (definition.ground ?? 'tarmac')
        && declaredFinalStageId === finalStageId
        && record.stages.length === stages.length
        && stages.every((stage, index) => sameStage(stage, record.stages[index]));
    if (!isLiveAppSeries(definition)) {
        (sameContent ? report.series.exact : report.series.changed).push(definition.id);
        return;
    }
    // Players raced every stage of a live app series. Its copy must keep them
    // live and unchanged, including an explicitly designated app endpoint.
    const keepsLiveStages = record.status === 'published'
        && record.publishedStageCount >= stages.length
        && record.ground === (definition.ground ?? 'tarmac')
        && (!finalStageId || (declaredFinalStageId === finalStageId && publishedFinalStageId === finalStageId
            && record.stages.length === stages.length && record.publishedStageCount === stages.length))
        && stages.every((stage, index) => sameStage(stage, record.stages[index]));
    if (!keepsLiveStages) {
        report.series.problems.push({
            key: definition.id,
            problem: 'Players race this series, but its Redis copy changed its live stages or final stage.',
        });
    } else if (sameContent && record.publishedStageCount === stages.length) {
        report.series.exact.push(definition.id);
    } else {
        report.series.changed.push(definition.id);
    }
}

export async function runCopyCheck({ username, now = new Date() }: { username: string; now?: Date }): Promise<CopyCheckReport> {
    const [records, storedSeries, schedule, firstDaily] = await Promise.all([
        listStoredTrackRecords(),
        listStoredSeries(),
        readDailySchedule(),
        firstDailyByTrack(),
    ]);
    const report: CopyCheckReport = {
        checkedAt: now.toISOString(),
        checkedBy: username,
        tracks: { exact: [], locked: 0, changed: [], problems: [], notCopied: [] },
        series: { exact: [], changed: [], problems: [], notCopied: [] },
        dailyList: 'app',
    };
    const appSeries = listAppSeriesDefinitions();
    const liveStageKeys = new Set(appSeries.filter(isLiveAppSeries)
        .flatMap((definition) => appStages(definition).map((stage) => stage.trackKey)));
    const storedKeys = new Set(records.map((record) => record.key));

    for (const record of [...records].sort((a, b) => a.key.localeCompare(b.key))) {
        if (!isAppTrack(record.key)) continue;
        const copiedAt = Date.parse(record.createdAt);
        const racedBeforeCopy = liveStageKeys.has(record.key)
            || (firstDaily.get(record.key) ?? Infinity) < (Number.isFinite(copiedAt) ? copiedAt : Infinity);
        checkTrack(record, racedBeforeCopy, report);
    }
    const raced = new Set([...liveStageKeys, ...[...firstDaily].filter(([, startsAt]) => startsAt <= now.getTime())
        .map(([trackKey]) => trackKey)]);
    report.tracks.notCopied = [...raced].filter((trackKey) => isAppTrack(trackKey) && !storedKeys.has(trackKey)).sort();

    const seriesById = new Map(storedSeries.map((record) => [record.id, record]));
    for (const definition of appSeries) {
        const record = seriesById.get(definition.id);
        if (record) checkSeries(definition, record, report);
        else if (isLiveAppSeries(definition)) report.series.notCopied.push(definition.id);
    }

    if (schedule.source === 'stored') {
        const sameList = schedule.keys.length === TRACK_SCHEDULE_KEYS.length
            && schedule.keys.every((trackKey, index) => trackKey === TRACK_SCHEDULE_KEYS[index]);
        report.dailyList = sameList ? 'exact' : 'changed';
    }

    await redis.set(COPY_CHECK_KEY, JSON.stringify(report));
    logCopyCheck(report);
    return report;
}

// One line for each check, and one line for each problem, so the server logs
// show them with one search for the prefix.
function logCopyCheck(report: CopyCheckReport): void {
    const problems = [...report.tracks.problems, ...report.series.problems];
    console.log(`${COPY_LOG_PREFIX} check by u/${report.checkedBy}: `
        + `${report.tracks.exact.length} exact track copies (${report.tracks.locked} locked), `
        + `${report.tracks.changed.length} changed in the Creator, `
        + `${report.series.exact.length} exact series copies, `
        + `${report.series.changed.length} series changed, Daily list ${report.dailyList}, `
        + `${problems.length} problems.`);
    for (const { key, problem } of problems) console.error(`${COPY_LOG_PREFIX} problem ${key}: ${problem}`);
}

export async function readCopyCheck(): Promise<CopyCheckReport | null> {
    const raw = await redis.get(COPY_CHECK_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as CopyCheckReport;
    } catch {
        return null;
    }
}
