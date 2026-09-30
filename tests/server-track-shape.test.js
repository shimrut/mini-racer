import { describe, expect, it } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import { normalizeTrackShape, TrackInputError } from '../src/server/tracks/track-shape.ts';
import { createTrackFingerprint } from '../src/server/competition/pb-ghost-trace.ts';

describe('stored track shape', () => {
    it('keeps every built-in track exactly, so a stored copy has the same fingerprint', () => {
        for (const [trackKey, track] of Object.entries(TRACKS)) {
            const copy = normalizeTrackShape(track, { maxNameLength: 40 });
            expect(createTrackFingerprint(copy), trackKey).toBe(createTrackFingerprint(track));
            expect(copy, trackKey).toEqual({ ...track });
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
