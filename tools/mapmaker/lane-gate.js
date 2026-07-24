const SEGMENT_EPSILON = 1e-9;

function clonePoint(point) {
    return { x: Number(point.x), y: Number(point.y) };
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeVector(x, y) {
    const length = Math.hypot(x, y);
    if (length < 0.000001) {
        return { x: 0, y: 0 };
    }
    return { x: x / length, y: y / length };
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y;
}

/**
 * Closest point on a closed polygon to a seed point.
 */
export function closestPointOnPolygon(point, polygon) {
    if (!polygon || polygon.length < 2) {
        return null;
    }

    let best = null;
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index];
        const b = polygon[(index + 1) % polygon.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        let t = 0;
        let closest = clonePoint(a);
        if (lengthSq > 0) {
            t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
            t = Math.max(0, Math.min(1, t));
            closest = {
                x: a.x + dx * t,
                y: a.y + dy * t,
            };
        }
        const dist = distance(point, closest);
        if (!best || dist < best.distance) {
            best = {
                closest,
                distance: dist,
                segmentIndex: index,
                t,
                a: clonePoint(a),
                b: clonePoint(b),
            };
        }
    }
    return best;
}

function segmentIntersectionParams(A, B, C, D) {
    const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
    const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
    const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);
    if (Math.abs(bottom) < SEGMENT_EPSILON) {
        return null;
    }
    const t = tTop / bottom;
    const u = uTop / bottom;
    if (
        t >= -SEGMENT_EPSILON
        && t <= 1 + SEGMENT_EPSILON
        && u >= -SEGMENT_EPSILON
        && u <= 1 + SEGMENT_EPSILON
    ) {
        return { t, u };
    }
    return null;
}

/**
 * Intersections of an infinite line through origin along direction with a polygon.
 */
export function linePolygonIntersections(origin, direction, polygon) {
    if (!polygon || polygon.length < 2) {
        return [];
    }
    const dirLength = Math.hypot(direction.x, direction.y);
    if (dirLength < 0.000001) {
        return [];
    }
    const unit = {
        x: direction.x / dirLength,
        y: direction.y / dirLength,
    };
    // Long segment spanning both directions from origin.
    const span = 10000;
    const lineA = {
        x: origin.x - unit.x * span,
        y: origin.y - unit.y * span,
    };
    const lineB = {
        x: origin.x + unit.x * span,
        y: origin.y + unit.y * span,
    };

    const hits = [];
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index];
        const b = polygon[(index + 1) % polygon.length];
        const params = segmentIntersectionParams(lineA, lineB, a, b);
        if (!params) {
            continue;
        }
        const point = {
            x: lineA.x + (lineB.x - lineA.x) * params.t,
            y: lineA.y + (lineB.y - lineA.y) * params.t,
        };
        hits.push({
            point,
            along: dot({
                x: point.x - origin.x,
                y: point.y - origin.y,
            }, unit),
            segmentIndex: index,
        });
    }
    return hits;
}

function pickClosestHit(hits, origin) {
    if (!hits.length) {
        return null;
    }
    let best = hits[0];
    let bestDistance = distance(origin, best.point);
    for (let index = 1; index < hits.length; index += 1) {
        const candidate = hits[index];
        const dist = distance(origin, candidate.point);
        if (dist < bestDistance) {
            best = candidate;
            bestDistance = dist;
        }
    }
    return best;
}

/**
 * Build a lane-crossing gate (outer→inner) through seedPoint, perpendicular
 * to the nearest outer-wall segment.
 */
export function buildPerpendicularLaneGate(seedPoint, outer, inner) {
    if (!seedPoint || !outer || !inner || outer.length < 3 || inner.length < 3) {
        return null;
    }

    const outerHit = closestPointOnPolygon(seedPoint, outer);
    const innerHit = closestPointOnPolygon(seedPoint, inner);
    if (!outerHit || !innerHit) {
        return null;
    }

    let tangent = normalizeVector(
        outerHit.b.x - outerHit.a.x,
        outerHit.b.y - outerHit.a.y,
    );
    if (tangent.x === 0 && tangent.y === 0) {
        tangent = normalizeVector(
            innerHit.b.x - innerHit.a.x,
            innerHit.b.y - innerHit.a.y,
        );
    }
    if (tangent.x === 0 && tangent.y === 0) {
        return {
            p1: clonePoint(outerHit.closest),
            p2: clonePoint(innerHit.closest),
        };
    }

    let across = { x: -tangent.y, y: tangent.x };
    const toInner = {
        x: innerHit.closest.x - outerHit.closest.x,
        y: innerHit.closest.y - outerHit.closest.y,
    };
    if (dot(across, toInner) < 0) {
        across = { x: -across.x, y: -across.y };
    }

    const outerHits = linePolygonIntersections(seedPoint, across, outer);
    const innerHits = linePolygonIntersections(seedPoint, across, inner);
    const bestOuter = pickClosestHit(outerHits, seedPoint);
    const bestInner = pickClosestHit(innerHits, seedPoint);

    if (!bestOuter || !bestInner) {
        return {
            p1: clonePoint(outerHit.closest),
            p2: clonePoint(innerHit.closest),
        };
    }

    // Keep a usable gate length; degenerate hits fall back to closest wall points.
    if (distance(bestOuter.point, bestInner.point) < 0.05) {
        return {
            p1: clonePoint(outerHit.closest),
            p2: clonePoint(innerHit.closest),
        };
    }

    return {
        p1: clonePoint(bestOuter.point),
        p2: clonePoint(bestInner.point),
    };
}
