import { CONFIG } from '../../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../../game/car/handling.js';
import { buildTrackGeometry } from '../../game/track/runtime.js';
import { distance } from '../geometry.js';

// Five flow rules, measured on the fast line with the car's real steering limits.
// Of the 124 Daily tracks on 2026-09-24, they pass exactly the six that play as
// flowy: Double Crest, Anvil Circuit, Shark Bite, Oven Mitt, Whistle Ridge and
// Safari Circuit. They are warnings: six examples are too few to block a track.
export const FLOW_LIMITS = Object.freeze({
    maxSteerFreeSec: 1,
    minCornerSpeedShare: 0.4,
    minInputsPerSec: 0.7,
    minSwitchShare: 0.75,
    maxWidthVariation: 0.08,
});

// Drawing guide for Line Build: a straight longer than 14 units takes about a second
// at top speed. A bend wider than a 15-unit radius needs no steering on the fast line.
export const FLOW_DRAW_GUIDE = Object.freeze({
    maxStraight: 14,
    minBendRadius: 15,
});

const SAMPLE_SPACING = 0.25;
const LINE_SPACING = 1;
const MAX_BLIND_SHARE = 0.05;
const WALL_SAMPLE_SPACING = 0.1;
const CENTERLINE_SMOOTHING_PASSES = 30;
const LANE_MARGIN = 0.15;
const MAX_RAY = 8;
const STEER_ON = 0.35;
const STEER_OFF = 0.2;
const SPEED_LAPS = 3;
const SOLVER_RELAXATION = 1.8;
const SOLVER_TOLERANCE = 1e-7;
const SOLVER_MAX_SWEEPS = 60000;
const EPSILON = 1e-9;

const TOP_SPEED = CONFIG.maxSpeed / KPH_PER_WORLD_UNIT;
const ACCELERATION = CONFIG.accel / KPH_PER_WORLD_UNIT;

function loopLength(points) {
    let total = 0;
    for (let index = 0; index < points.length; index += 1) {
        total += distance(points[index], points[(index + 1) % points.length]);
    }
    return total;
}

function resampleLoop(points, count) {
    const lengths = points.map((point, index) => distance(point, points[(index + 1) % points.length]));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const result = [];
    let segment = 0;
    let travelled = 0;
    for (let index = 0; index < count; index += 1) {
        const target = (index / count) * total;
        while (segment < points.length - 1 && travelled + lengths[segment] < target) {
            travelled += lengths[segment];
            segment += 1;
        }
        const a = points[segment];
        const b = points[(segment + 1) % points.length];
        const t = lengths[segment] > EPSILON ? (target - travelled) / lengths[segment] : 0;
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return result;
}

function nearestOnLoop(point, loop) {
    let best = null;
    let bestDistanceSq = Infinity;
    for (let index = 0; index < loop.length; index += 1) {
        const a = loop[index];
        const b = loop[(index + 1) % loop.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > EPSILON
            ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq))
            : 0;
        const x = a.x + dx * t;
        const y = a.y + dy * t;
        const distanceSq = (point.x - x) ** 2 + (point.y - y) ** 2;
        if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            best = { x, y };
        }
    }
    return best;
}

function rayToWall(origin, direction, loops) {
    let nearest = MAX_RAY;
    for (const loop of loops) {
        for (let index = 0; index < loop.length; index += 1) {
            const a = loop[index];
            const b = loop[(index + 1) % loop.length];
            const sx = b.x - a.x;
            const sy = b.y - a.y;
            const denominator = direction.x * sy - direction.y * sx;
            if (Math.abs(denominator) < EPSILON) continue;
            const ox = a.x - origin.x;
            const oy = a.y - origin.y;
            const t = (ox * sy - oy * sx) / denominator;
            const u = (ox * direction.y - oy * direction.x) / denominator;
            if (t > EPSILON && t < nearest && u >= 0 && u <= 1) nearest = t;
        }
    }
    return nearest;
}

function laneRoom(points, normals, walls) {
    return points.map((point, index) => {
        const normal = normals[index];
        const positive = rayToWall(point, normal, walls);
        const negative = rayToWall(point, { x: -normal.x, y: -normal.y }, walls);
        return { positive, negative, blind: positive >= MAX_RAY && negative >= MAX_RAY };
    });
}

function loopNormals(points) {
    return points.map((_, index) => {
        const previous = points[(index - 1 + points.length) % points.length];
        const next = points[(index + 1) % points.length];
        const length = distance(previous, next) || 1;
        return { x: -(next.y - previous.y) / length, y: (next.x - previous.x) / length };
    });
}

// Road middle: halfway between each outer-wall sample and the nearest inner-wall point.
function buildCenterline(outer, inner) {
    const outerSamples = resampleLoop(outer, Math.max(60, Math.round(loopLength(outer) / WALL_SAMPLE_SPACING)));
    const middles = outerSamples.map((point) => {
        const closest = nearestOnLoop(point, inner);
        return { x: (point.x + closest.x) / 2, y: (point.y + closest.y) / 2 };
    });
    const count = Math.max(120, Math.round(loopLength(middles) / SAMPLE_SPACING));
    let line = resampleLoop(middles, count);
    for (let pass = 0; pass < CENTERLINE_SMOOTHING_PASSES; pass += 1) {
        line = line.map((point, index) => {
            const previous = line[(index - 1 + count) % count];
            const next = line[(index + 1) % count];
            return {
                x: (previous.x + 2 * point.x + next.x) / 4,
                y: (previous.y + 2 * point.y + next.y) / 4,
            };
        });
    }
    return resampleLoop(line, count);
}

// Fast line: the smoothest path that stays inside the lane (least squared bend).
// Projected over-relaxed Gauss-Seidel, solved coarse to fine until it settles.
function solveFastLine(center, normals, low, high) {
    const count = center.length;
    const offset = new Float64Array(count);
    for (const step of [16, 8, 4, 2, 1]) {
        const picks = [];
        for (let index = 0; index < count; index += step) picks.push(index);
        const size = picks.length;
        if (size < 12) continue;
        const cx = Float64Array.from(picks, (index) => center[index].x);
        const cy = Float64Array.from(picks, (index) => center[index].y);
        const nx = Float64Array.from(picks, (index) => normals[index].x);
        const ny = Float64Array.from(picks, (index) => normals[index].y);
        const lo = Float64Array.from(picks, (index) => low[index]);
        const hi = Float64Array.from(picks, (index) => high[index]);
        const value = Float64Array.from(picks, (index) => offset[index]);
        const px = Float64Array.from(picks, (index, j) => cx[j] + nx[j] * value[j]);
        const py = Float64Array.from(picks, (index, j) => cy[j] + ny[j] * value[j]);
        for (let sweep = 0; sweep < SOLVER_MAX_SWEEPS; sweep += 1) {
            let largestMove = 0;
            for (let j = 0; j < size; j += 1) {
                const a = (j - 2 + size) % size;
                const b = (j - 1 + size) % size;
                const d = (j + 1) % size;
                const e = (j + 2) % size;
                // Change in the squared bend energy as this point moves along its normal.
                const gx = px[a] - 4 * px[b] + 6 * px[j] - 4 * px[d] + px[e];
                const gy = py[a] - 4 * py[b] + 6 * py[j] - 4 * py[d] + py[e];
                const moved = Math.max(lo[j], Math.min(hi[j],
                    value[j] - SOLVER_RELAXATION * (gx * nx[j] + gy * ny[j]) / 6));
                largestMove = Math.max(largestMove, Math.abs(moved - value[j]));
                value[j] = moved;
                px[j] = cx[j] + nx[j] * moved;
                py[j] = cy[j] + ny[j] * moved;
            }
            if (largestMove < SOLVER_TOLERANCE) break;
        }
        for (let j = 0; j < size; j += 1) {
            const from = picks[j];
            const to = picks[(j + 1) % size];
            const span = ((to - from + count) % count) || count;
            for (let t = 0; t < span; t += 1) {
                const index = (from + t) % count;
                const blended = value[j] + (value[(j + 1) % size] - value[j]) * (t / span);
                offset[index] = Math.max(low[index], Math.min(high[index], blended));
            }
        }
    }
    return center.map((point, index) => ({
        x: point.x + normals[index].x * offset[index],
        y: point.y + normals[index].y * offset[index],
    }));
}

function signedCurvature(points, span) {
    const count = points.length;
    return points.map((point, index) => {
        const a = points[(index - span + count) % count];
        const c = points[(index + span) % count];
        const ab = distance(a, point);
        const bc = distance(point, c);
        const ca = distance(c, a);
        const turn = (point.x - a.x) * (c.y - a.y) - (point.y - a.y) * (c.x - a.x);
        return (2 * turn) / (ab * bc * ca || 1);
    });
}

function steeringCapacity(speed) {
    const share = Math.min(1, speed / TOP_SPEED);
    return CONFIG.turnRate * (1 - CONFIG.highSpeedSteerTrim * share * share);
}

// Highest speed at which the car can still turn as tightly as the curve.
function cornerSpeedLimit(curvature) {
    const bend = Math.abs(curvature);
    if (bend < EPSILON) return TOP_SPEED;
    const a = CONFIG.turnRate * CONFIG.highSpeedSteerTrim / (TOP_SPEED * TOP_SPEED);
    return Math.min(TOP_SPEED, (-bend + Math.sqrt(bend * bend + 4 * a * CONFIG.turnRate)) / (2 * a));
}

function standardDeviationShare(values) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return mean > 0 ? Math.sqrt(variance) / mean : 0;
}

function rotateToDrivingOrder(points, track) {
    if (!Number.isFinite(track.startPos?.x) || !Number.isFinite(track.startAngle)) return points;
    let start = 0;
    let best = Infinity;
    points.forEach((point, index) => {
        const d = distance(point, track.startPos);
        if (d < best) {
            best = d;
            start = index;
        }
    });
    const ahead = points[(start + 4) % points.length];
    const forward = (ahead.x - points[start].x) * Math.cos(track.startAngle)
        + (ahead.y - points[start].y) * Math.sin(track.startAngle) >= 0;
    return points.map((_, j) => points[forward
        ? (start + j) % points.length
        : (start - j + points.length) % points.length]);
}

function steeringInputs(load, time) {
    const count = load.length;
    const side = new Array(count).fill(0);
    let current = 0;
    for (let pass = 0; pass < 2; pass += 1) {
        for (let index = 0; index < count; index += 1) {
            const value = load[index];
            if (current === 0 && Math.abs(value) > STEER_ON) current = Math.sign(value);
            else if (current !== 0 && (Math.sign(value) !== current || Math.abs(value) < STEER_OFF)) {
                current = Math.abs(value) > STEER_ON ? Math.sign(value) : 0;
            }
            side[index] = current;
        }
    }
    const inputs = [];
    const gaps = [];
    let input = null;
    let gap = null;
    let clock = 0;
    const firstFree = side.findIndex((value) => value === 0);
    const origin = firstFree < 0 ? 0 : firstFree;
    for (let step = 0; step < count; step += 1) {
        const index = (origin + step) % count;
        if (side[index] !== 0) {
            if (gap) {
                gaps.push(gap);
                gap = null;
            }
            if (!input || input.side !== side[index]) {
                if (input) inputs.push(input);
                input = { side: side[index], start: clock, from: index, to: index, duration: 0 };
            }
            input.to = index;
            input.duration += time[index];
        } else {
            if (input) {
                inputs.push(input);
                input = null;
            }
            if (!gap) gap = { from: index, to: index, duration: 0 };
            gap.to = index;
            gap.duration += time[index];
        }
        clock += time[index];
    }
    if (input) inputs.push(input);
    if (gap) gaps.push(gap);
    return { inputs, gaps };
}

function midpointIndex(from, to, count) {
    return (from + Math.floor((((to - from) + count) % count) / 2)) % count;
}

function rule(code, title, pass, detail, hotspot) {
    return { code, title, pass, detail, message: `${title}: ${detail}`, hotspot: pass ? null : hotspot };
}

function turnAt(previous, point, next) {
    const ax = point.x - previous.x;
    const ay = point.y - previous.y;
    const bx = next.x - point.x;
    const by = next.y - point.y;
    return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
}

/**
 * Find the stretches of a Line Build sketch that need no steering.
 * A point is a bend when the fast line must turn there tighter than the guide
 * radius. The fast line can round a corner only as far as the lane allows, and
 * a run of short sketch segments only as wide as the curve they draw.
 * Each run reports its length after the rounded bends at both ends.
 */
export function measureStraights(points, { closed = false, halfWidth = 0 } = {}) {
    const count = points?.length ?? 0;
    if (count < 2) return [];
    const segmentCount = closed ? count : count - 1;
    const lengths = Array.from({ length: segmentCount }, (_, index) => distance(points[index], points[(index + 1) % count]));
    const freeWidth = Math.max(0, 2 * (halfWidth - CONFIG.carRadius - LANE_MARGIN));
    const bendTrim = (index) => {
        if (!closed && (index === 0 || index === count - 1)) return { bend: true, trim: 0 };
        const before = lengths[(index - 1 + segmentCount) % segmentCount];
        const after = lengths[index % segmentCount];
        const turn = turnAt(points[(index - 1 + count) % count], points[index], points[(index + 1) % count]);
        if (turn < EPSILON || before < EPSILON || after < EPSILON) return { bend: false, trim: 0 };
        const drawnRadius = Math.min(before, after) / turn;
        const laneRadius = freeWidth / (1 / Math.cos(Math.min(turn, Math.PI * 0.99) / 2) - 1);
        if (Math.min(drawnRadius, laneRadius) >= FLOW_DRAW_GUIDE.minBendRadius) return { bend: false, trim: 0 };
        return { bend: true, trim: Math.min(halfWidth * Math.tan(turn / 2), Math.min(before, after) * 0.45) };
    };
    const joints = Array.from({ length: count }, (_, index) => bendTrim(index));
    const firstBend = joints.findIndex((joint) => joint.bend);
    if (firstBend < 0) {
        return [{ from: 0, to: 0, length: lengths.reduce((sum, length) => sum + length, 0), closedLoop: true }];
    }
    const runs = [];
    let from = firstBend;
    let length = 0;
    for (let step = 0; step < segmentCount; step += 1) {
        const segment = (firstBend + step) % segmentCount;
        length += lengths[segment];
        const end = (segment + 1) % count;
        if (joints[end].bend || (!closed && end === count - 1)) {
            runs.push({ from, to: end, length: Math.max(0, length - joints[from].trim - joints[end].trim) });
            from = end;
            length = 0;
        }
    }
    return runs;
}

const DRIVE_LAUNCH_SHARE = 0.5;
const DRIVE_TAP_MERGE_SEC = 0.25;

/**
 * Summarize how a real Drive Draft lap flowed, from per-step samples of
 * { time, speed, steer } where steer is -1 (left), 0 or 1 (right).
 * The standing start is skipped: the lap is read from the moment the car
 * first reaches half its top speed. Taps on one side less than a quarter
 * second apart count as one steering input.
 */
export function summarizeDriveFlow(samples) {
    const launch = samples?.findIndex((sample) => sample.speed >= TOP_SPEED * DRIVE_LAUNCH_SHARE) ?? -1;
    if (launch < 0) return null;
    const lap = samples.slice(launch);
    const startTime = lap[0].time;
    const endTime = lap[lap.length - 1].time;
    if (endTime - startTime < EPSILON) return null;
    let slowest = Infinity;
    let steerFreeSec = 0;
    let lastSteerTime = startTime;
    const inputs = [];
    for (const sample of lap) {
        slowest = Math.min(slowest, sample.speed);
        if (!sample.steer) continue;
        steerFreeSec = Math.max(steerFreeSec, sample.time - lastSteerTime);
        const last = inputs[inputs.length - 1];
        if (!last || last.side !== sample.steer || sample.time - lastSteerTime > DRIVE_TAP_MERGE_SEC) {
            inputs.push({ side: sample.steer });
        }
        lastSteerTime = sample.time;
    }
    steerFreeSec = Math.max(steerFreeSec, endTime - lastSteerTime);
    const changes = inputs.slice(1).filter((input, index) => input.side !== inputs[index].side).length;
    const metrics = {
        slowestShare: slowest / TOP_SPEED,
        steerFreeSec,
        inputsPerSec: inputs.length / (endTime - startTime),
        switchShare: inputs.length > 1 ? changes / (inputs.length - 1) : 0,
    };
    return {
        ...metrics,
        pass: {
            corner: metrics.slowestShare >= FLOW_LIMITS.minCornerSpeedShare,
            steerGap: metrics.steerFreeSec < FLOW_LIMITS.maxSteerFreeSec,
            beat: metrics.inputsPerSec >= FLOW_LIMITS.minInputsPerSec,
            leftRight: metrics.switchShare >= FLOW_LIMITS.minSwitchShare - EPSILON,
        },
    };
}

/**
 * Measure a closed track against the five flow rules.
 * Returns null when the walls do not form a road that can be measured.
 */
export function analyzeTrackFlow(track) {
    if (!Array.isArray(track?.outer) || !Array.isArray(track?.inner)
        || track.outer.length < 3 || track.inner.length < 3) return null;
    const { outer, inner } = buildTrackGeometry(track);
    const center = buildCenterline(outer, inner);
    const walls = [outer, inner];
    const room = laneRoom(center, loopNormals(center), walls);
    if (room.filter((entry) => entry.blind).length > center.length * MAX_BLIND_SHARE) return null;
    const widths = room.map((entry) => (entry.blind ? NaN : entry.positive + entry.negative));

    // The fast line is solved on a coarser copy of the road middle, where it settles fully.
    const guide = resampleLoop(center, Math.max(48, Math.round(loopLength(center) / LINE_SPACING)));
    const guideNormals = loopNormals(guide);
    const guideRoom = laneRoom(guide, guideNormals, walls);
    const clearance = CONFIG.carRadius + LANE_MARGIN;
    const low = guideRoom.map((entry) => (entry.blind ? 0 : -Math.max(0, entry.negative - clearance)));
    const high = guideRoom.map((entry) => (entry.blind ? 0 : Math.max(0, entry.positive - clearance)));
    const line = rotateToDrivingOrder(solveFastLine(guide, guideNormals, low, high), track);
    const count = line.length;
    const spacing = loopLength(line) / count;
    const curvature = signedCurvature(line, 1);
    const limit = curvature.map(cornerSpeedLimit);

    const speed = new Float64Array(count);
    let current = 0;
    for (let lap = 0; lap < SPEED_LAPS; lap += 1) {
        for (let index = 0; index < count; index += 1) {
            const push = ACCELERATION * (1 - (current / TOP_SPEED) ** 2);
            current = Math.min(limit[index], Math.sqrt(current * current + 2 * push * spacing));
            speed[index] = current;
        }
    }
    const time = Array.from(speed, (value) => spacing / Math.max(value, EPSILON));
    const lapSeconds = time.reduce((sum, value) => sum + value, 0);
    const load = curvature.map((bend, index) => speed[index] * bend / steeringCapacity(speed[index]));
    const { inputs, gaps } = steeringInputs(load, time);

    const longestGap = gaps.reduce((best, gap) => (gap.duration > (best?.duration ?? -1) ? gap : best), null);
    const steerFreeSec = longestGap?.duration ?? 0;
    let slowestIndex = 0;
    for (let index = 1; index < count; index += 1) {
        if (speed[index] < speed[slowestIndex]) slowestIndex = index;
    }
    const slowestShare = speed[slowestIndex] / TOP_SPEED;
    const inputsPerSec = inputs.length / lapSeconds;
    const sameSide = inputs.findIndex((input, index) => inputs[(index + 1) % inputs.length].side === input.side);
    const switchShare = inputs.length
        ? inputs.filter((input, index) => inputs[(index + 1) % inputs.length].side !== input.side).length / inputs.length
        : 0;
    const longestHold = inputs.reduce((best, input) => (input.duration > (best?.duration ?? -1) ? input : best), null);
    const measured = widths.map((width, index) => ({ width, index })).filter((entry) => Number.isFinite(entry.width));
    const widthVariation = standardDeviationShare(measured.map((entry) => entry.width));
    const meanWidth = measured.reduce((sum, entry) => sum + entry.width, 0) / measured.length;
    const narrowest = measured.reduce((best, entry) => (entry.width < best.width ? entry : best));
    const widest = measured.reduce((best, entry) => (entry.width > best.width ? entry : best));
    const widthHotspot = center[(meanWidth - narrowest.width >= widest.width - meanWidth ? narrowest : widest).index];
    // A failing value is rounded away from its limit, so it never reads the same as the target.
    const percent = (share, round = Math.round) => `${round(share * 100)}%`;
    const seconds = (value, round = Math.round) => `${(round(value * 10) / 10).toFixed(1)} s`;
    const limits = FLOW_LIMITS;

    const rules = [
        rule('flow-steer-gap', 'Steer at least every second', steerFreeSec < limits.maxSteerFreeSec,
            steerFreeSec < limits.maxSteerFreeSec
                ? `Longest stretch without steering is ${seconds(steerFreeSec)}.`
                : `A stretch without steering lasts ${seconds(steerFreeSec, Math.ceil)}. Shorten it or add a bend.`,
            longestGap ? line[midpointIndex(longestGap.from, longestGap.to, count)] : null),
        rule('flow-corner-speed', `Keep ${percent(limits.minCornerSpeedShare)} speed in every corner`,
            slowestShare >= limits.minCornerSpeedShare,
            slowestShare >= limits.minCornerSpeedShare
                ? `Slowest corner keeps ${percent(slowestShare)} of top speed.`
                : `This corner drops to ${percent(slowestShare, Math.floor)} of top speed. Open the bend.`,
            line[slowestIndex]),
        rule('flow-beat', 'Keep a steady beat', inputsPerSec >= limits.minInputsPerSec,
            inputsPerSec >= limits.minInputsPerSec
                ? `A new steering input every ${seconds(1 / Math.max(inputsPerSec, EPSILON))}.`
                : `A new steering input only every ${seconds(1 / Math.max(inputsPerSec, EPSILON), Math.ceil)}. Aim for ${seconds(1 / limits.minInputsPerSec, Math.floor)} or less. Add bends.`,
            longestHold ? line[midpointIndex(longestHold.from, longestHold.to, count)] : null),
        rule('flow-left-right', 'Alternate left and right', switchShare >= limits.minSwitchShare - EPSILON,
            switchShare >= limits.minSwitchShare - EPSILON
                ? `${percent(switchShare)} of steering inputs change side.`
                : `Only ${percent(switchShare, Math.floor)} of steering inputs change side. Aim for ${percent(limits.minSwitchShare)}. Link bends as S-shapes.`,
            sameSide >= 0 ? line[inputs[(sameSide + 1) % inputs.length].from] : null),
        rule('flow-width', 'Keep the same width', widthVariation <= limits.maxWidthVariation,
            widthVariation <= limits.maxWidthVariation
                ? `Road width varies by ${percent(widthVariation)}.`
                : `Road width varies by ${percent(widthVariation, Math.ceil)}. Aim for ${percent(limits.maxWidthVariation)} or less. Remove pinches and pockets.`,
            widthHotspot),
    ];

    return {
        rules,
        passed: rules.filter((entry) => entry.pass).length,
        lapSeconds,
        metrics: { steerFreeSec, slowestShare, inputsPerSec, switchShare, widthVariation },
    };
}
