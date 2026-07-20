import { describe, expect, it } from 'vitest';
import {
    createRunPolicy,
    handleFinishCrossing,
    handleHardCrash,
    resolveRunPolicy
} from '../game/race/run-policy.js';

function createPolicyState(overrides = {}) {
    return {
        status: 'playing',
        currentTime: 12,
        currentTrackKey: 'circuit',
        activeRunId: '00000000-0000-4000-8000-000000000001',
        nextCheckpointIndex: 2,
        currentChallengeRun: null,
        ...overrides
    };
}

describe('run-policy contracts', () => {
    it('returns a stable daily policy shape', () => {
        expect(createRunPolicy()).toEqual({
            id: 'daily:single_lap_fastest',
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1
        });
    });

    it('normalizes daily challenge policy values for product rules', () => {
        expect(createRunPolicy({
            challengeRun: {}
        })).toMatchObject({
            id: 'daily:single_lap_fastest',
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1
        });

        expect(createRunPolicy({
            challengeRun: {
                objectiveType: 'multi_lap_total',
                requiredLaps: 2.8
            }
        })).toMatchObject({
            id: 'daily:multi_lap_total',
            requiredLaps: 2
        });

    });

    it('resolves an explicit policy or derives daily from state', () => {
        const explicitPolicy = createRunPolicy({ challengeRun: { objectiveType: 'single_lap_fastest' } });
        expect(resolveRunPolicy({ currentRunPolicy: explicitPolicy })).toBe(explicitPolicy);
        expect(resolveRunPolicy()).toMatchObject({
            id: 'daily:single_lap_fastest'
        });
        expect(resolveRunPolicy({
            currentModeKey: 'daily'
        })).toMatchObject({
            id: 'daily:single_lap_fastest'
        });
    });

    it('non-daily finish crossing records a win', () => {
        const state = createPolicyState({ currentTime: 21.5 });
        const events = handleFinishCrossing(
            state,
            createRunPolicy(),
            4
        );

        expect(events).toEqual({
            winTriggered: true,
            challengeLapCompleted: true,
            challengeCompletedLapTime: 21.5,
            challengeProgressLaps: 1,
            winData: expect.objectContaining({
                lapTime: 21.5,
                trackKey: 'circuit',
                checkpointCount: 4,
                completedCheckpointCount: 2
            })
        });
        expect(state.status).toBe('won');
    });

    it('records interpolated crossing time for win and lap deltas', () => {
        const challengeRun = {
            objectiveType: 'multi_lap_total',
            requiredLaps: 2,
            completedLaps: 0,
            lastLapAt: 10.1
        };
        const policy = createRunPolicy({ challengeRun });
        const state = createPolicyState({ currentChallengeRun: challengeRun, currentTime: 18 });

        const firstLap = handleFinishCrossing(state, policy, 4, 17.85);
        expect(firstLap.challengeLapCompleted).toBe(true);
        expect(firstLap.challengeCompletedLapTime).toBeCloseTo(7.75);
        expect(firstLap.challengeProgressLaps).toBe(1);
        expect(firstLap.winTriggered).toBeUndefined();
        expect(challengeRun.lastLapAt).toBe(17.85);
        expect(state.status).toBe('playing');

        state.currentTime = 40;
        const secondLap = handleFinishCrossing(state, policy, 4, 39.42);
        expect(secondLap.winTriggered).toBe(true);
        expect(secondLap.winData).toMatchObject({
            completedLaps: 2,
            lapTime: 39.42
        });
        expect(secondLap.challengeCompletedLapTime).toBeCloseTo(21.57);
        expect(state.status).toBe('won');
    });

    it('only completes multi-lap daily challenges after the required lap count', () => {
        const challengeRun = {
            objectiveType: 'multi_lap_total',
            requiredLaps: 2,
            completedLaps: 0,
            crashCount: 2,
            lastLapAt: 10
        };
        const policy = createRunPolicy({ challengeRun });
        const state = createPolicyState({ currentChallengeRun: challengeRun, currentTime: 18 });

        const firstLap = handleFinishCrossing(state, policy, 4);
        expect(firstLap).toMatchObject({
            challengeLapCompleted: true,
            challengeCompletedLapTime: 8,
            challengeProgressLaps: 1
        });
        expect(firstLap.winTriggered).toBeUndefined();
        expect(challengeRun.lastLapAt).toBe(18);
        expect(state.status).toBe('playing');

        state.currentTime = 40;
        const secondLap = handleFinishCrossing(state, policy, 4);
        expect(secondLap.winTriggered).toBe(true);
        expect(secondLap.winData).toMatchObject({
            completedLaps: 2,
            lapTime: 40
        });
        expect(state.status).toBe('won');
    });

    it('requires both daily policy and active challenge state for daily handling', () => {
        const challengeRun = {
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            completedLaps: 0,
        };
        const regularPolicy = createRunPolicy();
        const stateWithChallenge = createPolicyState({
            currentChallengeRun: challengeRun,
            currentTime: 6
        });

        const regularFinish = handleFinishCrossing(stateWithChallenge, regularPolicy, 4);
        expect(regularFinish.winTriggered).toBe(true);
        expect(regularFinish.winData.completedLaps).toBe(1);

        const crashState = createPolicyState({
            currentChallengeRun: challengeRun,
            currentTime: 6
        });
        expect(handleHardCrash(crashState, regularPolicy, 4)).toEqual({
            challengeFailed: true,
            challengeFailureReason: 'Crash ended the challenge',
            crashEndedRun: true
        });
        expect(crashState.status).toBe('crashed');

        const dailyPolicy = createRunPolicy({ challengeRun });
        const stateWithoutChallenge = createPolicyState({
            currentChallengeRun: null,
            currentTime: 6
        });
        expect(handleHardCrash(stateWithoutChallenge, dailyPolicy, 4)).toEqual({
            crashEndedRun: true
        });
        expect(stateWithoutChallenge.status).toBe('crashed');
    });
});
