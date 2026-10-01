import { afterEach, describe, expect, it } from 'vitest';
import {
    CAMPAIGN_ALL_SERIES,
    CAMPAIGN_HAS_SERIES_CHOICE,
    CAMPAIGN_LIVE_STAGES,
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    campaignHasSeriesChoice,
    getCampaignSeries,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
} from '../game/campaign/manifest.js';
import {
    clearStoredSeriesForTests,
    isStoredSeriesListLoaded,
    markStoredSeriesLoaded,
    registerStoredSeries,
    setStoredSeriesResolver,
} from '../game/campaign/stored-series.js';

const nightSeries = {
    id: 'night-v1',
    name: 'Night Races',
    ground: 'tarmac',
    stages: [
        { trackKey: 'babylonRace', laps: 1, requiredMedals: 0 },
        { trackKey: 'smallSteps', laps: 2, requiredMedals: 1 },
    ],
};

afterEach(() => clearStoredSeriesForTests());

describe('published Creator series in the Campaign', () => {
    it('keeps the app series alone when nothing is stored', () => {
        expect(CAMPAIGN_SERIES.map((series) => series.id)).toEqual([CAMPAIGN_NUMBERS_SERIES_ID]);
        expect(campaignHasSeriesChoice()).toBe(CAMPAIGN_HAS_SERIES_CHOICE);
        expect(Array.isArray(CAMPAIGN_SERIES)).toBe(true);
    });

    it('adds a published series after the app series, with its stages', () => {
        const liveStageCount = CAMPAIGN_LIVE_STAGES.length;
        registerStoredSeries([nightSeries]);
        expect(CAMPAIGN_SERIES.map((series) => series.id)).toEqual([CAMPAIGN_NUMBERS_SERIES_ID, 'night-v1']);
        expect(CAMPAIGN_SERIES.length).toBe(2);
        expect([...CAMPAIGN_SERIES].at(-1).name).toBe('Night Races');
        expect(CAMPAIGN_LIVE_STAGES).toHaveLength(liveStageCount + 2);
        expect(campaignHasSeriesChoice()).toBe(true);
        expect(getCampaignSeries('night-v1').stages.map((stage) => stage.raceId))
            .toEqual(['night-v1-00', 'night-v1-01']);
        expect(getCampaignStage('night-v1-01')).toMatchObject({ trackKey: 'smallSteps', lapCount: 2 });
        expect(getCampaignUnlockedRaceIds({})).toContain('night-v1-00');
        expect(getCampaignUnlockedRaceIds({})).not.toContain('night-v1-01');
        expect(JSON.parse(JSON.stringify(CAMPAIGN_SERIES.map((series) => series.id)))).toHaveLength(2);
    });

    it('never lets a stored series replace Numbers', () => {
        registerStoredSeries([{ ...nightSeries, id: CAMPAIGN_NUMBERS_SERIES_ID, name: 'Fake Numbers' }]);
        expect(getCampaignSeries(CAMPAIGN_NUMBERS_SERIES_ID).name).toBe('Numbers');
    });

    it('lets a published copy replace a hidden app series of the same name', () => {
        const hidden = CAMPAIGN_ALL_SERIES.find((series) => !series.live);
        registerStoredSeries([{ id: hidden.id, name: 'Changed', ground: hidden.ground, stages: nightSeries.stages }]);
        const replaced = [...CAMPAIGN_ALL_SERIES].find((series) => series.id === hidden.id);
        expect(replaced.name).toBe('Changed');
        expect(CAMPAIGN_ALL_SERIES.length).toBeGreaterThan(1);
    });

    it('knows the list only after a Campaign answer, until the test reset', () => {
        expect(isStoredSeriesListLoaded()).toBe(false);
        registerStoredSeries([nightSeries]);
        expect(isStoredSeriesListLoaded()).toBe(false);
        markStoredSeriesLoaded();
        expect(isStoredSeriesListLoaded()).toBe(true);
        clearStoredSeriesForTests();
        expect(isStoredSeriesListLoaded()).toBe(false);
    });

    it('reads the series of the current request on the server', () => {
        const perRequest = Object.freeze([nightSeries]);
        setStoredSeriesResolver(() => perRequest);
        expect(getCampaignSeries('night-v1')).not.toBeNull();
        setStoredSeriesResolver(null);
        expect(getCampaignSeries('night-v1')).toBeNull();
    });
});
