import { describe, expect, it } from 'vitest';
import { updateSimulation } from '../game/race/simulation.js';
import { CONFIG } from '../game/config.js';
import { createTestSimState, TEST_TRACK } from './helpers/sim-state.js';

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

describe('updateSimulation — regular runs', () => {
    it('regular mode still wins after one valid lap', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            currentTime: 1.99
        });

        const events = crossFinishOnce(state);
        expect(events.winTriggered).toBe(true);
        expect(events.challengeLapCompleted).toBe(true);
        expect(state.status).toBe('won');
    });

    it('regular hard crash ends the run', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            pos: { x: 4.98, y: 0 },
            prevPos: { x: 4.98, y: 0 },
            velocity: { x: 30, y: 0 },
            angle: 0
        });

        const events = updateSimulation(state, 1 / 60, CONFIG, TEST_TRACK, WALL_X5);
        expect(events.crashEndedRun).toBe(true);
        expect(events.challengeCrashReset).toBe(false);
        expect(state.status).toBe('crashed');
    });

    it('keeps low-speed wall bounces on the safe side of the barrier', () => {
        const state = createTestSimState({
            currentModeKey: 'daily',
            pos: { x: 4.98, y: 0 },
            prevPos: { x: 4.98, y: 0 },
            velocity: { x: 1.5, y: 0 },
            angle: 0
        });

        const events = updateSimulation(
            state,
            1 / 60,
            { ...CONFIG, crashSpeed: 3 },
            TEST_TRACK,
            WALL_X5
        );

        expect(events.crashEndedRun).toBe(false);
        expect(state.status).toBe('playing');
        expect(state.pos.x).toBeLessThan(5);
        expect(state.velocity.x).toBeLessThan(0);
    });
});
