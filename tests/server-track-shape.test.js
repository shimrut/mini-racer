import { describe, expect, it } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { normalizeTrackShape, TrackInputError } from '../src/server/tracks/track-shape.ts';
import { createTrackFingerprint } from '../src/server/competition/pb-ghost-trace.ts';

describe('stored track shape', () => {
    it('keeps every built-in race field exactly while dropping obsolete rendering metadata', () => {
        for (const [trackKey, track] of Object.entries(TRACKS)) {
            const copy = normalizeTrackShape(track, { maxNameLength: 40 });
            const { drawWidth, lineSmoothing, ...raceTrack } = track;
            expect(createTrackFingerprint(copy), trackKey).toBe(createTrackFingerprint(track));
            expect(copy, trackKey).toEqual(raceTrack);
            expect(copy).not.toHaveProperty('drawWidth');
            expect(copy).not.toHaveProperty('lineSmoothing');
        }
    });

    it('refuses points out of range and unknown grounds', () => {
        const track = TRACKS.circuit;
        expect(() => normalizeTrackShape({ ...track, startPos: { x: 2_000, y: 0 } }))
            .toThrow(TrackInputError);
        expect(() => normalizeTrackShape({ ...track, ground: 'lava' })).toThrow('Unknown track ground.');
        expect(() => normalizeTrackShape({ ...track, name: 'x'.repeat(41) }, { maxNameLength: 40 }))
            .toThrow('at most 40 characters');
    });
});
