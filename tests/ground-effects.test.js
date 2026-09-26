import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import {
    createTyreTrackBuffer,
    drawSkidMarks,
    drawSpray,
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
    it('leaves tyre tracks and a spray of dust on dirt', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        for (let step = 0; step < 60; step++) recordGroundEffects(engine, dirt, CONFIG);

        expect(engine.tyreTracks.length).toBe(60);
        expect(engine.particles.length).toBeGreaterThan(0);
        for (const particle of engine.particles) {
            expect(particle.spray).toBe(true);
            expect(particle.color).toBe(dirt.sprayColor);
        }
    });

    it('starts the dirt and snow spray behind the car in line with the rear tires, and behind the front tires', () => {
        for (const ground of ['dirt', 'snow']) {
            const engine = createEngine({ angle: Math.PI / 2 });
            const look = resolveTrackPresentation('circuit', { ground });
            for (let step = 0; step < 120; step++) recordGroundEffects(engine, look, CONFIG);

            // The car faces +y from (10, 10): behind it is smaller y.
            const rear = engine.particles.filter((particle) => particle.y < 10);
            const front = engine.particles.filter((particle) => particle.y > 10);
            expect(rear.length, ground).toBeGreaterThan(0);
            expect(front.length, ground).toBeGreaterThan(0);
            expect(front.length, ground).toBeLessThan(rear.length);
            for (const particle of rear) {
                expect(particle.y).toBeCloseTo(10 - 0.6, 6);
                expect(Math.abs(particle.x - 10)).toBeCloseTo(0.28, 6);
            }
            for (const particle of front) {
                expect(particle.y).toBeCloseTo(10 + 0.2, 6);
                expect(Math.abs(particle.x - 10)).toBeCloseTo(0.26, 6);
            }
            // A front lump is about as wide as the front tire, smaller than a rear lump.
            expect(Math.max(...front.map((particle) => particle.size)), ground)
                .toBeLessThan(Math.min(...rear.map((particle) => particle.size)));
        }
    });

    it('throws the water spray from behind the jet ski only', () => {
        const engine = createEngine({ angle: Math.PI / 2 });
        const water = resolveTrackPresentation('circuit', { ground: 'water' });
        for (let step = 0; step < 120; step++) recordGroundEffects(engine, water, CONFIG);

        expect(engine.particles.length).toBeGreaterThan(0);
        for (const particle of engine.particles) expect(particle.y).toBeCloseTo(10 - 0.6, 6);
    });

    it('draws the dirt dust and the snow spray in one flat colour, with no shade or light', () => {
        for (const ground of ['dirt', 'snow']) {
            const look = resolveTrackPresentation('circuit', { ground });
            const puff = {
                x: 1, y: 1, vx: 0, vy: 0, life: 0.5, maxLife: 1, color: look.sprayColor, size: 6, spray: true,
            };
            const fills = [];
            const ctx = {
                save() {}, restore() {}, beginPath() {}, moveTo() {}, arc() {},
                fill() { fills.push(this.fillStyle); },
            };
            drawSpray(ctx, [puff], look, 40);

            expect(fills, ground).toEqual([look.sprayColor]);
        }
    });

    it('gives snow a spray of snow lumps that slow down', () => {
        const snowEngine = createEngine();
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 20; step++) recordGroundEffects(snowEngine, snow, CONFIG);

        expect(snowEngine.particles.length).toBeGreaterThan(0);
        for (const particle of snowEngine.particles) {
            expect(particle.spray).toBe(true);
            expect(particle.color).toBe(snow.sprayColor);
        }

        const lump = snowEngine.particles[0];
        const speedBefore = Math.hypot(lump.vx, lump.vy);
        recordGroundEffects(snowEngine, snow, CONFIG);
        expect(Math.hypot(lump.vx, lump.vy)).toBeLessThan(speedBefore);
    });

    it('throws the dirt dust out less than the snow lumps, so it stays behind the wheels', () => {
        // A car at rest on the spot: only the throw moves the spray.
        const still = { velocity: { x: 0, y: 0 }, cachedSpeed: 10 };
        const dirtEngine = createEngine(still);
        const snowEngine = createEngine(still);
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 60; step++) {
            recordGroundEffects(dirtEngine, dirt, CONFIG);
            recordGroundEffects(snowEngine, snow, CONFIG);
        }
        const fastest = (particles) => Math.max(...particles.map((particle) => Math.hypot(particle.vx, particle.vy)));

        expect(dirtEngine.particles.length).toBeGreaterThan(0);
        expect(fastest(dirtEngine.particles)).toBeLessThan(fastest(snowEngine.particles));
    });

    it('grows the dirt dust more slowly than the snow lumps pop up', () => {
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        const youngRadius = (look) => {
            // A puff from a rear wheel: the car at (10, 10) faces +x.
            const engine = createEngine();
            const rearPuff = () => engine.particles.find((particle) => particle.x < 10);
            while (!rearPuff()) recordGroundEffects(engine, look, CONFIG);
            const particle = { ...rearPuff(), x: 1, y: 1, size: 6, life: 0.9, maxLife: 1 };
            // The radius of the main layer, not of a shade or light layer.
            let radius;
            const ctx = {
                save() {}, restore() {}, beginPath() {}, moveTo() {}, fill() {},
                arc(x, y, r) { if (this.fillStyle === look.sprayColor) radius = r; },
            };
            drawSpray(ctx, [particle], look, 40);
            return radius;
        };

        expect(youngRadius(dirt)).toBeLessThan(youngRadius(snow));
    });

    it('pops the snow lumps up, then shrinks them away', () => {
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        const lump = (life) => ({
            x: 1, y: 1, vx: 0, vy: 0, life, maxLife: 1, color: snow.sprayColor, size: 6, spray: true,
        });
        const radiusAt = (life) => {
            const radii = [];
            const ctx = {
                save() {}, restore() {}, beginPath() {}, moveTo() {}, fill() {},
                arc(x, y, radius) { radii.push(radius); },
            };
            drawSpray(ctx, [lump(life)], snow, 40);
            return radii[0];
        };

        expect(radiusAt(0.95)).toBeLessThan(radiusAt(0.7));
        expect(radiusAt(0.1)).toBeLessThan(radiusAt(0.7));
        expect(radiusAt(0.7)).toBeLessThanOrEqual(6);
    });

    it('puts the dirt and snow tracks and skid marks under the rear tires, and a track as wide as a tire at any zoom', () => {
        const engine = createEngine();
        // The car drives along y = 10, so a line's y tells its distance from the middle.
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, resolveTrackPresentation('circuit', { ground: 'dirt' }), CONFIG);
        }
        const gs = 40;
        // The distances from the middle, and the widths, of the lines drawn in
        // one colour: the grooves or the skid marks, not the shade lines.
        const draw = (drawMarks, color) => {
            const widths = new Set();
            const halfWidths = new Set();
            let ys = [];
            const ctx = {
                save() {}, restore() {}, lineTo() {},
                beginPath() { ys = []; },
                moveTo(x, y) { ys.push(y); },
                stroke() {
                    if (this.strokeStyle !== color) return;
                    widths.add(this.lineWidth);
                    for (const y of ys) halfWidths.add(Math.abs(y / gs - 10).toFixed(3));
                },
            };
            drawMarks(ctx);
            return { widths: [...widths], halfWidths: [...halfWidths] };
        };

        for (const ground of ['dirt', 'snow']) {
            const look = resolveTrackPresentation('circuit', { ground });
            for (const zoom of [1, 0.75]) {
                const grooves = draw((ctx) => drawTyreTracks(ctx, engine.tyreTracks, look, gs, zoom), look.tyreTrackColor);
                expect(grooves.halfWidths, ground).toEqual(['0.290']);
                expect(grooves.widths, ground).toEqual([6]);
            }
            const skids = draw((ctx) => drawSkidMarks(ctx, engine.tyreTracks, look, gs, 1), look.skidColor);
            expect(skids.halfWidths, ground).toEqual(['0.290']);
        }

        const tarmac = resolveTrackPresentation('circuit');
        const skids = draw((ctx) => drawSkidMarks(ctx, engine.tyreTracks, tarmac, gs, 1), tarmac.skidColor);
        expect(skids.halfWidths).toEqual(['0.170']);
    });

    it('draws a snow groove with a thin shade line to its upper left', () => {
        const engine = createEngine();
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, snow, CONFIG);
        }
        const strokes = [];
        let firstPoint = null;
        const ctx = {
            save() {}, restore() {}, lineTo() {},
            beginPath() { firstPoint = null; },
            moveTo(x, y) { firstPoint ??= { x, y }; },
            stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth, firstPoint }); },
        };
        drawTyreTracks(ctx, engine.tyreTracks, snow, 40, 1);

        const [shade, groove] = strokes;
        expect(shade.color).toBe(snow.tyreTrackShadeColor);
        expect(groove.color).toBe(snow.tyreTrackColor);
        expect(shade.width).toBeLessThan(groove.width);
        expect(shade.firstPoint.x).toBeLessThan(groove.firstPoint.x);
        expect(shade.firstPoint.y).toBeLessThan(groove.firstPoint.y);
    });

    it('draws snow skid marks wider than dirt skid marks', () => {
        const engine = createEngine();
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });
        for (let step = 0; step < 30; step++) {
            engine.pos.x += 0.1;
            recordGroundEffects(engine, dirt, CONFIG);
        }
        const widths = (presentation) => {
            const strokes = [];
            const ctx = {
                save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
                stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth }); },
            };
            drawSkidMarks(ctx, engine.tyreTracks, presentation, 40, 1);
            return strokes.filter((stroke) => stroke.color === presentation.skidColor).map((stroke) => stroke.width);
        };

        expect(widths(snow)[0]).toBeGreaterThan(widths(dirt)[0]);
    });

    it('draws dirt skid marks as one stroke, wider and darker than the ruts', () => {
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
        expect(strokes).toHaveLength(1);
        const [skid] = strokes;
        strokes.length = 0;
        drawTyreTracks(ctx, engine.tyreTracks, dirt, 40, 1);
        const tyreTrack = strokes.at(-1);

        const alpha = (color) => Number(color.match(/([\d.]+)\)$/)[1]);
        expect(skid.color).toBe(dirt.skidColor);
        expect(tyreTrack.color).toBe(dirt.tyreTrackColor);
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

        // Each fade step draws the shade side, then the groove.
        expect(countStrokes(false)).toBe(12);
        expect(countStrokes(true)).toBe(6);
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

    it('throws lumps of the bank at a wall hit on snow and dirt, and keeps the sparks on tarmac', () => {
        // A wall along y = 10.5, just below the car. The road is above it.
        const wall = { start: { x: 0, y: 10.5 }, end: { x: 20, y: 10.5 }, dx: 20, dy: 0, lenSq: 400 };
        const scrape = { wallImpact: { kind: 'scrape', impactKph: 80, severity: 0.8 } };
        const spark = () => ({
            x: 10, y: 10, vx: 1, vy: 1, life: 0.3, maxLife: 0.3, color: CONFIG.sparkColor, size: 2,
        });
        for (const ground of ['snow', 'dirt']) {
            const look = resolveTrackPresentation('circuit', { ground });
            const engine = createEngine({ collisionHash: { segments: [wall] }, particles: [spark(), spark()] });
            recordGroundEffects(engine, look, CONFIG, scrape);

            expect(engine.particles.some((particle) => particle.color === CONFIG.sparkColor), ground).toBe(false);
            const lumps = engine.particles.filter((particle) => particle.debris);
            expect(lumps.length, ground).toBeGreaterThan(5);
            for (const lump of lumps) {
                expect(lump.color).toBe(look.scrapeDebris.color);
                expect(lump.spray).toBe(true);
                // They start on the wall and fly into the road, away from it.
                expect(lump.y).toBeCloseTo(10.5, 6);
                expect(lump.vy).toBeLessThan(0);
            }
        }

        const tarmac = resolveTrackPresentation('circuit');
        const engine = createEngine({ collisionHash: { segments: [wall] }, particles: [spark(), spark()] });
        recordGroundEffects(engine, tarmac, CONFIG, scrape);
        expect(engine.particles.filter((particle) => particle.color === CONFIG.sparkColor)).toHaveLength(2);
    });

    it('draws the wall hit lumps in the colours of the bank', () => {
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const lump = {
            x: 1, y: 1, vx: 0, vy: 0, life: 0.5, maxLife: 1, color: dirt.scrapeDebris.color, size: 6, spray: true, debris: true,
        };
        const fills = [];
        const ctx = {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, arc() {},
            fill() { fills.push(this.fillStyle); },
        };
        drawSpray(ctx, [lump], dirt, 40);

        expect(fills).toEqual([dirt.scrapeDebris.shade, dirt.scrapeDebris.color, dirt.scrapeDebris.light]);
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

        // Counts the points of the grooves only, not of their shade sides.
        const countDrawnPoints = (presentation) => {
            let points = 0;
            let pathPoints = 0;
            const ctx = {
                save() {}, restore() {},
                beginPath() { pathPoints = 0; },
                moveTo() { pathPoints += 1; }, lineTo() { pathPoints += 1; },
                stroke() { if (this.strokeStyle === presentation.tyreTrackColor) points += pathPoints; },
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
