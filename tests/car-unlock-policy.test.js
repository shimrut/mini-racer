import { describe, expect, it } from 'vitest';
import {
    EXTRA_CAR_ASSETS,
    buildCarUnlockSnapshot,
    countCampaignUnlockMedals,
    getCarUnlockRequirementProgress,
} from '../game/car/car-unlock-policy.js';

function isUnlocked(snapshot, assetName) {
    return snapshot.unlockedAssets.includes(assetName);
}

function campaignResults(medals) {
    return Object.fromEntries(medals.map((medal, index) => [
        `race-${index + 1}`,
        { medal },
    ]));
}

describe('car unlock policy', () => {
    it('keeps unrestricted cars available and unlocks Crimson after any completed race', () => {
        const fresh = buildCarUnlockSnapshot();
        const completed = buildCarUnlockSnapshot({ completedRace: true });

        expect(isUnlocked(fresh, EXTRA_CAR_ASSETS.cobalt)).toBe(true);
        expect(isUnlocked(fresh, EXTRA_CAR_ASSETS.crimson)).toBe(false);
        expect(isUnlocked(completed, EXTRA_CAR_ASSETS.crimson)).toBe(true);
    });

    it('counts Author as Gold-or-better on the same Campaign stage', () => {
        const results = campaignResults(['author', 'author', 'author', 'author', 'author']);

        expect(countCampaignUnlockMedals(results)).toEqual({
            campaignGoldOrBetter: 5,
            campaignAuthor: 5,
        });
        const snapshot = buildCarUnlockSnapshot({ campaignResultsByRaceId: results });
        expect(isUnlocked(snapshot, EXTRA_CAR_ASSETS.gold)).toBe(true);
        expect(isUnlocked(snapshot, EXTRA_CAR_ASSETS.surge)).toBe(true);
        expect(isUnlocked(snapshot, EXTRA_CAR_ASSETS.blaze)).toBe(false);
        expect(isUnlocked(snapshot, EXTRA_CAR_ASSETS.arctic)).toBe(false);
        expect(isUnlocked(snapshot, EXTRA_CAR_ASSETS.crimson)).toBe(true);
    });

    it('unlocks Campaign cars at exactly 5 and 10 qualifying distinct stages', () => {
        const fourGold = buildCarUnlockSnapshot({
            campaignResultsByRaceId: campaignResults(Array(4).fill('gold')),
        });
        const tenGold = buildCarUnlockSnapshot({
            campaignResultsByRaceId: campaignResults(Array(10).fill('gold')),
        });
        const tenAuthor = buildCarUnlockSnapshot({
            campaignResultsByRaceId: campaignResults(Array(10).fill('author')),
        });

        expect(isUnlocked(fourGold, EXTRA_CAR_ASSETS.gold)).toBe(false);
        expect(isUnlocked(tenGold, EXTRA_CAR_ASSETS.gold)).toBe(true);
        expect(isUnlocked(tenGold, EXTRA_CAR_ASSETS.blaze)).toBe(true);
        expect(isUnlocked(tenGold, EXTRA_CAR_ASSETS.surge)).toBe(false);
        expect(isUnlocked(tenAuthor, EXTRA_CAR_ASSETS.arctic)).toBe(true);
    });

    it('counts unique Head-to-Head tracks and wins only once', () => {
        const firstPost = buildCarUnlockSnapshot({
            postedTrackKeys: ['track-a'],
        });
        const repeatedTrack = buildCarUnlockSnapshot({
            postedTrackKeys: Array(5).fill('track-a'),
        });
        const fiveTracks = buildCarUnlockSnapshot({
            postedTrackKeys: ['a', 'b', 'c', 'd', 'e'],
        });
        const firstWin = buildCarUnlockSnapshot({
            wonChallengeIds: ['challenge-a'],
        });
        const repeatedWin = buildCarUnlockSnapshot({
            wonChallengeIds: Array(10).fill('challenge-a'),
        });
        const tenWins = buildCarUnlockSnapshot({
            wonChallengeIds: Array.from({ length: 10 }, (_, index) => `challenge-${index}`),
        });

        expect(isUnlocked(firstPost, EXTRA_CAR_ASSETS.fuchsia)).toBe(true);
        expect(isUnlocked(repeatedTrack, EXTRA_CAR_ASSETS.plasma)).toBe(false);
        expect(isUnlocked(fiveTracks, EXTRA_CAR_ASSETS.plasma)).toBe(true);
        expect(isUnlocked(firstWin, EXTRA_CAR_ASSETS.lime)).toBe(true);
        expect(isUnlocked(repeatedWin, EXTRA_CAR_ASSETS.onyx)).toBe(false);
        expect(isUnlocked(tenWins, EXTRA_CAR_ASSETS.onyx)).toBe(true);
    });

    it('reports bounded progress for the Garage lock ring and requirement modal', () => {
        const snapshot = buildCarUnlockSnapshot({
            postedTrackKeys: ['a', 'b', 'c'],
        });

        expect(getCarUnlockRequirementProgress(EXTRA_CAR_ASSETS.plasma, snapshot)).toMatchObject({
            label: 'Post on 5 different tracks',
            current: 3,
            required: 5,
            ratio: 0.6,
            unlocked: false,
        });
        expect(getCarUnlockRequirementProgress(EXTRA_CAR_ASSETS.cobalt, snapshot)).toBeNull();
    });
});
