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
            modeKey: 'daily',
            isDaily: true,
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            maxCrashes: null,
            bestResultComparator: 'time'
        });
    });

    it('normalizes daily challenge policy values for product rules', () => {
        expect(createRunPolicy({
            challengeRun: {}
        })).toMatchObject({
            id: 'daily:single_lap_fastest',
            modeKey: 'daily',
            isDaily: true,
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            maxCrashes: null,
            bestResultComparator: 'time'
        });

        expect(createRunPolicy({
            challengeRun: {
                objectiveType: 'multi_lap_total',
                requiredLaps: 2.8
            }
        })).toMatchObject({
            id: 'daily:multi_lap_total',
            isDaily: true,
            requiredLaps: 2,
            bestResultComparator: 'time'
        });

        expect(createRunPolicy({
            challengeRun: {
                objectiveType: 'finish_with_crash_budget',
                requiredLaps: 0,
                maxCrashes: 3
            }
        })).toMatchObject({
            id: 'daily:finish_with_crash_budget',
            isDaily: true,
            requiredLaps: 1,
            maxCrashes: 3,
            bestResultComparator: 'laps-then-time'
        });
    });

    it('resolves an explicit policy or derives daily from state', () => {
        const explicitPolicy = createRunPolicy({ challengeRun: { objectiveType: 'single_lap_fastest' } });
        expect(resolveRunPolicy({ currentRunPolicy: explicitPolicy })).toBe(explicitPolicy);
        expect(resolveRunPolicy()).toMatchObject({
            id: 'daily:single_lap_fastest',
            isDaily: true
        });
        expect(resolveRunPolicy({
            currentModeKey: 'daily'
        })).toMatchObject({
            id: 'daily:single_lap_fastest',
            isDaily: true
        });
        expect(resolveRunPolicy({
            currentChallengeRun: {
                objectiveType: 'finish_with_crash_budget',
                maxCrashes: 2
            }
        })).toMatchObject({
            id: 'daily:finish_with_crash_budget',
            isDaily: true,
            maxCrashes: 2
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
            crashCount: 2,
            lapTime: 40
        });
        expect(state.status).toBe('won');
    });

    it('accumulates crash-budget finish crossings without ending early', () => {
        const challengeRun = {
            objectiveType: 'finish_with_crash_budget',
            requiredLaps: 3,
            maxCrashes: null,
            completedLaps: 1,
            crashCount: 0,
            elapsedTime: 4
        };
        const policy = createRunPolicy({ challengeRun });
        const state = createPolicyState({ currentChallengeRun: challengeRun, currentTime: 5 });

        const events = handleFinishCrossing(state, policy, 4);

        expect(events).toEqual({
            challengeLapCompleted: true,
            challengeCompletedLapTime: 5,
            challengeProgressLaps: 2
        });
        expect(challengeRun.elapsedTime).toBe(9);
        expect(challengeRun.completedLaps).toBe(2);
        expect(state.currentTime).toBe(0);
        expect(state.status).toBe('playing');
    });

    it('keeps crash-budget daily runs alive until the terminal crash', () => {
        const challengeRun = {
            objectiveType: 'finish_with_crash_budget',
            requiredLaps: 1,
            maxCrashes: 2,
            completedLaps: 1,
            crashCount: 0,
            elapsedTime: 15
        };
        const policy = createRunPolicy({ challengeRun });
        const state = createPolicyState({ currentChallengeRun: challengeRun, currentTime: 8 });

        const firstCrash = handleHardCrash(state, policy, 4);
        expect(firstCrash).toEqual({
            challengeCrashReset: true,
            challengeCrashCount: 1
        });
        expect(state.status).toBe('playing');
        expect(state.currentTime).toBe(0);

        state.currentTime = 7;
        const terminalCrash = handleHardCrash(state, policy, 4);
        expect(terminalCrash.winTriggered).toBe(true);
        expect(terminalCrash.challengeCrashCount).toBe(2);
        expect(terminalCrash.winData).toMatchObject({
            completedLaps: 1,
            crashCount: 2,
            challengeEndedOnCrash: true,
            lapTime: 30
        });
        expect(state.status).toBe('won');
    });

    it('keeps unlimited crash-budget runs alive after a crash', () => {
        const challengeRun = {
            objectiveType: 'finish_with_crash_budget',
            requiredLaps: 1,
            maxCrashes: null,
            completedLaps: 1,
            crashCount: 0,
            elapsedTime: 2
        };
        const policy = createRunPolicy({ challengeRun });
        const state = createPolicyState({ currentChallengeRun: challengeRun, currentTime: 3 });

        const events = handleHardCrash(state, policy, 4);

        expect(events).toEqual({
            challengeCrashReset: true,
            challengeCrashCount: 1
        });
        expect(challengeRun.elapsedTime).toBe(5);
        expect(state.currentTime).toBe(0);
        expect(state.status).toBe('playing');
    });

    it('requires both daily policy and active challenge state for daily handling', () => {
        const challengeRun = {
            objectiveType: 'finish_with_crash_budget',
            requiredLaps: 1,
            maxCrashes: 1,
            completedLaps: 0,
            crashCount: 0,
            elapsedTime: 0
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
