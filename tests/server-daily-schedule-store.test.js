import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import roughCut from '../game/track/definitions/rough-cut.js';

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const mockRedis = {
    get: vi.fn(async (key) => strings.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    del: vi.fn(async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    }),
    mGet: vi.fn(async (keys) => keys.map((key) => strings.get(key) ?? null)),
    incrBy: vi.fn(async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    }),
    hGetAll: vi.fn(async (key) => Object.fromEntries(hashes.get(key) ?? new Map())),
    hSet: vi.fn(async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    }),
    hDel: vi.fn(async () => 1),
};

installTrackRedisTransactions(mockRedis, strings, hashes);

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const schedule = await import('../src/server/daily/daily-schedule-store.ts');
const store = await import('../src/server/tracks/track-store.ts');
const { TRACK_SCHEDULE_KEYS } = await import('../game/track/catalog.js');

const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

beforeEach(() => {
    strings.clear();
    hashes.clear();
    store.clearStoredTrackCacheForTests();
    store.installStoredTrackResolver();
});

async function saveTrack(key, extra = {}) {
    await store.saveStoredTrack(key, { track: { ...roughCut, name: 'Night Cut', ground: 'tarmac' }, medalRow, ...extra }, {
        username: 'ModOne',
    });
    await store.ensureStoredTracksLoaded();
}

describe('stored Daily list', () => {
    it('uses the app list until a moderator saves one', async () => {
        expect(await schedule.readDailySchedule()).toMatchObject({ source: 'app', revision: 0 });
        expect(await schedule.readDailySchedulePool()).toEqual(TRACK_SCHEDULE_KEYS);
    });

    it('saves a list with a new track, and the Daily picks from it', async () => {
        await saveTrack('nightCut');
        const saved = await schedule.saveDailySchedule(['circuit', 'nightCut'], {
            username: 'ModOne',
            currentTrackKey: 'circuit',
        });
        expect(saved).toMatchObject({ source: 'stored', revision: 1, keys: ['circuit', 'nightCut'] });
        expect(await schedule.readDailySchedulePool()).toEqual(['circuit', 'nightCut']);
        expect(await schedule.isTrackInDailySchedule('nightCut')).toBe(true);
    });

    it('refuses a track that is not ready, a repeated track and an unknown track', async () => {
        await saveTrack('nightCut', { medalRow: null });
        await expect(schedule.saveDailySchedule(['nightCut'], { username: 'ModOne' }))
            .rejects.toThrow('medal times');
        await expect(schedule.saveDailySchedule(['circuit', 'circuit'], { username: 'ModOne' }))
            .rejects.toThrow('only once');
        await expect(schedule.saveDailySchedule(['noSuchTrack'], { username: 'ModOne' }))
            .rejects.toThrow('no track called');
        await expect(schedule.saveDailySchedule([], { username: 'ModOne' }))
            .rejects.toThrow('at least one');
        await expect(schedule.saveDailySchedule(['lapinLoop'], { username: 'ModOne' }))
            .rejects.toThrow('Set all four medal times');
    });

    it('keeps the latest Daily track, and refuses an old revision', async () => {
        await expect(schedule.saveDailySchedule(['sunlitTemple'], {
            username: 'ModOne',
            currentTrackKey: 'circuit',
        })).rejects.toThrow('latest Daily');
        await schedule.saveDailySchedule(['circuit'], { username: 'ModOne' });
        await expect(schedule.saveDailySchedule(['circuit', 'sunlitTemple'], { username: 'ModOne', baseRevision: 0 }))
            .rejects.toBeInstanceOf(store.TrackConflictError);
    });

    it('leaves out a key that the game does not know when it picks', async () => {
        strings.set('dailygp:daily:schedule:v1', JSON.stringify({
            version: 1,
            keys: ['circuit', 'goneTrack'],
            revision: 3,
            updatedAt: '2026-09-30T00:00:00.000Z',
            updatedBy: 'ModOne',
        }));
        expect(await schedule.readDailySchedulePool()).toEqual(['circuit']);
    });
});
