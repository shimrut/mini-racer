import { getIntersection } from '../../game/track/geometry.js';

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

function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return { distance: distance(point, a), closest: clonePoint(a) };
    }
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return {
        distance: distance(point, {
            x: a.x + dx * t,
            y: a.y + dy * t,
        }),
        closest: {
            x: a.x + dx * t,
            y: a.y + dy * t,
        },
    };
}

function findClosestLoopHit(point, loop) {
    if (!loop?.length) {
        return null;
    }
    let best = null;
    for (let index = 0; index < loop.length; index += 1) {
        const a = loop[index];
        const b = loop[(index + 1) % loop.length];
        const hit = distanceToSegment(point, a, b);
        if (!best || hit.distance < best.distance) {
            best = {
                distance: hit.distance,
                closest: hit.closest,
                a,
                b,
                index,
            };
        }
    }
    return best;
}

function findRayLoopIntersection(origin, direction, loop, maxDistance = 80) {
    if (!loop?.length) {
        return null;
    }
    const end = {
        x: origin.x + direction.x * maxDistance,
        y: origin.y + direction.y * maxDistance,
    };
    let best = null;
    for (let index = 0; index < loop.length; index += 1) {
        const a = loop[index];
        const b = loop[(index + 1) % loop.length];
        const hit = getIntersection(origin, end, a, b);
        if (!hit) {
            continue;
        }
        const hitDistance = distance(origin, hit);
        if (hitDistance < 0.05) {
            continue;
        }
        if (!best || hitDistance < best.distance) {
            best = {
                point: hit,
                distance: hitDistance,
            };
        }
    }
    return best;
}

/**
 * Build a start-line / checkpoint span that sits on both walls and stays
 * perpendicular to the nearer wall at the cursor.
 */
export function buildPerpendicularWallSpan(worldPoint, outer, inner) {
    const outerHit = findClosestLoopHit(worldPoint, outer);
    const innerHit = findClosestLoopHit(worldPoint, inner);
    if (!outerHit || !innerHit) {
        return null;
    }

    const useOuter = outerHit.distance <= innerHit.distance;
    const anchorHit = useOuter ? outerHit : innerHit;
    const oppositeLoop = useOuter ? inner : outer;
    const tangent = normalizeVector(
        anchorHit.b.x - anchorHit.a.x,
        anchorHit.b.y - anchorHit.a.y,
    );
    if (tangent.x === 0 && tangent.y === 0) {
        return null;
    }
    const normal = { x: -tangent.y, y: tangent.x };
    const oppositeHit = [
        findRayLoopIntersection(anchorHit.closest, normal, oppositeLoop),
        findRayLoopIntersection(
            anchorHit.closest,
            { x: -normal.x, y: -normal.y },
            oppositeLoop,
        ),
    ]
        .filter(Boolean)
        .sort((left, right) => left.distance - right.distance)[0];
    if (!oppositeHit) {
        return null;
    }

    // Keep p1 on the outer wall and p2 on the inner wall, matching Line Build.
    if (useOuter) {
        return {
            p1: clonePoint(anchorHit.closest),
            p2: clonePoint(oppositeHit.point),
        };
    }
    return {
        p1: clonePoint(oppositeHit.point),
        p2: clonePoint(anchorHit.closest),
    };
}
