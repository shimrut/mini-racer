import { describe, it, expect } from 'vitest';
import { updateSimulation } from '../game/race/simulation.js';
import { CONFIG } from '../game/config.js';
import { createTestSimState, TEST_TRACK } from './helpers/sim-state.js';

/** Vertical wall at x = 5; movement from left to right crosses it between 4.x and 5.x. */
const WALL_X5 = [
    {
        start: { x: 5, y: -200 },
        end: { x: 5, y: 200 },
        dx: 0,
        dy: 400,
        lenSq: 160000
    }
];

function crossFinishOnce(state) {
    state.pos = { x: 5, y: -0.01 };
    state.velocity = { x: 0, y: 50 };
    state.angle = Math.PI / 2;
    state.nextCheckpointIndex = 0;
    return updateSimulation(state, 1 / 60, CONFIG, TEST_TRACK, []);
}

describe('updateSimulation — daily challenge laps', () => {
    it('does not complete a lap before 2s elapsed', () => {
        const challengeRun = {
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            completedLaps: 0,
            lastLapAt: 0,
        };
        const state = createTestSimState({
            currentTime: 0,
            currentChallengeRun: challengeRun
        });

        const events = crossFinishOnce(state);
        expect(state.currentTime).toBeLessThan(2);
        expect(events.winTriggered).toBe(false);
        expect(events.challengeLapCompleted).toBe(false);
    });

    it('registers a single-lap daily win with total time', () => {
        const challengeRun = {
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            completedLaps: 0,
            lastLapAt: 0,
        };
        const state = createTestSimState({
            currentTime: 1.99,
            currentChallengeRun: challengeRun
        });

        const events = crossFinishOnce(state);
        expect(events.winTriggered).toBe(true);
        expect(events.winData.lapTime).toBe(state.currentTime);
        expect(events.winData.completedLaps).toBe(1);
        expect(state.status).toBe('won');
    });

    it('requires multiple crossings for multi-lap total', () => {
        const challengeRun = {
            objectiveType: 'multi_lap_total',
            requiredLaps: 2,
            completedLaps: 0,
            lastLapAt: 0,
        };
        const state = createTestSimState({
            currentTime: 1.99,
            currentChallengeRun: challengeRun
        });

        const first = crossFinishOnce(state);
        expect(first.challengeLapCompleted).toBe(true);
        expect(first.winTriggered).toBe(false);
        expect(state.currentChallengeRun.completedLaps).toBe(1);

        const tAfterFirst = state.currentTime;
        const second = crossFinishOnce(state);
        expect(second.winTriggered).toBe(true);
        expect(second.winData.lapTime).toBe(state.currentTime);
        expect(second.winData.lapTime).toBeGreaterThan(tAfterFirst);
    });
});

describe('updateSimulation — daily challenge crashes', () => {
    it('fails non-budget daily on hard crash', () => {
        const challengeRun = {
            objectiveType: 'single_lap_fastest',
            requiredLaps: 1,
            completedLaps: 0,
            lastLapAt: 0,
        };
        const state = createTestSimState({
            currentTime: 2,
            currentChallengeRun: challengeRun,
            pos: { x: 4.98, y: 0 },
            prevPos: { x: 4.98, y: 0 },
            velocity: { x: 30, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 1 / 60, CONFIG, TEST_TRACK, WALL_X5);
        expect(events.challengeFailed).toBe(true);
        expect(events.challengeFailureReason).toBe('Crash ended the challenge');
        expect(state.status).toBe('crashed');
    });

});
