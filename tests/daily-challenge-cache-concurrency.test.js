import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    getDailyChallengePlaylist,
    getDailyChallengeSnapshot
} from '../game/daily-challenge/service.js';

// This file gets its own fresh module graph (Vitest isolates per test file),
// so the module-level playlist/snapshot caches start empty here. That lets us
// exercise the in-flight request dedup without leftover state from other
// daily-challenge test files.

function createJsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

function createMemoryLocalStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); }
    };
}

describe('daily-challenge service cache concurrency', () => {
    beforeEach(() => {
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('shares a single in-flight playlist request across concurrent callers', async () => {
        let resolveFetch;
        fetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

        const first = getDailyChallengePlaylist();
        const second = getDailyChallengePlaylist();
        await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
        resolveFetch(createJsonResponse({
            challenges: [{
                id: 'shared-playlist-challenge',
                trackKey: 'circuit',
                startsAt: '2026-06-03T00:00:00.000Z',
                endsAt: '2026-06-04T00:00:00.000Z',
                availableUntil: '2026-06-10T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default'
            }]
        }));

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual(secondResult);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('shares a single in-flight snapshot request for concurrent first-page callers', async () => {
        let resolveFetch;
        fetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

        const challengeId = 'shared-snapshot-challenge';
        const first = getDailyChallengeSnapshot({ challengeId });
        const second = getDailyChallengeSnapshot({ challengeId });
        await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
        resolveFetch(createJsonResponse({
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            objectiveType: 'single_lap_fastest'
        }));

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual(secondResult);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
