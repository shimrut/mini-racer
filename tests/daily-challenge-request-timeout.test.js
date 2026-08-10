import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    DAILY_REQUEST_TIMEOUT_MS,
    confirmDailyChallengeShare,
    getDailyChallengePlaylist,
    submitDailyChallengeBestTime,
} from '../game/daily-challenge/service.js';

function createMemoryLocalStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

function createStalledFetch() {
    return vi.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(new DOMException('Daily request timed out', 'AbortError'));
        });
    }));
}

function buildChallenge(overrides = {}) {
    return {
        id: 'timeout-challenge',
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

describe('daily challenge request timeouts', () => {
    beforeEach(() => {
        globalThis.window = {
            localStorage: createMemoryLocalStorage(),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
                origin: 'https://example.devvit.net',
            },
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('aborts a Daily submission that never settles', async () => {
        vi.useFakeTimers();
        globalThis.fetch = createStalledFetch();

        const request = submitDailyChallengeBestTime({
            challengeId: 'timeout-challenge',
            trackKey: 'circuit',
            bestTime: 42,
            replay: { revision: 1, segments: [] },
        });
        const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

        await vi.advanceTimersByTimeAsync(DAILY_REQUEST_TIMEOUT_MS);
        await rejection;
    });

    it('aborts a Daily share confirmation that never settles', async () => {
        vi.useFakeTimers();
        globalThis.fetch = createStalledFetch();

        const request = confirmDailyChallengeShare('share-token');
        const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

        await vi.advanceTimersByTimeAsync(DAILY_REQUEST_TIMEOUT_MS);
        await rejection;
    });

    it('releases the playlist cache promise so a stalled load can be retried', async () => {
        vi.useFakeTimers();
        globalThis.fetch = createStalledFetch();

        const stalled = getDailyChallengePlaylist({ forceRefresh: true });
        const rejection = expect(stalled).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(DAILY_REQUEST_TIMEOUT_MS);
        await rejection;

        vi.useRealTimers();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ challenges: [buildChallenge({ id: 'recovered' })] }),
        });

        const recovered = await getDailyChallengePlaylist({ forceRefresh: true });
        expect(recovered.map((challenge) => challenge.id)).toContain('recovered');
    });
});
