import { distance, midpoint, normalizeVector } from '../geometry.js';

// A vertex turning less than this is part of a straight, not a bend.
const MIN_STEP = 8 * Math.PI / 180;
// A run of turning vertices is a bend once it turns at least this far.
const MIN_BEND = 20 * Math.PI / 180;
// Points closer than this belong to one curve. A longer edge is the straight to the next bend.
const MAX_CURVE_EDGE = 2.5;
const MAX_PAIR_DISTANCE = 14;
const SAMPLE_STEP = 0.2;
// How far the red part continues after the car leaves the road.
const BLOCKED_TIP = 2.5;

function vertexTurn(points, index) {
    const count = points.length;
    const prev = points[(index - 1 + count) % count];
    const curr = points[index];
    const next = points[(index + 1) % count];
    const incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
    const outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
    if ((incoming.x === 0 && incoming.y === 0) || (outgoing.x === 0 && outgoing.y === 0)) return 0;
    return Math.atan2(
        incoming.x * outgoing.y - incoming.y * outgoing.x,
        incoming.x * outgoing.x + incoming.y * outgoing.y,
    );
}

function findBends(points) {
    const count = points?.length ?? 0;
    if (count < 3) return [];
    const turning = Array.from({ length: count }, (_, index) => {
        const angle = vertexTurn(points, index);
        return Math.abs(angle) >= MIN_STEP ? angle : 0;
    });
    const bends = [];
    const used = new Array(count).fill(false);
    const sameCurve = (from, to) => distance(points[from], points[to]) <= MAX_CURVE_EDGE;
    for (let seed = 0; seed < count; seed += 1) {
        if (used[seed] || turning[seed] === 0) continue;
        const previous = (seed - 1 + count) % count;
        if (turning[previous] !== 0 && Math.sign(turning[previous]) === Math.sign(turning[seed]) && sameCurve(previous, seed)) {
            continue;
        }
        const sign = Math.sign(turning[seed]);
        let end = seed;
        let total = turning[seed];
        used[seed] = true;
        while (true) {
            const next = (end + 1) % count;
            if (next === seed || used[next] || turning[next] === 0 || Math.sign(turning[next]) !== sign) break;
            if (!sameCurve(end, next)) break;
            used[next] = true;
            total += turning[next];
            end = next;
        }
        if (Math.abs(total) < MIN_BEND) continue;
        const origin = points[seed];
        const finish = points[end];
        const before = points[previous];
        const direction = normalizeVector(origin.x - before.x, origin.y - before.y);
        if (direction.x === 0 && direction.y === 0) continue;
        bends.push({
            origin: { x: origin.x, y: origin.y },
            end: { x: finish.x, y: finish.y },
        });
    }
    return bends;
}

function pairBends(outerBends, innerBends) {
    const used = new Set();
    const pairs = [];
    for (const outer of outerBends) {
        let best = null;
        innerBends.forEach((inner, index) => {
            if (used.has(index)) return;
            const gap = distance(outer.origin, inner.origin);
            if (gap > MAX_PAIR_DISTANCE) return;
            if (!best || gap < best.gap) best = { index, inner, gap };
        });
        if (!best) continue;
        used.add(best.index);
        pairs.push({ outer, inner: best.inner });
    }
    return pairs;
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const a = polygon[index];
        const b = polygon[previous];
        const crosses = (a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function onRoad(point, outer, inner) {
    return pointInPolygon(point, outer) && !pointInPolygon(point, inner);
}

function spotFits(point, outer, inner, carWidth) {
    const half = carWidth / 2;
    return [[0, 0], [half, 0], [-half, 0], [0, half], [0, -half]].every(([x, y]) => onRoad({
        x: point.x + x,
        y: point.y + y,
    }, outer, inner));
}

// A point in the road between the two walls, nearest the middle.
function bendPoint(outerPoint, innerPoint, outer, inner, carWidth) {
    let best = null;
    let bestOffset = Infinity;
    const steps = 12;
    for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const point = {
            x: outerPoint.x + (innerPoint.x - outerPoint.x) * t,
            y: outerPoint.y + (innerPoint.y - outerPoint.y) * t,
        };
        if (!spotFits(point, outer, inner, carWidth)) continue;
        const offset = Math.abs(t - 0.5);
        if (offset < bestOffset) {
            best = point;
            bestOffset = offset;
        }
    }
    return best ?? midpoint(outerPoint, innerPoint);
}

function ribbon(from, to, direction, carWidth) {
    const half = carWidth / 2;
    const side = { x: -direction.y * half, y: direction.x * half };
    return [
        { x: from.x + side.x, y: from.y + side.y },
        { x: to.x + side.x, y: to.y + side.y },
        { x: to.x - side.x, y: to.y - side.y },
        { x: from.x - side.x, y: from.y - side.y },
    ];
}

function carFits(center, direction, outer, inner, carWidth) {
    const half = carWidth / 2;
    const side = { x: -direction.y, y: direction.x };
    return [-half, 0, half].every((offset) => onRoad({
        x: center.x + side.x * offset,
        y: center.y + side.y * offset,
    }, outer, inner));
}

// The straight shot from one bend to the next, as wide as the car.
export function cornerShot(outer, inner, from, to, carWidth) {
    const length = distance(from, to);
    const direction = normalizeVector(to.x - from.x, to.y - from.y);
    if (length < 0.05 || (direction.x === 0 && direction.y === 0)) return null;
    const samples = Math.max(2, Math.ceil(length / SAMPLE_STEP));
    let blockedAt = null;
    for (let index = 0; index <= samples; index += 1) {
        const along = (index / samples) * length;
        const center = {
            x: from.x + direction.x * along,
            y: from.y + direction.y * along,
        };
        if (!carFits(center, direction, outer, inner, carWidth)) {
            blockedAt = along;
            break;
        }
    }
    const at = (along) => ({
        x: from.x + direction.x * along,
        y: from.y + direction.y * along,
    });
    const visible = blockedAt === null ? length : Math.min(length, blockedAt + BLOCKED_TIP);
    return {
        from,
        to: at(visible),
        fits: blockedAt === null,
        clear: blockedAt === 0 ? null : ribbon(from, at(blockedAt ?? length), direction, carWidth),
        blocked: blockedAt === null ? null : ribbon(at(blockedAt), at(visible), direction, carWidth),
    };
}

// Straight shots from the middle of the road at the end of one bend
// to the middle at the start of the next.
export function wallContinuations(outer, inner, carWidth) {
    const pairs = pairBends(findBends(outer), findBends(inner));
    if (pairs.length < 2) return [];
    return pairs.map((pair, index) => {
        const next = pairs[(index + 1) % pairs.length];
        return cornerShot(
            outer,
            inner,
            bendPoint(pair.outer.end, pair.inner.end, outer, inner, carWidth),
            bendPoint(next.outer.origin, next.inner.origin, outer, inner, carWidth),
            carWidth,
        );
    }).filter(Boolean);
}
