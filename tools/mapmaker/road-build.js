import { clonePoint, distance, midpoint } from '../geometry.js';
import { buildAutoGates, closedLoopLength, nearestDistanceAlongLoop } from './auto-gates.js';
import { buildRibbonWallsFromCenterline, findCornerWallGroups, fitCurvesToCorners } from './ribbon-walls.js';
import { isValidRoadLine } from './road-line.js';

// How Draw turns a closed line of points into a road: the walls, the start
// and the checkpoints. A track with a saved road line is built again the same
// way each time a bend moves.

export const DEFAULT_LINE_SMOOTHING = 0.35;

export function dedupeStrokePoints(points, minimumDistance) {
    if (!points.length) {
        return [];
    }
    const filtered = [clonePoint(points[0])];
    for (let index = 1; index < points.length; index += 1) {
        if (distance(points[index], filtered[filtered.length - 1]) >= minimumDistance) {
            filtered.push(clonePoint(points[index]));
        }
    }
    if (filtered.length === 1 && points.length > 1) {
        filtered.push(clonePoint(points[points.length - 1]));
    }
    return filtered;
}

export function smoothLoopPoints(points) {
    const smoothing = DEFAULT_LINE_SMOOTHING;
    if (points.length < 3 || smoothing <= 0) {
        return points.map(clonePoint);
    }

    const neighborWeight = smoothing * 0.2;
    const pointWeight = 1 - neighborWeight * 2;
    return points.map((point, index) => {
        const prev = points[(index - 1 + points.length) % points.length];
        const next = points[(index + 1) % points.length];
        return {
            x: prev.x * neighborWeight + point.x * pointWeight + next.x * neighborWeight,
            y: prev.y * neighborWeight + point.y * pointWeight + next.y * neighborWeight
        };
    });
}

export function smoothOpenPoints(points) {
    const smoothing = DEFAULT_LINE_SMOOTHING;
    if (points.length < 3 || smoothing <= 0) return points.map(clonePoint);
    const neighborWeight = smoothing * 0.2;
    const pointWeight = 1 - neighborWeight * 2;
    return points.map((point, index) => {
        if (index === 0 || index === points.length - 1) return clonePoint(point);
        const prev = points[index - 1];
        const next = points[index + 1];
        return {
            x: prev.x * neighborWeight + point.x * pointWeight + next.x * neighborWeight,
            y: prev.y * neighborWeight + point.y * pointWeight + next.y * neighborWeight,
        };
    });
}

// A moved point keeps its corner rounding.
function offsetTrackLayout(layout, offsetX, offsetY) {
    const movePoint = (point) => ({
        ...point,
        x: point.x + offsetX,
        y: point.y + offsetY
    });
    return {
        ...layout,
        outer: layout.outer.map(movePoint),
        inner: layout.inner.map(movePoint),
        startLine: {
            p1: movePoint(layout.startLine.p1),
            p2: movePoint(layout.startLine.p2)
        },
        startPos: movePoint(layout.startPos),
        checkpoints: layout.checkpoints.map((checkpoint) => ({
            p1: movePoint(checkpoint.p1),
            p2: movePoint(checkpoint.p2)
        })),
        centerline: layout.centerline?.map(movePoint),
        ...(layout.roadLine ? { roadLine: { ...layout.roadLine, points: layout.roadLine.points.map(movePoint) } } : {}),
    };
}

// Moves the whole track, its road line too, so that no race point is less
// than `padding` from the top or the left edge.
export function normalizeTrackLayout(layout, padding = 4) {
    const points = [
        ...layout.outer,
        ...layout.inner,
        layout.startLine.p1,
        layout.startLine.p2,
        layout.startPos,
        ...layout.checkpoints.flatMap((checkpoint) => [checkpoint.p1, checkpoint.p2])
    ];
    let minX = Infinity;
    let minY = Infinity;
    points.forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
    });
    const offsetX = minX < padding ? padding - minX : 0;
    const offsetY = minY < padding ? padding - minY : 0;
    const normalized = offsetX === 0 && offsetY === 0
        ? layout
        : offsetTrackLayout(layout, offsetX, offsetY);
    return { ...normalized, normalizationOffset: { x: offsetX, y: offsetY } };
}

// Each kept bend of the smoothed line, with the rounding of its drawn point.
function lineBends(rawPoints, kept, centerline) {
    let from = 0;
    return kept.map((point, index) => {
        while (from < rawPoints.length
            && (rawPoints[from].x !== point.x || rawPoints[from].y !== point.y)) {
            from += 1;
        }
        const radius = rawPoints[from]?.cornerRadius;
        from += 1;
        return { at: centerline[index], radius: Number.isFinite(radius) ? radius : null };
    });
}

// A bend with its own rounding gives it to the sharp wall point of its corner:
// the corner point that is nearest to that bend.
function giveBendRoundings(walls, bends, trackWidth) {
    if (!bends.some((bend) => bend.radius !== null)) return;
    for (const { pivot } of findCornerWallGroups(walls.outer, walls.inner, trackWidth)) {
        const point = walls[pivot.path][pivot.index];
        const nearest = bends.reduce((best, bend) => (
            distance(bend.at, point) < distance(best.at, point) ? bend : best
        ));
        if (nearest.radius !== null) point.cornerRadius = nearest.radius;
    }
}

export function buildRoadWallsFromLoop(rawPoints, trackWidth, cornerRadius) {
    const filtered = dedupeStrokePoints(rawPoints, 0.35);
    if (filtered.length < 3) {
        return null;
    }

    const centerline = smoothLoopPoints(filtered);
    const loopLength = closedLoopLength(centerline);
    if (loopLength < trackWidth * 5) {
        return null;
    }

    const walls = buildRibbonWallsFromCenterline(centerline, trackWidth / 2);
    if (!walls) {
        return null;
    }
    giveBendRoundings(walls, lineBends(rawPoints, filtered, centerline), trackWidth);
    return {
        ...walls,
        ...fitCurvesToCorners(walls.outer, walls.inner, cornerRadius, trackWidth),
    };
}

export function buildTrackFromLoop(rawPoints, trackWidth, cornerRadius) {
    const walls = buildRoadWallsFromLoop(rawPoints, trackWidth, cornerRadius);
    if (!walls) {
        return null;
    }
    const { outer, inner } = walls;
    const gates = buildAutoGates(walls.centerline, outer, inner, trackWidth, { cornerRadius });
    if (!gates) return null;
    return normalizeTrackLayout({
        outer: outer.map(clonePoint),
        inner: inner.map(clonePoint),
        startLine: gates.startLine,
        startPos: gates.startPos,
        startAngle: gates.startAngle,
        checkpoints: gates.checkpoints,
        centerline: walls.centerline.map(clonePoint),
        cornerRadius
    });
}

// Where the start line is along the road, and which way the start car faces,
// so that new checkpoints and a rebuilt road keep the start in its place.
export function startOnLoop(centerline, startLine, startAngle) {
    if (!startLine?.p1 || !startLine?.p2) return null;
    const nearest = nearestDistanceAlongLoop(centerline, midpoint(startLine.p1, startLine.p2));
    if (!nearest) return null;
    const heading = { x: Math.cos(startAngle), y: Math.sin(startAngle) };
    const direction = heading.x * nearest.tangent.x + heading.y * nearest.tangent.y < 0 ? -1 : 1;
    return { startDistance: nearest.distance, direction };
}

// The road that a saved road line builds, with the start kept near the given
// start line and new checkpoints. It is not moved from the edges: see
// normalizeTrackLayout. Null when the line cannot make a road.
export function buildRoadFromLine(roadLine, { cornerRadius = 3, startLine = null, startAngle = 0 } = {}) {
    if (!isValidRoadLine(roadLine)) return null;
    const walls = buildRoadWallsFromLoop(roadLine.points, roadLine.width, cornerRadius);
    if (!walls) return null;
    const gates = buildAutoGates(walls.centerline, walls.outer, walls.inner, roadLine.width, {
        cornerRadius,
        ...startOnLoop(walls.centerline, startLine, startAngle),
    });
    if (!gates) return null;
    return {
        outer: walls.outer,
        inner: walls.inner,
        startLine: gates.startLine,
        startPos: gates.startPos,
        startAngle: gates.startAngle,
        checkpoints: gates.checkpoints,
        centerline: walls.centerline,
    };
}
