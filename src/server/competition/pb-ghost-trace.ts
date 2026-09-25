import { createHash } from 'node:crypto';
import * as ghostFormat from '../../../game/shared/pb-ghost-format.js';
import { createPbGhostPoseRecorder } from '../../../game/shared/pb-ghost-recorder.js';
import { getStoredTrackGroundKey } from '../../../game/track/grounds.js';

export const PB_GHOST_SCHEMA_VERSION = ghostFormat.PB_GHOST_SCHEMA_VERSION as 2;
export const PB_GHOST_SAMPLE_RATE_HZ = ghostFormat.PB_GHOST_SAMPLE_RATE_HZ as 20;
export const PB_GHOST_SAMPLE_INTERVAL_MS: number = ghostFormat.PB_GHOST_SAMPLE_INTERVAL_MS;
export const PB_GHOST_SIMULATION_REVISION = ghostFormat.PB_GHOST_SIMULATION_REVISION as 1;
export const PB_GHOST_MAX_SAMPLES: number = ghostFormat.PB_GHOST_MAX_SAMPLES;
export const PB_GHOST_MAX_ENCODED_BYTES: number = ghostFormat.PB_GHOST_MAX_ENCODED_BYTES;

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

function encodedTraceFits(trace: PbGhostTrace): boolean {
    return Buffer.byteLength(JSON.stringify(trace), 'utf8') <= PB_GHOST_MAX_ENCODED_BYTES;
}

type RawPose = {
    timeSec: number;
    position: { x: number; y: number };
    angle: number;
};

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

export function createPbGhostTraceRecorder(initialPose: RawPose) {
    const recorder = createPbGhostPoseRecorder(initialPose);
    return {
        sample(pose: RawPose): void {
            recorder.sample(pose);
        },
        finish(pose: RawPose): PbGhostTrace | null {
            const trace = recorder.finish(pose);
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
        // Tarmac leaves this undefined, so JSON drops it and older hashes stay valid.
        ground: getStoredTrackGroundKey(track) ?? undefined,
    };
}

export function createTrackFingerprint(track: Record<string, any>): string {
    return createHash('sha256')
        .update(JSON.stringify(stableTrackShape(track)), 'utf8')
        .digest('base64url');
}
