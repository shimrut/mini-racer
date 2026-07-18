import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    getCachedDailyChallengePlaylist,
} from '../game/daily-challenge/service.js';

// Fresh module graph for playlist cache boundary checks.

function buildChallenge(overrides = {}) {
    return {
        id: 'mutation-survivor-challenge',
        trackKey: 'circuit',
        startsAt: '2026-07-18T00:00:00.000Z',
        endsAt: '2026-07-19T00:00:00.000Z',
        availableUntil: '2026-07-25T00:00:00.000Z',
        objectiveType: 'single_lap_fastest',
        objectiveParams: {},
        skin: 'default',
        status: 'active',
        ...overrides,
    };
}

describe('daily-challenge playlist boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
    });

    it('treats non-array playlist input as empty when caching', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.window = {
            localStorage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {},
            },
        };

        expect(cacheDailyChallengePlaylist(null)).toEqual([]);
        expect(cacheDailyChallengePlaylist('bad')).toEqual([]);
    });

    it('expires challenges when availableUntil is exactly now and keeps them one millisecond earlier', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.window = {
            localStorage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {},
            },
        };

        cacheDailyChallengePlaylist([
            buildChallenge({
                id: 'exactly-now-available',
                availableUntil: '2026-07-18T12:00:00.000Z',
                endsAt: '2026-07-17T00:00:00.000Z',
            }),
            buildChallenge({
                id: 'one-ms-after-available',
                availableUntil: '2026-07-18T12:00:00.001Z',
                endsAt: '2026-07-17T00:00:00.000Z',
            }),
        ]);

        const ids = getCachedDailyChallengePlaylist().map((challenge) => challenge.id);
        expect(ids).not.toContain('exactly-now-available');
        expect(ids).toContain('one-ms-after-available');
    });

    it('expires challenges when endsAt is exactly now but keeps them one millisecond earlier', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        globalThis.window = {
            localStorage: {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {},
            },
        };

        cacheDailyChallengePlaylist([
            buildChallenge({
                id: 'exactly-now-ends',
                availableUntil: null,
                endsAt: '2026-07-18T12:00:00.000Z',
            }),
            buildChallenge({
                id: 'one-ms-after-ends',
                availableUntil: null,
                endsAt: '2026-07-18T12:00:00.001Z',
            }),
        ]);

        const ids = getCachedDailyChallengePlaylist().map((challenge) => challenge.id);
        expect(ids).not.toContain('exactly-now-ends');
        expect(ids).toContain('one-ms-after-ends');
    });

    it('rewrites storage after in-memory playlist rows expire', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
        const storageData = new Map();
        globalThis.window = {
            localStorage: {
                getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
                setItem: (key, value) => { storageData.set(key, value); },
                removeItem: (key) => { storageData.delete(key); },
            },
        };

        cacheDailyChallengePlaylist([
            buildChallenge({ id: 'writeback-valid' }),
            buildChallenge({
                id: 'writeback-expired',
                startsAt: '2026-07-10T00:00:00.000Z',
                endsAt: '2026-07-11T00:00:00.000Z',
                availableUntil: '2026-07-17T00:00:00.000Z',
            }),
        ]);

        vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
        expect(getCachedDailyChallengePlaylist().map((challenge) => challenge.id)).toEqual(['writeback-valid']);

        const rewritten = JSON.parse(storageData.get('VectorGpDailyChallengePlaylistCache'));
        expect(rewritten.challenges.map((challenge) => challenge.id)).toEqual(['writeback-valid']);
    });
});
