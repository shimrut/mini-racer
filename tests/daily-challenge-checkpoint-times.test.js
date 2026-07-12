import { describe, expect, it } from 'vitest';
import { normalizeCheckpointTimesSec } from '../game/shared/checkpoint-times.js';

describe('normalizeCheckpointTimesSec', () => {
    it('accepts monotonic splits within the lap time', () => {
        expect(normalizeCheckpointTimesSec(30, [8.2, 16.4, 24.1])).toEqual([8.2, 16.4, 24.1]);
        expect(normalizeCheckpointTimesSec(30, ['8.2', '16.4', '24.1'])).toBe(null);
    });

    it('rejects non-increasing splits and out-of-range values', () => {
        expect(normalizeCheckpointTimesSec(30, [10, 9])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, [31])).toBe(null);
        expect(normalizeCheckpointTimesSec(30, 'bad')).toBe(null);
    });

    it('returns null for empty arrays', () => {
        expect(normalizeCheckpointTimesSec(30, [])).toBe(null);
    });
});
