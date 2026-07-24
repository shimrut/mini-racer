/**
 * Build outer/inner walls from a centerline so each bend gets:
 * - 1 point on the inside of the turn (apex)
 * - 2 points on the outside of the turn (chamfer)
 *
 * Straight stretches stay 1:1. Track.outer is the larger loop; track.inner
 * the hole. Which wall gets the chamfer depends on turn direction.
 */

const STRAIGHT_DOT = 0.985; // ~10° turn or less → treat as straight
const MERGE_DISTANCE = 0.05;

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

function signedArea(points) {
    if (!points || points.length < 3) {
        return 0;
    }
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const next = points[(index + 1) % points.length];
        area += points[index].x * next.y - next.x * points[index].y;
    }
    return area / 2;
}

function leftNormal(dir) {
    return { x: -dir.y, y: dir.x };
}

function scale(vec, amount) {
    return { x: vec.x * amount, y: vec.y * amount };
}

function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
}

function miterOffset(point, normalA, normalB, offsetDistance) {
    let bisector = normalizeVector(normalA.x + normalB.x, normalA.y + normalB.y);
    if (Math.abs(bisector.x) < 0.000001 && Math.abs(bisector.y) < 0.000001) {
        bisector = normalB;
    }
    const alignment = Math.max(
        0.3,
        Math.min(1, Math.abs(bisector.x * normalB.x + bisector.y * normalB.y)),
    );
    const distanceScale = Math.max(
        -Math.abs(offsetDistance) * 3,
        Math.min(Math.abs(offsetDistance) * 3, offsetDistance / alignment),
    );
    return add(point, scale(bisector, distanceScale));
}

function pushUnique(points, point) {
    const last = points[points.length - 1];
    if (last && distance(last, point) < MERGE_DISTANCE) {
        return;
    }
    points.push(clonePoint(point));
}

/**
 * @param {{x:number,y:number}[]} centerline closed loop sample points
 * @param {number} halfWidth half of lane width
 * @returns {{ outer: {x:number,y:number}[], inner: {x:number,y:number}[] } | null}
 */
export function buildRibbonWallsFromCenterline(centerline, halfWidth) {
    if (!centerline || centerline.length < 3 || !(halfWidth > 0)) {
        return null;
    }

    const loopCcw = signedArea(centerline) > 0;
    const outer = [];
    const inner = [];
    const len = centerline.length;

    for (let index = 0; index < len; index += 1) {
        const prev = centerline[(index - 1 + len) % len];
        const curr = centerline[index];
        const next = centerline[(index + 1) % len];

        let incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
        let outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
        if (Math.abs(incoming.x) < 0.000001 && Math.abs(incoming.y) < 0.000001) {
            incoming = outgoing;
        }
        if (Math.abs(outgoing.x) < 0.000001 && Math.abs(outgoing.y) < 0.000001) {
            outgoing = incoming;
        }

        const inLeft = leftNormal(incoming);
        const outLeft = leftNormal(outgoing);
        // CCW centerline: infield is to the left → inner wall uses left normals.
        const inTowardInner = loopCcw ? inLeft : scale(inLeft, -1);
        const outTowardInner = loopCcw ? outLeft : scale(outLeft, -1);
        const inTowardOuter = scale(inTowardInner, -1);
        const outTowardOuter = scale(outTowardInner, -1);

        const turnDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
        const turnCross = incoming.x * outgoing.y - incoming.y * outgoing.x;
        // Positive cross with CCW loop ≈ left turn (apex on inner wall).
        const leftTurn = turnCross > 0;
        const isCorner = turnDot < STRAIGHT_DOT;

        if (!isCorner) {
            pushUnique(outer, miterOffset(curr, inTowardOuter, outTowardOuter, halfWidth));
            pushUnique(inner, miterOffset(curr, inTowardInner, outTowardInner, halfWidth));
            continue;
        }

        // Outside of bend: two edge-normal offsets (chamfer).
        // Inside of bend: one miter (apex).
        const outerChamferA = add(curr, scale(inTowardOuter, halfWidth));
        const outerChamferB = add(curr, scale(outTowardOuter, halfWidth));
        const innerChamferA = add(curr, scale(inTowardInner, halfWidth));
        const innerChamferB = add(curr, scale(outTowardInner, halfWidth));
        const outerApex = miterOffset(curr, inTowardOuter, outTowardOuter, halfWidth);
        const innerApex = miterOffset(curr, inTowardInner, outTowardInner, halfWidth);

        // Left turn on CCW (or right turn on CW): apex on track.inner.
        const apexOnInner = loopCcw ? leftTurn : !leftTurn;
        if (apexOnInner) {
            pushUnique(inner, innerApex);
            pushUnique(outer, outerChamferA);
            pushUnique(outer, outerChamferB);
        } else {
            pushUnique(outer, outerApex);
            pushUnique(inner, innerChamferA);
            pushUnique(inner, innerChamferB);
        }
    }

    if (outer.length < 3 || inner.length < 3) {
        return null;
    }

    // Close-loop dedupe: drop last if it matches first.
    if (outer.length > 1 && distance(outer[0], outer[outer.length - 1]) < MERGE_DISTANCE) {
        outer.pop();
    }
    if (inner.length > 1 && distance(inner[0], inner[inner.length - 1]) < MERGE_DISTANCE) {
        inner.pop();
    }

    const outerArea = Math.abs(signedArea(outer));
    const innerArea = Math.abs(signedArea(inner));
    if (!Number.isFinite(outerArea) || !Number.isFinite(innerArea) || outerArea <= innerArea) {
        return null;
    }

    return { outer, inner };
}
