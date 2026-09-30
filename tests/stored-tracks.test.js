import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TRACK_CATALOG, getTrackName, hasTrack, isBuiltInTrack } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import {
    clearStoredTracksForTests,
    getStoredTrack,
    registerStoredTrack,
    setStoredTrackResolver,
} from '../game/track/stored-tracks.js';
import {
    getAuthorMedalSeconds,
    getMedalForRaceTime,
    getTrackMedalThresholds,
    normalizeMedalRow,
} from '../game/medals/medal-timing.js';
import {
    clearClientTrackRegistryForTests,
    getLoadedClientTrack,
    loadClientTrack,
    setStoredTrackLoader,
} from '../game/track/client-registry.js';
import { generateTracksRegistrySource } from '../tools/mapmaker/track-repository.js';

const shape = {
    name: 'Night Loop',
    outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inner: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
    startLine: { p1: { x: 1, y: 1 }, p2: { x: 1, y: 3 } },
    startPos: { x: 1, y: 2 },
    startAngle: 0,
    checkpoints: [],
};

function storedEntry(key, overrides = {}) {
    return {
        key,
        name: shape.name,
        ground: 'tarmac',
        medalRow: normalizeMedalRow({ author: 9, gold: 10, silver: 11, bronze: 12 }),
        track: { ...shape },
        ...overrides,
    };
}

afterEach(() => {
    clearStoredTracksForTests();
    clearClientTrackRegistryForTests();
    setStoredTrackLoader(null);
});

describe('stored track overlay', () => {
    it('finds a stored track by its key, next to the built-in tracks', () => {
        expect(hasTrack('nightLoop')).toBe(false);
        registerStoredTrack(storedEntry('nightLoop'));
        expect(hasTrack('nightLoop')).toBe(true);
        expect(isBuiltInTrack('nightLoop')).toBe(false);
        expect(getTrackName('nightLoop')).toBe('Night Loop');
        expect(TRACKS.nightLoop.outer).toHaveLength(3);
        expect('nightLoop' in TRACKS).toBe(true);
        expect(getTrackMedalThresholds('nightLoop')).toEqual({ gold: 10, silver: 11, bronze: 12 });
        expect(getAuthorMedalSeconds('nightLoop')).toBe(9);
        expect(getMedalForRaceTime('nightLoop', 19.5, 2)).toBe('gold');
    });

    it('lets a stored copy win over the built-in track with the same key', () => {
        const builtIn = TRACKS.circuit;
        registerStoredTrack(storedEntry('circuit', { name: 'Stored Circuit', medalRow: null }));
        expect(TRACKS.circuit).not.toBe(builtIn);
        expect(TRACKS.circuit.name).toBe('Night Loop');
        expect(getTrackName('circuit')).toBe('Stored Circuit');
        expect(getTrackMedalThresholds('circuit')).toBeNull();
        clearStoredTracksForTests();
        expect(TRACKS.circuit).toBe(builtIn);
    });

    it('lists only the built-in tracks', () => {
        registerStoredTrack(storedEntry('nightLoop'));
        expect(Object.keys(TRACKS)).toEqual(Object.keys(TRACK_CATALOG));
    });

    it('uses the resolver that the server sets for the current request', () => {
        const entry = Object.freeze(storedEntry('serverLoop'));
        setStoredTrackResolver((key) => (key === 'serverLoop' ? entry : null));
        expect(getStoredTrack('serverLoop')).toBe(entry);
        expect(hasTrack('serverLoop')).toBe(true);
        setStoredTrackResolver(null);
        expect(hasTrack('serverLoop')).toBe(false);
    });

    it('asks the loader once for a stored track that the game does not have', async () => {
        let calls = 0;
        setStoredTrackLoader(async (key) => {
            calls += 1;
            registerStoredTrack(storedEntry(key));
        });
        const [first, second] = await Promise.all([
            loadClientTrack('fetchedLoop'),
            loadClientTrack('fetchedLoop'),
        ]);
        expect(calls).toBe(1);
        expect(first).toBe(second);
        expect(first.outer).toHaveLength(3);
        expect(getLoadedClientTrack('fetchedLoop')).toBe(first);
    });

    it('returns no track for an unknown key without a loader', async () => {
        expect(await loadClientTrack('missingLoop')).toBeNull();
    });

    it('keeps the generated track registry in step with the file', () => {
        const source = readFileSync(new URL('../game/track/tracks.js', import.meta.url), 'utf8');
        const keys = [...source.matchAll(/^import (\w+) from '\.\/definitions\//gm)].map((match) => match[1]);
        expect(generateTracksRegistrySource(keys)).toBe(source);
    });
});
