import { describe, it, expect, afterEach, vi } from 'vitest';
import { getActiveDailyChallenge } from '../game/daily-challenge/service.js';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

function buildCachedChallenge(overrides = {}) {
    return {
        id: 'active-cache-boundary',
        trackKey: 'circuit',
        startsAt: '2026-07-18T00:00:00.000Z',
        endsAt: '2026-07-19T00:00:00.000Z',
        availableUntil: '2026-07-25T00:00:00.000Z',
        objectiveType: 'single_lap_fastest',
        objectiveParams: {},
        skin: 'default',
        ...overrides,
    };
}

describe('daily-challenge active cache boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('returns a still-valid cached challenge when fetch fails and endsAt is one millisecond in the future', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T23:59:59.999Z'));
        const cached = buildCachedChallenge({
            endsAt: '2026-07-19T00:00:00.000Z',
        });
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpActiveDailyChallengeCache: JSON.stringify({ challenge: cached }),
            }),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('active-cache-boundary');
        expect(fetch).toHaveBeenCalled();
    });

    it('ignores an active cache whose endsAt is exactly now and falls back to mock data on preview pages', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
        const cached = buildCachedChallenge({
            endsAt: '2026-07-19T00:00:00.000Z',
        });
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpActiveDailyChallengeCache: JSON.stringify({ challenge: cached }),
            }),
            location: {
                hostname: 'localhost',
                pathname: '/preview.html',
                protocol: 'http:',
                search: '?mockDaily=true',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('mock-daily-challenge-local');
        expect(challenge.id).not.toBe('active-cache-boundary');
    });

    it('rethrows fetch failures on non-preview pages when the cached challenge has already ended', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
        const cached = buildCachedChallenge({
            endsAt: '2026-07-19T00:00:00.000Z',
        });
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpActiveDailyChallengeCache: JSON.stringify({ challenge: cached }),
            }),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('defaults non-string objectiveType values when writing the active cache', async () => {
        globalThis.window = {
            localStorage: createMemoryLocalStorage(),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/game.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => buildCachedChallenge({ objectiveType: 42, skin: '  ' }),
        });

        await getActiveDailyChallenge();

        const stored = JSON.parse(
            globalThis.window.localStorage.getItem('VectorGpActiveDailyChallengeCache'),
        );
        expect(stored.challenge.objectiveType).toBe('single_lap_fastest');
        expect(stored.challenge.skin).toBe('default');
    });
});
