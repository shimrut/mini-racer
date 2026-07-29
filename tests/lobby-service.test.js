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

    it('turns a stage short of Gold into the time it still needs', () => {
        // numberFive: gold 15.28s a lap, so a two-lap stage wants 0:30.560.
        const stage = normalizeCampaignStage({
            trackKey: 'numberFive',
            laps: 2,
            unlocked: true,
            bestTimeMs: 30831,
            medal: 'Silver',
        }, 5);

        expect(stage.goldTargetMs).toBe(30560);
        expect(stage.goldTargetLabel).toBe('0:30.560');
        expect(stage.needsGold).toBe(true);
        expect(stage.goldGapLabel).toBe('+0.271');
    });

    it('drops the Gold goal once the stage is cleared, locked, or untimed', () => {
        const cleared = normalizeCampaignStage({
            trackKey: 'numberFive', laps: 2, unlocked: true, bestTimeMs: 30100, medal: 'Gold',
        }, 5);
        const author = normalizeCampaignStage({
            trackKey: 'numberZero', laps: 1, unlocked: true, bestTimeMs: 6879, medal: 'Author',
        }, 0);
        const locked = normalizeCampaignStage({
            trackKey: 'numberSix', laps: 3, unlocked: false,
        }, 6);
        const untimed = normalizeCampaignStage({
            trackKey: 'numberOne', laps: 1, unlocked: true,
        }, 1);

        expect(cleared.needsGold).toBe(false);
        expect(author.needsGold).toBe(false);
        expect(locked.needsGold).toBe(false);
        // No run yet: the target still stands, there is just no gap to quote.
        expect(untimed.needsGold).toBe(true);
        expect(untimed.goldTargetLabel).toBe('0:09.520');
        expect(untimed.goldGapLabel).toBeNull();

        // Gold banked is not the end of the stage: Author becomes the target.
        expect(cleared).toMatchObject({
            needsAuthor: true,
            authorTargetLabel: '0:30.100',
            authorGapLabel: null,
        });
        // Author earned, and locked stages, have nothing left to chase.
        expect(author.needsAuthor).toBe(false);
        expect(locked.needsAuthor).toBe(false);
    });

    it('names the stage a locked row is waiting on', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'a', trackName: 'Number Five', unlocked: true, medal: 'Silver' },
                {
                    id: 'b',
                    trackName: 'Number Six',
                    unlocked: false,
                    unlock: { type: 'medal_on_race', raceId: 'a', minimumMedal: 'gold' },
                },
                { id: 'c', trackName: 'Number Seven', unlocked: false },
            ],
        });

        expect(state.stages[0].unlockRequirementLabel).toBeNull();
        expect(state.stages[1].unlockRequirementLabel).toBe('Gold on Number Five to unlock');
        // No unlock metadata: the stage above it is still the honest answer.
        expect(state.stages[2].unlockRequirementLabel).toBe('Gold on Number Six to unlock');
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

    it('blocks guests from accepting a player challenge', () => {
        const guest = normalizeChallengeLobbyState({
            challengerName: 'RaceFan',
            trackName: 'Number Three',
            laps: 2,
            targetTimeMs: 25640,
            medal: 'Gold',
            signedIn: false,
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
            opponentLabel: 'u/RaceFan challenges you',
            trackLabel: 'Number Three · 2 laps',
            targetTimeLabel: '0:25.640',
            canAccept: false,
            statusMessage: 'Sign in to accept this challenge.',
        });
        expect(player.canAccept).toBe(true);
        expect(player.statusMessage).toBe('');
    });
});
