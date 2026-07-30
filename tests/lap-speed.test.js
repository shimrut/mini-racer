import { describe, expect, it } from 'vitest';
import { formatSplitTimeDeltaSec } from '../game/race/lap-speed.js';

describe('split time helpers', () => {
    it('formats checkpoint split deltas (lower is better)', () => {
        expect(formatSplitTimeDeltaSec(-0.12)).toEqual({
            text: '-0.120',
            isGain: true,
            isLoss: false,
        });
        expect(formatSplitTimeDeltaSec(0.25)).toEqual({
            text: '+0.250',
            isGain: false,
            isLoss: true,
        });
        expect(formatSplitTimeDeltaSec(null)).toBeNull();
    });
});
