/**
 * Build constant-width outer/inner walls from a centerline.
 *
 * Sharp centerline corners are filleted with radius = halfWidth, then each
 * sample is offset left/right by halfWidth. That keeps lane width steady
 * through bends (no miter flare).
 *
 * At a hard bend this yields ~1 inner apex (fillet center) and several outer
 * points on an arc of radius 2 * halfWidth.
 */

const STRAIGHT_DOT = 0.985; // ~10° or less → no fillet
const MERGE_DISTANCE = 0.04;
const MIN_ARC_STEPS = 2;
const MAX_ARC_STEPS = 10;

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

function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}

function pushUnique(points, point) {
    const last = points[points.length - 1];
    if (last && distance(last, point) < MERGE_DISTANCE) {
        return;
    }
    if (points.length > 0 && distance(points[0], point) < MERGE_DISTANCE) {
        return;
    }
    points.push(clonePoint(point));
}

function cornerFrame(prev, curr, next) {
    let incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
    let outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
    if (Math.abs(incoming.x) < 0.000001 && Math.abs(incoming.y) < 0.000001) {
        incoming = outgoing;
    }
    if (Math.abs(outgoing.x) < 0.000001 && Math.abs(outgoing.y) < 0.000001) {
        outgoing = incoming;
    }
    const turnDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const turnCross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    const turnAngle = Math.atan2(turnCross, turnDot);
    return { incoming, outgoing, turnDot, turnCross, turnAngle };
}

/**
 * Fillet sharp corners of a closed centerline with radius `filletRadius`.
 * Returns dense samples with local tangents for offsetting.
 */
export function filletCenterline(points, filletRadius) {
    if (!points || points.length < 3 || !(filletRadius > 0)) {
        return (points || []).map((point) => ({
            point: clonePoint(point),
            tangent: { x: 1, y: 0 },
        }));
    }

    const len = points.length;
    const corners = [];
    for (let index = 0; index < len; index += 1) {
        const prev = points[(index - 1 + len) % len];
        const curr = points[index];
        const next = points[(index + 1) % len];
        const frame = cornerFrame(prev, curr, next);
        const absAngle = Math.abs(frame.turnAngle);
        const isCorner = frame.turnDot < STRAIGHT_DOT && absAngle > 1e-4;
        let radius = 0;
        let trim = 0;
        let center = null;
        let startAngle = 0;
        let endAngle = 0;

        if (isCorner) {
            const halfAngle = absAngle / 2;
            const tanHalf = Math.tan(halfAngle);
            const prevLen = distance(prev, curr);
            const nextLen = distance(curr, next);
            const maxTrim = Math.min(prevLen, nextLen) * 0.45;
            const idealTrim = filletRadius * tanHalf;
            trim = Math.min(idealTrim, maxTrim);
            radius = tanHalf > 1e-6 ? trim / tanHalf : 0;

            if (radius > 1e-4 && trim > 1e-4) {
                const t1 = sub(curr, scale(frame.incoming, trim));
                const side = frame.turnAngle >= 0 ? 1 : -1;
                const inLeft = leftNormal(frame.incoming);
                center = add(t1, scale(inLeft, side * radius));
                const t2 = add(curr, scale(frame.outgoing, trim));
                startAngle = Math.atan2(t1.y - center.y, t1.x - center.x);
                endAngle = Math.atan2(t2.y - center.y, t2.x - center.x);
            } else {
                radius = 0;
                trim = 0;
            }
        }

        corners.push({
            curr: clonePoint(curr),
            ...frame,
            isCorner: radius > 1e-4,
            radius,
            trim,
            center,
            startAngle,
            endAngle,
        });
    }

    const samples = [];
    const pushSample = (point, tangent) => {
        const last = samples[samples.length - 1];
        if (last && distance(last.point, point) < MERGE_DISTANCE) {
            last.tangent = tangent;
            return;
        }
        samples.push({ point: clonePoint(point), tangent: { ...tangent } });
    };

    for (let index = 0; index < len; index += 1) {
        const corner = corners[index];
        const nextCorner = corners[(index + 1) % len];
        const curr = points[index];
        const next = points[(index + 1) % len];
        const edgeDir = normalizeVector(next.x - curr.x, next.y - curr.y);

        if (corner.isCorner) {
            const sweep = deltaAngle(corner.startAngle, corner.endAngle, corner.turnAngle >= 0);
            const steps = Math.min(
                MAX_ARC_STEPS,
                Math.max(MIN_ARC_STEPS, Math.ceil(Math.abs(sweep) / (Math.PI / 8))),
            );
            for (let step = 0; step <= steps; step += 1) {
                const t = step / steps;
                const angle = corner.startAngle + sweep * t;
                const point = {
                    x: corner.center.x + Math.cos(angle) * corner.radius,
                    y: corner.center.y + Math.sin(angle) * corner.radius,
                };
                // Arc tangent: left turn → +90° from radius, right turn → -90°.
                const radial = normalizeVector(point.x - corner.center.x, point.y - corner.center.y);
                const tangent =
                    corner.turnAngle >= 0
                        ? { x: -radial.y, y: radial.x }
                        : { x: radial.y, y: -radial.x };
                pushSample(point, tangent);
            }
        } else {
            pushSample(corner.curr, edgeDir);
        }

        // Straight run from this corner's exit to the next corner's entry.
        const exitTrim = corner.isCorner ? corner.trim : 0;
        const enterTrim = nextCorner.isCorner ? nextCorner.trim : 0;
        const edgeLen = distance(curr, next);
        if (edgeLen > exitTrim + enterTrim + MERGE_DISTANCE) {
            const a = add(curr, scale(edgeDir, exitTrim));
            const b = sub(next, scale(edgeDir, enterTrim));
            pushSample(a, edgeDir);
            pushSample(b, edgeDir);
        }
    }

    return samples;
}

function deltaAngle(start, end, ccw) {
    let sweep = end - start;
    if (ccw) {
        while (sweep <= 0) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
    } else {
        while (sweep >= 0) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
    }
    return sweep;
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
    // Fillet radius = halfWidth → inner side of a hard bend collapses to the
    // fillet center; outer rides an arc at 2 * halfWidth (constant width).
    const samples = filletCenterline(centerline, halfWidth);
    if (samples.length < 3) {
        return null;
    }

    const outer = [];
    const inner = [];
    for (const sample of samples) {
        const tangent = sample.tangent;
        const left = leftNormal(tangent);
        const towardInner = loopCcw ? left : scale(left, -1);
        const towardOuter = scale(towardInner, -1);
        pushUnique(inner, add(sample.point, scale(towardInner, halfWidth)));
        pushUnique(outer, add(sample.point, scale(towardOuter, halfWidth)));
    }

    if (outer.length > 1 && distance(outer[0], outer[outer.length - 1]) < MERGE_DISTANCE) {
        outer.pop();
    }
    if (inner.length > 1 && distance(inner[0], inner[inner.length - 1]) < MERGE_DISTANCE) {
        inner.pop();
    }

    if (outer.length < 3 || inner.length < 3) {
        return null;
    }

    const outerArea = Math.abs(signedArea(outer));
    const innerArea = Math.abs(signedArea(inner));
    if (!Number.isFinite(outerArea) || !Number.isFinite(innerArea) || outerArea <= innerArea) {
        return null;
    }

    return { outer, inner };
}
