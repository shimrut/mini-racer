import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { updateSimulation } from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: [],
};

describe('simulation formula kills', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not add forward thrust when accel is zero even below max speed (L578)', () => {
        const dt = 1 / 60;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 2 },
            angle: 0,
            keys: { left: false, right: false },
        });

        updateSimulation(state, dt, { ...CONFIG, accel: 0, grip: 0, downforceGrip: 0 }, OPEN_TRACK, []);

        expect(state.velocity.y).toBeCloseTo(2, 8);
        expect(state.velocity.x).toBeCloseTo(0, 8);
    });

    it('does not add forward thrust when total speed already equals max speed (L578)', () => {
        const dt = 1 / 60;
        const safeMax = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: safeMax },
            angle: Math.PI / 2,
            keys: { left: false, right: false },
        });

        updateSimulation(state, dt, { ...CONFIG, accel: 200, grip: 0, downforceGrip: 0 }, OPEN_TRACK, []);

        expect(state.velocity.y).toBeCloseTo(safeMax, 6);
    });
});
