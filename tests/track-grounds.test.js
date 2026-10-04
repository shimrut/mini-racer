import { describe, expect, it } from 'vitest';
import {
    REPLAY_FRAMES_PER_LAP,
    validateDailyGpReplayDetailed,
} from '../src/server/competition/replay-validator.ts';
import { CONFIG } from '../game/config.js';
import { simulateStraightLine } from '../game/car/handling.js';
import {
    DEFAULT_TRACK_GROUND_KEY,
    TRACK_GROUNDS,
    TRACK_GROUND_KEYS,
    getStoredTrackGroundKey,
    getTrackGround,
    getTrackGroundMaxSpeedKph,
    isTrackGroundKey,
} from '../game/track/grounds.js';
import { TRACKS } from '../game/track/tracks.js';
import { Point } from '../game/track/geometry.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { getTrackMedalThresholds } from '../game/medals/medal-timing.js';
import { createReplaySimulationState, driveAutopilot } from './helpers/autopilot.js';
import { updateSimulation } from '../game/race/simulation.js';

const DRIVING_MULTIPLIERS = ['accel', 'maxSpeed', 'grip', 'steerGripScale', 'turnRate', 'angularResponse'];

function createChallenge(trackKey, laps = 1) {
    return {
        id: `ground-${trackKey}-${laps}`,
        challengeDate: '2026-09-24',
        trackKey,
        startsAt: '2026-09-24T00:00:00.000Z',
        endsAt: '2026-09-25T00:00:00.000Z',
        availableUntil: '2026-10-01T00:00:00.000Z',
        status: 'active',
        rulesRevision: 1,
        objectiveType: laps > 1 ? 'multi_lap_total' : 'single_lap_fastest',
        objectiveParams: { lapCount: laps },
        skin: 'default',
    };
}

describe('track ground table', () => {
    it('multiplies every tarmac driving setting by exactly 1', () => {
        const tarmac = TRACK_GROUNDS[DEFAULT_TRACK_GROUND_KEY];
        for (const setting of DRIVING_MULTIPLIERS) {
            expect(tarmac[setting]).toBe(1);
        }
    });

    it('gives every ground a finite positive value for every driving setting', () => {
        for (const key of TRACK_GROUND_KEYS) {
            const ground = TRACK_GROUNDS[key];
            expect(ground.key).toBe(key);
            expect(typeof ground.label).toBe('string');
            for (const setting of DRIVING_MULTIPLIERS) {
                expect(Number.isFinite(ground[setting])).toBe(true);
                expect(ground[setting]).toBeGreaterThan(0);
            }
            expect(ground.skidMarkMinSlipRatio).toBeGreaterThan(0);
            expect(Object.isFrozen(ground)).toBe(true);
        }
        expect(Object.isFrozen(TRACK_GROUNDS)).toBe(true);
    });

    it('drives a missing or unknown ground as tarmac', () => {
        expect(getTrackGround({}).key).toBe('tarmac');
        expect(getTrackGround(null).key).toBe('tarmac');
        expect(getTrackGround({ ground: 'lava' }).key).toBe('tarmac');
        expect(getTrackGround({ ground: 'toString' }).key).toBe('tarmac');
        expect(getTrackGround({ ground: 'dirt' }).key).toBe('dirt');
        expect(isTrackGroundKey('dirt')).toBe(true);
        expect(isTrackGroundKey('lava')).toBe(false);
    });

    it('stores only a non-tarmac ground', () => {
        expect(getStoredTrackGroundKey({})).toBeNull();
        expect(getStoredTrackGroundKey({ ground: 'tarmac' })).toBeNull();
        expect(getStoredTrackGroundKey({ ground: 'lava' })).toBeNull();
        expect(getStoredTrackGroundKey({ ground: 'dirt' })).toBe('dirt');
    });

    it('scales the speed bar top speed by the ground', () => {
        expect(getTrackGroundMaxSpeedKph(310, {})).toBe(310);
        expect(getTrackGroundMaxSpeedKph(310, { ground: 'dirt' })).toBe(310 * TRACK_GROUNDS.dirt.maxSpeed);
        expect(getTrackGroundMaxSpeedKph(undefined, { ground: 'dirt' })).toBeUndefined();
    });

    it('gives dirt less grip, a lower top speed and slower acceleration than tarmac', () => {
        const dirt = TRACK_GROUNDS.dirt;
        expect(dirt.grip).toBeLessThan(1);
        expect(dirt.maxSpeed).toBeLessThan(1);
        expect(dirt.accel).toBeLessThan(1);

        const tarmacRun = simulateStraightLine(CONFIG, { targetSpeed: 200 });
        const dirtRun = simulateStraightLine({
            ...CONFIG,
            accel: CONFIG.accel * dirt.accel,
            maxSpeed: CONFIG.maxSpeed * dirt.maxSpeed,
        }, { targetSpeed: 200 });
        expect(dirtRun.time).toBeGreaterThan(tarmacRun.time);
    });
});

describe('dirt driving', () => {
    const DIRT_CASES = [
        { trackKey: 'circuit', laps: 1 },
        { trackKey: 'kettleRun', laps: 1 },
        { trackKey: 'carbonBend', laps: 1 },
        { trackKey: 'circuit', laps: 3 },
    ];

    it.each(DIRT_CASES)('changes the $trackKey time and the server check agrees ($laps lap)', ({ trackKey, laps }) => {
        const tarmacTrack = TRACKS[trackKey];
        const dirtTrack = { ...tarmacTrack, ground: 'dirt' };

        const tarmacRun = driveAutopilot(tarmacTrack, { laps });
        const dirtRun = driveAutopilot(dirtTrack, { laps });
        expect(dirtRun.winData).not.toBeNull();
        expect(dirtRun.winData.lapTime).not.toBe(tarmacRun.winData.lapTime);

        const dirtOutcome = validateDailyGpReplayDetailed({
            challenge: createChallenge(trackKey, laps),
            replay: dirtRun.replay,
            track: dirtTrack,
        });
        expect(dirtOutcome.ok).toBe(true);
        expect(dirtOutcome.run.bestTimeSec).toBe(dirtRun.winData.lapTime);
    });

    it('starts and stops turning more slowly than on tarmac', () => {
        // Steer right for a few frames from the grid, then let go.
        const turn = (ground) => {
            const track = { ...TRACKS.circuit, ground };
            const { state, collisionSegments } = createReplaySimulationState(track);
            const rates = [];
            for (let frame = 0; frame < 16; frame++) {
                state.keys.right = frame < 8;
                updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, track, collisionSegments);
                rates.push(state.angularVelocity);
            }
            return rates;
        };
        const tarmac = turn('tarmac');
        const dirt = turn('dirt');

        // After 3 frames of steering, dirt turns at a lower share of its full rate.
        const fullTarmac = CONFIG.turnRate;
        const fullDirt = CONFIG.turnRate * TRACK_GROUNDS.dirt.turnRate;
        expect(dirt[2] / fullDirt).toBeLessThan(tarmac[2] / fullTarmac);
        // 3 frames after the player lets go, dirt still turns at a higher share.
        expect(dirt[10] / dirt[7]).toBeGreaterThan(tarmac[10] / tarmac[7]);
    });

    it('does not accept a dirt replay as the same time on the tarmac track', () => {
        const dirtRun = driveAutopilot({ ...TRACKS.circuit, ground: 'dirt' });
        const tarmacOutcome = validateDailyGpReplayDetailed({
            challenge: createChallenge('circuit'),
            replay: dirtRun.replay,
            track: TRACKS.circuit,
        });
        const sameTime = tarmacOutcome.ok && tarmacOutcome.run.bestTimeSec === dirtRun.winData.lapTime;
        expect(sameTime).toBe(false);
    });
});

describe('ground feel settings', () => {
    // A huge open square, so no wall is near the car.
    const OPEN = {
        outer: [Point(0, 0), Point(4000, 0), Point(4000, 4000), Point(0, 4000)],
        inner: [Point(3990, 3990), Point(3995, 3990), Point(3995, 3995), Point(3990, 3995)],
        startLine: { p1: Point(1900, 0), p2: Point(1900, 3990) },
        checkpoints: [{ p1: Point(2000, 3995), p2: Point(2000, 4000) }],
        startPos: Point(2000, 2000),
        startAngle: 0,
    };

    // Reaches top speed, taps right for 12 frames, then lets go for 60 frames.
    function tap(ground) {
        const { state, collisionSegments } = createReplaySimulationState(OPEN);
        const step = () => updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, OPEN, collisionSegments, ground);
        for (let frame = 0; frame < 600; frame++) step();
        const startAngle = state.angle;
        const topKph = state.cachedSpeed * KPH_PER_WORLD_UNIT;
        let lowestKph = topKph;
        let angleAtRelease = 0;
        for (let frame = 0; frame < 72; frame++) {
            state.keys.right = frame < 12;
            step();
            if (frame === 11) angleAtRelease = state.angle - startAngle;
            lowestKph = Math.min(lowestKph, state.cachedSpeed * KPH_PER_WORLD_UNIT);
        }
        return { afterRelease: state.angle - startAngle - angleAtRelease, turned: state.angle - startAngle, lostKph: topKph - lowestKph };
    }

    const dirt = TRACK_GROUNDS.dirt;

    it('turns every new setting off on tarmac', () => {
        expect(TRACK_GROUNDS.tarmac.yawCarry).toBe(0);
        expect(TRACK_GROUNDS.tarmac.slideScrub).toBe(0);
        expect(TRACK_GROUNDS.tarmac.slideCarry).toBe(0);
        expect(TRACK_GROUNDS.tarmac.highSpeedSteerTrim).toBe(1);
    });

    it('keeps the car turning after the player lets go, with yaw carry', () => {
        expect(tap({ ...dirt, yawCarry: 0.6 }).afterRelease).toBeGreaterThan(2 * tap(dirt).afterRelease);
    });

    it('takes more speed in a slide, with slide scrub', () => {
        expect(tap({ ...dirt, slideScrub: 1 }).lostKph).toBeGreaterThan(tap(dirt).lostKph + 5);
    });

    it('keeps more speed in a slide, with slide carry', () => {
        expect(tap({ ...dirt, slideCarry: 0.7 }).lostKph).toBeLessThan(tap({ ...dirt, slideCarry: 0 }).lostKph - 5);
    });

    it('never adds speed with slide carry', () => {
        // Reaches top speed, turns the car 30 degrees away from its path,
        // and coasts with no engine. Returns the speed at each frame.
        const coast = (slideCarry) => {
            const ground = { ...dirt, slideCarry };
            const { state, collisionSegments } = createReplaySimulationState(OPEN);
            const step = (g) => updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, OPEN, collisionSegments, g);
            for (let frame = 0; frame < 600; frame++) step(ground);
            state.angle += Math.PI / 6;
            const speeds = [state.cachedSpeed];
            for (let frame = 0; frame < 60; frame++) {
                step({ ...ground, accel: 0 });
                speeds.push(state.cachedSpeed);
            }
            return speeds;
        };
        const full = coast(1);
        for (const speed of full) expect(speed).toBeCloseTo(full[0], 9);
        const none = coast(0);
        expect(none[none.length - 1]).toBeLessThan(none[0] * 0.9);
    });

    // Reaches top speed, then steers right for the given number of frames.
    // Returns the widest slide angle, and how far the car goes to the side.
    function holdTurn(ground, frames) {
        const { state, collisionSegments } = createReplaySimulationState(OPEN);
        let widestSlide = 0;
        let startY = 0;
        let sideways = 0;
        for (let frame = 0; frame < 600 + frames; frame++) {
            state.keys.right = frame >= 600;
            updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, OPEN, collisionSegments, ground);
            if (frame === 599) startY = state.pos.y;
            if (frame < 600) continue;
            const slide = Math.atan2(state.velocity.y, state.velocity.x) - state.angle;
            widestSlide = Math.max(widestSlide, Math.abs(Math.atan2(Math.sin(slide), Math.cos(slide))));
            sideways = Math.max(sideways, Math.abs(state.pos.y - startY));
        }
        return { widestSlide, sideways };
    }

    it('slides about half as wide on grip as on tarmac', () => {
        expect(holdTurn(TRACK_GROUNDS.grip, 30).widestSlide)
            .toBeLessThan(holdTurn(TRACK_GROUNDS.tarmac, 30).widestSlide * 0.6);
    });

    it('changes the line after a tap about as smoothly on grip as on tarmac', () => {
        // Reaches top speed, taps right for 8 frames, then lets go. Returns
        // the fastest turn of the car's line, in radians each second.
        const fastestLineTurn = (ground) => {
            const { state, collisionSegments } = createReplaySimulationState(OPEN);
            let fastest = 0;
            let lastLine = 0;
            for (let frame = 0; frame < 660; frame++) {
                state.keys.right = frame >= 600 && frame < 608;
                updateSimulation(state, CONFIG.fixedDt, { ...CONFIG }, OPEN, collisionSegments, ground);
                const line = Math.atan2(state.velocity.y, state.velocity.x);
                const turn = Math.atan2(Math.sin(line - lastLine), Math.cos(line - lastLine));
                if (frame >= 600) fastest = Math.max(fastest, Math.abs(turn) / CONFIG.fixedDt);
                lastLine = line;
            }
            return fastest;
        };
        const tarmac = fastestLineTurn(TRACK_GROUNDS.tarmac);
        expect(fastestLineTurn(TRACK_GROUNDS.grip)).toBeLessThan(tarmac * 1.3);
        // With the tarmac turn response, the grip car's line turns too fast.
        const quick = { ...TRACK_GROUNDS.grip, angularResponse: 1 };
        expect(fastestLineTurn(quick)).toBeGreaterThan(tarmac * 1.3);
    });

    it('keeps a U-turn on grip within 20% of the tarmac width', () => {
        const tarmac = holdTurn(TRACK_GROUNDS.tarmac, 120).sideways;
        expect(holdTurn(TRACK_GROUNDS.grip, 120).sideways).toBeLessThan(tarmac * 1.2);
    });

    it('turns the car less at top speed, with a larger high speed steer trim', () => {
        expect(tap({ ...dirt, highSpeedSteerTrim: 1.5 }).turned).toBeLessThan(tap(dirt).turned * 0.85);
    });
});

describe('snow driving', () => {
    it('is slower than dirt, which is slower than tarmac', () => {
        const snow = TRACK_GROUNDS.snow;
        const dirt = TRACK_GROUNDS.dirt;
        expect(snow.grip).toBeLessThan(dirt.grip);
        expect(snow.maxSpeed).toBeLessThan(dirt.maxSpeed);
        // Snow speeds up as fast as dirt. Less grip and a lower top speed make it slower.
        expect(snow.accel).toBeLessThanOrEqual(dirt.accel);

        // The snow track. On the short Classic Circuit, the autopilot laps snow
        // a little faster than dirt.
        const track = TRACKS.snowCircuit;
        const tarmacRun = driveAutopilot({ ...track, ground: 'tarmac' });
        const dirtRun = driveAutopilot({ ...track, ground: 'dirt' });
        const snowRun = driveAutopilot({ ...track, ground: 'snow' });
        expect(snowRun.winData.lapTime).toBeGreaterThan(dirtRun.winData.lapTime);
        expect(dirtRun.winData.lapTime).toBeGreaterThan(tarmacRun.winData.lapTime);
    });

    it.each([
        { trackKey: 'circuit', laps: 1 },
        { trackKey: 'carbonBend', laps: 1 },
        { trackKey: 'circuit', laps: 2 },
    ])('gets the same $trackKey time from the server check on snow ($laps lap)', ({ trackKey, laps }) => {
        const snowTrack = { ...TRACKS[trackKey], ground: 'snow' };
        const snowRun = driveAutopilot(snowTrack, { laps });
        expect(snowRun.winData).not.toBeNull();

        const outcome = validateDailyGpReplayDetailed({
            challenge: createChallenge(trackKey, laps),
            replay: snowRun.replay,
            track: snowTrack,
        });
        expect(outcome.ok).toBe(true);
        expect(outcome.run.bestTimeSec).toBe(snowRun.winData.lapTime);
    });
});

describe('grip driving', () => {
    it('has more grip, and at least the tarmac speed and acceleration', () => {
        const grip = TRACK_GROUNDS.grip;
        expect(grip.grip).toBeGreaterThan(1);
        expect(grip.accel).toBeGreaterThanOrEqual(1);
        expect(grip.maxSpeed).toBeGreaterThanOrEqual(1);
    });

    it.each([
        { trackKey: 'circuit', laps: 1 },
        { trackKey: 'carbonBend', laps: 1 },
        { trackKey: 'circuit', laps: 2 },
    ])('gets the same $trackKey time from the server check on grip ($laps lap)', ({ trackKey, laps }) => {
        const gripTrack = { ...TRACKS[trackKey], ground: 'grip' };
        const gripRun = driveAutopilot(gripTrack, { laps });
        expect(gripRun.winData).not.toBeNull();

        const outcome = validateDailyGpReplayDetailed({
            challenge: createChallenge(trackKey, laps),
            replay: gripRun.replay,
            track: gripTrack,
        });
        expect(outcome.ok).toBe(true);
        expect(outcome.run.bestTimeSec).toBe(gripRun.winData.lapTime);
    });
});

describe('ground tracks and the replay frame limit', () => {
    const limitSec = REPLAY_FRAMES_PER_LAP * CONFIG.fixedDt;

    it('keeps a bronze lap on every ground track well under the replay frame limit', () => {
        for (const [trackKey, track] of Object.entries(TRACKS)) {
            if (getStoredTrackGroundKey(track) === null) continue;
            const thresholds = getTrackMedalThresholds(trackKey);
            expect(thresholds, `${trackKey} needs medal times`).toBeTruthy();
            expect(thresholds.bronze, trackKey).toBeLessThan(limitSec * 0.6);
        }
    });

    it('keeps long existing tracks drivable on dirt inside the frame limit', () => {
        for (const trackKey of ['kettleRun', 'cedarRidgeCircuit', 'alloyRing']) {
            const run = driveAutopilot({ ...TRACKS[trackKey], ground: 'dirt' });
            expect(run.winData, trackKey).not.toBeNull();
            expect(run.frames, trackKey).toBeLessThan(REPLAY_FRAMES_PER_LAP * 0.6);
        }
    });
});
