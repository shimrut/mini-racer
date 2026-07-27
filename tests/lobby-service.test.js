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

    it('selects Continue and the first unlocked stage without Gold', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { id: 'zero', unlocked: true, bestTimeMs: 24000, medal: 'Gold' },
                { id: 'one', unlocked: true, bestTimeMs: 31000, medal: 'Silver' },
                { id: 'two', unlocked: false },
            ],
        });

        expect(state.complete).toBe(false);
        expect(state.primaryLabel).toBe('Continue Campaign');
        expect(state.nextStage.id).toBe('one');
        expect(state.progressLabel).toBe('1 / 3 Gold');
    });

    it('withholds the campaign CTA until the progress it names is known', () => {
        const pending = normalizeCampaignLobbyState({
            resolved: false,
            stages: [{ id: 'zero', unlocked: true }],
        });

        // Guessing here is what made the button flash Start before Continue.
        expect(pending.resolved).toBe(false);
        expect(pending.primaryLabel).toBeNull();
        expect(pending.nextStage.id).toBe('zero');

        const resolved = normalizeCampaignLobbyState({
            stages: [{ id: 'zero', unlocked: true }],
        });
        expect(resolved.resolved).toBe(true);
        expect(resolved.primaryLabel).toBe('Start Campaign');
    });

    it('turns the campaign CTA into Complete once every stage is Gold or Author', () => {
        const state = normalizeCampaignLobbyState({
            stages: [
                { unlocked: true, medal: 'Gold' },
                { unlocked: true, medal: 'Author' },
            ],
        });

        expect(state.complete).toBe(true);
        expect(state.primaryLabel).toBe('Complete');
        expect(state.progressLabel).toBe('2 / 2 Gold');
        // Re-normalizing a painted state must not drift the label back.
        expect(normalizeCampaignLobbyState(state).primaryLabel).toBe('Complete');
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
