import { describe, expect, it } from 'vitest';
import {
    CAMPAIGN_ID,
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    countCampaignMedals,
    getCampaignSeriesStages,
    getCampaignStage,
    getCampaignStageMedalCount,
    getCampaignUnlockedRaceIds,
} from '../game/campaign/manifest.js';
import { isCampaignSeriesLive } from '../game/campaign/series-rules.js';
import { normalizeRaceSpec } from '../game/race/race-spec.js';

const NUMBERS_STAGES = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);

// The open Numbers stages. The first stage of every other series is open too.
function getNumbersUnlockedRaceIds(results) {
    return getCampaignUnlockedRaceIds(results)
        .filter((raceId) => getCampaignStage(raceId)?.seriesId === CAMPAIGN_NUMBERS_SERIES_ID);
}

describe('Campaign manifest', () => {
    it('lets players see only the series on a live ground', () => {
        expect(CAMPAIGN_SERIES.map((series) => series.id)).toEqual(['numbered-v1', 'dirt-v1']);
        const tenStages = Array.from({ length: 10 }, (_, index) => ({ trackKey: `t${index}` }));
        expect(isCampaignSeriesLive({ id: 'dirt-v1', ground: 'dirt', stages: tenStages })).toBe(true);
        for (const ground of ['grip', 'snow', 'water', 'space']) {
            expect(isCampaignSeriesLive({ id: `${ground}-v1`, ground, stages: tenStages }), ground).toBe(false);
        }
    });

    it('defines the immutable numbered-v1 stage order, laps, and medal-total gates', () => {
        expect(CAMPAIGN_ID).toBe('numbered-v1');
        expect(NUMBERS_STAGES.map((stage) => ({
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            unlock: stage.unlock,
        }))).toEqual([
            { raceId: 'numbered-v1-00', trackKey: 'numberZero', lapCount: 2, unlock: { type: 'start' } },
            { raceId: 'numbered-v1-01', trackKey: 'numberOne', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 1, previousRaceId: 'numbered-v1-00' } },
            { raceId: 'numbered-v1-02', trackKey: 'numberTwo', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'numbered-v1-01' } },
            { raceId: 'numbered-v1-03', trackKey: 'numberThree', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 7, previousRaceId: 'numbered-v1-02' } },
            { raceId: 'numbered-v1-04', trackKey: 'numberFour', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 10, previousRaceId: 'numbered-v1-03' } },
            { raceId: 'numbered-v1-05', trackKey: 'numberFive', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-04' } },
            { raceId: 'numbered-v1-06', trackKey: 'numberSix', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 15, previousRaceId: 'numbered-v1-05' } },
            { raceId: 'numbered-v1-07', trackKey: 'numberSeven', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 17, previousRaceId: 'numbered-v1-06' } },
            { raceId: 'numbered-v1-08', trackKey: 'numberEight', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 20, previousRaceId: 'numbered-v1-07' } },
            { raceId: 'numbered-v1-09', trackKey: 'numberNine', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 22, previousRaceId: 'numbered-v1-08' } },
            { raceId: 'numbered-v1-10', trackKey: 'imaginaryNumber', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 25, previousRaceId: 'numbered-v1-09' } },
            { raceId: 'numbered-v1-11', trackKey: 'infinitePie', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 27, previousRaceId: 'numbered-v1-10' } },
            { raceId: 'numbered-v1-12', trackKey: 'eulersNumber', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 30, previousRaceId: 'numbered-v1-11' } },
            { raceId: 'numbered-v1-13', trackKey: 'goldenRatio', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 32, previousRaceId: 'numbered-v1-12' } },
            { raceId: 'numbered-v1-14', trackKey: 'squareRoot', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 35, previousRaceId: 'numbered-v1-13' } },
            { raceId: 'numbered-v1-15', trackKey: 'halfLife', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 37, previousRaceId: 'numbered-v1-14' } },
        ]);
        expect(Object.isFrozen(NUMBERS_STAGES)).toBe(true);
        expect(Object.isFrozen(getCampaignStage('numbered-v1-03'))).toBe(true);
    });

    it('keeps every gate reachable on Gold alone and strictly rising', () => {
        const requirements = NUMBERS_STAGES.map((stage) => stage.unlock.requiredMedals ?? 0);
        expect(requirements).toEqual([0, 1, 3, 7, 10, 12, 15, 17, 20, 22, 25, 27, 30, 32, 35, 37]);
        requirements.forEach((required, index) => {
            expect(required).toBeLessThanOrEqual(index * 3);
            if (index > 0) expect(required).toBeGreaterThan(requirements[index - 1]);
        });
    });

    it('counts a stage as the medals showing in its stack', () => {
        expect(getCampaignStageMedalCount(null)).toBe(0);
        expect(getCampaignStageMedalCount('bronze')).toBe(1);
        expect(getCampaignStageMedalCount('silver')).toBe(2);
        expect(getCampaignStageMedalCount('gold')).toBe(3);
        expect(getCampaignStageMedalCount('author')).toBe(4);
        expect(getCampaignStageMedalCount('platinum')).toBe(0);

        expect(countCampaignMedals({})).toBe(0);
        expect(countCampaignMedals({
            'numbered-v1-00': { medal: 'author' },
            'numbered-v1-01': { medal: 'bronze' },
            'numbered-v1-02': { medal: null },
            'daily-2026-07-29': { medal: 'gold' },
        })).toBe(5);
    });

    it('derives unlocks from the campaign-wide medal total', () => {
        expect(getNumbersUnlockedRaceIds({})).toEqual(['numbered-v1-00']);
        expect(getNumbersUnlockedRaceIds({
            'numbered-v1-00': { medal: 'bronze' },
        })).toEqual(['numbered-v1-00', 'numbered-v1-01']);
    });

    it('opens a stage the old Gold chain would have kept shut', () => {
        expect(getNumbersUnlockedRaceIds({
            'numbered-v1-00': { medal: 'gold' },
            'numbered-v1-01': { medal: 'silver' },
            'numbered-v1-02': { medal: 'silver' },
        })).toEqual([
            'numbered-v1-00',
            'numbered-v1-01',
            'numbered-v1-02',
            'numbered-v1-03',
        ]);
    });

    it('opens one stage at a time however strong the early runs are', () => {
        for (const medal of ['gold', 'author']) {
            for (let played = 1; played < NUMBERS_STAGES.length; played += 1) {
                const results = {};
                for (const stage of NUMBERS_STAGES.slice(0, played)) {
                    results[stage.raceId] = { medal };
                }
                const unlocked = getNumbersUnlockedRaceIds(results);
                expect(unlocked).toHaveLength(played + 1);
                expect(unlocked.at(-1)).toBe(NUMBERS_STAGES[played].raceId);
            }
        }
    });

    it('holds a stage shut until the one before it has a medal', () => {
        const authorsThenNothing = {
            'numbered-v1-00': { medal: 'author' },
            'numbered-v1-01': { medal: 'author' },
            'numbered-v1-02': { medal: 'author' },
            'numbered-v1-03': { medal: 'author' },
            'numbered-v1-04': { medal: null },
        };
        expect(countCampaignMedals(authorsThenNothing)).toBe(16);
        expect(getCampaignUnlockedRaceIds(authorsThenNothing)).not.toContain('numbered-v1-05');

        const withBronze = { ...authorsThenNothing, 'numbered-v1-04': { medal: 'bronze' } };
        expect(getCampaignUnlockedRaceIds(withBronze)).toContain('numbered-v1-05');
    });

    it('lets Authors buy back the Golds the last stage would otherwise need', () => {
        const silverEverywhere = Object.fromEntries(
            NUMBERS_STAGES.slice(0, 9).map((stage) => [stage.raceId, { medal: 'silver' }]),
        );
        expect(countCampaignMedals(silverEverywhere)).toBe(18);
        expect(getCampaignUnlockedRaceIds(silverEverywhere)).not.toContain('numbered-v1-09');

        const withFourGolds = { ...silverEverywhere };
        for (const stage of NUMBERS_STAGES.slice(0, 4)) withFourGolds[stage.raceId] = { medal: 'gold' };
        expect(getCampaignUnlockedRaceIds(withFourGolds)).toContain('numbered-v1-09');

        const withTwoAuthors = { ...silverEverywhere };
        for (const stage of NUMBERS_STAGES.slice(0, 2)) withTwoAuthors[stage.raceId] = { medal: 'author' };
        expect(getCampaignUnlockedRaceIds(withTwoAuthors)).toContain('numbered-v1-09');
    });

    it('rejects malformed shared race specifications', () => {
        expect(normalizeRaceSpec({
            raceId: 'numbered-v1-00',
            mode: 'campaign',
            trackKey: 'numberZero',
            lapCount: 4,
            scoring: 'total_time',
            medalScale: 'linear_v1',
            rulesRevision: 1,
        })).toBeNull();
    });
});

describe('Campaign series data', () => {
    it('keeps the Numbers Redis key names that saved player records use', async () => {
        const { createHash } = await import('node:crypto');
        const { campaignProgressKey } = await import('../src/server/campaign/campaign-progress-key.ts');
        const { toCampaignCompetition } = await import('../src/server/competition/competition.ts');
        const playerHash = createHash('sha256').update('reddit:t2_racer', 'utf8').digest('base64url');
        expect(campaignProgressKey('reddit:t2_racer', 'numbered-v1'))
            .toBe(`campaign:numbered-v1:progress:${playerHash}`);
        expect(campaignProgressKey('reddit:t2_racer')).toBe(`campaign:numbered-v1:progress:${playerHash}`);
        const stage = getCampaignStage('numbered-v1-03');
        expect(toCampaignCompetition(stage.seriesId, stage)).toMatchObject({
            leaderboardKey: 'campaign:numbered-v1:leaderboard:numbered-v1-03',
            entryHashKey: 'campaign:numbered-v1:leaderboard:numbered-v1-03:entries',
            standingsRevisionKey: 'campaign:numbered-v1:leaderboard:numbered-v1-03:standings-revision',
            pbHashKey: 'campaign:numbered-v1:pbs:numbered-v1-03',
            guestExpiryKey: 'campaign:numbered-v1:guest-expiry',
        });
    });

    it('gives every series stage a track with all four medal times', async () => {
        const { CAMPAIGN_ALL_SERIES } = await import('../game/campaign/manifest.js');
        const { getRaceMedalThresholds } = await import('../game/medals/medal-timing.js');
        const { hasTrack } = await import('../game/track/catalog.js');
        for (const series of CAMPAIGN_ALL_SERIES) {
            for (const stage of series.stages) {
                expect(hasTrack(stage.trackKey), `${stage.raceId} track`).toBe(true);
                const thresholds = getRaceMedalThresholds(stage.trackKey, 1);
                expect(thresholds?.author, `${stage.raceId} author time`).toBeGreaterThan(0);
            }
        }
    });
});
