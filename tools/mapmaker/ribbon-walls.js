import { clamp, clonePoint, distance, normalizeVector, subtract } from '../geometry.js';

const STRAIGHT_DOT = 0.985;
const MERGE_DISTANCE = 0.04;
const MIN_ARC_STEPS = 2;
const MAX_ARC_STEPS = 12;
const ARC_STEP_ANGLE = Math.PI / 8;
const INFLATE_ITERS = 10;
// smoothPoly never trims a corner by more than this share of a neighbouring segment.
const RACE_TRIM_SHARE = 1 / 2.5;
// Curve ends sit nearer their own corner, so each wall edge splits at its middle.
const CURVE_ZONE_SHARE = 0.5;
const CURVE_GAP_SLACK = 1.25;
const CURVE_FIT_PASSES = 10;
const CURVE_CHECK_SAMPLES = 32;
const CURVE_MATCH_TOLERANCE = 0.05;
const EPSILON = 1e-6;
// On a near-straight, a width change spans this many wider half widths each side.
const WIDTH_BLEND_HALF_WIDTHS = 1.5;
// Past this turn (cos 150°), the two inside walls do not meet near the corner.
const HAIRPIN_DOT = -0.866;

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

// minRadius is one radius for every point, or a radius for each point.
export function inflateTightBends(points, minRadius) {
    const radiusAt = Array.isArray(minRadius) ? (index) => minRadius[index] : () => minRadius;
    const anyRadius = Array.isArray(minRadius) ? minRadius.some((radius) => radius > 0) : minRadius > 0;
    if (!points || points.length < 3 || !anyRadius) {
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
            const needed = radiusAt(index);
            if (!(needed > 0) || !(radius < needed)) {
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
            next[index] = add(center, scale(radial, needed));
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
                const t1 = subtract(curr, scale(frame.incoming, trim));
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
                Math.max(MIN_ARC_STEPS, Math.ceil(Math.abs(sweep) / ARC_STEP_ANGLE)),
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
            const b = subtract(next, scale(edgeDir, enterTrim));
            pushSample(a, edgeDir);
            pushSample(b, edgeDir);
        }
    }

    return samples;
}

function smoothStep(t) {
    return t * t * (3 - 2 * t);
}

// Where two lines meet, or null when they are parallel.
function lineCrossing(pointA, dirA, pointB, dirB) {
    const denominator = cross(dirA, dirB);
    if (Math.abs(denominator) < EPSILON) {
        return null;
    }
    return add(pointA, scale(dirA, cross(subtract(pointB, pointA), dirB) / denominator));
}

// Per-section widths: each corner keeps one sharp inside point for the race to round, and the outside takes the change.
function buildVaryingRibbonWalls(centerline, sectionHalves) {
    const count = centerline.length;
    const cornerHalves = sectionHalves.map((half, index) => Math.max(half, sectionHalves[(index - 1 + count) % count]));
    const widest = Math.max(...sectionHalves);
    const line = inflateTightBends(centerline, cornerHalves);
    const loopCcw = signedArea(line) > 0;
    const walls = { outer: [], inner: [] };
    const pivots = [];
    const push = (wallName, point) => {
        pushUnique(walls[wallName], point);
        return walls[wallName][walls[wallName].length - 1];
    };
    const towardOuter = (dir) => (loopCcw ? scale(leftNormal(dir), -1) : leftNormal(dir));

    for (let index = 0; index < count; index += 1) {
        const prev = line[(index - 1 + count) % count];
        const curr = line[index];
        const next = line[(index + 1) % count];
        const before = sectionHalves[(index - 1 + count) % count];
        const after = sectionHalves[index];
        const frame = cornerFrame(prev, curr, next);
        const absAngle = Math.abs(frame.turnAngle);
        const prevLen = distance(prev, curr);
        const nextLen = distance(curr, next);
        let radius = 0;
        let trim = 0;
        if (frame.turnDot < STRAIGHT_DOT && absAngle > 1e-4) {
            const tanHalf = Math.tan(absAngle / 2);
            trim = Math.min(cornerHalves[index] * tanHalf, Math.min(prevLen, nextLen) * 0.45);
            radius = tanHalf > 1e-6 ? trim / tanHalf : 0;
        }

        if (!(radius > 1e-4 && trim > 1e-4)) {
            const normalIn = towardOuter(frame.incoming);
            const normalOut = towardOuter(frame.outgoing);
            const bisector = normalizeVector(normalIn.x + normalOut.x, normalIn.y + normalOut.y);
            const reach = before === after ? 0 : Math.min(widest * WIDTH_BLEND_HALF_WIDTHS, prevLen * 0.45, nextLen * 0.45);
            for (const step of reach > 0 ? [-1, -0.5, 0, 0.5, 1] : [0]) {
                const at = add(curr, scale(step < 0 ? frame.incoming : frame.outgoing, step * reach));
                const normal = step < 0 ? normalIn : step > 0 ? normalOut : bisector;
                const half = before + (after - before) * smoothStep((step + 1) / 2);
                push('outer', add(at, scale(normal, half)));
                push('inner', subtract(at, scale(normal, half)));
            }
            continue;
        }

        const side = frame.turnAngle >= 0 ? 1 : -1;
        const insideIn = scale(leftNormal(frame.incoming), side);
        const insideOut = scale(leftNormal(frame.outgoing), side);
        const start = subtract(curr, scale(frame.incoming, trim));
        const end = add(curr, scale(frame.outgoing, trim));
        const center = add(start, scale(insideIn, radius));
        const insideWall = (side > 0) === loopCcw ? 'inner' : 'outer';
        const outsideWall = insideWall === 'inner' ? 'outer' : 'inner';

        const meeting = frame.turnDot < HAIRPIN_DOT ? null : lineCrossing(
            add(start, scale(insideIn, before)), frame.incoming,
            add(end, scale(insideOut, after)), frame.outgoing,
        );
        const insidePoints = meeting ? [meeting] : [
            subtract(center, scale(insideIn, radius - before)),
            subtract(center, scale(insideOut, radius - after)),
        ];
        insidePoints.forEach((point) => pivots.push({ index, point: push(insideWall, point) }));

        const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
        const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
        const sweep = deltaAngle(startAngle, endAngle, frame.turnAngle >= 0);
        const steps = clamp(Math.ceil(Math.abs(sweep) / ARC_STEP_ANGLE), MIN_ARC_STEPS, MAX_ARC_STEPS);
        for (let step = 0; step <= steps; step += 1) {
            const angle = startAngle + (sweep * step) / steps;
            const half = before + (after - before) * smoothStep(step / steps);
            push(outsideWall, add(center, scale({ x: Math.cos(angle), y: Math.sin(angle) }, radius + half)));
        }
    }

    for (const wall of [walls.outer, walls.inner]) {
        if (wall.length > 1 && distance(wall[0], wall[wall.length - 1]) < MERGE_DISTANCE) {
            wall.pop();
        }
    }
    const outerArea = Math.abs(signedArea(walls.outer));
    const innerArea = Math.abs(signedArea(walls.inner));
    if (walls.outer.length < 3 || walls.inner.length < 3
        || !Number.isFinite(outerArea) || !Number.isFinite(innerArea) || outerArea <= innerArea) {
        return null;
    }
    const samples = filletCenterline(line, cornerHalves);
    return {
        outer: walls.outer,
        inner: walls.inner,
        centerline: samples.map((sample) => clonePoint(sample.point)),
        pivots: pivots.filter(({ point }) => walls.outer.includes(point) || walls.inner.includes(point)),
    };
}

// halfWidth is one value, or one per centerline section.
export function buildRibbonWallsFromCenterline(centerline, halfWidth, filletRadii = null) {
    if (Array.isArray(halfWidth)) {
        if (!centerline || centerline.length < 3 || halfWidth.length !== centerline.length
            || !halfWidth.every((half) => half > 0)) {
            return null;
        }
        return halfWidth.every((half) => half === halfWidth[0])
            ? buildRibbonWallsFromCenterline(centerline, halfWidth[0], filletRadii)
            : buildVaryingRibbonWalls(centerline, halfWidth);
    }
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

    // Keep the road's own guide points; tight bends may have moved the centerline.
    return { outer, inner, centerline: samples.map((sample) => clonePoint(sample.point)) };
}

function cross(a, b) {
    return a.x * b.y - a.y * b.x;
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y;
}

// A point of the race's rounded corner (the quadratic Bezier smoothPoly draws).
function roundedCornerPoint(corner, frame, trim, t) {
    const u = 1 - t;
    const start = subtract(corner, scale(frame.incoming, trim));
    const end = add(corner, scale(frame.outgoing, trim));
    return {
        x: u * u * start.x + 2 * u * t * corner.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * corner.y + t * t * end.y,
    };
}

// Wall points one road width from the rounded corner; roadSide is 1 when the road is left of the wall.
function curveAroundCorner(prev, corner, next, frame, cornerRadius, roadWidth, roadSide) {
    const { incoming, outgoing, turnAngle } = frame;
    const trim = Math.min(
        cornerRadius,
        distance(prev, corner) * RACE_TRIM_SHARE,
        distance(corner, next) * RACE_TRIM_SHARE,
    );
    const steps = clamp(
        Math.ceil((roadWidth * Math.abs(turnAngle) + 2 * trim) / (roadWidth * ARC_STEP_ANGLE) - EPSILON),
        MIN_ARC_STEPS,
        MAX_ARC_STEPS,
    );
    const startAngle = Math.atan2(incoming.y, incoming.x);
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
        const angle = startAngle + (turnAngle * step) / steps;
        const heading = { x: Math.cos(angle), y: Math.sin(angle) };
        // Where the rounded corner has this heading.
        const fromStart = cross(incoming, heading);
        const t = clamp(fromStart / (fromStart - cross(outgoing, heading)), 0, 1);
        const onCurve = roundedCornerPoint(corner, frame, trim, t);
        points.push(add(onCurve, scale(leftNormal(heading), roadSide * roadWidth)));
    }
    return points;
}

// The run of wall points curving round a corner of the other wall, within maxWidth.
function facingRun(wall, claimed, prev, corner, next, frame, roadSide, maxWidth) {
    const belongs = wall.map((point, index) => {
        if (claimed[index]) {
            return false;
        }
        const offset = subtract(point, corner);
        if (cross(frame.incoming, offset) * roadSide <= 0
            && cross(frame.outgoing, offset) * roadSide <= 0) {
            return false;
        }
        let nearest = null;
        for (const far of [prev, next]) {
            const edge = subtract(far, corner);
            const t = clamp(dot(offset, edge) / dot(edge, edge), 0, 1);
            const gap = distance(point, add(corner, scale(edge, t)));
            if (!nearest || gap < nearest.gap) {
                nearest = { gap, t };
            }
        }
        return nearest.t <= CURVE_ZONE_SHARE && nearest.gap <= maxWidth;
    });

    let seed = -1;
    belongs.forEach((inside, index) => {
        if (inside && (seed < 0 || distance(wall[index], corner) < distance(wall[seed], corner))) {
            seed = index;
        }
    });
    if (seed < 0) {
        return null;
    }
    const count = wall.length;
    let first = seed;
    let size = 1;
    while (size < count && belongs[(first - 1 + count) % count]) {
        first = (first - 1 + count) % count;
        size += 1;
    }
    while (size < count && belongs[(first + size) % count]) {
        size += 1;
    }
    return size >= 2 && size < count ? { first, size } : null;
}

// True when the run already keeps one road width from the rounded corner; hand-shaped curves stay.
function followsRoundedCorner(runPoints, prev, corner, next, frame, roadWidth) {
    const trimIn = dot(subtract(corner, runPoints[0]), frame.incoming);
    const trimOut = dot(subtract(runPoints[runPoints.length - 1], corner), frame.outgoing);
    const trim = (trimIn + trimOut) / 2;
    const maxTrim = Math.min(distance(prev, corner), distance(corner, next)) * RACE_TRIM_SHARE;
    if (Math.abs(trimIn - trimOut) > CURVE_MATCH_TOLERANCE
        || trim < -CURVE_MATCH_TOLERANCE
        || trim > maxTrim + CURVE_MATCH_TOLERANCE) {
        return false;
    }
    const rounded = Array.from(
        { length: CURVE_CHECK_SAMPLES + 1 },
        (_, step) => roundedCornerPoint(corner, frame, Math.max(0, trim), step / CURVE_CHECK_SAMPLES),
    );
    return runPoints.every((point) => {
        const gap = Math.min(...rounded.map((sample) => distance(point, sample)));
        return Math.abs(gap - roadWidth) <= CURVE_MATCH_TOLERANCE;
    });
}

function findCornerCurves(walls, roadSides, maxWidth) {
    const claimed = {
        outer: walls.outer.map(() => false),
        inner: walls.inner.map(() => false),
    };
    const corners = [];
    for (const [wallName, facing] of [['inner', 'outer'], ['outer', 'inner']]) {
        const wall = walls[wallName];
        const len = wall.length;
        for (let index = 0; index < len; index += 1) {
            const prev = wall[(index - 1 + len) % len];
            const corner = wall[index];
            const next = wall[(index + 1) % len];
            const frame = cornerFrame(prev, corner, next);
            const pointsIntoRoad = frame.turnAngle * roadSides[wallName] < 0 && frame.turnDot < STRAIGHT_DOT;
            if (!pointsIntoRoad || distance(prev, corner) < 0.01 || distance(corner, next) < 0.01) {
                continue;
            }
            const facingWall = walls[facing];
            const run = facingRun(
                facingWall, claimed[facing], prev, corner, next, frame, roadSides[wallName], maxWidth,
            );
            if (!run) {
                continue;
            }
            const runPoints = Array.from(
                { length: run.size },
                (_, offset) => facingWall[(run.first + offset) % facingWall.length],
            );
            const sameWay = dot(
                subtract(runPoints[run.size - 1], runPoints[0]),
                add(frame.incoming, frame.outgoing),
            ) > 0;
            if (!sameWay) {
                runPoints.reverse();
            }
            const roadWidth = (
                Math.abs(cross(frame.incoming, subtract(runPoints[0], corner)))
                + Math.abs(cross(frame.outgoing, subtract(runPoints[run.size - 1], corner)))
            ) / 2;
            if (!followsRoundedCorner(runPoints, prev, corner, next, frame, roadWidth)) {
                continue;
            }
            for (let offset = 0; offset < run.size; offset += 1) {
                claimed[facing][(run.first + offset) % facingWall.length] = true;
            }
            corners.push({ wallName, index, facing, run, sameWay, roadWidth, curve: null });
        }
    }
    // A corner point that is itself part of a curve is not a single-point corner.
    return corners.filter((entry) => !claimed[entry.wallName][entry.index]);
}

// Rebuilds many-segment curves facing a corner point, which smoothing barely changes, to keep one road width.
export function findCornerWallGroups(outer, inner, roadWidth) {
    const walls = { outer, inner };
    const roadSides = {
        outer: signedArea(outer) > 0 ? 1 : -1,
        inner: signedArea(inner) > 0 ? -1 : 1,
    };
    return findCornerCurves(walls, roadSides, roadWidth * CURVE_GAP_SLACK).map(
        ({ wallName, index, facing, run }) => ({
            pivot: { path: wallName, index },
            facing: { path: facing, indices: Array.from(
                { length: run.size },
                (_, offset) => (run.first + offset) % walls[facing].length,
            ) },
        }),
    );
}

export function fitCurvesToCorners(outer, inner, cornerRadius, roadWidth) {
    const radius = Math.max(0, Number(cornerRadius) || 0);
    const walls = { outer: outer.map((point) => ({ ...point })), inner: inner.map((point) => ({ ...point })) };
    // The road is inside the outer wall and outside the inner wall.
    const roadSides = {
        outer: signedArea(outer) > 0 ? 1 : -1,
        inner: signedArea(inner) > 0 ? -1 : 1,
    };
    const corners = findCornerCurves(walls, roadSides, roadWidth * CURVE_GAP_SLACK);

    const curveEnds = { outer: new Map(), inner: new Map() };
    corners.forEach((entry) => {
        const len = walls[entry.facing].length;
        curveEnds[entry.facing].set(entry.run.first, { entry, atStart: true });
        curveEnds[entry.facing].set((entry.run.first + entry.run.size - 1) % len, { entry, atStart: false });
    });
    const pointAt = (wallName, index) => {
        const len = walls[wallName].length;
        const wrapped = (index + len) % len;
        const end = curveEnds[wallName].get(wrapped);
        if (!end?.entry.curve) {
            return walls[wallName][wrapped];
        }
        const { curve } = end.entry;
        return end.atStart ? curve[0] : curve[curve.length - 1];
    };
    // A rebuilt curve moves points next to the other wall's corners, changing their rounding.
    for (let pass = 0; pass < CURVE_FIT_PASSES; pass += 1) {
        corners.forEach((entry) => {
            const prev = pointAt(entry.wallName, entry.index - 1);
            const corner = walls[entry.wallName][entry.index];
            const next = pointAt(entry.wallName, entry.index + 1);
            const curve = curveAroundCorner(
                prev,
                corner,
                next,
                cornerFrame(prev, corner, next),
                Number.isFinite(corner.cornerRadius) ? Math.max(0, corner.cornerRadius) : radius,
                entry.roadWidth,
                roadSides[entry.wallName],
            );
            entry.curve = entry.sameWay ? curve : curve.reverse();
        });
    }

    const rebuilt = {};
    for (const wallName of ['outer', 'inner']) {
        const owners = walls[wallName].map(() => null);
        corners.filter((entry) => entry.facing === wallName).forEach((entry) => {
            for (let offset = 0; offset < entry.run.size; offset += 1) {
                owners[(entry.run.first + offset) % owners.length] = entry;
            }
        });
        rebuilt[wallName] = walls[wallName].flatMap((point, index) => {
            const owner = owners[index];
            if (!owner) {
                return [point];
            }
            return index === owner.run.first ? owner.curve : [];
        });
    }
    return rebuilt;
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
