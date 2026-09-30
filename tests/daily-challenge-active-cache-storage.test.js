import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearStoredTrackChecksForTests, registerStoredTracksFromPayload } from '../game/track/stored-track-service.js';
import * as catalog from '../game/track/catalog.js';
import { getActiveDailyChallenge } from '../game/daily-challenge/service.js';
import { createMemoryLocalStorage } from './helpers/memory-local-storage.js';

function createJsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

function futureIso(hoursFromNow = 24) {
    return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

describe('daily-challenge active cache storage', () => {
    // These metadata/cache tests model a session whose race layout was already confirmed.
    beforeEach(() => {
        clearStoredTrackChecksForTests();
        registerStoredTracksFromPayload([], { confirmedTrackKeys: ['circuit'] });
    });

    let memoryLocalStorage;

    afterEach(() => {
        vi.restoreAllMocks();
        memoryLocalStorage?._clear();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.devvit;
    });

    it('hydrates a still-current active challenge from storage when the fetch fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: JSON.stringify({
                challenge: {
                    id: 'hydrated-active-challenge',
                    trackKey: 'circuit',
                    objectiveType: 'single_lap_fastest',
                    endsAt: futureIso(12),
                    availableUntil: futureIso(24 * 7),
                    skin: 'default',
                },
            }),
        });
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('hydrated-active-challenge');
        expect(fetch).toHaveBeenCalled();
    });

    it('ignores an active cache entry with a missing or invalid endsAt', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: JSON.stringify({
                challenge: {
                    id: 'bad-ends-at-cache',
                    trackKey: 'circuit',
                    objectiveType: 'single_lap_fastest',
                    endsAt: 'not-a-date',
                    skin: 'default',
                },
            }),
        });
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
    });

    it('treats corrupted active-cache JSON as empty instead of throwing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: '{not-json',
        });
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await expect(getActiveDailyChallenge()).rejects.toThrow('offline');
        expect(console.error).toHaveBeenCalledWith(
            'Error reading active daily challenge cache:',
            expect.any(Error),
        );
    });

    it('clears the active cache when a fetched challenge cannot be trimmed for storage', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const originalHasTrack = catalog.hasTrack;
        const hasTrackSpy = vi.spyOn(catalog, 'hasTrack');
        let counting = false;
        let circuitChecks = 0;
        hasTrackSpy.mockImplementation((key) => {
            if (!counting || key !== 'circuit') {
                return originalHasTrack(key);
            }
            circuitChecks += 1;
            return circuitChecks === 1;
        });

        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: JSON.stringify({
                challenge: {
                    id: 'stale-active-cache',
                    trackKey: 'circuit',
                    objectiveType: 'single_lap_fastest',
                    endsAt: futureIso(12),
                    skin: 'default',
                },
            }),
        });
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            counting = true;
            return createJsonResponse({
                id: 'uncacheable-active',
                trackKey: 'circuit',
                endsAt: futureIso(12),
                availableUntil: futureIso(24 * 7),
                objectiveType: 'single_lap_fastest',
                skin: 'default',
            });
        });

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('uncacheable-active');
        expect(memoryLocalStorage.getItem('VectorGpActiveDailyChallengeCache')).toBeNull();
    });

    it('swallows storage errors while clearing the active cache', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const originalHasTrack = catalog.hasTrack;
        const hasTrackSpy = vi.spyOn(catalog, 'hasTrack');
        let counting = false;
        let circuitChecks = 0;
        hasTrackSpy.mockImplementation((key) => {
            if (!counting || key !== 'circuit') {
                return originalHasTrack(key);
            }
            circuitChecks += 1;
            return circuitChecks === 1;
        });

        memoryLocalStorage = createMemoryLocalStorage({
            VectorGpActiveDailyChallengeCache: JSON.stringify({
                challenge: {
                    id: 'must-clear',
                    trackKey: 'circuit',
                    endsAt: futureIso(12),
                    skin: 'default',
                },
            }),
        });
        memoryLocalStorage.removeItem = () => { throw new Error('remove blocked'); };
        globalThis.window = {
            localStorage: memoryLocalStorage,
            location: {
                hostname: 'example.devvit.net',
                pathname: '/index.html',
                protocol: 'https:',
                search: '',
            },
        };
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            counting = true;
            return createJsonResponse({
                id: 'uncacheable-clear-error',
                trackKey: 'circuit',
                endsAt: futureIso(12),
                objectiveType: 'single_lap_fastest',
                skin: 'default',
            });
        });

        const challenge = await getActiveDailyChallenge();

        expect(challenge.id).toBe('uncacheable-clear-error');
        expect(console.error).toHaveBeenCalledWith(
            'Error clearing active daily challenge cache:',
            expect.any(Error),
        );
    });
});
