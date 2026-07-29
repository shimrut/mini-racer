import { describe, expect, it } from 'vitest';
import {
    CAMPAIGN_ID,
    CAMPAIGN_STAGES,
    countCampaignMedals,
    getCampaignStage,
    getCampaignStageMedalCount,
    getCampaignUnlockedRaceIds,
} from '../game/campaign/manifest.js';
import { normalizeRaceSpec } from '../game/race/race-spec.js';

describe('Campaign manifest', () => {
    it('defines the immutable numbered-v1 stage order, laps, and medal-total gates', () => {
        expect(CAMPAIGN_ID).toBe('numbered-v1');
        expect(CAMPAIGN_STAGES.map((stage) => ({
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            unlock: stage.unlock,
        }))).toEqual([
            { raceId: 'numbered-v1-00', trackKey: 'numberZero', lapCount: 1, unlock: { type: 'start' } },
            { raceId: 'numbered-v1-01', trackKey: 'numberOne', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 1, previousRaceId: 'numbered-v1-00' } },
            { raceId: 'numbered-v1-02', trackKey: 'numberTwo', lapCount: 1, unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'numbered-v1-01' } },
            { raceId: 'numbered-v1-03', trackKey: 'numberThree', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 7, previousRaceId: 'numbered-v1-02' } },
            { raceId: 'numbered-v1-04', trackKey: 'numberFour', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 10, previousRaceId: 'numbered-v1-03' } },
            { raceId: 'numbered-v1-05', trackKey: 'numberFive', lapCount: 2, unlock: { type: 'medal_total', requiredMedals: 12, previousRaceId: 'numbered-v1-04' } },
            { raceId: 'numbered-v1-06', trackKey: 'numberSix', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 15, previousRaceId: 'numbered-v1-05' } },
            { raceId: 'numbered-v1-07', trackKey: 'numberSeven', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 17, previousRaceId: 'numbered-v1-06' } },
            { raceId: 'numbered-v1-08', trackKey: 'numberEight', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 20, previousRaceId: 'numbered-v1-07' } },
            { raceId: 'numbered-v1-09', trackKey: 'numberNine', lapCount: 3, unlock: { type: 'medal_total', requiredMedals: 22, previousRaceId: 'numbered-v1-08' } },
        ]);
        expect(Object.isFrozen(CAMPAIGN_STAGES)).toBe(true);
        expect(Object.isFrozen(getCampaignStage('numbered-v1-03'))).toBe(true);
    });

    /**
     * The curve is a balance decision, not an implementation detail: every gate
     * has to stay clearable without a single Author, and has to keep asking for
     * more than the one before it or a stage would open for free.
     */
    it('keeps every gate reachable on Gold alone and strictly rising', () => {
        const requirements = CAMPAIGN_STAGES.map((stage) => stage.unlock.requiredMedals ?? 0);
        expect(requirements).toEqual([0, 1, 3, 7, 10, 12, 15, 17, 20, 22]);
        requirements.forEach((required, index) => {
            // Gold on every stage before this one, the best a player can do
            // without ever touching an Author time.
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
            // A finished stage that earned nothing is worth nothing, and a race
            // outside the campaign is not part of this total at all.
            'numbered-v1-02': { medal: null },
            'daily-2026-07-29': { medal: 'gold' },
        })).toBe(5);
    });

    it('derives unlocks from the campaign-wide medal total', () => {
        expect(getCampaignUnlockedRaceIds({})).toEqual(['numbered-v1-00']);
        expect(getCampaignUnlockedRaceIds({
            'numbered-v1-00': { medal: 'bronze' },
        })).toEqual(['numbered-v1-00', 'numbered-v1-01']);
    });

    /**
     * The point of the total: strength on one stage pays for weakness on
     * another. Silver on stage 01 would have been a dead end under the old
     * chain — here it still opens stage 03 because the other two carried it.
     */
    it('opens a stage the old Gold chain would have kept shut', () => {
        expect(getCampaignUnlockedRaceIds({
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

    /**
     * Medals spend against every gate at once, so a total on its own would let a
     * strong early run open stages the player has never driven: six Authors is
     * 24 medals, past the price of stages 06 through 09 together. The medal on
     * the stage before is what holds the ladder to one rung at a time.
     */
    it('opens one stage at a time however strong the early runs are', () => {
        for (const medal of ['gold', 'author']) {
            for (let played = 1; played <= 9; played += 1) {
                const results = {};
                for (const stage of CAMPAIGN_STAGES.slice(0, played)) {
                    results[stage.raceId] = { medal };
                }
                const unlocked = getCampaignUnlockedRaceIds(results);
                // Everything played, plus exactly one stage past it.
                expect(unlocked).toHaveLength(played + 1);
                expect(unlocked.at(-1)).toBe(CAMPAIGN_STAGES[played].raceId);
            }
        }
    });

    it('holds a stage shut until the one before it has a medal', () => {
        const authorsThenNothing = {
            'numbered-v1-00': { medal: 'author' },
            'numbered-v1-01': { medal: 'author' },
            'numbered-v1-02': { medal: 'author' },
            'numbered-v1-03': { medal: 'author' },
            // Driven and banked, but too slow for even a Bronze.
            'numbered-v1-04': { medal: null },
        };
        // 16 medals is well past stage 05's price of 12 — the empty stage 04 is
        // the only thing in the way.
        expect(countCampaignMedals(authorsThenNothing)).toBe(16);
        expect(getCampaignUnlockedRaceIds(authorsThenNothing)).not.toContain('numbered-v1-05');

        const withBronze = { ...authorsThenNothing, 'numbered-v1-04': { medal: 'bronze' } };
        expect(getCampaignUnlockedRaceIds(withBronze)).toContain('numbered-v1-05');
    });

    it('lets Authors buy back the Golds the last stage would otherwise need', () => {
        const silverEverywhere = Object.fromEntries(
            CAMPAIGN_STAGES.slice(0, 9).map((stage) => [stage.raceId, { medal: 'silver' }]),
        );
        // Silver on all nine earlier stages is 18 medals — four short of stage 09.
        expect(countCampaignMedals(silverEverywhere)).toBe(18);
        expect(getCampaignUnlockedRaceIds(silverEverywhere)).not.toContain('numbered-v1-09');

        const withFourGolds = { ...silverEverywhere };
        for (const stage of CAMPAIGN_STAGES.slice(0, 4)) withFourGolds[stage.raceId] = { medal: 'gold' };
        expect(getCampaignUnlockedRaceIds(withFourGolds)).toContain('numbered-v1-09');

        // Two Authors are worth those four Golds: each is two medals past Silver.
        const withTwoAuthors = { ...silverEverywhere };
        for (const stage of CAMPAIGN_STAGES.slice(0, 2)) withTwoAuthors[stage.raceId] = { medal: 'author' };
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
