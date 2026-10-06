import { describe, expect, it } from 'vitest';
import { formatSeriesMedals } from '../game/lobby/campaign-series-picker.js';

describe('Campaign series medal count', () => {
    it('counts medals out of four for each stage', () => {
        expect(formatSeriesMedals({ stageCount: 16, medalCount: 23 })).toBe('23/64');
        expect(formatSeriesMedals({})).toBe('0/0');
    });
});
