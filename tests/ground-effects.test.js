import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import {
    createTyreTrackBuffer,
    drawSkidMarks,
    drawTyreTracks,
    recordGroundEffects,
} from '../game/race/ground-effects.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';

function createEngine(overrides = {}) {
    return {
        status: 'playing',
        relaunchDelayRemaining: 0,
        pos: { x: 10, y: 10 },
        angle: 0,
        velocity: { x: 10, y: 4 },
        cachedSpeed: Math.hypot(10, 4),
        frameSkip: 0,
        qualityLevel: 0,
        particles: [],
        tyreTracks: createTyreTrackBuffer(),
        ...overrides,
    };
}

describe('ground effects', () => {
    it('leaves tyre tracks and dust on dirt', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 60; step++) recordGroundEffects(engine, dirt, CONFIG);

        expect(engine.tyreTracks.length).toBe(60);
        expect(engine.particles.length).toBeGreaterThan(0);
        expect(engine.particles.every((particle) => particle.color === dirt.dustColor)).toBe(true);
    });

    it('starts the dust behind the car, in line with the rear tires, not under its middle', () => {
        const engine = createEngine({ angle: Math.PI / 2 });
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 120; step++) recordGroundEffects(engine, dirt, CONFIG);

        expect(engine.particles.length).toBeGreaterThan(0);
        for (const particle of engine.particles) {
            // The car faces +y from (10, 10): behind it is smaller y.
            expect(particle.y).toBeCloseTo(10 - 0.6, 6);
            expect(Math.abs(particle.x - 10)).toBeCloseTo(0.28, 6);
        }
    });

    it('gives snow spray a darker edge puff under each white puff, and dirt none', () => {
        const dirtEngine = createEngine();
        const snowEngine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 120; step++) {
            recordGroundEffects(dirtEngine, dirt, CONFIG);
            recordGroundEffects(snowEngine, snow, CONFIG);
        }

        expect(dirtEngine.particles.some((particle) => particle.color !== dirt.dustColor)).toBe(false);
        const edges = snowEngine.particles.filter((particle) => particle.color === snow.dustEdgeColor);
        const puffs = snowEngine.particles.filter((particle) => particle.color === snow.dustColor);
        expect(puffs.length).toBeGreaterThan(0);
        expect(edges.length).toBe(puffs.length);
    });

    it('draws a snow rut with a light edge under the groove', () => {
        const engine = createEngine();
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, snow, CONFIG);
        }
        const strokes = [];
        const ctx = {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth }); },
        };
        drawTyreTracks(ctx, engine.tyreTracks, snow, 40, 1);

        expect(strokes[0].color).toBe(snow.tyreTrackEdgeColor);
        expect(strokes[1].color).toBe(snow.tyreTrackColor);
        expect(strokes[0].width).toBeGreaterThan(strokes[1].width);
    });

    it('draws dirt skid marks darker than the tyre tracks, with a light soil ridge', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, dirt, CONFIG);
        }
        const strokes = [];
        const ctx = {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth }); },
        };
        drawSkidMarks(ctx, engine.tyreTracks, dirt, 40, 1);
        const skidEdge = strokes[0];
        const skid = strokes[1];
        strokes.length = 0;
        drawTyreTracks(ctx, engine.tyreTracks, dirt, 40, 1);
        const tyreTrack = strokes.at(-1);

        const alpha = (color) => Number(color.match(/([\d.]+)\)$/)[1]);
        expect(skidEdge.color).toBe(dirt.skidEdgeColor);
        expect(skid.color).toBe(dirt.skidColor);
        expect(skidEdge.width).toBeGreaterThan(skid.width);
        expect(skid.width).toBeGreaterThan(tyreTrack.width);
        expect(alpha(skid.color)).toBeGreaterThan(alpha(tyreTrack.color));
    });

    it('draws the tyre tracks in fewer fade steps on a slow device', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 120; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, dirt, CONFIG);
        }
        const countStrokes = (lowQuality) => {
            let strokes = 0;
            const ctx = {
                save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
                stroke() { strokes += 1; },
            };
            drawTyreTracks(ctx, engine.tyreTracks, dirt, 40, 1, lowQuality);
            return strokes;
        };

        expect(countStrokes(false)).toBe(6);
        expect(countStrokes(true)).toBe(3);
    });

    it('draws tarmac skid marks with one stroke in the default colour', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, dirt, CONFIG);
        }
        const strokes = [];
        const ctx = {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { strokes.push(this.strokeStyle); },
        };
        drawSkidMarks(ctx, engine.tyreTracks, resolveTrackPresentation('circuit'), 40, 1);

        expect(strokes).toEqual([CONFIG.skidColor]);
    });

    it('leaves nothing on tarmac', () => {
        const engine = createEngine();
        const tarmac = resolveTrackPresentation('circuit');
        for (let step = 0; step < 60; step++) recordGroundEffects(engine, tarmac, CONFIG);

        expect(engine.tyreTracks.length).toBe(0);
        expect(engine.particles).toEqual([]);
    });

    it('leaves nothing while the car is slow, waiting, or not racing', () => {
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (const overrides of [
            { cachedSpeed: 1 },
            { relaunchDelayRemaining: 0.2 },
            { status: 'paused' },
        ]) {
            const engine = createEngine(overrides);
            recordGroundEffects(engine, dirt, CONFIG);
            expect(engine.tyreTracks.length).toBe(0);
            expect(engine.particles).toEqual([]);
        }
    });

    it('keeps five seconds of tracks and draws as many seconds as the ground asks', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 400; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, dirt, CONFIG);
        }
        expect(engine.tyreTracks.length).toBe(300);

        const countDrawnPoints = (presentation) => {
            let points = 0;
            const ctx = {
                save() {}, restore() {}, beginPath() {}, stroke() {},
                moveTo() { points += 1; }, lineTo() { points += 1; },
            };
            drawTyreTracks(ctx, engine.tyreTracks, presentation, 40, 1);
            return points;
        };
        const dirtPoints = countDrawnPoints(dirt);
        const snowPoints = countDrawnPoints(snow);
        expect(dirtPoints).toBeGreaterThanOrEqual(2 * 180);
        expect(dirtPoints).toBeLessThan(2 * 200);
        expect(snowPoints).toBeGreaterThanOrEqual(2 * 300);
    });
});
