import { createHash } from 'node:crypto';
import * as ghostFormat from '../../game/shared/pb-ghost-format.js';

export const PB_GHOST_SCHEMA_VERSION = ghostFormat.PB_GHOST_SCHEMA_VERSION as 2;
export const PB_GHOST_SAMPLE_RATE_HZ = ghostFormat.PB_GHOST_SAMPLE_RATE_HZ as 20;
export const PB_GHOST_SAMPLE_INTERVAL_MS: number = ghostFormat.PB_GHOST_SAMPLE_INTERVAL_MS;
export const PB_GHOST_SIMULATION_REVISION = ghostFormat.PB_GHOST_SIMULATION_REVISION as 1;
export const PB_GHOST_MAX_SAMPLES: number = ghostFormat.PB_GHOST_MAX_SAMPLES;
export const PB_GHOST_MAX_ENCODED_BYTES: number = ghostFormat.PB_GHOST_MAX_ENCODED_BYTES;
const PB_GHOST_POSITION_SCALE: number = ghostFormat.PB_GHOST_POSITION_SCALE;
const PB_GHOST_ANGLE_SCALE: number = ghostFormat.PB_GHOST_ANGLE_SCALE;
const FULL_TURN_MILLI = Math.round(Math.PI * 2 * PB_GHOST_ANGLE_SCALE);
const HALF_TURN_MILLI = Math.round(Math.PI * PB_GHOST_ANGLE_SCALE);

export type PbGhostOrigin = [
    xCm: number,
    yCm: number,
    angleMilli: number,
];

export type PbGhostTrace = {
    schemaVersion: typeof PB_GHOST_SCHEMA_VERSION;
    sampleIntervalMs: typeof PB_GHOST_SAMPLE_INTERVAL_MS;
    finishTimeMs: number;
    origin: PbGhostOrigin;
    deltas: number[];
};

type QuantizedPose = {
    timeMs: number;
    xCm: number;
    yCm: number;
    angleMilli: number;
};

function quantizePose(
    timeSec: number,
    position: { x: number; y: number },
    angle: number,
): QuantizedPose | null {
    if (
        !Number.isFinite(timeSec)
        || timeSec < 0
        || !Number.isFinite(position?.x)
        || !Number.isFinite(position?.y)
        || !Number.isFinite(angle)
    ) {
        return null;
    }
    return {
        timeMs: Math.max(0, Math.round(timeSec * 1000)),
        xCm: Math.round(position.x * PB_GHOST_POSITION_SCALE),
        yCm: Math.round(position.y * PB_GHOST_POSITION_SCALE),
        angleMilli: Math.round(angle * PB_GHOST_ANGLE_SCALE),
    };
}

function encodedTraceFits(trace: PbGhostTrace): boolean {
    return Buffer.byteLength(JSON.stringify(trace), 'utf8') <= PB_GHOST_MAX_ENCODED_BYTES;
}

function shortestAngleDeltaMilli(next: number, previous: number): number {
    let delta = next - previous;
    while (delta > HALF_TURN_MILLI) delta -= FULL_TURN_MILLI;
    while (delta < -HALF_TURN_MILLI) delta += FULL_TURN_MILLI;
    return delta;
}

type RawPose = {
    timeSec: number;
    position: { x: number; y: number };
    angle: number;
};

function isFiniteRawPose(pose: RawPose): boolean {
    return (
        Number.isFinite(pose.timeSec)
        && pose.timeSec >= 0
        && Number.isFinite(pose.position?.x)
        && Number.isFinite(pose.position?.y)
        && Number.isFinite(pose.angle)
    );
}

function cloneRawPose(pose: RawPose): RawPose {
    return {
        timeSec: pose.timeSec,
        position: { x: pose.position.x, y: pose.position.y },
        angle: pose.angle,
    };
}

function shortestAngleDeltaRad(next: number, previous: number): number {
    let delta = next - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
}

function lerpRawPoseAtTime(last: RawPose, current: RawPose, atTimeSec: number): RawPose {
    const span = current.timeSec - last.timeSec;
    if (span <= Number.EPSILON) {
        return {
            timeSec: atTimeSec,
            position: { x: current.position.x, y: current.position.y },
            angle: current.angle,
        };
    }
    const progress = Math.min(1, Math.max(0, (atTimeSec - last.timeSec) / span));
    return {
        timeSec: atTimeSec,
        position: {
            x: last.position.x + (current.position.x - last.position.x) * progress,
            y: last.position.y + (current.position.y - last.position.y) * progress,
        },
        angle: last.angle + shortestAngleDeltaRad(current.angle, last.angle) * progress,
    };
}

export function getPbGhostTraceSampleCount(trace: Partial<PbGhostTrace> | null | undefined): number {
    if (!Array.isArray(trace?.deltas) || trace.deltas.length % 3 !== 0) return 0;
    return 1 + trace.deltas.length / 3;
}

export function isValidPbGhostTrace(value: unknown): value is PbGhostTrace {
    if (!value || typeof value !== 'object') return false;
    const trace = value as Partial<PbGhostTrace>;
    if (
        trace.schemaVersion !== PB_GHOST_SCHEMA_VERSION
        || trace.sampleIntervalMs !== PB_GHOST_SAMPLE_INTERVAL_MS
        || !Number.isSafeInteger(trace.finishTimeMs)
        || Number(trace.finishTimeMs) <= 0
        || !Array.isArray(trace.origin)
        || trace.origin.length !== 3
        || !trace.origin.every(Number.isSafeInteger)
        || !Array.isArray(trace.deltas)
        || trace.deltas.length < 3
        || trace.deltas.length % 3 !== 0
        || !trace.deltas.every(Number.isSafeInteger)
    ) {
        return false;
    }
    const sampleCount = getPbGhostTraceSampleCount(trace);
    if (sampleCount < 2 || sampleCount > PB_GHOST_MAX_SAMPLES) return false;
    const penultimateTimeMs = (sampleCount - 2) * PB_GHOST_SAMPLE_INTERVAL_MS;
    const nextRegularTimeMs = (sampleCount - 1) * PB_GHOST_SAMPLE_INTERVAL_MS;
    if (trace.finishTimeMs <= penultimateTimeMs || trace.finishTimeMs > nextRegularTimeMs) {
        return false;
    }
    let xCm = trace.origin[0];
    let yCm = trace.origin[1];
    let angleMilli = trace.origin[2];
    for (let index = 0; index < trace.deltas.length; index += 3) {
        xCm += trace.deltas[index];
        yCm += trace.deltas[index + 1];
        angleMilli += trace.deltas[index + 2];
        if (![xCm, yCm, angleMilli].every(Number.isSafeInteger)) return false;
    }
    return encodedTraceFits(trace as PbGhostTrace);
}

export function createPbGhostTraceRecorder(initialPose: {
    timeSec: number;
    position: { x: number; y: number };
    angle: number;
}) {
    const sampleIntervalSec = 1 / PB_GHOST_SAMPLE_RATE_HZ;
    const poses: QuantizedPose[] = [];
    let nextSampleTimeSec = 0;
    let overflowed = false;
    let lastPose: RawPose = isFiniteRawPose(initialPose)
        ? cloneRawPose(initialPose)
        : { timeSec: 0, position: { x: 0, y: 0 }, angle: 0 };

    function appendPose(pose: RawPose, exact = false): void {
        if (overflowed) return;
        const sample = quantizePose(pose.timeSec, pose.position, pose.angle);
        if (!sample) return;
        const previous = poses.at(-1);
        if (
            previous
            && previous.timeMs === sample.timeMs
            && previous.xCm === sample.xCm
            && previous.yCm === sample.yCm
            && previous.angleMilli === sample.angleMilli
        ) {
            return;
        }
        if (exact && previous?.timeMs === sample.timeMs) {
            poses[poses.length - 1] = sample;
            return;
        }
        if (poses.length >= PB_GHOST_MAX_SAMPLES) {
            overflowed = true;
            return;
        }
        poses.push(sample);
    }

    appendPose(initialPose, true);
    nextSampleTimeSec = sampleIntervalSec;

    return {
        sample(pose: RawPose): void {
            if (overflowed) return;
            if (!isFiniteRawPose(pose)) return;

            while (pose.timeSec + Number.EPSILON >= nextSampleTimeSec) {
                appendPose(lerpRawPoseAtTime(lastPose, pose, nextSampleTimeSec));
                nextSampleTimeSec += sampleIntervalSec;
                if (overflowed) break;
            }
            lastPose = cloneRawPose(pose);
        },
        finish(pose: RawPose): PbGhostTrace | null {
            appendPose(pose, true);
            if (overflowed || poses.length < 2) return null;
            const finishPose = poses.at(-1);
            if (!finishPose) return null;
            const finishTimeMs = finishPose.timeMs;
            if (!Number.isSafeInteger(finishTimeMs) || finishTimeMs <= 0) return null;

            // Format requires: (n-2)*50 < finishTimeMs <= (n-1)*50
            const requiredCount = Math.ceil(finishTimeMs / PB_GHOST_SAMPLE_INTERVAL_MS) + 1;
            if (requiredCount < 2 || requiredCount > PB_GHOST_MAX_SAMPLES) return null;

            const regularPoses = poses.slice(0, -1);
            while (regularPoses.length + 1 < requiredCount) {
                const padSource = regularPoses.at(-1);
                if (!padSource) return null;
                regularPoses.push({ ...padSource });
            }
            if (regularPoses.length + 1 > requiredCount) {
                regularPoses.length = requiredCount - 1;
            }
            if (regularPoses.length < 1) return null;

            const alignedPoses = [...regularPoses, finishPose];
            const originPose = alignedPoses[0];
            const deltas: number[] = [];
            let previous = originPose;
            for (let index = 1; index < alignedPoses.length; index += 1) {
                const current = alignedPoses[index];
                deltas.push(
                    current.xCm - previous.xCm,
                    current.yCm - previous.yCm,
                    shortestAngleDeltaMilli(current.angleMilli, previous.angleMilli),
                );
                previous = current;
            }
            const trace: PbGhostTrace = {
                schemaVersion: PB_GHOST_SCHEMA_VERSION,
                sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
                finishTimeMs,
                origin: [originPose.xCm, originPose.yCm, originPose.angleMilli],
                deltas,
            };
            return isValidPbGhostTrace(trace) ? trace : null;
        },
    };
}

function stableTrackShape(track: Record<string, any>) {
    return {
        outer: track.outer,
        inner: track.inner,
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle,
        checkpoints: track.checkpoints,
    };
}

export function createTrackFingerprint(track: Record<string, any>): string {
    return createHash('sha256')
        .update(JSON.stringify(stableTrackShape(track)), 'utf8')
        .digest('base64url');
}
