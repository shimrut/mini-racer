import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    cacheDailyChallengePlaylist,
    getCachedDailyChallengePlaylist
} from '../game/daily-challenge/service.js';

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); }
    };
}

describe('daily-challenge playlist cache storage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('treats a corrupted playlist cache entry as empty instead of throwing', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengePlaylistCache: '{not-json'
            })
        };

        expect(getCachedDailyChallengePlaylist()).toEqual([]);
        expect(console.error).toHaveBeenCalledWith(
            'Error reading daily playlist cache:',
            expect.any(Error)
        );
    });

    it('keeps the in-memory playlist cache updated even when persisting it throws', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.window = { localStorage: createMemoryLocalStorage() };
        globalThis.window.localStorage.setItem = () => { throw new Error('quota exceeded'); };

        const now = Date.now();
        const merged = cacheDailyChallengePlaylist([{
            id: 'write-error-playlist-challenge',
            trackKey: 'circuit',
            startsAt: new Date(now).toISOString(),
            endsAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            availableUntil: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default'
        }]);

        expect(merged.map((challenge) => challenge.id)).toContain('write-error-playlist-challenge');
        expect(getCachedDailyChallengePlaylist().map((challenge) => challenge.id)).toContain(
            'write-error-playlist-challenge'
        );
        expect(console.error).toHaveBeenCalledWith(
            'Error writing daily playlist cache:',
            expect.any(Error)
        );
    });
});
