import { redis } from '@devvit/redis';
import medalTimes from '../../../game/medals/medal-times.json' with { type: 'json' };
import { TRACK_CATALOG } from '../../../game/track/catalog.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';
import { readDailySchedule, saveDailySchedule } from '../daily/daily-schedule-store.js';
import { TrackInputError } from './track-shape.js';
import { deleteStoredTrack, readStoredTrack, saveStoredTrack } from './track-store.js';
import { readTrackUsage } from './track-usage.js';

// Copies what nobody has raced into Redis, so the Creator can change it:
// the unplayed built-in tracks with their medal times, and the Daily list.
// Played tracks and the live Campaign stay in the app. A second run copies
// only what the first run did not copy.

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

const MIGRATION_LOCK_KEY = 'dailygp:tracks:v1:migration-lock';
const MIGRATION_REPORT_KEY = 'dailygp:tracks:v1:migration-report';
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

export async function readMigrationReport(): Promise<MigrationReport | null> {
    const raw = await redis.get(MIGRATION_REPORT_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as MigrationReport;
    } catch {
        return null;
    }
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
    if (record.fingerprint !== createTrackFingerprint(builtIn)) {
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
        const usage = await readTrackUsage();
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
            if (await readStoredTrack(trackKey)) {
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
                report.failed.push({ key: trackKey, error: error instanceof Error ? error.message : String(error) });
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
                    report.failed.push({
                        key: 'dailyList',
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        if (hooks.copySeries) report.extra = { series: await hooks.copySeries({ dryRun, username }) };
        if (!dryRun) await redis.set(MIGRATION_REPORT_KEY, JSON.stringify(report));
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
