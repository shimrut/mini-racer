import { clamp, clonePoint, distance, normalizeVector } from '../geometry.js';
import { buildTrackGeometry } from '../../game/track/runtime.js';
import { buildPerpendicularLaneGate } from './lane-gate.js';
import { snapStartPose } from './start-pose.js';
import { validateGateOnWalls } from './track-quality.js';

const GATE_SHIFT_STEPS = [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6, 0.8, -0.8, 1, -1];

export function closedLoopLength(points) {
    if (!Array.isArray(points) || points.length < 2) return 0;
    return points.reduce((length, point, index) => (
        length + distance(point, points[(index + 1) % points.length])
    ), 0);
}

export function sampleClosedLoopAtDistance(points, targetDistance) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const length = closedLoopLength(points);
    if (length < 0.000001) return null;
    let remaining = ((targetDistance % length) + length) % length;
    for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const segmentLength = distance(a, b);
        if (segmentLength < 0.000001) continue;
        if (remaining <= segmentLength) {
            const t = clamp(remaining / segmentLength, 0, 1);
            return {
                point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
                tangent: normalizeVector(b.x - a.x, b.y - a.y),
            };
        }
        remaining -= segmentLength;
    }
    return {
        point: clonePoint(points[0]),
        tangent: normalizeVector(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y),
    };
}

export function nearestDistanceAlongLoop(points, target) {
    if (!Array.isArray(points) || points.length < 2 || !target) return null;
    let best = null;
    let progress = 0;
    for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const segmentLength = distance(a, b);
        if (segmentLength < 0.000001) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = clamp(((target.x - a.x) * dx + (target.y - a.y) * dy) / (segmentLength ** 2), 0, 1);
        const point = { x: a.x + dx * t, y: a.y + dy * t };
        const separation = distance(point, target);
        if (!best || separation < best.separation) {
            best = {
                distance: progress + segmentLength * t,
                separation,
                tangent: normalizeVector(dx, dy),
            };
        }
        progress += segmentLength;
    }
    return best;
}

export function buildAutoGates(centerline, outer, inner, trackWidth, options = {}) {
    const length = closedLoopLength(centerline);
    if (length < trackWidth * 5) return null;

    const desiredStartDistance = Number.isFinite(options.startDistance)
        ? options.startDistance
        : Math.min(length * 0.06, trackWidth * 1.5);
    const direction = options.direction === -1 ? -1 : 1;
    const runtimeWalls = buildTrackGeometry({ outer, inner, cornerRadius: options.cornerRadius ?? 3 });
    const findGate = (desiredDistance, maxShift) => {
        for (const step of GATE_SHIFT_STEPS) {
            const candidateDistance = desiredDistance + step * maxShift;
            const sample = sampleClosedLoopAtDistance(centerline, candidateDistance);
            const gate = buildPerpendicularLaneGate(sample.point, outer, inner);
            if (gate && validateGateOnWalls(gate, runtimeWalls.outer, runtimeWalls.inner).length === 0) {
                return { gate, distance: candidateDistance, sample };
            }
        }
        return null;
    };
    const start = findGate(desiredStartDistance, Math.min(length * 0.08, trackWidth * 2));
    if (!start) return null;
    const startDistance = start.distance;
    const startLine = start.gate;

    const checkpointCount = Math.min(5, Math.max(3, Math.ceil(length / 35)));
    const checkpoints = [];
    const spacing = length / (checkpointCount + 1);
    for (let index = 1; index <= checkpointCount; index += 1) {
        const candidate = findGate(
            startDistance + direction * spacing * index,
            spacing * 0.3,
        );
        if (!candidate) return null;
        checkpoints.push(candidate.gate);
    }

    const poseSeed = sampleClosedLoopAtDistance(
        centerline,
        startDistance - direction * Math.min(length * 0.02, trackWidth * 0.5),
    );
    const pose = snapStartPose(poseSeed.point, startLine, {
        preferredAngle: Math.atan2(start.sample.tangent.y * direction, start.sample.tangent.x * direction),
    });
    if (!pose) return null;
    return {
        startLine,
        startPos: clonePoint(pose.startPos),
        startAngle: pose.startAngle,
        checkpoints,
        length,
        checkpointCount,
    };
}
