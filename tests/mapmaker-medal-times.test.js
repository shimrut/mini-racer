import { describe, expect, it } from 'vitest';
import {
    averageDraftLap,
    draftLapsStorageKey,
    getMedalRowError,
    lapToAuthorTime,
    readDraftLaps,
    recordDraftLap,
    suggestMedalTimes,
    trackLayoutHash,
} from '../tools/mapmaker/medal-times.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
    };
}

const TRACK = {
    name: 'Test',
    outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inner: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
    checkpoints: [],
};

describe('Mapmaker medal times', () => {
    it('suggests gold, silver and bronze from the author time', () => {
        expect(suggestMedalTimes(10)).toEqual({ author: 10, gold: 10.25, silver: 10.55, bronze: 10.88 });
        expect(suggestMedalTimes(0)).toBeNull();
    });

    it('rounds a lap up to 0.01 s, so the lap itself earns the author medal', () => {
        expect(lapToAuthorTime(16.561)).toBe(16.57);
        expect(lapToAuthorTime(16.56)).toBe(16.56);
    });

    it('needs four times that go up', () => {
        expect(getMedalRowError({ author: 9, gold: 9.2, silver: 9.5, bronze: 9.9 })).toBeNull();
        expect(getMedalRowError({ author: 9, gold: 9.2, silver: 9.5 })).toMatch('all four');
        expect(getMedalRowError({ author: 9.3, gold: 9.2, silver: 9.5, bronze: 9.9 })).toMatch('go up');
    });

    it('keeps the 10 best Drive Draft laps for one layout', () => {
        const storage = memoryStorage();
        const key = draftLapsStorageKey('testTrack', TRACK);
        for (const lap of [12, 11, 13, 10.5, 14, 15, 16, 17, 18, 19, 20, 9.9]) {
            recordDraftLap(storage, key, lap);
        }
        const laps = readDraftLaps(storage, key);
        expect(laps).toHaveLength(10);
        expect(laps[0]).toBe(9.9);
        expect(laps.at(-1)).toBe(18);
        expect(averageDraftLap([10, 12])).toBe(11);
    });

    it('starts a new lap list when the layout changes, but not when the name changes', () => {
        const moved = { ...TRACK, outer: [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 10, y: 10 }] };
        expect(trackLayoutHash({ ...TRACK, name: 'Other' })).toBe(trackLayoutHash(TRACK));
        expect(trackLayoutHash(moved)).not.toBe(trackLayoutHash(TRACK));
        expect(trackLayoutHash({ ...TRACK, ground: 'dirt' })).not.toBe(trackLayoutHash(TRACK));
    });
});
