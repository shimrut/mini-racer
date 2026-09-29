import { CONFIG } from '../../game/config.js';
import { buildTrackGeometry } from '../../game/track/runtime.js';
import { distance, isFinitePoint, midpoint, subtract } from '../geometry.js';
import { buildPerpendicularLaneGate, closestPointOnPolygon } from './lane-gate.js';

const EPSILON = 1e-7;
const SEAM_TOLERANCE = 0.2;
const CAR_RADIUS = CONFIG.carRadius;
const MIN_CHECKPOINTS = 3;

function cross(a, b) {
    return a.x * b.y - a.y * b.x;
}

function segmentIntersection(a, b, c, d) {
    const r = subtract(b, a);
    const s = subtract(d, c);
    const denominator = cross(r, s);
    const offset = subtract(c, a);
    if (Math.abs(denominator) < EPSILON) {
        if (Math.abs(cross(offset, r)) > EPSILON) return null;
        const lengthSq = r.x * r.x + r.y * r.y;
        if (lengthSq < EPSILON) return null;
        const t1 = (offset.x * r.x + offset.y * r.y) / lengthSq;
        const dOffset = subtract(d, a);
        const t2 = (dOffset.x * r.x + dOffset.y * r.y) / lengthSq;
        const low = Math.max(0, Math.min(t1, t2));
        const high = Math.min(1, Math.max(t1, t2));
        if (low > high + EPSILON) return null;
        const t = (low + high) / 2;
        return { point: { x: a.x + r.x * t, y: a.y + r.y * t }, t, overlap: high - low > EPSILON };
    }
    const t = cross(offset, s) / denominator;
    const u = cross(offset, r) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
    return { point: { x: a.x + r.x * t, y: a.y + r.y * t }, t, u, overlap: false };
}

function withoutDuplicateCorners(polygon) {
    return polygon.filter((point, index) => distance(point, polygon[(index + 1) % polygon.length]) > EPSILON);
}

function polygonArea(polygon) {
    return Math.abs(polygon.reduce((sum, point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        return sum + point.x * next.y - next.x * point.y;
    }, 0)) / 2;
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[index];
        const b = polygon[previous];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

function onRoad(point, outer, inner) {
    return pointInPolygon(point, outer) && !pointInPolygon(point, inner);
}

function firstSelfIntersection(polygon) {
    for (let i = 0; i < polygon.length; i += 1) {
        for (let j = i + 1; j < polygon.length; j += 1) {
            if (j === i + 1 || (i === 0 && j === polygon.length - 1)) continue;
            const hit = segmentIntersection(
                polygon[i], polygon[(i + 1) % polygon.length],
                polygon[j], polygon[(j + 1) % polygon.length],
            );
            if (hit && [polygon[i], polygon[(i + 1) % polygon.length], polygon[j], polygon[(j + 1) % polygon.length]]
                .every((endpoint) => distance(hit.point, endpoint) > SEAM_TOLERANCE)) return hit.point;
        }
    }
    return null;
}

function wallGap(outer, inner) {
    let best = { distance: Infinity, hotspot: null, crossed: false };
    for (let i = 0; i < outer.length; i += 1) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        for (let j = 0; j < inner.length; j += 1) {
            const c = inner[j];
            const d = inner[(j + 1) % inner.length];
            const hit = segmentIntersection(a, b, c, d);
            if (hit) return { distance: 0, hotspot: hit.point, crossed: true };
            for (const point of [a, b]) {
                const closest = closestPointOnSegment(point, c, d);
                if (closest.distance < best.distance) best = { distance: closest.distance, hotspot: midpoint(point, closest.point), crossed: false };
            }
            for (const point of [c, d]) {
                const closest = closestPointOnSegment(point, a, b);
                if (closest.distance < best.distance) best = { distance: closest.distance, hotspot: midpoint(point, closest.point), crossed: false };
            }
        }
    }
    return best;
}

function closestPointOnSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > EPSILON
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq))
        : 0;
    const closest = { x: a.x + dx * t, y: a.y + dy * t };
    return { point: closest, distance: distance(point, closest) };
}

function gateWallHits(gate, polygon) {
    const hits = [];
    for (let index = 0; index < polygon.length; index += 1) {
        const hit = segmentIntersection(gate.p1, gate.p2, polygon[index], polygon[(index + 1) % polygon.length]);
        if (!hit) continue;
        if (hits.some((existing) => distance(existing.point, hit.point) < 0.001)) continue;
        hits.push({ ...hit, segmentIndex: index, wallFraction: hit.u });
    }
    return hits;
}

function issue(code, severity, title, detail, hotspot = null) {
    return { code, severity, title, detail, message: `${title}: ${detail}`, hotspot };
}

function checkGate(label, code, gate, outer, inner, issues) {
    if (!isFinitePoint(gate?.p1) || !isFinitePoint(gate?.p2) || distance(gate.p1, gate.p2) < 0.25) {
        issues.push(issue(`${code}-invalid`, 'error', `${label} is incomplete`, 'Place a line with two distinct endpoints.', isFinitePoint(gate?.p1) ? gate.p1 : null));
        return null;
    }
    const middle = midpoint(gate.p1, gate.p2);
    const outerHits = gateWallHits(gate, outer);
    const innerHits = gateWallHits(gate, inner);
    if (!outerHits.length || !innerHits.length || !onRoad(middle, outer, inner)
        || outerHits.some((hit) => hit.overlap) || innerHits.some((hit) => hit.overlap)) {
        issues.push(issue(`${code}-corridor`, 'error', `${label} misses the lane`, 'The gate must cross both walls, with its midpoint on the road.', middle));
        return null;
    }
    if (outerHits.length > 1 || innerHits.length > 1) {
        issues.push(issue(`${code}-multi-hit`, 'warning', `${label} crosses a wall more than once`, 'Move the gate to a simpler part of the road if it can trigger in two places.', middle));
    }
    for (const endpoint of [gate.p1, gate.p2]) {
        if (!onRoad(endpoint, outer, inner)) continue;
        const gap = Math.min(
            closestPointOnPolygon(endpoint, outer).distance,
            closestPointOnPolygon(endpoint, inner).distance,
        );
        if (gap > CAR_RADIUS + EPSILON) {
            issues.push(issue(`${code}-gap`, 'error', `${label} leaves a gap`, 'Extend the gate past both walls so a car cannot bypass it.', endpoint));
            break;
        }
    }
    return outerHits.length === 1 ? outerHits[0] : null;
}

export function validateGateOnWalls(gate, outer, inner) {
    const issues = [];
    checkGate('Gate', 'gate', gate, outer, inner, issues);
    return issues;
}

function perimeterProgress(polygon, hit) {
    let progress = 0;
    for (let index = 0; index < hit.segmentIndex; index += 1) {
        progress += distance(polygon[index], polygon[(index + 1) % polygon.length]);
    }
    const segmentStart = polygon[hit.segmentIndex];
    const segmentEnd = polygon[(hit.segmentIndex + 1) % polygon.length];
    return progress + distance(segmentStart, segmentEnd) * Math.max(0, Math.min(1, hit.wallFraction));
}

function pointAtPerimeterProgress(polygon, progress) {
    let remaining = progress;
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index];
        const b = polygon[(index + 1) % polygon.length];
        const length = distance(a, b);
        if (remaining <= length) {
            const t = length > EPSILON ? remaining / length : 0;
            return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
        remaining -= length;
    }
    return { ...polygon[0] };
}

// Measures the lap along the outer wall from the finish, in the driving
// direction. An alignment under 0.25 means the start heading points across the
// road, so the direction is unknown.
function measureLap(outer, finishHit, startAngle) {
    const outerLength = outer.reduce((sum, point, index) => sum + distance(point, outer[(index + 1) % outer.length]), 0);
    const a = outer[finishHit.segmentIndex];
    const b = outer[(finishHit.segmentIndex + 1) % outer.length];
    const heading = { x: Math.cos(startAngle), y: Math.sin(startAngle) };
    const tangent = { x: (b.x - a.x) / distance(a, b), y: (b.y - a.y) / distance(a, b) };
    const alignment = heading.x * tangent.x + heading.y * tangent.y;
    const direction = Math.sign(alignment);
    const finishProgress = perimeterProgress(outer, finishHit);
    const wrap = (value) => ((value % outerLength) + outerLength) % outerLength;
    return {
        alignment,
        outerLength,
        fromFinish: (hit) => wrap(direction * (perimeterProgress(outer, hit) - finishProgress)),
        pointAt: (fromFinish) => pointAtPerimeterProgress(outer, wrap(finishProgress + direction * fromFinish)),
    };
}

// Tried in turn until a gate crosses the road cleanly: the middle of the stretch first.
const NEW_CHECKPOINT_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];

/**
 * Places a new checkpoint in the longest stretch of the lap without a gate:
 * finish to the first checkpoint, one checkpoint to the next, or the last
 * checkpoint to the finish. Returns its list position and the gate. Null when a
 * gate misses the road, the start heading points across the road, the
 * checkpoints are out of order, or no clean gate fits in that stretch.
 */
export function placeCheckpointInLongestGap(track) {
    if (!Number.isFinite(track?.startAngle)) return null;
    const geometry = buildTrackGeometry(track);
    const outer = withoutDuplicateCorners(geometry.outer);
    const inner = withoutDuplicateCorners(geometry.inner);
    const ignored = [];
    const finishHit = checkGate('Finish line', 'finish', track.startLine, outer, inner, ignored);
    const checkpointHits = (track.checkpoints ?? []).map((checkpoint) => (
        checkGate('Checkpoint', 'checkpoint', checkpoint, outer, inner, ignored)
    ));
    if (!finishHit || !checkpointHits.every(Boolean)) return null;
    const lap = measureLap(outer, finishHit, track.startAngle);
    if (Math.abs(lap.alignment) < 0.25) return null;
    const stops = [0, ...checkpointHits.map(lap.fromFinish), lap.outerLength];
    let best = null;
    for (let index = 0; index < stops.length - 1; index += 1) {
        const length = stops[index + 1] - stops[index];
        if (length <= 0) return null;
        if (!best || length > best.end - best.start) best = { index, start: stops[index], end: stops[index + 1] };
    }
    for (const spot of NEW_CHECKPOINT_SPOTS) {
        const onOuter = lap.pointAt(best.start + (best.end - best.start) * spot);
        const seed = midpoint(onOuter, closestPointOnPolygon(onOuter, inner).closest);
        const checkpoint = buildPerpendicularLaneGate(seed, track.outer, track.inner);
        if (!checkpoint) continue;
        const gateIssues = [];
        const hit = checkGate('Checkpoint', 'checkpoint', checkpoint, outer, inner, gateIssues);
        if (!hit || gateIssues.length) continue;
        const fromFinish = lap.fromFinish(hit);
        if (fromFinish > best.start + 0.25 && fromFinish < best.end - 0.25) {
            return { index: best.index, checkpoint };
        }
    }
    return null;
}

/**
 * Validate a Mapmaker draft against the race collision walls and lap gates.
 * Errors make a track unplayable; warnings flag risky but potentially intentional layouts.
 */
export function validateTrackQuality(track) {
    const issues = [];
    const rawOuter = track?.outer;
    const rawInner = track?.inner;
    if (!Array.isArray(rawOuter) || rawOuter.length < 3 || rawOuter.some((point) => !isFinitePoint(point))) {
        issues.push(issue('outer-invalid', 'error', 'Outer wall is incomplete', 'Draw at least three points with valid coordinates.'));
    }
    if (!Array.isArray(rawInner) || rawInner.length < 3 || rawInner.some((point) => !isFinitePoint(point))) {
        issues.push(issue('inner-invalid', 'error', 'Inner wall is incomplete', 'Draw at least three points with valid coordinates.'));
    }
    if (issues.length) return { issues, hasErrors: true, minClearance: null };

    const rawCrossing = firstSelfIntersection(withoutDuplicateCorners(rawOuter));
    if (rawCrossing) issues.push(issue('outer-self-intersection', 'error', 'Outer wall crosses itself', 'Move the crossing wall points apart.', rawCrossing));
    const innerCrossing = firstSelfIntersection(withoutDuplicateCorners(rawInner));
    if (innerCrossing) issues.push(issue('inner-self-intersection', 'error', 'Inner wall crosses itself', 'Move the crossing wall points apart.', innerCrossing));

    const geometry = buildTrackGeometry(track);
    const outer = withoutDuplicateCorners(geometry.outer);
    const inner = withoutDuplicateCorners(geometry.inner);
    if (outer.length < 3 || polygonArea(outer) < 0.01) {
        issues.push(issue('outer-degenerate', 'error', 'Outer wall has no enclosed area', 'Separate its points to form a loop.'));
    }
    if (inner.length < 3 || polygonArea(inner) < 0.01) {
        issues.push(issue('inner-degenerate', 'error', 'Inner wall has no enclosed area', 'Separate its points to form a loop.'));
    }
    if (issues.some((entry) => entry.code.endsWith('-degenerate'))) return { issues, hasErrors: true, minClearance: null };
    const smoothedOuterCrossing = firstSelfIntersection(outer);
    if (!rawCrossing && smoothedOuterCrossing) issues.push(issue('outer-runtime-intersection', 'error', 'Rounded outer wall crosses itself', 'Reduce corner rounding or move the wall points.', smoothedOuterCrossing));
    const smoothedInnerCrossing = firstSelfIntersection(inner);
    if (!innerCrossing && smoothedInnerCrossing) issues.push(issue('inner-runtime-intersection', 'error', 'Rounded inner wall crosses itself', 'Reduce corner rounding or move the wall points.', smoothedInnerCrossing));

    const gap = wallGap(outer, inner);
    if (gap.crossed) {
        issues.push(issue('walls-cross', 'error', 'Inner and outer walls cross', 'Move the walls apart to restore a continuous road.', gap.hotspot));
    } else if (inner.some((point) => !pointInPolygon(point, outer))) {
        const hotspot = inner.find((point) => !pointInPolygon(point, outer));
        issues.push(issue('inner-outside', 'error', 'Inner wall leaves the outer wall', 'Keep the inner wall entirely inside the outer wall.', hotspot));
    } else if (gap.distance < CAR_RADIUS * 2 + 0.15) {
        issues.push(issue('road-too-narrow', 'error', 'Road pinches below safe width', `The narrowest gap is ${gap.distance.toFixed(2)} units. Widen it for the car.`, gap.hotspot));
    } else if (gap.distance < 1.2) {
        issues.push(issue('road-narrow', 'warning', 'Road has a narrow section', `The narrowest gap is ${gap.distance.toFixed(2)} units. Test it at racing speed.`, gap.hotspot));
    }

    if (!isFinitePoint(track.startPos)) {
        issues.push(issue('start-invalid', 'error', 'Start position is missing', 'Place the car on the road.'));
    } else if (!onRoad(track.startPos, outer, inner)) {
        issues.push(issue('start-off-road', 'error', 'Start position is off road', 'Move the car between the two walls.', track.startPos));
    } else {
        const clearance = Math.min(
            closestPointOnPolygon(track.startPos, outer).distance,
            closestPointOnPolygon(track.startPos, inner).distance,
        );
        if (clearance < CAR_RADIUS) {
            issues.push(issue('start-collision', 'error', 'Car starts in a wall', 'Move the start position farther from both walls.', track.startPos));
        } else if (clearance < CAR_RADIUS + 0.1) {
            issues.push(issue('start-clearance', 'warning', 'Car starts close to a wall', 'Move it toward the lane center if this is unintentional.', track.startPos));
        }
    }

    const finishHit = checkGate('Finish line', 'finish', track.startLine, outer, inner, issues);
    const checkpoints = Array.isArray(track.checkpoints) ? track.checkpoints : [];
    if (checkpoints.length < MIN_CHECKPOINTS) {
        issues.push(issue('checkpoints-too-few', 'error', 'Too few checkpoints', `Add ${MIN_CHECKPOINTS - checkpoints.length} more.`));
    }
    const checkpointHits = checkpoints.map((checkpoint, index) => (
        checkGate(`Checkpoint ${index + 1}`, `checkpoint-${index + 1}`, checkpoint, outer, inner, issues)
    ));

    if (!Number.isFinite(track.startAngle)) {
        issues.push(issue('heading-invalid', 'error', 'Start heading is missing', 'Set the direction the car should drive.'));
    } else if (finishHit && checkpointHits.every(Boolean) && checkpoints.length) {
        const lap = measureLap(outer, finishHit, track.startAngle);
        if (Math.abs(lap.alignment) < 0.25) {
            issues.push(issue('heading-across-road', 'warning', 'Start heading points across the road', 'Turn the car to face along the road.', track.startPos));
        } else {
            let previous = 0;
            checkpointHits.map(lap.fromFinish).forEach((fromStart, index) => {
                if (fromStart < 0.25 || fromStart > lap.outerLength - 0.25) {
                    issues.push(issue(`checkpoint-${index + 1}-near-finish`, 'error', `Checkpoint ${index + 1} overlaps the finish`, 'Move it farther along the lap.', midpoint(checkpoints[index].p1, checkpoints[index].p2)));
                } else if (fromStart < previous + 0.25) {
                    issues.push(issue(`checkpoint-${index + 1}-order`, 'error', `Checkpoint ${index + 1} is out of order`, 'Place checkpoints in the order the car reaches them from the start heading.', midpoint(checkpoints[index].p1, checkpoints[index].p2)));
                }
                previous = fromStart;
            });
        }
    }

    return { issues, hasErrors: issues.some((entry) => entry.severity === 'error'), minClearance: gap.distance };
}
