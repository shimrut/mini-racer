import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearStoredTrackChecksForTests,
    ensureStoredTracks,
    registerStoredTracksFromPayload,
} from '../game/track/stored-track-service.js';
import { clearStoredTracksForTests, getStoredTrack } from '../game/track/stored-tracks.js';
import { hasTrack, getTrackName } from '../game/track/catalog.js';
import { clearClientTrackRegistryForTests, loadClientTrack } from '../game/track/client-registry.js';

function wireTrack(key, name = 'Night Loop') {
    return {
        key,
        name,
        ground: 'tarmac',
        medalRow: { gold: 10, silver: 11, bronze: 12, author: 9 },
        track: {
            name,
            outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
            inner: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
            startLine: { p1: { x: 1, y: 1 }, p2: { x: 1, y: 3 } },
            startPos: { x: 1, y: 2 },
            startAngle: 0,
            checkpoints: [],
        },
        placed: true,
    };
}

function answer(tracks, ok = true) {
    return { ok, status: ok ? 200 : 500, json: async () => ({ tracks }) };
}

beforeEach(() => {
    vi.useRealTimers();
    clearStoredTracksForTests();
    clearStoredTrackChecksForTests();
    clearClientTrackRegistryForTests();
});

afterEach(() => vi.unstubAllGlobals());

describe('stored track service', () => {
    it('asks once for the keys that the app does not have, and registers the answer', async () => {
        const fetchMock = vi.fn(async () => answer([wireTrack('nightLoop')]));
        vi.stubGlobal('fetch', fetchMock);
        await Promise.all([
            ensureStoredTracks(['nightLoop', 'circuit', 'nightLoop']),
            ensureStoredTracks(['nightLoop']),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/tracks/stored?keys=nightLoop');
        expect(hasTrack('nightLoop')).toBe(true);
        expect(getTrackName('nightLoop')).toBe('Night Loop');
        await ensureStoredTracks(['nightLoop']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not ask again for a missing key until a few minutes pass', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => answer([]));
        vi.stubGlobal('fetch', fetchMock);
        await ensureStoredTracks(['laterLoop']);
        await ensureStoredTracks(['laterLoop']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(11 * 60 * 1000);
        await ensureStoredTracks(['laterLoop']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asks about a built-in key only when the caller wants it', async () => {
        const fetchMock = vi.fn(async () => answer([wireTrack('waterCircuit', 'Water Circuit II')]));
        vi.stubGlobal('fetch', fetchMock);
        await ensureStoredTracks(['waterCircuit']);
        expect(fetchMock).not.toHaveBeenCalled();
        await ensureStoredTracks(['waterCircuit'], { includeBuiltIn: true });
        expect(getTrackName('waterCircuit')).toBe('Water Circuit II');
    });

    it('keeps the built-in tracks when the request fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => answer([], false)));
        await expect(ensureStoredTracks(['brokenLoop'])).resolves.toBeUndefined();
        expect(hasTrack('brokenLoop')).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('registers only well-formed tracks from a server answer', () => {
        registerStoredTracksFromPayload([
            wireTrack('goodLoop'),
            { key: 'badLoop', track: { outer: 'no' } },
            { key: 'Bad Key', track: wireTrack('x').track },
        ]);
        expect(getStoredTrack('goodLoop')?.track.name).toBe('Night Loop');
        expect(getStoredTrack('badLoop')).toBeNull();
        expect(getStoredTrack('Bad Key')).toBeNull();
    });

    it('lets the game load a stored track that it does not have yet', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => answer([wireTrack('lateLoop')])));
        const track = await loadClientTrack('lateLoop');
        expect(track.name).toBe('Night Loop');
    });
});
