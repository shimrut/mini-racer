import { describe, expect, it } from 'vitest';
import { getCrossingFraction } from '../game/track/geometry.js';

describe('getCrossingFraction', () => {
    it('returns null when segments miss', () => {
        expect(getCrossingFraction(
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 }
        )).toBeNull();
    });

    it('returns ~0.5 for a mid-segment crossing', () => {
        const t = getCrossingFraction(
            { x: 0, y: -1 },
            { x: 0, y: 1 },
            { x: -1, y: 0 },
            { x: 1, y: 0 }
        );
        expect(t).toBeCloseTo(0.5, 9);
    });

    it('clamps near-endpoint hits into [0, 1]', () => {
        const nearStart = getCrossingFraction(
            { x: 0, y: 0 },
            { x: 0, y: 10 },
            { x: -1, y: -1e-12 },
            { x: 1, y: -1e-12 }
        );
        const nearEnd = getCrossingFraction(
            { x: 0, y: 0 },
            { x: 0, y: 10 },
            { x: -1, y: 10 + 1e-12 },
            { x: 1, y: 10 + 1e-12 }
        );
        expect(nearStart).toBe(0);
        expect(nearEnd).toBe(1);
    });

    it('matches a known quarter-path crossing', () => {
        const t = getCrossingFraction(
            { x: 5, y: -0.115 },
            { x: 5, y: -0.065 },
            { x: 0, y: -0.1 },
            { x: 10, y: -0.1 }
        );
        expect(t).toBeCloseTo(0.3, 9);
    });
});
