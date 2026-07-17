import { createHash } from 'node:crypto';

export const PB_GHOST_SCHEMA_VERSION = 1;
export const PB_GHOST_SAMPLE_RATE_HZ = 20;
export const PB_GHOST_SIMULATION_REVISION = 1;
export const PB_GHOST_MAX_SAMPLES = 4_000;
export const PB_GHOST_MAX_ENCODED_BYTES = 128 * 1024;

export type PbGhostSample = [
    timeMs: number,
    xMilli: number,
    yMilli: number,
    angleMilli: number,
];

export type PbGhostTrace = {
    schemaVersion: typeof PB_GHOST_SCHEMA_VERSION;
    sampleRateHz: typeof PB_GHOST_SAMPLE_RATE_HZ;
    samples: PbGhostSample[];
};

function quantizePose(
    timeSec: number,
    position: { x: number; y: number },
    angle: number,
): PbGhostSample | null {
    if (
        !Number.isFinite(timeSec)
        || timeSec < 0
        || !Number.isFinite(position?.x)
        || !Number.isFinite(position?.y)
        || !Number.isFinite(angle)
    ) {
        return null;
    }
    return [
        Math.max(0, Math.round(timeSec * 1000)),
        Math.round(position.x * 1000),
        Math.round(position.y * 1000),
        Math.round(angle * 1000),
    ];
}

function encodedTraceFits(trace: PbGhostTrace): boolean {
    return Buffer.byteLength(JSON.stringify(trace), 'utf8') <= PB_GHOST_MAX_ENCODED_BYTES;
}

export function createPbGhostTraceRecorder(initialPose: {
    timeSec: number;
    position: { x: number; y: number };
    angle: number;
}) {
    const sampleIntervalSec = 1 / PB_GHOST_SAMPLE_RATE_HZ;
    const samples: PbGhostSample[] = [];
    let nextSampleTimeSec = 0;
    let overflowed = false;

    function appendPose(pose: typeof initialPose, exact = false): void {
        if (overflowed) return;
        const sample = quantizePose(pose.timeSec, pose.position, pose.angle);
        if (!sample) return;
        const previous = samples.at(-1);
        if (
            previous
            && previous[0] === sample[0]
            && previous[1] === sample[1]
            && previous[2] === sample[2]
            && previous[3] === sample[3]
        ) {
            return;
        }
        if (exact && previous?.[0] === sample[0]) {
            samples[samples.length - 1] = sample;
            return;
        }
        if (samples.length >= PB_GHOST_MAX_SAMPLES) {
            overflowed = true;
            return;
        }
        samples.push(sample);
    }

    appendPose(initialPose, true);
    nextSampleTimeSec = sampleIntervalSec;

    return {
        sample(pose: typeof initialPose): void {
            if (overflowed || pose.timeSec + Number.EPSILON < nextSampleTimeSec) return;
            appendPose(pose);
            while (nextSampleTimeSec <= pose.timeSec + Number.EPSILON) {
                nextSampleTimeSec += sampleIntervalSec;
            }
        },
        finish(pose: typeof initialPose): PbGhostTrace | null {
            appendPose(pose, true);
            const trace: PbGhostTrace = {
                schemaVersion: PB_GHOST_SCHEMA_VERSION,
                sampleRateHz: PB_GHOST_SAMPLE_RATE_HZ,
                samples,
            };
            if (overflowed || samples.length < 2 || !encodedTraceFits(trace)) {
                return null;
            }
            return trace;
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
