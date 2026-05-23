import { describe, expect, it } from 'vitest';
import {
    createRunPolicy,
    handleFinishCrossing,
    handleHardCrash
} from '../game/race/run-policy.js';

function createDailyState(overrides = {}) {
    return {
        status: 'playing',
        currentTime: 12.5,
        currentTrackKey: 'circuit',
        activeRunId: '00000000-0000-4000-8000-000000000001',
        nextCheckpointIndex: 0,
        currentChallengeRun: {
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            maxCrashes: null,
            completedLaps: 0,
            crashCount: 0,
            elapsedTime: 0,
            lastLapAt: 0
        },
        ...overrides
    };
}

describe('run-policy daily challenge parity', () => {
    it('preserves a completed daily challenge win when a crash happens in the same frame', () => {
        const state = createDailyState();
        const policy = createRunPolicy({ challengeRun: state.currentChallengeRun });

        const finishResult = handleFinishCrossing(state, policy, 0);
        const crashResult = handleHardCrash(state, policy, 0);

        expect(finishResult.winTriggered).toBe(true);
        expect(state.status).toBe('won');
        expect(crashResult).toEqual({});
    });

    it('still fails unfinished non-crash-budget daily challenges on hard crash', () => {
        const state = createDailyState({
            currentChallengeRun: {
                objectiveType: 'multi_lap_total',
                requiredLaps: 3,
                maxCrashes: null,
                completedLaps: 1,
                crashCount: 0,
                elapsedTime: 0,
                lastLapAt: 4
            }
        });
        const policy = createRunPolicy({ challengeRun: state.currentChallengeRun });

        const crashResult = handleHardCrash(state, policy, 0);

        expect(state.status).toBe('crashed');
        expect(crashResult).toEqual({
            challengeFailed: true,
            challengeFailureReason: 'Crash ended the challenge',
            crashEndedRun: true
        });
    });
});
