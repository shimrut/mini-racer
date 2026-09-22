import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengePlaylist } from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

describe('daily-challenge playlist prune hydration', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('hydrates a stored playlist on the first cache read and prunes expired rows', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const stillValid = {
            id: 'hydrated-valid-playlist',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const expired = {
            id: 'hydrated-expired-playlist',
            trackKey: 'alloyRing',
            startsAt: '2026-07-10T00:00:00.000Z',
            endsAt: '2026-07-11T00:00:00.000Z',
            availableUntil: '2026-07-17T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        globalThis.window = {
            localStorage: createMemoryLocalStorage({
                VectorGpDailyChallengePlaylistCache: JSON.stringify({
                    challenges: [stillValid, expired],
                }),
            }),
        };

        const playlist = getCachedDailyChallengePlaylist();

        expect(playlist.map((challenge) => challenge.id)).toEqual(['hydrated-valid-playlist']);
        vi.useRealTimers();
    });
});
