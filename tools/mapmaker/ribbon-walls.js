const STRAIGHT_DOT = 0.985;
const MERGE_DISTANCE = 0.04;
const MIN_ARC_STEPS = 2;
const MAX_ARC_STEPS = 12;
const INFLATE_ITERS = 10;

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

function localBendRadius(prev, curr, next) {
    const a = distance(curr, next);
    const b = distance(prev, next);
    const c = distance(prev, curr);
    const area2 = Math.abs(
        (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x),
    );
    if (area2 < 1e-8) {
        return Infinity;
    }
    return (a * b * c) / area2;
}

function circumcenter(prev, curr, next) {
    const d = 2 * (
        prev.x * (curr.y - next.y) + curr.x * (next.y - prev.y) + next.x * (prev.y - curr.y)
    );
    if (Math.abs(d) < 1e-9) {
        return null;
    }
    const prevSq = prev.x * prev.x + prev.y * prev.y;
    const currSq = curr.x * curr.x + curr.y * curr.y;
    const nextSq = next.x * next.x + next.y * next.y;
    return {
        x: (prevSq * (curr.y - next.y) + currSq * (next.y - prev.y) + nextSq * (prev.y - curr.y)) / d,
        y: (prevSq * (next.x - curr.x) + currSq * (prev.x - next.x) + nextSq * (curr.x - prev.x)) / d,
    };
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

export function inflateTightBends(points, minRadius) {
    if (!points || points.length < 3 || !(minRadius > 0)) {
        return (points || []).map(clonePoint);
    }

    let result = points.map(clonePoint);
    for (let iter = 0; iter < INFLATE_ITERS; iter += 1) {
        let moved = false;
        const next = result.map(clonePoint);
        const len = result.length;
        for (let index = 0; index < len; index += 1) {
            const prev = result[(index - 1 + len) % len];
            const curr = result[index];
            const following = result[(index + 1) % len];
            const radius = localBendRadius(prev, curr, following);
            if (!(radius < minRadius)) {
                continue;
            }
            const center = circumcenter(prev, curr, following);
            if (!center) {
                continue;
            }
            const radial = normalizeVector(curr.x - center.x, curr.y - center.y);
            if (Math.abs(radial.x) < 1e-9 && Math.abs(radial.y) < 1e-9) {
                continue;
            }
            next[index] = add(center, scale(radial, minRadius));
            moved = true;
        }
        result = next;
        if (!moved) {
            break;
        }
    }
    return result;
}

export function filletCenterline(points, filletRadius) {
    if (!points || points.length < 3) {
        return (points || []).map((point) => ({
            point: clonePoint(point),
            tangent: { x: 1, y: 0 },
        }));
    }

    const radiusAt = (index) => {
        if (Array.isArray(filletRadius)) {
            const value = Number(filletRadius[index]);
            return Number.isFinite(value) && value > 0 ? value : 0;
        }
        return Number(filletRadius) || 0;
    };
    const hasAnyRadius = points.some((_, index) => radiusAt(index) > 0);
    if (!hasAnyRadius) {
        return points.map((point, index) => {
            const next = points[(index + 1) % points.length];
            return {
                point: clonePoint(point),
                tangent: normalizeVector(next.x - point.x, next.y - point.y),
            };
        });
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
            const idealTrim = radiusAt(index) * tanHalf;
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

export function buildRibbonWallsFromCenterline(centerline, halfWidth, filletRadii = null) {
    if (!centerline || centerline.length < 3 || !(halfWidth > 0)) {
        return null;
    }

    const inflated = inflateTightBends(centerline, halfWidth);
    const loopCcw = signedArea(inflated) > 0;
    const radii = Array.isArray(filletRadii) && filletRadii.length === inflated.length
        ? filletRadii.map((value) => {
            const radius = Number(value);
            if (!(radius > 0)) {
                return 0;
            }
            return Math.max(halfWidth, radius);
        })
        : halfWidth;
    const samples = filletCenterline(inflated, radii);
    if (samples.length < 3) {
        return null;
    }

    const outer = [];
    const inner = [];
    const sampleCount = samples.length;
    for (let index = 0; index < sampleCount; index += 1) {
        const prev = samples[(index - 1 + sampleCount) % sampleCount];
        const curr = samples[index];
        const next = samples[(index + 1) % sampleCount];
        const left = leftNormal(curr.tangent);
        const towardInner = loopCcw ? left : scale(left, -1);
        const towardOuter = scale(towardInner, -1);

        pushUnique(outer, add(curr.point, scale(towardOuter, halfWidth)));

        const bendRadius = localBendRadius(prev.point, curr.point, next.point);
        const frame = cornerFrame(prev.point, curr.point, next.point);
        const turningInward =
            (loopCcw && frame.turnAngle > 0) || (!loopCcw && frame.turnAngle < 0);

        if (turningInward && bendRadius <= halfWidth * 1.05) {
            const center = circumcenter(prev.point, curr.point, next.point);
            pushUnique(inner, center || add(curr.point, scale(towardInner, halfWidth)));
        } else {
            pushUnique(inner, add(curr.point, scale(towardInner, halfWidth)));
        }
    }

    if (outer.length > 1 && distance(outer[0], outer[outer.length - 1]) < MERGE_DISTANCE) {
        outer.pop();
    }
    if (inner.length > 1 && distance(inner[0], inner[inner.length - 1]) < MERGE_DISTANCE) {
        inner.pop();
    }

    collapsePointClusters(inner, halfWidth * 0.15);

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

function collapsePointClusters(points, radius) {
    if (!points || points.length < 3 || !(radius > 0)) {
        return;
    }
    let guard = 0;
    while (guard < points.length) {
        guard += 1;
        let merged = false;
        for (let index = 0; index < points.length; index += 1) {
            const a = points[index];
            const b = points[(index + 1) % points.length];
            if (distance(a, b) > radius) {
                continue;
            }
            let end = index;
            let count = 1;
            let sumX = a.x;
            let sumY = a.y;
            while (count < points.length) {
                const nextIndex = (end + 1) % points.length;
                if (distance(points[end], points[nextIndex]) > radius) {
                    break;
                }
                end = nextIndex;
                count += 1;
                sumX += points[end].x;
                sumY += points[end].y;
                if (end === index) {
                    break;
                }
            }
            if (count < 2) {
                continue;
            }
            const centroid = { x: sumX / count, y: sumY / count };
            if (end >= index) {
                points.splice(index, count, centroid);
            } else {
                const tail = points.length - index;
                points.splice(index, tail);
                points.splice(0, end + 1);
                points.push(centroid);
            }
            merged = true;
            break;
        }
        if (!merged) {
            break;
        }
    }
}
