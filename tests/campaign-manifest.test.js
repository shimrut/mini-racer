import { describe, expect, it } from 'vitest';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    getCampaignStage,
    getCampaignUnlockedRaceIds,
} from '../game/campaign/manifest.js';
import { normalizeRaceSpec } from '../game/race/race-spec.js';

describe('Campaign manifest', () => {
    it('defines the immutable numbered-v1 stage order, laps, and Gold gates', () => {
        expect(CAMPAIGN_ID).toBe('numbered-v1');
        expect(CAMPAIGN_STAGES.map((stage) => ({
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            unlock: stage.unlock,
        }))).toEqual([
            { raceId: 'numbered-v1-00', trackKey: 'numberZero', lapCount: 1, unlock: { type: 'start' } },
            { raceId: 'numbered-v1-01', trackKey: 'numberOne', lapCount: 1, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-00', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-02', trackKey: 'numberTwo', lapCount: 1, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-01', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-03', trackKey: 'numberThree', lapCount: 2, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-02', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-04', trackKey: 'numberFour', lapCount: 2, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-03', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-05', trackKey: 'numberFive', lapCount: 2, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-04', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-06', trackKey: 'numberSix', lapCount: 3, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-05', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-07', trackKey: 'numberSeven', lapCount: 3, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-06', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-08', trackKey: 'numberEight', lapCount: 3, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-07', minimumMedal: 'gold' } },
            { raceId: 'numbered-v1-09', trackKey: 'numberNine', lapCount: 3, unlock: { type: 'medal_on_race', raceId: 'numbered-v1-08', minimumMedal: 'gold' } },
        ]);
        expect(Object.isFrozen(CAMPAIGN_STAGES)).toBe(true);
        expect(Object.isFrozen(getCampaignStage('numbered-v1-03'))).toBe(true);
    });

    it('derives unlocks only from Gold or Author on the prerequisite race', () => {
        expect(getCampaignUnlockedRaceIds({})).toEqual(['numbered-v1-00']);
        expect(getCampaignUnlockedRaceIds({
            'numbered-v1-00': { medal: 'silver' },
        })).toEqual(['numbered-v1-00']);
        expect(getCampaignUnlockedRaceIds({
            'numbered-v1-00': { medal: 'gold' },
            'numbered-v1-01': { medal: 'author' },
        })).toEqual(['numbered-v1-00', 'numbered-v1-01', 'numbered-v1-02']);
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
