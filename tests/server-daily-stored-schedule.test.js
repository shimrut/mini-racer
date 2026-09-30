import { beforeEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';

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
    hSetNX: async (key, field, value) => {
        const hash = hashes.get(key) ?? new Map();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
    },
    hScan: async () => ({ cursor: 0, fieldValues: [] }),
    hDel: async () => 0,
    expire: async () => true,
};
const mockRedis = new Proxy(known, {
    get: (target, name) => target[name] ?? (async () => null),
});

vi.mock('@devvit/redis', () => ({ redis: mockRedis, redisCompressed: mockRedis }));
vi.mock('@devvit/web/server', () => ({ redis: mockRedis, context: mockContext }));

const store = await import('../src/server/tracks/track-store.ts');
const { saveDailySchedule } = await import('../src/server/daily/daily-schedule-store.ts');
const { getServerDailyGpChallenge } = await import('../src/server/daily/daily-gp-store.ts');
const { DAILY_GP_CHALLENGE_HISTORY_HASH_KEY } = await import('../src/server/daily/daily-gp-model.ts');

beforeEach(() => {
    strings.clear();
    hashes.clear();
    store.clearStoredTrackCacheForTests();
    store.installStoredTrackResolver();
});

describe('Daily from the stored list', () => {
    it('makes a stored track the next Daily, and locks it', async () => {
        await store.saveStoredTrack('nightCut', {
            track: { ...smallSteps, name: 'Night Cut' },
            medalRow: { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 },
        }, { username: 'ModOne' });
        await store.ensureStoredTracksLoaded();
        await saveDailySchedule(['circuit', 'nightCut'], { username: 'ModOne' });
        await known.hSet(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY, {
            'daily-gp-2026-07-10': JSON.stringify({
                id: 'daily-gp-2026-07-10',
                challengeDate: '2026-07-10',
                trackKey: 'circuit',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
            }),
        });

        const challenge = await getServerDailyGpChallenge();

        expect(challenge.trackKey).toBe('nightCut');
        const record = await store.readStoredTrack('nightCut');
        expect(record.lockedAt).not.toBeNull();
        expect(record.lockReason).toBe('daily');
        await expect(store.saveStoredTrack('nightCut', { track: { ...smallSteps, name: 'Changed' } }, {
            username: 'ModOne',
            baseRevision: record.revision,
        })).rejects.toThrow('locked');
    });
});
