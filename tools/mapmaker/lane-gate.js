const SEGMENT_EPSILON = 1e-9;
const MAX_GATE_LENGTH = 20;
const CORNER_T = 0.08;
export const GATE_WALL_OVERHANG = 0.75;

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

function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
    };
}

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

function segmentTangent(a, b) {
    return normalizeVector(b.x - a.x, b.y - a.y);
}

function inwardNormalForSegment(a, b, fromPoint, towardPoint) {
    const tangent = segmentTangent(a, b);
    if (tangent.x === 0 && tangent.y === 0) {
        return { x: 0, y: 0 };
    }
    let normal = { x: -tangent.y, y: tangent.x };
    const toward = {
        x: towardPoint.x - fromPoint.x,
        y: towardPoint.y - fromPoint.y,
    };
    if (dot(normal, toward) < 0) {
        normal = { x: -normal.x, y: -normal.y };
    }
    return normal;
}

export function firstRayPolygonHit(origin, direction, polygon, minT = 0.02, maxT = MAX_GATE_LENGTH) {
    if (!polygon || polygon.length < 2) {
        return null;
    }
    const unit = normalizeVector(direction.x, direction.y);
    if (unit.x === 0 && unit.y === 0) {
        return null;
    }

    const rayEnd = {
        x: origin.x + unit.x * maxT,
        y: origin.y + unit.y * maxT,
    };

    let best = null;
    for (let index = 0; index < polygon.length; index += 1) {
        const a = polygon[index];
        const b = polygon[(index + 1) % polygon.length];
        const params = segmentIntersectionParams(origin, rayEnd, a, b);
        if (!params) {
            continue;
        }
        const along = params.t * maxT;
        if (along < minT || along > maxT) {
            continue;
        }
        const point = {
            x: origin.x + unit.x * along,
            y: origin.y + unit.y * along,
        };
        if (!best || along < best.along) {
            best = {
                point,
                along,
                segmentIndex: index,
            };
        }
    }
    return best;
}

function castGateFromSegment(a, b, foot, toPolygon, towardPoint) {
    const normal = inwardNormalForSegment(a, b, foot, towardPoint);
    if (normal.x === 0 && normal.y === 0) {
        return null;
    }
    const hit = firstRayPolygonHit(foot, normal, toPolygon);
    if (!hit) {
        return null;
    }
    const length = hit.along;
    if (length < 0.05 || length > MAX_GATE_LENGTH) {
        return null;
    }
    return {
        from: clonePoint(foot),
        to: clonePoint(hit.point),
        length,
        mid: midpoint(foot, hit.point),
    };
}

function gateCandidatesFromHit(hit, polygon, toPolygon, towardPoint) {
    const len = polygon.length;
    const candidates = [];
    const segmentLength = distance(hit.a, hit.b);
    const nearCorner = hit.t <= CORNER_T || hit.t >= 1 - CORNER_T;

    if (!nearCorner && segmentLength > 0.25) {
        const gate = castGateFromSegment(hit.a, hit.b, hit.closest, toPolygon, towardPoint);
        if (gate) {
            candidates.push(gate);
        }
        return candidates;
    }

    const indexes = nearCorner
        ? [
            (hit.segmentIndex - 1 + len) % len,
            hit.segmentIndex,
            (hit.segmentIndex + 1) % len,
        ]
        : [hit.segmentIndex];

    const seen = new Set();
    indexes.forEach((segmentIndex) => {
        if (seen.has(segmentIndex)) {
            return;
        }
        seen.add(segmentIndex);
        const a = polygon[segmentIndex];
        const b = polygon[(segmentIndex + 1) % len];
        if (distance(a, b) < 0.25) {
            return;
        }
        const gate = castGateFromSegment(a, b, hit.closest, toPolygon, towardPoint);
        if (gate) {
            candidates.push(gate);
        }
    });
    return candidates;
}

function scoreGateCandidate(gate, seedPoint, previousMidpoint = null) {
    const seedDistance = distance(gate.mid, seedPoint);
    const continuity = previousMidpoint
        ? distance(gate.mid, previousMidpoint)
        : 0;
    return seedDistance * 4 + continuity * 3 + gate.length;
}

export function extendGatePastWalls(p1, p2, overhang = GATE_WALL_OVERHANG) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.000001 || !(overhang > 0)) {
        return {
            p1: clonePoint(p1),
            p2: clonePoint(p2),
        };
    }
    const ux = dx / length;
    const uy = dy / length;
    return {
        p1: {
            x: p1.x - ux * overhang,
            y: p1.y - uy * overhang,
        },
        p2: {
            x: p2.x + ux * overhang,
            y: p2.y + uy * overhang,
        },
    };
}

export function buildPerpendicularLaneGate(seedPoint, outer, inner, options = {}) {
    if (!seedPoint || !outer || !inner || outer.length < 3 || inner.length < 3) {
        return null;
    }

    const previousMidpoint = options.previousMidpoint || null;
    const outerHit = closestPointOnPolygon(seedPoint, outer);
    const innerHit = closestPointOnPolygon(seedPoint, inner);
    if (!outerHit || !innerHit) {
        return null;
    }

    const towardLane = midpoint(outerHit.closest, innerHit.closest);
    const candidates = [
        ...gateCandidatesFromHit(outerHit, outer, inner, towardLane),
        ...gateCandidatesFromHit(innerHit, inner, outer, towardLane),
    ];
    if (!candidates.length) {
        return null;
    }

    candidates.sort((left, right) => (
        scoreGateCandidate(left, seedPoint, previousMidpoint)
        - scoreGateCandidate(right, seedPoint, previousMidpoint)
    ));
    const chosen = candidates[0];

    const outerEnd = closestPointOnPolygon(chosen.from, outer);
    const startsOnOuter = outerEnd && distance(outerEnd.closest, chosen.from) < 0.001;
    const wallSpan = startsOnOuter
        ? { p1: chosen.from, p2: chosen.to }
        : { p1: chosen.to, p2: chosen.from };
    return extendGatePastWalls(wallSpan.p1, wallSpan.p2);
}
