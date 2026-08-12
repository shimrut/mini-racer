import { describe, expect, it } from 'vitest';
import {
    createRunPolicy,
    handleFinishCrossing,
    handleHardCrash
} from '../game/race/run-policy.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';

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
            completedLaps: 0,
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

    it('still fails unfinished daily challenges on hard crash', () => {
        const state = createDailyState({
            currentChallengeRun: {
                objectiveType: 'multi_lap_total',
                requiredLaps: 3,
                completedLaps: 1,
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

    it('records the finish time on the first lap only after a collision restart', () => {
        const state = {
            status: 'playing',
            currentTime: 40,
            currentTrackKey: 'circuit',
            activeRunId: '00000000-0000-4000-8000-000000000001',
            nextCheckpointIndex: 0,
            currentChallengeRun: {
                objectiveType: 'multi_lap_total',
                requiredLaps: 2,
                completedLaps: 1,
                lastLapAt: 20,
            },
        };
        const policy = createRunPolicy({
            challengeRun: state.currentChallengeRun,
            mode: 'campaign',
        });

        raceEngineMethods.resetChallengeRunAfterCollisionRestart.call(state);
        state.currentTime = 0;

        const finishResult = handleFinishCrossing(state, policy, 0, 18);

        expect(finishResult.winTriggered).toBeUndefined();
        expect(state.status).toBe('playing');
        expect(state.currentChallengeRun.completedLaps).toBe(1);
    });
});
