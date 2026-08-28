import { describe, expect, it, vi } from 'vitest';
import { raceEngineMethods } from '../game/race/engine-methods.js';
import { ageSparkParticles } from '../game/race/simulation.js';
import { trackEngineMethods } from '../game/track/engine-methods.js';

function spark(overrides = {}) {
    return {
        x: 0,
        y: 0,
        vx: 10,
        vy: 0,
        life: 0.3,
        maxLife: 0.3,
        ...overrides,
    };
}

function createLoopEngine(overrides = {}) {
    return {
        status: 'won',
        particles: [spark({ life: 0.05, maxLife: 0.05 })],
        lastTime: 1000,
        frameTimeHistory: [],
        frameTimeHistoryIndex: 0,
        frameTimeTotal: 0,
        frameSkip: 0,
        accumulator: 0,
        FIXED_DT: 1 / 60,
        _frameRequestId: 1,
        _needsRender: false,
        cachedSpeed: 0,
        angle: 0,
        velocity: { x: 0, y: 0 },
        relaunchDelayRemaining: 0,
        runtimeConfig: { maxSpeed: 220 },
        hud: { syncHud: vi.fn() },
        carEffectsAudio: { syncFrame: vi.fn() },
        proceduralMusic: { syncFrame: vi.fn() },
        render: vi.fn(),
        update: vi.fn(),
        requestFrame: vi.fn(),
        shouldAnimateFrame: trackEngineMethods.shouldAnimateFrame,
        ...overrides,
    };
}

describe('ageSparkParticles', () => {
    it('moves sparks and drops them when their life runs out', () => {
        const particles = [spark({ life: 0.25 })];

        ageSparkParticles(particles, 0.1, { maxParticles: 50 });

        expect(particles).toHaveLength(1);
        expect(particles[0].x).toBeCloseTo(1);
        expect(particles[0].life).toBeCloseTo(0.15);

        ageSparkParticles(particles, 0.2, { maxParticles: 50 });
        expect(particles).toHaveLength(0);
    });

    it('keeps only the newest sparks up to the cap', () => {
        const particles = [
            spark({ x: 1, life: 1 }),
            spark({ x: 2, life: 1 }),
            spark({ x: 3, life: 1 }),
        ];

        ageSparkParticles(particles, 0, { maxParticles: 2 });

        expect(particles.map((particle) => particle.x)).toEqual([2, 3]);
    });
});

describe('race loop leftover sparks', () => {
    it('fades sparks after finish without running the car, then stops drawing', () => {
        const engine = createLoopEngine();

        raceEngineMethods.loop.call(engine, 1016);

        expect(engine.update).not.toHaveBeenCalled();
        expect(engine.particles).toHaveLength(1);
        expect(engine.particles[0].life).toBeCloseTo(0.034);
        expect(engine.render).toHaveBeenCalledTimes(1);
        expect(engine.requestFrame).toHaveBeenCalledTimes(1);

        engine.requestFrame.mockClear();
        engine.render.mockClear();
        raceEngineMethods.loop.call(engine, 1066);

        expect(engine.update).not.toHaveBeenCalled();
        expect(engine.particles).toHaveLength(0);
        expect(engine.render).toHaveBeenCalledTimes(1);
        expect(engine.requestFrame).not.toHaveBeenCalled();
    });

    it('does the same fade-then-stop after pause', () => {
        const engine = createLoopEngine({
            status: 'paused',
            particles: [spark({ life: 0.01, maxLife: 0.01 })],
        });

        raceEngineMethods.loop.call(engine, 1100);

        expect(engine.update).not.toHaveBeenCalled();
        expect(engine.particles).toHaveLength(0);
        expect(engine.requestFrame).not.toHaveBeenCalled();
    });
});
