import { describe, expect, it } from 'vitest';
import { validateTrackQuality } from '../game/track/authoring/track-quality.js';
import {
    buildRoadFromLine,
    buildTrackFromLoop,
    normalizeTrackLayout,
    startOnLoop,
} from '../tools/mapmaker/road-build.js';
import { buildRoadLine } from '../tools/mapmaker/road-line.js';
import { DEFAULT_DRAW_WIDTH } from '../tools/mapmaker/track-source.js';

// An L-shaped road, as Draw gets it: the points you place, in order.
const drawn = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 },
    { x: 25, y: 20 }, { x: 25, y: 40 }, { x: 0, y: 40 },
];

function drawTrack(cornerRadius = 3) {
    const built = buildTrackFromLoop(drawn, DEFAULT_DRAW_WIDTH, cornerRadius);
    return {
        ...built,
        roadLine: buildRoadLine(drawn, built.normalizationOffset, DEFAULT_DRAW_WIDTH),
    };
}

function rebuild(track, roadLine = track.roadLine) {
    return buildRoadFromLine(roadLine, {
        cornerRadius: track.cornerRadius,
        startLine: track.startLine,
        startAngle: track.startAngle,
    });
}

function largestGap(first, second) {
    expect(first.length).toBe(second.length);
    return Math.max(...first.map((point, index) => Math.hypot(point.x - second[index].x, point.y - second[index].y)));
}

function midpointOf(gate) {
    return { x: (gate.p1.x + gate.p2.x) / 2, y: (gate.p1.y + gate.p2.y) / 2 };
}

describe('road built from a saved road line', () => {
    it('builds the same walls and gates as Draw', () => {
        const track = drawTrack();
        const built = rebuild(track);
        expect(largestGap(built.outer, track.outer)).toBeLessThan(1e-9);
        expect(largestGap(built.inner, track.inner)).toBeLessThan(1e-9);
        expect(largestGap(
            built.checkpoints.flatMap((gate) => [gate.p1, gate.p2]),
            track.checkpoints.flatMap((gate) => [gate.p1, gate.p2]),
        )).toBeLessThan(0.05);
        expect(Math.hypot(built.startPos.x - track.startPos.x, built.startPos.y - track.startPos.y)).toBeLessThan(0.05);
    });

    it('moves the road with a bend, keeps the start in place, and passes the track checks', () => {
        const track = drawTrack();
        const points = track.roadLine.points.map((point, index) => (
            index === 2 ? { x: point.x + 6, y: point.y + 4 } : point
        ));
        const built = rebuild(track, { ...track.roadLine, points });
        expect(built).not.toBeNull();
        // The corner at the far end of the road does not move.
        const far = track.roadLine.points[5];
        const near = (point) => Math.hypot(point.x - far.x, point.y - far.y) < DEFAULT_DRAW_WIDTH * 2;
        expect(largestGap(built.outer.filter(near), track.outer.filter(near))).toBeLessThan(1e-9);
        expect(Math.max(...built.outer.map((point) => point.x))).toBeGreaterThan(
            Math.max(...track.outer.map((point) => point.x)) + 3,
        );
        const startShift = Math.hypot(
            midpointOf(built.startLine).x - midpointOf(track.startLine).x,
            midpointOf(built.startLine).y - midpointOf(track.startLine).y,
        );
        expect(startShift).toBeLessThan(DEFAULT_DRAW_WIDTH);
        const issues = validateTrackQuality({ ...track, ...built }).issues.filter((issue) => issue.severity === 'error');
        expect(issues).toEqual([]);
    });

    it('gives a bend its own rounding, and leaves the other corners as they are', () => {
        const track = drawTrack();
        const points = track.roadLine.points.map((point, index) => (index === 1 ? { ...point, cornerRadius: 5 } : point));
        const built = rebuild(track, { ...track.roadLine, points });
        const rounded = [...built.outer, ...built.inner].filter((point) => point.cornerRadius === 5);
        expect(rounded).toHaveLength(1);
        const nearestBend = track.roadLine.points.reduce((best, point, index) => (
            Math.hypot(point.x - rounded[0].x, point.y - rounded[0].y)
                < Math.hypot(track.roadLine.points[best].x - rounded[0].x, track.roadLine.points[best].y - rounded[0].y)
                ? index : best
        ), 0);
        expect(nearestBend).toBe(1);
        // The corner across the road from bend 4 does not change.
        const far = track.roadLine.points[4];
        const near = (point) => Math.hypot(point.x - far.x, point.y - far.y) < DEFAULT_DRAW_WIDTH * 2;
        expect(largestGap(built.inner.filter(near), track.inner.filter(near))).toBeLessThan(1e-9);
    });

    it('gives nothing when the line cannot make a road', () => {
        const track = drawTrack();
        const tooShort = { ...track.roadLine, points: [{ x: 5, y: 5 }, { x: 7, y: 5 }, { x: 6, y: 6 }] };
        expect(rebuild(track, tooShort)).toBeNull();
        expect(rebuild(track, { ...track.roadLine, width: 0 })).toBeNull();
    });

    it('moves the road line and keeps each rounding when the track moves from the edge', () => {
        const track = drawTrack();
        const shifted = {
            ...track,
            outer: track.outer.map((point) => ({ ...point, x: point.x - 10 })),
            roadLine: { ...track.roadLine, points: track.roadLine.points.map((point, index) => (
                index === 0 ? { ...point, x: point.x - 10, cornerRadius: 5 } : { ...point, x: point.x - 10 }
            )) },
        };
        shifted.outer[0].cornerRadius = 1.5;
        const normalized = normalizeTrackLayout(shifted);
        expect(normalized.normalizationOffset.x).toBeGreaterThan(0);
        expect(normalized.roadLine.points[0].cornerRadius).toBe(5);
        expect(normalized.outer[0].cornerRadius).toBe(1.5);
        expect(normalized.roadLine.points[1].x).toBeCloseTo(shifted.roadLine.points[1].x + normalized.normalizationOffset.x);
    });

    it('finds which way the start car faces along the road', () => {
        const track = drawTrack();
        const built = rebuild(track);
        const forward = startOnLoop(built.centerline, track.startLine, track.startAngle);
        const backward = startOnLoop(built.centerline, track.startLine, track.startAngle + Math.PI);
        expect(forward.direction).toBe(-backward.direction);
        expect(forward.startDistance).toBeCloseTo(backward.startDistance);
        expect(startOnLoop(built.centerline, null, 0)).toBeNull();
    });
});
