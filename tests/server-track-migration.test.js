import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const known = {
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    },
    del: async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    },
    mGet: async (keys) => keys.map((key) => strings.get(key) ?? null),
    incrBy: async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    },
    hGet: async (key, field) => hashes.get(key)?.get(field) ?? null,
    hGetAll: async (key) => Object.fromEntries(hashes.get(key) ?? new Map()),
    hSet: async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    },
    hDel: async (key, fields) => {
        fields.forEach((field) => hashes.get(key)?.delete(field));
        return 1;
    },
    hScan: async () => ({ cursor: 0, fieldValues: [] }),
    expire: async () => true,
};
const mockRedis = new Proxy(known, { get: (target, name) => target[name] ?? (async () => null) });

installTrackRedisTransactions(mockRedis, strings, hashes);

vi.mock('@devvit/redis', () => ({ redis: mockRedis, redisCompressed: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const { runTrackMigration, readMigrationReport, isNearUtcMidnight } = await import('../src/server/tracks/track-migration.ts');
const store = await import('../src/server/tracks/track-store.ts');
const { readDailySchedule } = await import('../src/server/daily/daily-schedule-store.ts');
const { DAILY_GP_CHALLENGE_HISTORY_HASH_KEY } = await import('../src/server/daily/daily-gp-model.ts');
const { TRACK_CATALOG, TRACK_SCHEDULE_KEYS } = await import('../game/track/catalog.js');
const { BUILT_IN_TRACKS } = await import('../game/track/tracks.js');
const { CAMPAIGN_LIVE_STAGES } = await import('../game/campaign/manifest.js');
const { createTrackFingerprint } = await import('../src/server/competition/pb-ghost-trace.ts');

const noon = new Date('2026-10-01T12:00:00.000Z');

function playDaily(date, trackKey) {
    const hash = hashes.get(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY) ?? new Map();
    hash.set(`daily-gp-${date}`, JSON.stringify({
        id: `daily-gp-${date}`,
        challengeDate: date,
        trackKey,
        startsAt: `${date}T00:00:00.000Z`,
        endsAt: `${date}T23:59:59.000Z`,
        availableUntil: `${date}T23:59:59.000Z`,
    }));
    hashes.set(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, hash);
}

beforeEach(() => {
    strings.clear();
    hashes.clear();
    store.clearStoredTrackCacheForTests();
    store.installStoredTrackResolver();
});

describe('copy of unplayed tracks', () => {
    it('copies every unplayed built-in track once, with its fingerprint and medal times', async () => {
        playDaily('2026-09-29', 'smallSteps');
        playDaily('2026-09-30', 'sunlitTemple');

        const report = await runTrackMigration({ username: 'ModOne', now: noon });

        expect(report.failed).toEqual([]);
        expect(report.copied).not.toContain('sunlitTemple');
        expect(report.copied).not.toContain('smallSteps');
        expect(report.copied).not.toContain(CAMPAIGN_LIVE_STAGES[0].trackKey);
        expect(report.copied).not.toContain('albertGardens');
        expect(report.copied).toContain('babylonRace');
        expect(report.copied).toContain('lapinLoop');
        expect(report.copied.length + report.played).toBe(Object.keys(TRACK_CATALOG).length);

        const copy = await store.readStoredTrack('babylonRace');
        expect(copy).toMatchObject({ origin: 'migrated', checksPassed: true, lockedAt: null });
        expect(copy.fingerprint).toBe(createTrackFingerprint(BUILT_IN_TRACKS.babylonRace));
        expect(copy.medalRow).toMatchObject({ gold: 10.49, author: 10.28 });
        expect((await store.readStoredTrack('lapinLoop')).medalRow).toBeNull();

        const schedule = await readDailySchedule();
        expect(schedule).toMatchObject({ source: 'stored', keys: TRACK_SCHEDULE_KEYS });
        expect(report.dailyList).toBe('copied');
        expect((await readMigrationReport()).copied).toEqual(report.copied);

        const again = await runTrackMigration({ username: 'ModOne', now: noon });
        expect(again.copied).toEqual([]);
        expect(again.alreadyStored).toEqual(report.copied);
        expect(again.dailyList).toBe('kept');
    });

    it('refuses to copy a track that a series published after the run took its list', async () => {
        // The run's series list is older: the manifest never loads these records.
        const record = (id, status, trackKey) => ({
            version: 1,
            id,
            name: id,
            ground: 'tarmac',
            stages: [{ trackKey, laps: 1, requiredMedals: 0 }],
            status,
            publishedStageCount: status === 'published' ? 1 : 0,
            publishedAt: status === 'published' ? noon.toISOString() : null,
            origin: 'creator',
            revision: 1,
            createdAt: noon.toISOString(),
            createdBy: 'ModTwo',
            updatedAt: noon.toISOString(),
            updatedBy: 'ModTwo',
        });
        for (const series of [record('night-v1', 'published', 'babylonRace'), record('dusk-v1', 'draft', 'kettleRun')]) {
            strings.set(`dailygp:campaign:series:v1:series:${series.id}`, JSON.stringify(series));
            const index = hashes.get('dailygp:campaign:series:v1:index') ?? new Map();
            index.set(series.id, '1');
            hashes.set('dailygp:campaign:series:v1:index', index);
        }

        const report = await runTrackMigration({ username: 'ModOne', now: noon });

        expect(report.failed).toEqual([
            { key: 'babylonRace', error: 'This track became a race while the copy was running.' },
        ]);
        expect(await store.readStoredTrack('babylonRace')).toBeNull();
        // A draft stage is not raced yet, so its track is still copied.
        expect(report.copied).toContain('kettleRun');
    });

    it('writes nothing on a dry run', async () => {
        const report = await runTrackMigration({ username: 'ModOne', dryRun: true, now: noon });
        expect(report.copied.length).toBeGreaterThan(0);
        expect(report.dailyList).toBe('would-copy');
        expect(await store.readStoredTrack(report.copied[0])).toBeNull();
        expect(await readMigrationReport()).toBeNull();
    });

    it('finds the stored tracks in one read on a dry run, not one read per track', async () => {
        await store.saveStoredTrack('babylonRace', {
            track: BUILT_IN_TRACKS.babylonRace,
        }, { username: 'ModOne', origin: 'migrated', trusted: true, now: noon });
        const get = vi.spyOn(known, 'get');
        const report = await runTrackMigration({ username: 'ModOne', dryRun: true, now: noon });
        expect(report.alreadyStored).toEqual(['babylonRace']);
        expect(report.copied).not.toContain('babylonRace');
        expect(get.mock.calls.filter(([key]) => String(key).includes(':track:'))).toEqual([]);
        get.mockRestore();
    });

    it('waits while the Daily changes at midnight UTC', async () => {
        expect(isNearUtcMidnight(new Date('2026-10-01T23:57:00.000Z'))).toBe(true);
        expect(isNearUtcMidnight(new Date('2026-10-01T00:03:00.000Z'))).toBe(true);
        expect(isNearUtcMidnight(noon)).toBe(false);
        await expect(runTrackMigration({
            username: 'ModOne',
            now: new Date('2026-10-01T00:01:00.000Z'),
        })).rejects.toThrow('midnight UTC');
    });
});
