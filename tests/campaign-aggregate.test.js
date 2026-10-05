import { afterEach, describe, expect, it } from 'vitest';
import { formatCampaignPlace, formatCampaignTotalTime, getCampaignAggregateTotalTimeMs, readCampaignPlace } from '../game/campaign/aggregate.js';
import { getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { clearStoredSeriesForTests, registerStoredSeries } from '../game/campaign/stored-series.js';

const series = {
    id: 'aggregate-v1', name: 'Aggregate', ground: 'tarmac', finalStageId: 'aggregate-v1-01',
    stages: [
        { trackKey: 'numberZero', laps: 2, requiredMedals: 0 },
        { trackKey: 'numberOne', laps: 3, requiredMedals: 1 },
    ],
};
function savedResults() {
    registerStoredSeries([series]);
    return Object.fromEntries(getCampaignSeriesStages(series.id).map((stage, index) => [stage.raceId, {
        bestTimeMs: 12_345 + index, medal: 'bronze',
    }]));
}
afterEach(clearStoredSeriesForTests);

describe('Campaign total best time', () => {
    it('formats exact PB totals with milliseconds across minute and hour boundaries', () => {
        expect(formatCampaignTotalTime(1)).toBe('0:00.001');
        expect(formatCampaignTotalTime(59_999)).toBe('0:59.999');
        expect(formatCampaignTotalTime(60_000)).toBe('1:00.000');
        expect(formatCampaignTotalTime(3_600_001)).toBe('1:00:00.001');
        for (const value of [undefined, null, 0, -1, 12.5, Infinity, '12345', Number.MAX_SAFE_INTEGER + 1]) {
            expect(formatCampaignTotalTime(value)).toBe('');
        }
    });
    it('sums the full saved race times exactly once, including different lap counts', () => {
        expect(getCampaignAggregateTotalTimeMs(series.id, savedResults())).toBe(24_691);
    });

    it('excludes incomplete, invalid and medal-free final results', () => {
        const results = savedResults();
        for (const time of [undefined, null, 0, -1, 12.5, Infinity, '12345']) {
            expect(getCampaignAggregateTotalTimeMs(series.id, {
                ...results, 'aggregate-v1-00': { bestTimeMs: time, medal: 'bronze' },
            })).toBeNull();
        }
        expect(getCampaignAggregateTotalTimeMs(series.id, { 'aggregate-v1-01': results['aggregate-v1-01'] })).toBeNull();
        expect(getCampaignAggregateTotalTimeMs(series.id, {
            ...results, 'aggregate-v1-01': { bestTimeMs: 12346, medal: null },
        })).toBeNull();
    });

    it('does not rank an undeclared or still unpublished endpoint', () => {
        const results = savedResults();
        registerStoredSeries([{ ...series, finalStageId: null }]);
        expect(getCampaignAggregateTotalTimeMs(series.id, results)).toBeNull();
        registerStoredSeries([{ ...series, finalStageId: 'aggregate-v1-02' }]);
        expect(getCampaignAggregateTotalTimeMs(series.id, results)).toBeNull();
    });

    it('reduces the total when an earlier PB improves and rejects unsafe sums', () => {
        const results = savedResults();
        results['aggregate-v1-00'].bestTimeMs = 11_000;
        expect(getCampaignAggregateTotalTimeMs(series.id, results)).toBe(23_346);
        results['aggregate-v1-00'].bestTimeMs = Number.MAX_SAFE_INTEGER;
        expect(getCampaignAggregateTotalTimeMs(series.id, results)).toBeNull();
    });

    it('keeps only a real overall place', () => {
        expect(readCampaignPlace({ rank: 2, total: 12 })).toEqual({ rank: 2, total: 12 });
        expect(formatCampaignPlace({ rank: 2, total: 12 })).toBe('#2 / 12');
        expect(readCampaignPlace({ rank: 0, total: 3 })).toBeNull();
        expect(readCampaignPlace({ rank: 4, total: 3 })).toBeNull();
        expect(formatCampaignPlace(null)).toBe('');
    });
});
