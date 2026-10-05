import { describe, expect, it } from 'vitest';
import { applyTrackSeriesUpdate, normalizeCampaignSeriesData, parseCampaignSeriesSource, serializeCampaignSeries } from '../tools/mapmaker/campaign-series.js';
import { fitsLiveSeries, sameSeriesContent } from '../tools/mapmaker/creator-conflicts.js';

const stage = { trackKey: 'numberZero', laps: 2, requiredMedals: 0 };

describe('Campaign authoring endpoint', () => {
    it('retains the endpoint through JSON authoring roundtrips and rejects non-tail declarations', () => {
        const data = normalizeCampaignSeriesData({ series: [{
            id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', finalStageId: 'numbered-v1-00', stages: [stage],
        }] });
        expect(parseCampaignSeriesSource(serializeCampaignSeries(data))).toEqual(data);
        expect(() => normalizeCampaignSeriesData({ series: [{
            ...data.series[0], finalStageId: 'numbered-v1-01',
        }] })).toThrow('last stage');
        expect(() => applyTrackSeriesUpdate(data, { trackKey: 'numberOne', destination: 'series:numbered-v1' }))
            .toThrow('final stage');
    });

    it('distinguishes a saved endpoint from an undeclared series during uncertain save recovery', () => {
        const series = { ground: 'tarmac', stages: [stage], publishedStageCount: 1 };
        expect(sameSeriesContent(series, { ...series, finalStageId: 'night-v1-00' })).toBe(false);
        const sealed = { ...series, finalStageId: 'night-v1-00', publishedFinalStageId: 'night-v1-00' };
        expect(fitsLiveSeries({ ...series, finalStageId: null }, sealed)).toBe(false);
        expect(fitsLiveSeries({ ...sealed, stages: [stage, stage] }, sealed)).toBe(false);
        expect(fitsLiveSeries({ ...sealed, name: 'Rename' }, sealed)).toBe(true);
        expect(fitsLiveSeries({ ...series, finalStageId: 'night-v1-00' }, series)).toBe(true);
    });
});
