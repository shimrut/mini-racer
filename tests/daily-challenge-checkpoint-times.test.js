import { describe, expect, it } from 'vitest';
import { normalizeCheckpointTimesSec } from '../game/shared/checkpoint-times.js';

describe('normalizeCheckpointTimesSec', () => {
    it('accepts monotonic splits within the lap time', () => {
        expect(normalizeCheckpointTimesSec(30, [8.2, 16.4, 24.1])).toEqual([8.2, 16.4, 24.1]);
        expect(normalizeCheckpointTimesSec(30, ['8.2', '16.4', '24.1'])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, [0, 15, 30])).toEqual([0, 15, 30]);
    });

    it('rejects missing raw input and non-arrays', () => {
        expect(normalizeCheckpointTimesSec(30, null)).toBe(null);
        expect(normalizeCheckpointTimesSec(30, undefined)).toBe(null);
        expect(normalizeCheckpointTimesSec(30, 'bad')).toBe(null);
        expect(normalizeCheckpointTimesSec(30, { 0: 1 })).toBe(null);
    });

    it('rejects non-positive or non-finite best times', () => {
        expect(normalizeCheckpointTimesSec(0, [1])).toBe(null);
        expect(normalizeCheckpointTimesSec(-5, [1])).toBe(null);
        expect(normalizeCheckpointTimesSec(Number.NaN, [1])).toBe(null);
        expect(normalizeCheckpointTimesSec(Number.POSITIVE_INFINITY, [1])).toBe(null);
    });

    it('rejects non-increasing splits and out-of-range values', () => {
        expect(normalizeCheckpointTimesSec(30, [10, 9])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, [10, 10])).toEqual([10, 10]);
        expect(normalizeCheckpointTimesSec(30, [-0.1])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, [31])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, [Number.NaN])).toBe(null);
        // First split must not compare against an empty previous list.
        expect(normalizeCheckpointTimesSec(30, [0])).toEqual([0]);
    });

    it('rejects bestTimeSec of exactly zero while accepting tiny positives', () => {
        expect(normalizeCheckpointTimesSec(0, [0])).toBe(null);
        expect(normalizeCheckpointTimesSec(0.001, [0])).toEqual([0]);
        expect(normalizeCheckpointTimesSec(0.001, [0.001])).toEqual([0.001]);
    });

    it('rejects more than 32 checkpoint splits', () => {
        const tooMany = Array.from({ length: 33 }, (_, index) => index);
        expect(normalizeCheckpointTimesSec(100, tooMany)).toBe(null);
        const maxAllowed = Array.from({ length: 32 }, (_, index) => index);
        expect(normalizeCheckpointTimesSec(100, maxAllowed)).toEqual(maxAllowed);
    });

    it('returns null for empty arrays', () => {
        expect(normalizeCheckpointTimesSec(30, [])).toBe(null);
    });
});
