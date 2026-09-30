import { redis } from '@devvit/redis';
import medalTimes from '../../../game/medals/medal-times.json' with { type: 'json' };
import { CAMPAIGN_LIVE_STAGES } from '../../../game/campaign/manifest.js';
import { PUBLISHED_DAILY_GP_TRACKS_BY_DATE } from '../../../game/shared/daily-gp-history-backfill.js';
import { TRACK_CATALOG } from '../../../game/track/catalog.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { isDailyGpChallengePlayable } from '../daily/daily-gp-model.js';
import { readDailyChallengeHistory } from '../daily/daily-gp-store.js';
import { readDailySchedule, saveDailySchedule } from '../daily/daily-schedule-store.js';
import { buildLockedTrackCopy, matchesAppTrack } from './track-copy.js';
import { TrackInputError } from './track-shape.js';
import { deleteStoredTrack, readStoredTrackKeys, saveLockedTrackCopy, saveStoredTrack } from './track-store.js';
import { readTrackUsage } from './track-usage.js';

// Three copies move the app tracks into Redis. A second run of each copies
// only what the first run did not copy.
// - Unplayed: the tracks nobody has raced, with their medal times, the Daily
//   list and the hidden series. The Creator can change these copies.
// - Played Dailies: the tracks of past Dailies, locked. A track whose Daily
//   players can still race waits for a later run.
// - Live Campaign: each live app series with its stage tracks, locked.
// The app keeps its own tracks until a later release removes them.

export type MigrationReport = {
    dryRun: boolean;
    ranAt: string;
    ranBy: string;
    copied: string[];
    alreadyStored: string[];
    played: number;
    failed: { key: string; error: string }[];
    dailyList: 'copied' | 'kept' | 'would-copy';
    extra?: Record<string, unknown>;
};

export type MigrationHooks = {
    // Copies the unpublished Campaign series. It returns a short summary.
    copySeries?: (options: { dryRun: boolean; username: string }) => Promise<Record<string, unknown>>;
};

// The report of a locked copy. `copied` and `alreadyStored` hold track keys
// for the played Dailies and series keys for the live Campaign.
export type LockedCopyReport = {
    dryRun: boolean;
    ranAt: string;
    ranBy: string;
    copied: string[];
    alreadyStored: string[];
    // Played Dailies: the tracks whose Daily players can still race.
    waiting: string[];
    // Live Campaign: the stage tracks that the copy wrote.
    tracks: string[];
    failed: { key: string; error: string }[];
};

export type LockedCopyKind = 'played-dailies' | 'live-campaign';

// Copies each live app series with its stage tracks (series-store.ts).
export type LiveSeriesCopier = (options: { dryRun: boolean; username: string; now: Date }) => Promise<{
    copied: string[];
    alreadyStored: string[];
    tracks: string[];
    failed: { key: string; error: string }[];
}>;

const MIGRATION_LOCK_KEY = 'dailygp:tracks:v1:migration-lock';
const MIGRATION_REPORT_KEY = 'dailygp:tracks:v1:migration-report';
const LOCKED_COPY_REPORT_KEYS: Record<LockedCopyKind, string> = {
    'played-dailies': 'dailygp:tracks:v1:copy-report:played-dailies:v1',
    'live-campaign': 'dailygp:tracks:v1:copy-report:live-campaign:v1',
};
const MIGRATION_LOCK_TTL_MS = 120_000;
// The Daily picks its track at midnight UTC. The migration waits a few minutes
// on each side, so the two never run at the same time.
const MIDNIGHT_GUARD_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const APP_MEDAL_ROWS = medalTimes as Record<string, unknown>;

export function isNearUtcMidnight(now: Date): boolean {
    const intoDay = ((now.getTime() % DAY_MS) + DAY_MS) % DAY_MS;
    return intoDay < MIDNIGHT_GUARD_MS || DAY_MS - intoDay < MIDNIGHT_GUARD_MS;
}

async function readReport<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export async function readMigrationReport(): Promise<MigrationReport | null> {
    return readReport<MigrationReport>(MIGRATION_REPORT_KEY);
}

export async function readLockedCopyReport(kind: LockedCopyKind): Promise<LockedCopyReport | null> {
    return readReport<LockedCopyReport>(LOCKED_COPY_REPORT_KEYS[kind]);
}

// Every copy waits around midnight UTC, runs one at a time, and keeps the
// report of its last real run. A trial run (dryRun) writes nothing.
async function runCopy<T>(
    { dryRun, now, reportKey }: { dryRun: boolean; now: Date; reportKey: string },
    work: () => Promise<T>,
): Promise<T> {
    if (!dryRun && isNearUtcMidnight(now)) {
        throw new TrackInputError('The Daily changes at midnight UTC. Try again a few minutes later.');
    }
    const token = `${now.getTime()}:${Math.random().toString(36).slice(2)}`;
    if (!dryRun) {
        const acquired = await redis.set(MIGRATION_LOCK_KEY, token, {
            nx: true,
            expiration: new Date(now.getTime() + MIGRATION_LOCK_TTL_MS),
        });
        if (!acquired) throw new TrackInputError('The copy is running already. Wait for it to finish.');
    }
    try {
        const report = await work();
        if (!dryRun) await redis.set(reportKey, JSON.stringify(report));
        return report;
    } finally {
        if (!dryRun) {
            try {
                if (await redis.get(MIGRATION_LOCK_KEY) === token) await redis.del(MIGRATION_LOCK_KEY);
            } catch (error) {
                console.error('Failed to release the migration lock:', error);
            }
        }
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function copyBuiltInTrack(trackKey: string, username: string, now: Date): Promise<void> {
    const builtIn = BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
    const record = await saveStoredTrack(trackKey, {
        track: builtIn,
        medalRow: APP_MEDAL_ROWS[trackKey] ?? null,
    }, { username, origin: 'migrated', trusted: true, now, assertUnplayed: async (key) => {
        if ((await readTrackUsage()).playedTrackKeys.has(key)) {
            throw new TrackInputError('This track became a race while the copy was running.');
        }
    } });
    if (!matchesAppTrack(record)) {
        await deleteStoredTrack(trackKey);
        throw new TrackInputError('The copy did not match the app track.');
    }
}

export async function runTrackMigration({
    username,
    dryRun = false,
    now = new Date(),
    hooks = {},
}: {
    username: string;
    dryRun?: boolean;
    now?: Date;
    hooks?: MigrationHooks;
}): Promise<MigrationReport> {
    return runCopy({ dryRun, now, reportKey: MIGRATION_REPORT_KEY }, async () => {
        const usage = await readTrackUsage();
        // One read of the stored keys, not one read per track: the Copy tab
        // runs this trial when it loads.
        const storedKeys = await readStoredTrackKeys();
        const report: MigrationReport = {
            dryRun,
            ranAt: now.toISOString(),
            ranBy: username,
            copied: [],
            alreadyStored: [],
            played: 0,
            failed: [],
            dailyList: 'kept',
        };
        for (const trackKey of Object.keys(TRACK_CATALOG)) {
            if (usage.playedTrackKeys.has(trackKey)) {
                report.played += 1;
                continue;
            }
            if (storedKeys.has(trackKey)) {
                report.alreadyStored.push(trackKey);
                continue;
            }
            if (dryRun) {
                report.copied.push(trackKey);
                continue;
            }
            try {
                await copyBuiltInTrack(trackKey, username, now);
                report.copied.push(trackKey);
            } catch (error) {
                report.failed.push({ key: trackKey, error: errorText(error) });
            }
        }
        const schedule = await readDailySchedule();
        if (schedule.source === 'app') {
            if (dryRun) {
                report.dailyList = 'would-copy';
            } else {
                try {
                    await saveDailySchedule(schedule.keys, { username, baseRevision: 0, now });
                    report.dailyList = 'copied';
                } catch (error) {
                    report.failed.push({ key: 'dailyList', error: errorText(error) });
                }
            }
        }
        if (hooks.copySeries) report.extra = { series: await hooks.copySeries({ dryRun, username }) };
        return report;
    });
}

function newLockedCopyReport(dryRun: boolean, username: string, now: Date): LockedCopyReport {
    return {
        dryRun,
        ranAt: now.toISOString(),
        ranBy: username,
        copied: [],
        alreadyStored: [],
        waiting: [],
        tracks: [],
        failed: [],
    };
}

// Copies the tracks of past Dailies, locked. A track that is also a stage of
// the live Campaign goes with the Campaign copy.
export async function runPlayedDailyCopy({
    username,
    dryRun = false,
    now = new Date(),
}: {
    username: string;
    dryRun?: boolean;
    now?: Date;
}): Promise<LockedCopyReport> {
    return runCopy({ dryRun, now, reportKey: LOCKED_COPY_REPORT_KEYS['played-dailies'] }, async () => {
        const history = await readDailyChallengeHistory();
        const inPlay = new Set(history
            .filter((challenge) => isDailyGpChallengePlayable(challenge, now) || Date.parse(challenge.startsAt) > now.getTime())
            .map((challenge) => challenge.trackKey));
        const dailyKeys = new Set([
            ...Object.values(PUBLISHED_DAILY_GP_TRACKS_BY_DATE).map(String),
            ...history.map((challenge) => challenge.trackKey),
        ]);
        const campaignKeys = new Set([...CAMPAIGN_LIVE_STAGES].map((stage) => stage.trackKey));
        const storedKeys = await readStoredTrackKeys();
        const report = newLockedCopyReport(dryRun, username, now);
        for (const trackKey of [...dailyKeys].sort()) {
            if (!Object.hasOwn(BUILT_IN_TRACKS, trackKey) || campaignKeys.has(trackKey)) continue;
            if (storedKeys.has(trackKey)) {
                report.alreadyStored.push(trackKey);
                continue;
            }
            if (inPlay.has(trackKey)) {
                report.waiting.push(trackKey);
                continue;
            }
            if (dryRun) {
                report.copied.push(trackKey);
                continue;
            }
            try {
                const wrote = await saveLockedTrackCopy(buildLockedTrackCopy(trackKey, { username, reason: 'daily', now }));
                (wrote ? report.copied : report.alreadyStored).push(trackKey);
            } catch (error) {
                report.failed.push({ key: trackKey, error: errorText(error) });
            }
        }
        return report;
    });
}

// Copies each live app series with its stage tracks, locked.
export async function runLiveCampaignCopy({
    username,
    dryRun = false,
    now = new Date(),
    copyLiveSeries,
}: {
    username: string;
    dryRun?: boolean;
    now?: Date;
    copyLiveSeries: LiveSeriesCopier;
}): Promise<LockedCopyReport> {
    return runCopy({ dryRun, now, reportKey: LOCKED_COPY_REPORT_KEYS['live-campaign'] }, async () => ({
        ...newLockedCopyReport(dryRun, username, now),
        ...await copyLiveSeries({ dryRun, username, now }),
    }));
}
