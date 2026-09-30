import { createHash } from 'node:crypto';
import { isTrackGroundKey } from '../../../game/track/grounds.js';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';

export type Point = { x: number; y: number; cornerRadius?: number };
export type Gate = { p1: Point; p2: Point };
export type CommunityTrack = {
    name: string;
    outer: Point[];
    inner: Point[];
    startLine: Gate;
    startPos: Point;
    startAngle: number;
    checkpoints: Gate[];
    cornerRadius?: number;
    ground?: string;
};

export class CommunityMapInputError extends Error {}

const MAX_TRACK_BYTES = 80_000;
const MAX_WALL_POINTS = 160;
const MAX_DRAFT_POINTS = 160;
const MAX_CHECKPOINTS = 12;
const MAX_COORDINATE = 1_000;

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CommunityMapInputError('Track data must be an object.');
    }
    return value as Record<string, unknown>;
}

function point(value: unknown): Point {
    const input = object(value);
    const x = input.x;
    const y = input.y;
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > MAX_COORDINATE
        || typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > MAX_COORDINATE) {
        throw new CommunityMapInputError('Map points must have finite coordinates within 1,000 units.');
    }
    const output: Point = { x, y };
    if (input.cornerRadius !== undefined) {
        if (typeof input.cornerRadius !== 'number' || !Number.isFinite(input.cornerRadius)
            || input.cornerRadius < 0 || input.cornerRadius > 20) {
            throw new CommunityMapInputError('Corner rounding is out of range.');
        }
        output.cornerRadius = input.cornerRadius;
    }
    return output;
}

function points(value: unknown, max: number, label: string): Point[] {
    if (!Array.isArray(value) || value.length > max) {
        throw new CommunityMapInputError(`${label} must contain at most ${max} points.`);
    }
    return value.map(point);
}

function gate(value: unknown): Gate {
    const input = object(value);
    return { p1: point(input.p1), p2: point(input.p2) };
}

export function normalizeCommunityDraft(input: unknown): { track: CommunityTrack; draftLoop: Point[] } {
    const payload = object(input);
    const trackInput = object(payload.track);
    const byteLength = Buffer.byteLength(JSON.stringify(payload.track) ?? '', 'utf8');
    if (byteLength > MAX_TRACK_BYTES) {
        throw new CommunityMapInputError('Track is too large to save.');
    }
    if (typeof trackInput.name !== 'string' || trackInput.name.length > 80) {
        throw new CommunityMapInputError('Map name must be at most 80 characters.');
    }
    const checkpoints = trackInput.checkpoints;
    if (!Array.isArray(checkpoints) || checkpoints.length > MAX_CHECKPOINTS) {
        throw new CommunityMapInputError(`A map can have at most ${MAX_CHECKPOINTS} checkpoints.`);
    }
    const startAngle = trackInput.startAngle;
    if (typeof startAngle !== 'number' || !Number.isFinite(startAngle) || Math.abs(startAngle) > 100) {
        throw new CommunityMapInputError('Start heading is out of range.');
    }
    const track: CommunityTrack = {
        name: trackInput.name.trim(),
        outer: points(trackInput.outer, MAX_WALL_POINTS, 'Outer wall'),
        inner: points(trackInput.inner, MAX_WALL_POINTS, 'Inner wall'),
        startLine: gate(trackInput.startLine),
        startPos: point(trackInput.startPos),
        startAngle,
        checkpoints: checkpoints.map(gate),
    };
    if (trackInput.cornerRadius !== undefined) {
        if (typeof trackInput.cornerRadius !== 'number' || !Number.isFinite(trackInput.cornerRadius)
            || trackInput.cornerRadius < 0 || trackInput.cornerRadius > 20) {
            throw new CommunityMapInputError('Track corner rounding is out of range.');
        }
        track.cornerRadius = trackInput.cornerRadius;
    }
    if (trackInput.ground !== undefined) {
        if (!isTrackGroundKey(trackInput.ground)) {
            throw new CommunityMapInputError('Unknown track ground.');
        }
        track.ground = trackInput.ground as string;
    }
    const draftLoop = points(payload.draftLoop ?? [], MAX_DRAFT_POINTS, 'Unfinished road');
    return { track, draftLoop };
}

export function communityTrackSignature(track: CommunityTrack): string {
    return createHash('sha256').update(JSON.stringify(track)).digest('hex');
}

export function assertCommunityTrackPublishable(track: CommunityTrack): void {
    if (!track.name) {
        throw new CommunityMapInputError('Give the map a name before publishing.');
    }
    const quality = validateTrackQuality(track);
    if (quality.hasErrors) {
        const problem = quality.issues.find((entry: { severity: string }) => entry.severity === 'error');
        throw new CommunityMapInputError(problem?.message ?? 'Map geometry did not pass checks.');
    }
}
