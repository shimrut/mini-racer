import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    getDailyChallengePlaylist,
} from '../game/daily-challenge/service.js';

// Fresh module graph: first playlist-cache touch hydrates from localStorage here.

function createMemoryLocalStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
    };
}

describe('daily-challenge playlist hydration', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
        delete globalThis.fetch;
    });

    it('returns a hydrated seven-day playlist without refetching the server', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const challenges = Array.from({ length: 7 }, (_, index) => {
            const day = 18 - index;
            const dayString = String(day).padStart(2, '0');
            return {
                id: `hydrated-seven-${dayString}`,
                trackKey: 'circuit',
                startsAt: `2026-07-${dayString}T00:00:00.000Z`,
                endsAt: `2026-07-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`,
                availableUntil: '2026-07-25T00:00:00.000Z',
                objectiveType: 'single_lap_fastest',
                objectiveParams: {},
                skin: 'default',
            };
        });
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengePlaylistCache: JSON.stringify({ challenges }),
            }),
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn();

        const playlist = await getDailyChallengePlaylist();

        expect(playlist).toHaveLength(7);
        expect(fetch).not.toHaveBeenCalled();

        vi.useRealTimers();
    });
});
