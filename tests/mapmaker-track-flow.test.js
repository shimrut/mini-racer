import { describe, expect, it } from 'vitest';
import { TRACKS } from '../game/track/tracks.js';
import {
    analyzeTrackFlow,
    FLOW_DRAW_GUIDE,
    FLOW_LIMITS,
    measureStraights,
    summarizeDriveFlow,
} from '../tools/mapmaker/track-flow.js';

const TOP_SPEED = 15.5;

const FLOWY = ['doubleCrest', 'anvilCircuit', 'sharkBite', 'ovenMitt', 'whistleRidge', 'safariCircuit'];

// Tracks judged not flowy in play, and the rule each one misses. Winding Road and
// Hook Loop were judged too, but they were reshaped after that on 2026-09-25.
const NOT_FLOWY = {
    slateCircuit: 'flow-left-right',
    puppetMaster: 'flow-beat',
    twinRise: 'flow-steer-gap',
    alloyRing: 'flow-steer-gap',
    groundControl: 'flow-width',
    greatBazaar: 'flow-corner-speed',
};

function pointInLoop(point, loop) {
    let inside = false;
    for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
        const a = loop[index];
        const b = loop[previous];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

describe('Mapmaker flow check', () => {
    it.each(FLOWY)('passes every rule on %s', (key) => {
        const report = analyzeTrackFlow(TRACKS[key]);
        expect(report.rules.filter((rule) => !rule.pass).map((rule) => rule.message)).toEqual([]);
        expect(report.passed).toBe(5);
    });

    it.each(Object.entries(NOT_FLOWY))('flags %s on %s', (key, code) => {
        const report = analyzeTrackFlow(TRACKS[key]);
        const failed = report.rules.find((rule) => rule.code === code);
        expect(failed.pass).toBe(false);
        expect(report.passed).toBeLessThan(5);
    });

    it('marks each missed rule at a point on the road', () => {
        const track = TRACKS.greatBazaar;
        const report = analyzeTrackFlow(track);
        for (const rule of report.rules) {
            if (rule.pass) {
                expect(rule.hotspot).toBeNull();
                continue;
            }
            expect(Number.isFinite(rule.hotspot.x) && Number.isFinite(rule.hotspot.y)).toBe(true);
            expect(pointInLoop(rule.hotspot, track.outer)).toBe(true);
        }
    });

    it('gives the same answer every time', () => {
        const first = analyzeTrackFlow(TRACKS.sharkBite);
        const second = analyzeTrackFlow(TRACKS.sharkBite);
        expect(second.metrics).toEqual(first.metrics);
    });

    it('names a failing value that differs from its target', () => {
        const report = analyzeTrackFlow(TRACKS.puppetMaster);
        const beat = report.rules.find((rule) => rule.code === 'flow-beat');
        expect(report.metrics.inputsPerSec).toBeLessThan(FLOW_LIMITS.minInputsPerSec);
        expect(beat.detail).toBe('A new steering input only every 2.1 s. Aim for 1.4 s or less. Add bends.');
    });

    it('skips a track without closed walls', () => {
        expect(analyzeTrackFlow({ outer: [], inner: [] })).toBeNull();
        expect(analyzeTrackFlow(null)).toBeNull();
    });
});

describe('Line Build straight guide', () => {
    it('measures an open sketch end to end', () => {
        const runs = measureStraights([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
        expect(runs).toHaveLength(1);
        expect(runs[0].length).toBeCloseTo(20);
    });

    it('splits a square at its corners and trims the rounded bends', () => {
        const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
        const runs = measureStraights(square, { closed: true, halfWidth: 1.925 });
        expect(runs).toHaveLength(4);
        for (const run of runs) {
            expect(run.length).toBeCloseTo(20 - 2 * 1.925);
            expect(run.length).toBeGreaterThan(FLOW_DRAW_GUIDE.maxStraight);
        }
    });

    it('breaks a run at a sharp corner between long segments', () => {
        const runs = measureStraights([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], { halfWidth: 1.925 });
        expect(runs.map((run) => Math.round(run.length))).toEqual([38, 38]);
    });

    it('treats a wide curve as a stretch without steering', () => {
        const circle = Array.from({ length: 36 }, (_, index) => ({
            x: 30 * Math.cos((index / 36) * Math.PI * 2),
            y: 30 * Math.sin((index / 36) * Math.PI * 2),
        }));
        const runs = measureStraights(circle, { closed: true, halfWidth: 1.925 });
        expect(runs).toHaveLength(1);
        expect(runs[0].closedLoop).toBe(true);
    });
});

describe('Test Drive lap flow', () => {
    function drive(pattern, seconds, dt = 1 / 60) {
        const samples = [];
        for (let time = 0; time < seconds; time += dt) {
            samples.push({ time, speed: Math.min(TOP_SPEED, time * 20), steer: pattern(time) });
        }
        return samples;
    }

    it('reads a steady left-right rhythm', () => {
        // After launch: 0.5 s left, 0.3 s straight, 0.5 s right, 0.3 s straight, and so on.
        const summary = summarizeDriveFlow(drive((time) => {
            if (time < 1) return 0;
            const phase = (time - 1) % 1.6;
            if (phase < 0.5) return -1;
            if (phase >= 0.8 && phase < 1.3) return 1;
            return 0;
        }, 9));
        expect(summary.switchShare).toBe(1);
        expect(summary.inputsPerSec).toBeGreaterThan(1);
        expect(summary.steerFreeSec).toBeLessThan(FLOW_LIMITS.maxSteerFreeSec);
        expect(summary.pass).toEqual({ corner: true, steerGap: true, beat: true, leftRight: true });
    });

    it('counts quick taps on one side as one input', () => {
        const summary = summarizeDriveFlow(drive((time) => (time > 2 && time < 3 && (time * 10) % 1 < 0.5 ? 1 : 0), 4));
        expect(summary.inputsPerSec * (4 - 0.4)).toBeCloseTo(1, 0);
    });

    it('skips a drive that never gets up to speed', () => {
        expect(summarizeDriveFlow([{ time: 0, speed: 0, steer: 0 }, { time: 1, speed: 2, steer: 1 }])).toBeNull();
    });
});
