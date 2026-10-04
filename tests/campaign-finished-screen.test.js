import { afterEach, describe, expect, it } from 'vitest';
import { buildCampaignFinishedScreen } from '../game/campaign/finished-screen.js';
import {
    CAMPAIGN_NUMBERS_SERIES_ID,
    getCampaignSeriesStages,
} from '../game/campaign/manifest.js';
import {
    clearStoredSeriesForTests,
    registerStoredSeries,
} from '../game/campaign/stored-series.js';

const NUMBERS_STAGES = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);

function resultsFor(stages, medalFor = () => 'bronze') {
    return Object.fromEntries(stages.map((stage, index) => [stage.raceId, {
        bestTimeMs: 10000,
        medal: medalFor(stage, index),
    }]));
}

afterEach(() => {
    clearStoredSeriesForTests();
});

describe('buildCampaignFinishedScreen', () => {
    it('fills the screen from the finished series', () => {
        const screen = buildCampaignFinishedScreen(
            CAMPAIGN_NUMBERS_SERIES_ID,
            resultsFor(NUMBERS_STAGES),
        );

        expect(screen).toMatchObject({
            seriesId: CAMPAIGN_NUMBERS_SERIES_ID,
            title: 'Numbers',
            eyebrow: 'Campaign finished',
            summary: 'Numbers is finished.',
            facts: [
                { label: 'Stages', value: '16' },
                { label: 'Medals', value: '16/64' },
                { label: 'Surface', value: 'Street' },
            ],
        });
        expect(screen.kerb.a).toEqual(expect.any(String));
        expect(screen.kerb.b).toEqual(expect.any(String));
    });

    it('uses another campaign’s name, surface and size', () => {
        registerStoredSeries([{
            id: 'harbour-v1',
            name: 'Grey Harbour',
            ground: 'dirt',
            stages: [
                { trackKey: 'countryRoad', laps: 1, requiredMedals: 0 },
                { trackKey: 'forestTrail', laps: 2, requiredMedals: 1 },
            ],
        }]);
        const stages = getCampaignSeriesStages('harbour-v1');

        const screen = buildCampaignFinishedScreen('harbour-v1', resultsFor(stages, () => 'gold'));

        expect(screen).toMatchObject({
            seriesId: 'harbour-v1',
            title: 'Grey Harbour',
            summary: 'Grey Harbour is finished, with gold or better on every stage.',
            facts: [
                { label: 'Stages', value: '2' },
                { label: 'Medals', value: '6/8' },
                { label: 'Surface', value: 'Dirt' },
            ],
        });
    });

    it('stays empty until the last stage has a medal', () => {
        const unfinished = resultsFor(NUMBERS_STAGES, (_stage, index) => (
            index === NUMBERS_STAGES.length - 1 ? null : 'bronze'
        ));
        delete unfinished[NUMBERS_STAGES.at(-1).raceId];

        expect(buildCampaignFinishedScreen(CAMPAIGN_NUMBERS_SERIES_ID, unfinished)).toBeNull();
        expect(buildCampaignFinishedScreen('missing-series', {})).toBeNull();
    });
});
