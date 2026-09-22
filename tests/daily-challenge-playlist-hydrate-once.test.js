import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedDailyChallengePlaylist } from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

describe('daily-challenge playlist hydrate once', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it('does not re-read localStorage after the first hydration pass', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));

        const validChallenge = {
            id: 'hydrate-once-valid',
            trackKey: 'circuit',
            startsAt: '2026-07-18T00:00:00.000Z',
            endsAt: '2026-07-19T00:00:00.000Z',
            availableUntil: '2026-07-25T00:00:00.000Z',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
        const storage = createMemoryLocalStorage({
            VectorGpDailyChallengePlaylistCache: JSON.stringify({ challenges: [validChallenge] }),
        });
        globalThis.window = { localStorage: storage };

        expect(getCachedDailyChallengePlaylist().map((challenge) => challenge.id))
            .toEqual(['hydrate-once-valid']);

        storage.setItem(
            'VectorGpDailyChallengePlaylistCache',
            JSON.stringify({
                challenges: [{
                    ...validChallenge,
                    id: 'should-not-rehydrate',
                }],
            }),
        );

        expect(getCachedDailyChallengePlaylist().map((challenge) => challenge.id))
            .toEqual(['hydrate-once-valid']);

        vi.useRealTimers();
    });
});
