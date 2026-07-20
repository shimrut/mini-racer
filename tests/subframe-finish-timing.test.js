import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import { crossingTimeSec, updateSimulation } from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const FRAME_DT = 1 / 60;

const OPEN_FINISH_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: []
};

const CHECKPOINT_TRACK = {
    startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
    checkpoints: [
        { p1: { x: 0, y: -0.1 }, p2: { x: 10, y: -0.1 } }
    ]
};

describe('crossingTimeSec', () => {
    it('interpolates within the physics step', () => {
        expect(crossingTimeSec(2, FRAME_DT, 0)).toBeCloseTo(2 - FRAME_DT, 12);
        expect(crossingTimeSec(2, FRAME_DT, 0.5)).toBeCloseTo(2 - FRAME_DT / 2, 12);
        expect(crossingTimeSec(2, FRAME_DT, 1)).toBe(2);
    });

    it('can produce millisecond last digits outside the frame-quantized {0,3,7} set', () => {
        const lastDigits = new Set();
        for (const fraction of [0.1, 0.2, 0.4, 0.55, 0.7, 0.85, 0.92]) {
            const ms = Math.round(crossingTimeSec(12, FRAME_DT, fraction) * 1000);
            lastDigits.add(ms % 10);
        }
        const outsideFrameSet = [...lastDigits].filter((d) => d !== 0 && d !== 3 && d !== 7);
        expect(outsideFrameSet.length).toBeGreaterThan(0);
    });
});

describe('updateSimulation — sub-frame crossing times', () => {
    it('records a mid-segment checkpoint split strictly before end-of-frame time', () => {
        const state = createTestSimState({
            currentTime: 1.25,
            pos: { x: 5, y: -0.115 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0,
            lapCheckpointTimesSec: []
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, CHECKPOINT_TRACK, []);

        expect(events.checkpointPassed?.splitTimeSec).toBe(1.265);
        expect(events.checkpointPassed.splitTimeSec).toBeLessThan(state.currentTime);
        expect(events.checkpointPassed.splitTimeSec).toBeGreaterThan(state.currentTime - 0.05);
    });

    it('records finish time at end-of-frame when the line is crossed at the end of the step', () => {
        const state = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.001 },
            velocity: { x: 0, y: 0.02 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, OPEN_FINISH_TRACK, []);

        expect(events.winTriggered).toBe(true);
        expect(events.winData.lapTime).toBeCloseTo(state.currentTime, 8);
    });

    it('records finish time strictly before end-of-frame for a mid-segment crossing', () => {
        const state = createTestSimState({
            currentTime: 2,
            pos: { x: 5, y: -0.015 },
            velocity: { x: 0, y: 1 },
            angle: Math.PI / 2,
            nextCheckpointIndex: 0
        });

        const events = updateSimulation(state, 0.05, { ...CONFIG, accel: 0 }, OPEN_FINISH_TRACK, []);

        expect(events.winTriggered).toBe(true);
        expect(events.winData.lapTime).toBeLessThan(state.currentTime);
        expect(events.winData.lapTime).toBeGreaterThan(state.currentTime - 0.05);
        const lastDigit = Math.round(events.winData.lapTime * 1000) % 10;
        expect([0, 3, 7]).not.toContain(lastDigit);
    });
});
