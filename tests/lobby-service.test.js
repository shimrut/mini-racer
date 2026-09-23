import { describe, expect, it } from 'vitest';
import {
    formatLobbyTime,
    normalizeCampaignLobbyState,
    normalizeCampaignStage,
    normalizeChallengeLobbyState,
    formatLobbyGap,
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
        expect(state.stages[3].unlockRequirementLabel).toBe('More medals to unlock');
    });

    it('points a locked row at the unmedalled stage in front of it', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'a', trackName: 'Number Five', unlocked: true, medal: 'Author' },
                { id: 'b', trackName: 'Number Six', unlocked: true, medal: null },
                {
                    id: 'c',
                    trackName: 'Number Seven',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 3, previousRaceId: 'b' },
                },
                {
                    id: 'd',
                    trackName: 'Number Eight',
                    unlocked: false,
                    unlock: { type: 'medal_total', requiredMedals: 9, previousRaceId: 'c' },
                },
            ],
        });

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
        expect(state.nextStage).toBeNull();
        expect(state.stages.some((stage) => stage.isNext)).toBe(false);
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
            trackName: 'Number Three',
            laps: 2,
            targetTimeLabel: '0:25.640',
            canAccept: true,
            statusMessage: '',
        });
        expect(guest.signedIn).toBe(false);
        expect(player.canAccept).toBe(true);
        expect(normalizeChallengeLobbyState({
            ...player,
            viewerBestTimeMs: 26_500,
        })).toMatchObject({
            viewerBestTimeMs: 26_500,
            viewerBestTimeLabel: '0:26.500',
        });
        for (const viewerBestTimeMs of [undefined, null, 0, -1, Number.NaN]) {
            expect(normalizeChallengeLobbyState({
                ...player,
                viewerBestTimeMs,
            })).toMatchObject({
                viewerBestTimeMs: null,
                viewerBestTimeLabel: null,
            });
        }
        expect(player.statusMessage).toBe('');
        expect(guest.beaten).toBe(false);
        expect(player.beaten).toBe(false);
    });

    it('closes Accept on a duel the viewer has already beaten', () => {
        const base = {
            challengerName: 'RaceFan',
            trackName: 'Number Three',
            laps: 2,
            targetTimeMs: 25640,
            signedIn: true,
            canRace: true,
        };

        const beaten = normalizeChallengeLobbyState({
            ...base,
            outcome: 'won',
            bestTimeMs: 25168,
        });
        expect(beaten).toMatchObject({
            beaten: true,
            canAccept: false,
            available: true,
            canRace: true,
            targetTimeLabel: '0:25.640',
            gapMs: -472,
            winMarginLabel: '0.472',
        });

        expect(normalizeChallengeLobbyState({ ...base, outcome: 'won' })).toMatchObject({
            beaten: true,
            gapMs: null,
            winMarginLabel: null,
        });

        for (const outcome of ['lost', 'tie', null, undefined]) {
            const state = normalizeChallengeLobbyState({ ...base, outcome, bestTimeMs: 26000 });
            expect(state.beaten).toBe(false);
            expect(state.canAccept).toBe(true);
            expect(state.winMarginLabel).toBeNull();
        }
    });

    it('signs a race gap the way a timing screen does', () => {
        expect(formatLobbyGap(-472)).toBe('−0.472');
        expect(formatLobbyGap(-12_451)).toBe('−12.451');
        expect(formatLobbyGap(1_204)).toBe('+1.204');
        expect(formatLobbyGap(0)).toBe('+0.000');
        expect(formatLobbyGap(null)).toBeNull();
        expect(formatLobbyGap('nope')).toBeNull();
    });
});
