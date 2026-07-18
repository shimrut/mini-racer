import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { updateSimulation } from '../game/race/simulation.js';
import { createTestSimState } from './helpers/sim-state.js';

const OPEN_TRACK = {
    startLine: { p1: { x: 100, y: 100 }, p2: { x: 110, y: 100 } },
    checkpoints: [],
};

const WALL_AT = (x) => ({
    start: { x, y: -10 },
    end: { x, y: 10 },
    dx: 0,
    dy: 20,
    lenSq: 400,
});

describe('simulation observable kills', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('advances position and speed over many ticks with forward thrust', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: Math.PI / 2,
            currentTime: 0,
            keys: { left: false, right: false },
        });
        const dt = 1 / 60;
        const config = { ...CONFIG, grip: 0, downforceGrip: 0, highSpeedSteerTrim: 0 };

        for (let tick = 0; tick < 180; tick += 1) {
            updateSimulation(state, dt, config, OPEN_TRACK, []);
        }

        expect(state.pos.y).toBeGreaterThan(5);
        expect(state.cachedSpeed).toBeGreaterThan(5);
        expect(state.cachedSpeed).toBeLessThanOrEqual(CONFIG.maxSpeed / KPH_PER_WORLD_UNIT + 1e-6);
    });

    it('does not advance race time while relaunch delay is active', () => {
        const state = createTestSimState({
            relaunchDelayRemaining: 0.5,
            currentTime: 3,
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
        });

        updateSimulation(state, 0.2, { ...CONFIG, accel: 200 }, OPEN_TRACK, []);

        expect(state.currentTime).toBe(3);
        expect(state.relaunchDelayRemaining).toBeCloseTo(0.3);
    });

    it('skips driving physics when status is not playing', () => {
        const state = createTestSimState({
            status: 'won',
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            angle: 0,
            currentTime: 5,
        });

        updateSimulation(state, 0.1, { ...CONFIG, accel: 200 }, OPEN_TRACK, []);

        expect(state.pos).toEqual({ x: 0, y: 0 });
        expect(state.currentTime).toBe(5);
    });

    it('emits fewer scrape particles when frameSkip is enabled', () => {
        const wall = WALL_AT(0.4);
        const normal = createTestSimState({
            pos: { x: 0.1, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            frameSkip: 0,
            particles: [],
        });
        const skipped = createTestSimState({
            pos: { x: 0.1, y: 0 },
            velocity: { x: 8, y: 0 },
            angle: 0,
            frameSkip: 1,
            particles: [],
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.275,
            carCollisionHalfLength: 0,
            wallScrapeReferenceImpactKph: 5,
        };

        updateSimulation(normal, 0.05, config, OPEN_TRACK, [wall]);
        updateSimulation(skipped, 0.05, config, OPEN_TRACK, [wall]);

        expect(normal.particles.length).toBeGreaterThan(skipped.particles.length);
    });

    it('records skid marks when lateral slip exceeds thresholds at speed', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 10, y: 2 },
            angle: 1.2,
            keys: { left: false, right: true },
            skidMarks: createTestSimState().skidMarks,
        });
        state.skidMarks.clear();
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0.05,
            downforceGrip: 0,
            steerGripScale: 0.2,
        };

        for (let tick = 0; tick < 20; tick += 1) {
            updateSimulation(state, 0.05, config, OPEN_TRACK, []);
        }

        expect(state.skidMarks.length).toBeGreaterThan(0);
    });

    it('writes route trace samples when a stroke style is configured', () => {
        const state = createTestSimState({
            pos: { x: 0, y: 0 },
            velocity: { x: 0, y: 12 },
            angle: Math.PI / 2,
            routeTraceStrokeStyle: '#fff',
            routeTrace: createTestSimState().routeTrace,
            trailTimer: 0,
        });
        state.routeTrace.clear();

        for (let tick = 0; tick < 12; tick += 1) {
            updateSimulation(state, 0.05, { ...CONFIG, accel: 0, grip: 0 }, OPEN_TRACK, []);
        }

        expect(state.routeTrace.length).toBeGreaterThan(0);
    });

    it('does not emit wall scrape feedback after a valid finish win', () => {
        const finishTrack = {
            startLine: { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } },
            checkpoints: [],
        };
        const state = createTestSimState({
            currentTime: 2.5,
            pos: { x: 5, y: -0.2 },
            velocity: { x: 0, y: 20 },
            angle: Math.PI / 2,
            particles: [],
        });
        const wall = WALL_AT(5.1);

        const events = updateSimulation(
            state,
            0.05,
            { ...CONFIG, accel: 0, grip: 0, carRadius: 0.275 },
            finishTrack,
            [wall],
        );

        expect(events.winTriggered).toBe(true);
        expect(events.wallImpact).toBeNull();
        expect(state.particles).toHaveLength(0);
    });

    it('caps particle count after many wall scrapes', () => {
        const wall = WALL_AT(0.35);
        const state = createTestSimState({
            pos: { x: 0.05, y: 0 },
            velocity: { x: 6, y: 0 },
            angle: 0,
            frameSkip: 0,
            particles: [],
        });
        const config = {
            ...CONFIG,
            accel: 0,
            grip: 0,
            carRadius: 0.275,
            wallScrapeReferenceImpactKph: 5,
        };

        for (let tick = 0; tick < 40; tick += 1) {
            updateSimulation(state, 0.05, config, OPEN_TRACK, [wall]);
        }

        expect(state.particles.length).toBeLessThanOrEqual(50);
    });
});
