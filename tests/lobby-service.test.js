import { describe, expect, it } from 'vitest';
import {
    formatLobbyTime,
    normalizeCampaignLobbyState,
    normalizeCampaignStage,
    normalizeChallengeLobbyState,
} from '../game/lobby/service.js';

describe('lobby service', () => {
    it('formats verified millisecond times without losing precision', () => {
        expect(formatLobbyTime(25640)).toBe('0:25.640');
        expect(formatLobbyTime(125678)).toBe('2:05.678');
        expect(formatLobbyTime(null)).toBe('--:--.---');
        expect(formatLobbyTime(-1)).toBe('--:--.---');
    });

    it('normalizes the immutable numbered stage defaults', () => {
        expect(normalizeCampaignStage({}, 0)).toMatchObject({
            id: 'numbered-v1-0',
            numberLabel: '00',
            trackName: 'Number Zero',
            laps: 1,
            unlocked: true,
            bestTimeLabel: 'No time',
        });
        expect(normalizeCampaignStage({}, 6)).toMatchObject({
            id: 'numbered-v1-6',
            numberLabel: '06',
            trackName: 'Number Six',
            laps: 3,
            unlocked: false,
        });
    });

    /**
     * A normalized stage carried a Gold and an Author target, a flag for each,
     * and the gap to both — all of it to feed one row on the card that no longer
     * exists. What a stage still owes is the medal stack, which needs none of it.
     */
    it('carries no medal target times on a stage', () => {
        const stage = normalizeCampaignStage({
            trackKey: 'numberFive',
            laps: 2,
            unlocked: true,
            bestTimeMs: 30831,
            medal: 'Silver',
        }, 5);

        expect(stage).toMatchObject({ medal: 'Silver', bestTimeLabel: '0:30.831' });
        for (const key of [
            'goldTargetMs', 'goldTargetLabel', 'needsGold', 'goldGapLabel',
            'authorTargetMs', 'authorTargetLabel', 'needsAuthor', 'authorGapLabel',
        ]) {
            expect(stage).not.toHaveProperty(key);
        }
    });

    it('prices a locked row against the medals the player has banked', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                // Author and Silver: four medals plus two.
                { id: 'a', trackName: 'Number Five', unlocked: true, medal: 'Author' },
                { id: 'b', trackName: 'Number Six', unlocked: true, medal: 'Silver' },
                {
                    id: 'c',
                    trackName: 'Number Seven',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 10, previousRaceId: 'b' },
                },
                { id: 'd', trackName: 'Number Eight', unlocked: false },
            ],
        });

        expect(state.stages[0].unlockRequirementLabel).toBeNull();
        expect(state.stages[1].unlockRequirementLabel).toBeNull();
        // The stage before it is medalled, so the total is what is left to do.
        expect(state.stages[2].unlockRequirementLabel).toBe('4 more medals needed');
        expect(state.stages[2].unlockRequirements).toEqual([
            {
                id: 'previous-medal',
                copy: 'Medal earned on Number Six',
                satisfied: true,
            },
            {
                id: 'medal-total',
                copy: 'Additional medals needed',
                satisfied: false,
                medalTotal: 6,
                requiredMedals: 10,
                remainingMedals: 4,
            },
        ]);
        // No unlock metadata, and the row above it is locked too: say it needs
        // more without inventing a number or pointing at an unreachable track.
        expect(state.stages[3].unlockRequirementLabel).toBe('More medals to unlock');
    });

    it('points a locked row at the unmedalled stage in front of it', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'a', trackName: 'Number Five', unlocked: true, medal: 'Author' },
                // Raced, banked, but nothing earned — one run from fixing.
                { id: 'b', trackName: 'Number Six', unlocked: true, medal: null },
                {
                    id: 'c',
                    trackName: 'Number Seven',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'b' },
                },
                // Two rows out: naming Number Seven would point at a track that
                // cannot be raced yet, so this one quotes the total.
                {
                    id: 'd',
                    trackName: 'Number Eight',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 9, previousRaceId: 'c' },
                },
            ],
        });

        // Four medals already clears the price of 3, so naming the total would
        // read as though nothing were owed.
        expect(state.stages[2].unlockRequirementLabel).toBe('Earn any medal on Number Six');
        expect(state.stages[3].unlockRequirementLabel).toBe('5 more medals needed');
        expect(state.stages[2].unlockRequirements).toEqual([
            {
                id: 'previous-medal',
                copy: 'Earn any medal on Number Six',
                satisfied: false,
            },
            {
                id: 'medal-total',
                copy: 'Medal total reached',
                satisfied: true,
                medalTotal: 4,
                requiredMedals: 3,
                remainingMedals: 0,
            },
        ]);
    });

    it('uses singular copy when exactly one medal remains', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'a', trackName: 'Number Five', unlocked: true, medal: 'Author' },
                { id: 'b', trackName: 'Number Six', unlocked: true, medal: 'Author' },
                { id: 'c', trackName: 'Number Seven', unlocked: true, medal: 'Bronze' },
                {
                    id: 'd',
                    trackName: 'Number Eight',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 10, previousRaceId: 'c' },
                },
            ],
        });

        expect(state.stages[3].unlockRequirementLabel).toBe('One more medal needed');
    });

    it('flags exactly one stage as the one to race next', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'zero', unlocked: true, medal: 'Gold' },
                { id: 'one', unlocked: true, medal: 'Silver' },
                { id: 'two', unlocked: false },
            ],
        });

        expect(state.stages.filter((stage) => stage.isNext)).toHaveLength(1);
        expect(state.stages[1].isNext).toBe(true);
        expect(state.nextStage.id).toBe('one');
        // Re-normalizing a painted state must not leave two stages claiming it.
        expect(normalizeCampaignLobbyState(state).stages.filter((s) => s.isNext)).toHaveLength(1);
    });

    it('selects the first unlocked stage without Gold', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'zero', unlocked: true, bestTimeMs: 24000, medal: 'Gold' },
                { id: 'one', unlocked: true, bestTimeMs: 31000, medal: 'Silver' },
                { id: 'two', unlocked: false },
            ],
        });

        expect(state.complete).toBe(false);
        expect(state.primaryLabel).toBe('Start Race');
        expect(state.nextStage.id).toBe('one');
        expect(state.progressLabel).toBe('1 / 3 Gold');
    });

    it('withholds the campaign CTA until the unlock state it reports is known', () => {
        const pending = normalizeCampaignLobbyState({
            resolved: false,
            stages: [{ id: 'zero', unlocked: true }],
        });

        // Guessing here is what made the button flash before the real state.
        expect(pending.resolved).toBe(false);
        expect(pending.primaryLabel).toBeNull();
        expect(pending.nextStage.id).toBe('zero');

        const resolved = normalizeCampaignLobbyState({
            stages: [{ id: 'zero', unlocked: true }],
        });
        expect(resolved.resolved).toBe(true);
        expect(resolved.primaryLabel).toBe('Start Race');
    });

    it('keeps the campaign CTA on Start Race once every stage is Gold or Author', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { unlocked: true, medal: 'Gold' },
                { unlocked: true, medal: 'Author' },
            ],
        });

        expect(state.complete).toBe(true);
        // A finished campaign is asking for nothing, so no stage may claim to be
        // the live one — that is what made Stage 00 look re-activated.
        expect(state.nextStage).toBeNull();
        expect(state.stages.some((stage) => stage.isNext)).toBe(false);
        // Finishing the campaign does not stop any of its stages being raceable.
        expect(state.primaryLabel).toBe('Start Race');
        expect(state.progressLabel).toBe('2 / 2 Gold');
        expect(normalizeCampaignLobbyState(state).primaryLabel).toBe('Start Race');
    });

    it('allows an authorized guest to accept a player challenge', () => {
        const guest = normalizeChallengeLobbyState({
            challengerName: 'RaceFan',
            trackName: 'Number Three',
            laps: 2,
            targetTimeMs: 25640,
            medal: 'Gold',
            signedIn: false,
            canRace: true,
        });
        const player = normalizeChallengeLobbyState({
            challengerName: 'u/RaceFan',
            trackName: 'Number Three',
            laps: 2,
            targetTimeMs: 25640,
            signedIn: true,
        });

        expect(guest).toMatchObject({
            challengerName: 'u/RaceFan',
            trackLabel: 'Number Three · 2 laps',
            targetTimeLabel: '0:25.640',
            canAccept: true,
            statusMessage: '',
        });
        expect(guest.signedIn).toBe(false);
        expect(player.canAccept).toBe(true);
        expect(player.statusMessage).toBe('');
    });
});
