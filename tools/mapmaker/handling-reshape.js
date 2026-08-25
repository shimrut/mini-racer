import { DEFAULT_PHYSICS_TUNING, KPH_PER_WORLD_UNIT } from '../../game/car/handling.js';
import { CONFIG } from '../../game/config.js';
import { clamp } from '../../game/shared/clamp.js';

const PHYSICS_DT = 1 / 60;
const STRAIGHT_DOT = 0.985;
const SHARP_TURN = (75 * Math.PI) / 180;
const OPPOSITE_TURN = (50 * Math.PI) / 180;
const MIN_TURN = 0.05;
const TARGET_SPEED_LOW = 200 / KPH_PER_WORLD_UNIT;
const TARGET_SPEED_HIGH = 230 / KPH_PER_WORLD_UNIT;
const MIN_EDGE = 1.1;
const MIN_SCALE = 0.28;
const MAX_SCALE = 2.2;
const RESHAPE_ITERS = 3;
const FLATTEN_STEP = 0.18;
const MAX_FIT_RADIUS = 40;

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

function lerp(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
    };
}

function vmaxWorld(tuning) {
    return Math.max(0.001, tuning.maxSpeed / KPH_PER_WORLD_UNIT);
}

export function lockRadiusAtSpeed(speedWorld, tuning = DEFAULT_PHYSICS_TUNING) {
    const v = Math.max(0, speedWorld);
    const speedRatio = clamp(v / vmaxWorld(tuning), 0, 1);
    const omega = tuning.turnRate * (1 - tuning.highSpeedSteerTrim * speedRatio * speedRatio);
    if (omega < 1e-6) {
        return Number.POSITIVE_INFINITY;
    }
    return v / omega;
}

export function speedForLockRadius(radius, tuning = DEFAULT_PHYSICS_TUNING) {
    if (!(radius > 0) || !Number.isFinite(radius)) {
        return 0;
    }
    let lo = 0;
    let hi = vmaxWorld(tuning);
    for (let step = 0; step < 24; step += 1) {
        const mid = (lo + hi) / 2;
        if (lockRadiusAtSpeed(mid, tuning) < radius) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

export function speedAfterDistance(speedWorld, length, tuning = DEFAULT_PHYSICS_TUNING) {
    const vmax = vmaxWorld(tuning);
    let speed = clamp(speedWorld, 0, vmax);
    let travelled = 0;
    const distance = Math.max(0, length);
    if (distance < 1e-6) {
        return speed;
    }
    for (let guard = 0; guard < 12000 && travelled < distance; guard += 1) {
        if (speed >= vmax - 1e-6) {
            return vmax;
        }
        const speedRatio = speed / vmax;
        const next = Math.min(
            vmax,
            speed + (tuning.accel / KPH_PER_WORLD_UNIT) * (1 - speedRatio * speedRatio) * PHYSICS_DT
        );
        travelled += Math.max(((speed + next) / 2) * PHYSICS_DT, 1e-9);
        speed = next;
    }
    return speed;
}

export function lengthToReachSpeed(speedWorld, targetSpeed, tuning = DEFAULT_PHYSICS_TUNING) {
    const vmax = vmaxWorld(tuning);
    const goal = clamp(targetSpeed, 0, vmax);
    let speed = clamp(speedWorld, 0, vmax);
    if (speed >= goal - 1e-6) {
        return 0;
    }
    let travelled = 0;
    for (let guard = 0; guard < 12000; guard += 1) {
        const speedRatio = speed / vmax;
        const next = Math.min(
            vmax,
            speed + (tuning.accel / KPH_PER_WORLD_UNIT) * (1 - speedRatio * speedRatio) * PHYSICS_DT
        );
        travelled += Math.max(((speed + next) / 2) * PHYSICS_DT, 1e-9);
        speed = next;
        if (speed >= goal - 1e-6) {
            return travelled;
        }
    }
    return travelled;
}

function median(values) {
    if (!values.length) {
        return 1;
    }
    const ranked = [...values].sort((a, b) => a - b);
    const mid = Math.floor(ranked.length / 2);
    if (ranked.length % 2 === 0) {
        return (ranked[mid - 1] + ranked[mid]) / 2;
    }
    return ranked[mid];
}

export function maxFitRadius(absAngle, usableWidth) {
    const chord = 1 - Math.cos(clamp(absAngle, 0, Math.PI));
    if (chord < 1e-4) {
        return MAX_FIT_RADIUS;
    }
    return Math.min(MAX_FIT_RADIUS, usableWidth / chord);
}

export function cornerTurnAngle(prev, curr, next) {
    const incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
    const outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
    const turnDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const turnCross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    return Math.atan2(turnCross, turnDot);
}

function loopTurns(points) {
    const count = points.length;
    const turns = [];
    for (let index = 0; index < count; index += 1) {
        const prev = points[(index - 1 + count) % count];
        const curr = points[index];
        const next = points[(index + 1) % count];
        const incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
        const outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
        const turnDot = incoming.x * outgoing.x + incoming.y * outgoing.y;
        const turnAngle = cornerTurnAngle(prev, curr, next);
        turns.push({
            turnDot,
            turnAngle,
            absAngle: Math.abs(turnAngle),
            isCorner: turnDot < STRAIGHT_DOT && Math.abs(turnAngle) > MIN_TURN,
            inboundLength: distance(prev, curr)
        });
    }
    return turns;
}

function usableLaneWidth(trackWidth) {
    return Math.max(0.5, trackWidth - CONFIG.carRadius * 2);
}

function speedThroughCorner(speed, absAngle, usableWidth, tuning) {
    if (absAngle < MIN_TURN) {
        return speed;
    }
    const rFit = maxFitRadius(absAngle, usableWidth);
    const rLock = lockRadiusAtSpeed(speed, tuning);
    if (rLock > rFit) {
        return speedForLockRadius(rFit, tuning);
    }
    return speedAfterDistance(speed, Math.max(rLock, 0.2) * absAngle, tuning);
}

export function estimateArrivalSpeeds(points, trackWidth, tuning = DEFAULT_PHYSICS_TUNING) {
    const count = points.length;
    const usable = usableLaneWidth(trackWidth);
    const turns = loopTurns(points);
    const arrivals = new Array(count).fill(0);
    const exits = new Array(count).fill(0);
    let speed = 0;
    for (let index = 0; index < count; index += 1) {
        const turn = turns[index];
        speed = speedAfterDistance(speed, turn.inboundLength, tuning);
        arrivals[index] = speed;
        if (turn.isCorner) {
            speed = speedThroughCorner(speed, turn.absAngle, usable, tuning);
        }
        exits[index] = speed;
    }
    return { arrivals, exits, turns };
}

function trimForCorner(absAngle, filletRadius) {
    const tanHalf = Math.tan(absAngle / 2);
    if (!(tanHalf > 1e-6)) {
        return 0;
    }
    return filletRadius * tanHalf;
}

function targetFilletRadius(halfWidth, isCorner) {
    if (!isCorner) {
        return 0;
    }
    return halfWidth;
}

function loopCentroid(points) {
    let x = 0;
    let y = 0;
    for (let index = 0; index < points.length; index += 1) {
        x += points[index].x;
        y += points[index].y;
    }
    const count = Math.max(1, points.length);
    return { x: x / count, y: y / count };
}

function scaleLoopFromCentroid(points, factor) {
    const center = loopCentroid(points);
    return points.map((point) => ({
        x: center.x + (point.x - center.x) * factor,
        y: center.y + (point.y - center.y) * factor
    }));
}

function scaleLoopToFitHandling(points, trackWidth, halfWidth, tuning) {
    const { exits, turns } = estimateArrivalSpeeds(points, trackWidth, tuning);
    const count = points.length;
    const ratios = [];

    for (let index = 0; index < count; index += 1) {
        const prevIndex = (index - 1 + count) % count;
        const turn = turns[index];
        if (!turn.isCorner || turn.absAngle < SHARP_TURN || turn.inboundLength < 1e-6) {
            continue;
        }
        const prevTurn = turns[prevIndex];
        const filletNeed = MIN_EDGE
            + trimForCorner(turn.absAngle, halfWidth)
            + (prevTurn.isCorner ? trimForCorner(prevTurn.absAngle, halfWidth) : 0);
        const startSpeed = index === 0 ? 0 : exits[prevIndex];
        const minLength = Math.max(filletNeed, lengthToReachSpeed(startSpeed, TARGET_SPEED_LOW, tuning));
        const maxLength = Math.max(
            minLength,
            lengthToReachSpeed(startSpeed, TARGET_SPEED_HIGH, tuning)
        );
        let desired = turn.inboundLength;
        if (desired < minLength) {
            desired = minLength;
        } else if (desired > maxLength) {
            desired = maxLength;
        }
        ratios.push(desired / turn.inboundLength);
    }

    if (!ratios.length) {
        return points.map(clonePoint);
    }
    const scaleBy = clamp(median(ratios), MIN_SCALE, MAX_SCALE);
    if (Math.abs(scaleBy - 1) <= 0.02) {
        return points.map(clonePoint);
    }
    return scaleLoopFromCentroid(points, scaleBy);
}

function flattenOppositeKinks(points, trackWidth, tuning) {
    const usable = usableLaneWidth(trackWidth);
    const { arrivals, turns } = estimateArrivalSpeeds(points, trackWidth, tuning);
    const count = points.length;
    const nextPoints = points.map(clonePoint);

    for (let index = 0; index < count; index += 1) {
        const nextIndex = (index + 1) % count;
        const a = turns[index];
        const b = turns[nextIndex];
        if (!a.isCorner || !b.isCorner) {
            continue;
        }
        if (a.absAngle < OPPOSITE_TURN || b.absAngle < OPPOSITE_TURN) {
            continue;
        }
        if (a.turnAngle * b.turnAngle >= 0) {
            continue;
        }

        const rA = Math.min(lockRadiusAtSpeed(arrivals[index], tuning), maxFitRadius(a.absAngle, usable));
        const rB = Math.min(lockRadiusAtSpeed(arrivals[nextIndex], tuning), maxFitRadius(b.absAngle, usable));
        const span = rA * (1 - Math.cos(Math.min(a.absAngle, Math.PI)))
            + rB * (1 - Math.cos(Math.min(b.absAngle, Math.PI)));
        if (span <= usable) {
            continue;
        }

        const prev = nextPoints[(nextIndex - 1 + count) % count];
        const curr = nextPoints[nextIndex];
        const following = nextPoints[(nextIndex + 1) % count];
        const chordMid = lerp(prev, following, 0.5);
        nextPoints[nextIndex] = lerp(curr, chordMid, FLATTEN_STEP);
    }

    return nextPoints;
}

export function reshapeLoopForHandling(points, trackWidth, tuning = DEFAULT_PHYSICS_TUNING) {
    if (!points || points.length < 3 || !(trackWidth > 0)) {
        return {
            points: (points || []).map(clonePoint),
            filletRadii: []
        };
    }

    const halfWidth = trackWidth / 2;
    let working = points.map(clonePoint);
    for (let iter = 0; iter < RESHAPE_ITERS; iter += 1) {
        working = flattenOppositeKinks(working, trackWidth, tuning);
        working = scaleLoopToFitHandling(working, trackWidth, halfWidth, tuning);
    }

    const { turns } = estimateArrivalSpeeds(working, trackWidth, tuning);
    const filletRadii = turns.map((turn) => targetFilletRadius(halfWidth, turn.isCorner));

    return { points: working, filletRadii };
}

export const HANDLING_RESHAPE = Object.freeze({
    TARGET_SPEED_LOW,
    TARGET_SPEED_HIGH,
    SHARP_TURN,
    MIN_SCALE,
    MAX_SCALE
});
