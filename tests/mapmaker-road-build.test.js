import { describe, expect, it } from 'vitest';
import { validateTrackQuality } from '../game/track/authoring/track-quality.js';
import {
    buildRoadFromLine,
    buildTrackFromLoop,
    normalizeTrackLayout,
    startOnLoop,
} from '../tools/mapmaker/road-build.js';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';
import { buildRoadLine } from '../tools/mapmaker/road-line.js';
import { DEFAULT_DRAW_WIDTH, ROAD_WIDTHS } from '../tools/mapmaker/track-source.js';

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

function gapToWall(point, wall) {
    return Math.min(...wall.map((a, index) => {
        const b = wall[(index + 1) % wall.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
    }));
}

function nearestOnLine(point, line) {
    let best = null;
    line.forEach((a, index) => {
        const b = line[(index + 1) % line.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
        const at = { x: a.x + dx * t, y: a.y + dy * t };
        if (!best || Math.hypot(point.x - at.x, point.y - at.y) < Math.hypot(point.x - best.x, point.y - best.y)) best = at;
    });
    return best;
}

function roadWidthAt(road, point) {
    return gapToWall(point, road.outer) + gapToWall(point, road.inner);
}

// The road width across the middle of the section from one bend to the next.
function sectionWidth(road, line, index) {
    const a = line.points[index];
    const b = line.points[(index + 1) % line.points.length];
    return roadWidthAt(road, nearestOnLine({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, road.centerline));
}

// The largest change of road width between two points 0.25 apart along the road.
function largestWidthStep(road) {
    const points = road.centerline.flatMap((a, index) => {
        const b = road.centerline[(index + 1) % road.centerline.length];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        return Array.from({ length: Math.ceil(length / 0.25) }, (_, step) => ({
            x: a.x + ((b.x - a.x) * step * 0.25) / length,
            y: a.y + ((b.y - a.y) * step * 0.25) / length,
        }));
    });
    const widths = points.map((point) => roadWidthAt(road, point));
    return Math.max(...widths.slice(1).map((width, index) => Math.abs(width - widths[index])));
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

    it('gives a section its own width, from its bend to the next one', () => {
        const track = drawTrack();
        const narrow = ROAD_WIDTHS.find((entry) => entry.value === 'narrow');
        const wide = ROAD_WIDTHS.find((entry) => entry.value === 'wide');
        const line = { ...track.roadLine, width: wide.width };
        const plain = rebuild(track, line);
        const points = line.points.map((point, index) => (index === 0 ? { ...point, width: narrow.width } : point));
        const built = rebuild(track, { ...line, points });
        expect(sectionWidth(plain, line, 0)).toBeCloseTo(wide.width, 1);
        expect(sectionWidth(built, line, 0)).toBeCloseTo(narrow.width, 1);
        // The other sections keep the road width.
        for (const index of [2, 4]) {
            expect(sectionWidth(built, line, index)).toBeCloseTo(sectionWidth(plain, line, index), 6);
        }
        const issues = validateTrackQuality({ ...track, ...built }).issues.filter((issue) => issue.severity === 'error');
        expect(issues).toEqual([]);
    });

    it('changes the width smoothly where two sections meet', () => {
        const track = drawTrack();
        const narrow = ROAD_WIDTHS.find((entry) => entry.value === 'narrow');
        const wide = ROAD_WIDTHS.find((entry) => entry.value === 'wide');
        const line = { ...track.roadLine, width: wide.width };
        const points = line.points.map((point, index) => (index === 0 ? { ...point, width: narrow.width } : point));
        const plain = rebuild(track, line);
        const built = rebuild(track, { ...line, points });
        // The width change makes no larger step than the corners of a road of one width.
        expect(largestWidthStep(built)).toBeLessThanOrEqual(largestWidthStep(plain) + 0.01);
        expect(largestWidthStep(built)).toBeLessThan((wide.width - narrow.width) / 2);
    });

    it('builds the same walls from one width or from equal section widths', () => {
        const centerline = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }];
        const one = buildRibbonWallsFromCenterline(centerline, 2);
        const each = buildRibbonWallsFromCenterline(centerline, [2, 2, 2, 2]);
        expect(each).toEqual(one);
        expect(buildRibbonWallsFromCenterline(centerline, [2, 2, 2])).toBeNull();
    });

    it('keeps a corner between two widths as round as a corner of one width', () => {
        const track = drawTrack();
        const narrow = ROAD_WIDTHS.find((entry) => entry.value === 'narrow');
        const normal = ROAD_WIDTHS.find((entry) => entry.value === 'normal');
        const wide = ROAD_WIDTHS.find((entry) => entry.value === 'wide');
        const line = { ...track.roadLine, width: wide.width };
        // Wall points where the wall turns: the race rounds each one by the
        // corner setting, but never past 1/2.5 of the wall on either side.
        const cornerWalls = (road) => [road.outer, road.inner].flatMap((wall) => wall.flatMap((point, index) => {
            const prev = wall[(index - 1 + wall.length) % wall.length];
            const next = wall[(index + 1) % wall.length];
            const turn = Math.abs(Math.atan2(
                (point.x - prev.x) * (next.y - point.y) - (point.y - prev.y) * (next.x - point.x),
                (point.x - prev.x) * (next.x - point.x) + (point.y - prev.y) * (next.y - point.y),
            ));
            return turn > Math.PI / 6 ? [Math.min(
                Math.hypot(point.x - prev.x, point.y - prev.y),
                Math.hypot(next.x - point.x, next.y - point.y),
            )] : [];
        }));
        const plain = Math.min(...cornerWalls(rebuild(track, line)));
        for (const width of [narrow.width, normal.width]) {
            const points = line.points.map((point, index) => (index === 1 ? { ...point, width } : point));
            const built = rebuild(track, { ...line, points });
            expect(built).not.toBeNull();
            expect(Math.min(...cornerWalls(built))).toBeGreaterThan(plain - 0.5);
        }
    });

    it('gives a bend its own rounding where two widths meet', () => {
        const track = drawTrack();
        const narrow = ROAD_WIDTHS.find((entry) => entry.value === 'narrow');
        const wide = ROAD_WIDTHS.find((entry) => entry.value === 'wide');
        const points = track.roadLine.points.map((point, index) => (
            index === 1 ? { ...point, width: narrow.width, cornerRadius: 5 } : point
        ));
        const built = rebuild(track, { ...track.roadLine, width: wide.width, points });
        const rounded = [...built.outer, ...built.inner].filter((point) => point.cornerRadius === 5);
        expect(rounded).toHaveLength(1);
    });
});
