import { DEFAULT_PHYSICS_TUNING, KPH_PER_WORLD_UNIT } from '../../game/car/handling.js';
import { CONFIG } from '../../game/config.js';
import { clamp } from '../../game/shared/clamp.js';

const PHYSICS_DT = 1 / 60;
const STRAIGHT_DOT = 0.985;
const SHARP_TURN = (75 * Math.PI) / 180;
const OPPOSITE_TURN = (50 * Math.PI) / 180;
const MIN_TURN = 0.05;
const TARGET_SPEED_LOW = 200 / KPH_PER_WORLD_UNIT;
const MAX_EDGE_GROWTH = 8;
const MIN_EDGE = 1.1;
const MAX_FILLET = 4.2;
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

function targetFilletRadius(speed, halfWidth, isCorner) {
    if (!isCorner) {
        return 0;
    }
    return clamp(lockRadiusAtSpeed(speed), halfWidth, MAX_FILLET);
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
    const { arrivals, exits, turns } = estimateArrivalSpeeds(points, trackWidth, tuning);
    const count = points.length;
    let factor = 1;

    for (let index = 0; index < count; index += 1) {
        const prevIndex = (index - 1 + count) % count;
        const turn = turns[index];
        const prevTurn = turns[prevIndex];
        const fillet = targetFilletRadius(arrivals[index], halfWidth, turn.isCorner);
        const prevFillet = targetFilletRadius(arrivals[prevIndex], halfWidth, prevTurn.isCorner);
        let need = MIN_EDGE
            + (turn.isCorner ? trimForCorner(turn.absAngle, fillet) : 0)
            + (prevTurn.isCorner ? trimForCorner(prevTurn.absAngle, prevFillet) : 0);

        if (turn.isCorner && turn.absAngle >= SHARP_TURN && arrivals[index] < TARGET_SPEED_LOW) {
            const startSpeed = index === 0 ? 0 : exits[prevIndex];
            let extra = 0;
            while (
                speedAfterDistance(startSpeed, turn.inboundLength + extra, tuning) < TARGET_SPEED_LOW
                && extra < MAX_EDGE_GROWTH
            ) {
                extra += 0.25;
            }
            need = Math.max(need, turn.inboundLength + extra);
        }

        if (turn.inboundLength > 1e-6) {
            factor = Math.max(factor, need / turn.inboundLength);
        }
    }

    const scaleBy = clamp(factor, 1, 2.2);
    if (scaleBy <= 1.001) {
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

    const { arrivals, turns } = estimateArrivalSpeeds(working, trackWidth, tuning);
    const filletRadii = turns.map((turn, index) => (
        turn.isCorner
            ? targetFilletRadius(arrivals[index], halfWidth, true)
            : 0
    ));

    return { points: working, filletRadii };
}

export const HANDLING_RESHAPE = Object.freeze({
    TARGET_SPEED_LOW,
    SHARP_TURN,
    MAX_FILLET,
    MAX_EDGE_GROWTH
});
