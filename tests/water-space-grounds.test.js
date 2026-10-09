import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
    REPLAY_FRAMES_PER_LAP,
    validateDailyGpReplayDetailed,
} from '../src/server/competition/replay-validator.ts';
import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { DRAWN_CAR_MODELS, DrawnCar } from '../game/car/drawn-car.js';
import { JET_SKI } from '../game/car/drawn-car/jet-ski.js';
import { getCarAssetGround, getDefaultCarAssetForGround } from '../game/car/car-skin-grounds.js';
import { DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import { updateSimulation } from '../game/race/simulation.js';
import { TRACK_GROUNDS } from '../game/track/grounds.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';
import { TRACKSIDE_ITEMS } from '../game/track/trackside-items.js';
import { TRACKS } from '../game/track/tracks.js';
import { Point } from '../game/track/geometry.js';
import { createReplaySimulationState, driveAutopilot } from './helpers/autopilot.js';

const FRAME = 1 / 60;

function createChallenge(trackKey, laps = 1) {
    return {
        id: `ground-${trackKey}-${laps}`,
        challengeDate: '2026-09-25',
        trackKey,
        startsAt: '2026-09-25T00:00:00.000Z',
        endsAt: '2026-09-26T00:00:00.000Z',
        availableUntil: '2026-10-02T00:00:00.000Z',
        status: 'active',
        rulesRevision: 1,
        objectiveType: laps > 1 ? 'multi_lap_total' : 'single_lap_fastest',
        objectiveParams: { lapCount: laps },
        skin: 'default',
    };
}

// A huge open square, so no wall is near the car.
const OPEN = {
    outer: [Point(0, 0), Point(4000, 0), Point(4000, 4000), Point(0, 4000)],
    inner: [Point(3990, 3990), Point(3995, 3990), Point(3995, 3995), Point(3990, 3995)],
    startLine: { p1: Point(1900, 0), p2: Point(1900, 3990) },
    checkpoints: [{ p1: Point(2000, 3995), p2: Point(2000, 4000) }],
    startPos: Point(2000, 2000),
    startAngle: 0,
};

// Straight for `frames`, right for `steerFrames`, then released for `afterFrames`.
function drive(ground, { frames = 600, steerFrames = 0, afterFrames = 0 } = {}) {
    const { state, collisionSegments } = createReplaySimulationState(OPEN);
    const step = () => updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, OPEN, collisionSegments, ground);
    let reached200 = null;
    for (let frame = 0; frame < frames; frame++) {
        step();
        if (reached200 === null && state.cachedSpeed * KPH_PER_WORLD_UNIT >= 200) reached200 = frame;
    }
    const top = state.cachedSpeed * KPH_PER_WORLD_UNIT;
    const startAngle = state.angle;
    let angleAtRelease = startAngle;
    let widestSlide = 0;
    for (let frame = 0; frame < steerFrames + afterFrames; frame++) {
        state.keys.right = frame < steerFrames;
        step();
        if (frame === steerFrames - 1) angleAtRelease = state.angle;
        const slide = Math.atan2(state.velocity.y, state.velocity.x) - state.angle;
        widestSlide = Math.max(widestSlide, Math.abs(Math.atan2(Math.sin(slide), Math.cos(slide))));
    }
    return { reached200, top, afterRelease: state.angle - angleAtRelease, widestSlide };
}

describe('water and space driving', () => {
    const { tarmac, dirt, snow, water, space } = TRACK_GROUNDS;

    it('gives water a lower top speed and a slide as wide as snow', () => {
        expect(water.maxSpeed).toBeLessThan(1);
        expect(water.accel).toBeLessThan(1);
        const hold = (ground) => drive(ground, { steerFrames: 60 }).widestSlide;
        expect(hold(water)).toBeGreaterThan(hold(dirt));
        expect(hold(water)).toBeGreaterThan(hold(snow) * 0.9);
    });

    it('keeps the jet ski turning after the player lets go', () => {
        const tap = (ground) => drive(ground, { steerFrames: 8, afterFrames: 60 }).afterRelease;
        expect(water.yawCarry).toBeGreaterThan(0);
        expect(tap(water)).toBeGreaterThan(tap(tarmac) * 1.5);
    });

    it('gives space the fastest start, the highest top speed and a very wide slide', () => {
        const spaceRun = drive(space, { steerFrames: 60 });
        const tarmacRun = drive(tarmac, { steerFrames: 60 });
        expect(spaceRun.reached200).toBeLessThan(tarmacRun.reached200);
        expect(spaceRun.top).toBeGreaterThan(tarmacRun.top * 1.05);
        expect(spaceRun.widestSlide).toBeGreaterThan(tarmacRun.widestSlide * 1.5);
        expect(space.slideScrub).toBe(0);
    });

    it('laps water slower than tarmac and space close to tarmac', () => {
        const lap = (ground) => driveAutopilot({ ...TRACKS.circuit, ground }).winData.lapTime;
        expect(lap('water')).toBeGreaterThan(lap('tarmac') * 1.1);
        expect(lap('space')).toBeLessThan(lap('tarmac') * 1.1);
    });

    it.each([
        { ground: 'water', trackKey: 'circuit', laps: 1 },
        { ground: 'water', trackKey: 'carbonBend', laps: 2 },
        { ground: 'space', trackKey: 'circuit', laps: 1 },
        { ground: 'space', trackKey: 'carbonBend', laps: 2 },
    ])('gets the same $trackKey time from the server check on $ground ($laps lap)', ({ ground, trackKey, laps }) => {
        const track = { ...TRACKS[trackKey], ground };
        const run = driveAutopilot(track, { laps });
        expect(run.winData).not.toBeNull();
        const outcome = validateDailyGpReplayDetailed({
            challenge: createChallenge(trackKey, laps),
            replay: run.replay,
            track,
        });
        expect(outcome.ok).toBe(true);
        expect(outcome.run.bestTimeSec).toBe(run.winData.lapTime);
    });

    it('keeps long existing tracks drivable on water inside the frame limit', () => {
        for (const trackKey of ['kettleRun', 'alloyRing']) {
            const run = driveAutopilot({ ...TRACKS[trackKey], ground: 'water' });
            expect(run.winData, trackKey).not.toBeNull();
            expect(run.frames, trackKey).toBeLessThan(REPLAY_FRAMES_PER_LAP * 0.6);
        }
    });
});

describe('water and space looks', () => {
    const tarmac = resolveTrackPresentation('circuit');
    const water = resolveTrackPresentation('circuit', { ground: 'water' });
    const space = resolveTrackPresentation('circuit', { ground: 'space' });

    it('gives water a blue road, sand banks with a foam line, a wake and splashes', () => {
        expect(water.key).toBe('track:circuit:ground:water');
        expect(water.trackColor).not.toBe(tarmac.trackColor);
        expect(water.showCurbs).toBe(false);
        expect(water.bankColor).toBeTruthy();
        expect(water.bankLipColor).toBeTruthy();
        expect(water.waveColor).toBeTruthy();
        expect(water.tyreTrackSpread).toBeGreaterThan(0);
        expect(water.sprayColor).toBeTruthy();
        expect(water.showTireWalls).toBe(false);
        expect(water.tracksideItems.map(([name]) => name).sort()).toEqual(['palm', 'rock', 'umbrella']);
    });

    it('gives space a dark lane with a grid, light strips, stars and a see-through infield', () => {
        expect(space.key).toBe('track:circuit:ground:space');
        expect(space.showCurbs).toBe(true);
        expect(space.curbRed).not.toBe(tarmac.curbRed);
        expect(space.gridSpacing).toBeGreaterThan(0);
        expect(space.backgroundStyle).toBe('space');
        expect(space.starColors.length).toBeGreaterThan(0);
        expect(space.infieldColor).toBe('transparent');
        expect(space.sprayColor).toBeUndefined();
        expect(space.carShadowOffsetY).toBeGreaterThan(tarmac.carShadowOffsetY ?? 0);
        expect(space.tracksideItems.map(([name]) => name).sort()).toEqual(['asteroid', 'planet', 'satellite']);
    });

    it('has every trackside item that water and space ask for', () => {
        for (const look of [water, space]) {
            for (const [name, weight] of look.tracksideItems) {
                expect(TRACKSIDE_ITEMS[name], name).toBeTruthy();
                expect(weight).toBeGreaterThan(0);
            }
        }
    });
});

describe('jet ski and spaceship', () => {
    const PPU = 4;
    let savedDocument;

    beforeAll(() => {
        savedDocument = globalThis.document;
        globalThis.document = { createElement: () => createCanvas(1, 1) };
    });

    afterAll(() => {
        globalThis.document = savedDocument;
    });

    function alphaAt(canvas, x, y) {
        const center = canvas.width / 2;
        return canvas.getContext('2d').getImageData(Math.round(center + x * PPU), Math.round(center + y * PPU), 1, 1).data[3];
    }

    // Counts the pixels that a ground drawing covers on a clear canvas.
    function groundCover(car, size = 110 * PPU) {
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.translate(size / 2, size / 2);
        car.drawGround(ctx, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let covered = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) covered += 1;
        return covered;
    }

    it('gives each water and space skin the right vehicle and ground', () => {
        for (const [assetName, skin] of Object.entries(DRAWN_CAR_SKINS)) {
            const ground = getCarAssetGround(assetName);
            if (ground === 'water') expect(skin.car, assetName).toBe('jetski');
            if (ground === 'space') expect(skin.car, assetName).toBe('spaceship');
            expect(DRAWN_CAR_MODELS[skin.car], assetName).toBeTruthy();
        }
        expect(DRAWN_CAR_SKINS[getDefaultCarAssetForGround('water')].car).toBe('jetski');
        expect(DRAWN_CAR_SKINS[getDefaultCarAssetForGround('space')].car).toBe('spaceship');
    });

    // The point of a part, in car units from the car center, at a local point.
    function pointOf(ctx, x, y, boxSize) {
        const m = ctx.getTransform();
        const half = boxSize / 2;
        return [(m.a * x + m.c * y + m.e) / PPU - half, (m.b * x + m.d * y + m.f) / PPU - half];
    }

    it('turns the handlebars with the steering and the jet nozzle against it', () => {
        const probes = { handlebar: [], nozzle: [] };
        const recorder = (id, localX) => ({
            moves: true,
            defaults: {},
            draw(ctx) {
                probes[id].push(pointOf(ctx, localX, 0, JET_SKI.boxSize)[1]);
            },
        });
        const jetSki = new DrawnCar(JET_SKI, {
            parts: {
                // A point in front of the column, and the rear end of the nozzle.
                handlebar: { part: recorder('handlebar', 5) },
                nozzle: { part: recorder('nozzle', -5) },
            },
        }, { pixelsPerUnit: PPU });
        jetSki.renderFrame();
        for (let i = 0; i < 30; i += 1) jetSki.update(FRAME, { steer: 1 });
        jetSki.renderFrame();
        // A right turn swings the bar front and the nozzle rear to +y.
        for (const id of ['handlebar', 'nozzle']) {
            const [straight, turned] = probes[id].slice(-2);
            expect(straight, id).toBeCloseTo(0, 4);
            expect(turned, id).toBeGreaterThan(1);
        }
    });

    it('keeps the rider\'s hands on the grips when the handlebars turn', () => {
        const { handlebar, rider } = Object.fromEntries(JET_SKI.parts.map((item) => [item.id, item]));
        const riderSettings = { ...rider.part.defaults, ...(rider.settings || {}) };
        const barSettings = { ...handlebar.part.defaults, ...(handlebar.settings || {}) };
        expect(riderSettings.barPivot).toEqual(handlebar.at);
        expect(riderSettings.gripSweep).toBe(barSettings.sweep);
        // The hand is on the grip, between its inner end and the bar end.
        expect(riderSettings.grip).toBeGreaterThan(barSettings.halfWidth - barSettings.grip);
        expect(riderSettings.grip).toBeLessThanOrEqual(barSettings.halfWidth);
        expect(rider.part.moves).toBe(true);
    });

    it('draws a bigger wake on the water at speed, and none of it on the jet ski picture', () => {
        const slow = new DrawnCar(JET_SKI, {}, { pixelsPerUnit: PPU });
        const fast = new DrawnCar(JET_SKI, {}, { pixelsPerUnit: PPU });
        for (let i = 0; i < 60; i += 1) fast.update(FRAME, { speedPx: 560, size: 52 });
        expect(groundCover(fast)).toBeGreaterThan(groundCover(slow) * 2);

        const hidden = new DrawnCar(JET_SKI, { parts: { wake: { hidden: true } } }, { pixelsPerUnit: PPU });
        const a = slow.sprite.getContext('2d').getImageData(0, 0, slow.sprite.width, slow.sprite.height).data;
        const b = hidden.sprite.getContext('2d').getImageData(0, 0, hidden.sprite.width, hidden.sprite.height).data;
        expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
        // The nozzle sticks out behind the stern.
        expect(alphaAt(slow.sprite, -48.5, 0)).toBe(255);
    });

    it('makes the spaceship flames longer at speed', () => {
        const ship = new DrawnCar(DRAWN_CAR_MODELS.spaceship, {}, { pixelsPerUnit: PPU });
        // Behind the nozzle of the left engine.
        const tail = [-52, -5.2];
        expect(alphaAt(ship.sprite, ...tail)).toBe(0);
        for (let i = 0; i < 60; i += 1) ship.update(FRAME, { speedPx: 670, size: 52 });
        expect(alphaAt(ship.renderFrame(), ...tail)).toBeGreaterThan(200);
    });

    it('turns only the engine flames of the spaceship, against the steering', () => {
        const ship = new DrawnCar(DRAWN_CAR_MODELS.spaceship);
        const steering = ship.placements.filter((placement) => placement.steers);
        expect(steering.map((placement) => placement.id)).toEqual(['flame', 'flame']);
        for (const placement of steering) expect(placement.steerScale).toBe(-1);
    });

    it('makes the jet ski and the spaceship as long and as wide as the Formula car', () => {
        // The width and the length that a picture covers, in car units.
        const extent = (model) => {
            const sprite = new DrawnCar(model, {}, { pixelsPerUnit: PPU }).sprite;
            const data = sprite.getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data;
            let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
            for (let y = 0; y < sprite.height; y += 1) {
                for (let x = 0; x < sprite.width; x += 1) {
                    if (data[(y * sprite.width + x) * 4 + 3] < 128) continue;
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                }
            }
            return { length: (maxX - minX) / PPU, width: (maxY - minY) / PPU };
        };
        const car = extent(DRAWN_CAR_MODELS.formula);
        for (const name of ['jetski', 'spaceship']) {
            const vehicle = extent(DRAWN_CAR_MODELS[name]);
            expect(Math.abs(vehicle.length - car.length), name).toBeLessThan(car.length * 0.06);
            expect(Math.abs(vehicle.width - car.width), name).toBeLessThan(car.width * 0.06);
        }
    });
});
