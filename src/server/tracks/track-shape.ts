import { isTrackGroundKey } from '../../../game/track/grounds.js';

export type Point = { x: number; y: number; cornerRadius?: number };
export type Gate = { p1: Point; p2: Point };
export type TrackShape = {
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

// A bad track from an editor. The routes answer it with status 400.
export class TrackInputError extends Error {}

const MAX_TRACK_BYTES = 80_000;
const MAX_WALL_POINTS = 160;
const MAX_DRAFT_POINTS = 160;
const MAX_CHECKPOINTS = 12;
const MAX_COORDINATE = 1_000;
const MAX_CORNER_RADIUS = 20;

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TrackInputError('Track data must be an object.');
    }
    return value as Record<string, unknown>;
}

function cornerRadius(value: unknown, message: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CORNER_RADIUS) {
        throw new TrackInputError(message);
    }
    return value;
}

function point(value: unknown): Point {
    const input = object(value);
    const x = input.x;
    const y = input.y;
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > MAX_COORDINATE
        || typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > MAX_COORDINATE) {
        throw new TrackInputError('Map points must have finite coordinates within 1,000 units.');
    }
    const output: Point = { x, y };
    if (input.cornerRadius !== undefined) {
        output.cornerRadius = cornerRadius(input.cornerRadius, 'Corner rounding is out of range.');
    }
    return output;
}

function points(value: unknown, max: number, label: string): Point[] {
    if (!Array.isArray(value) || value.length > max) {
        throw new TrackInputError(`${label} must contain at most ${max} points.`);
    }
    return value.map(point);
}

function gate(value: unknown): Gate {
    const input = object(value);
    return { p1: point(input.p1), p2: point(input.p2) };
}

// Keeps only the fields a track uses, in the order of the track files, and
// refuses values out of range. It does not run the track checks.
export function normalizeTrackShape(value: unknown, { maxNameLength = 80 } = {}): TrackShape {
    const trackInput = object(value);
    const byteLength = Buffer.byteLength(JSON.stringify(trackInput) ?? '', 'utf8');
    if (byteLength > MAX_TRACK_BYTES) {
        throw new TrackInputError('Track is too large to save.');
    }
    if (typeof trackInput.name !== 'string') {
        throw new TrackInputError('Give the track a name.');
    }
    if (trackInput.name.trim().length > maxNameLength) {
        throw new TrackInputError(`The name must be at most ${maxNameLength} characters.`);
    }
    const checkpoints = trackInput.checkpoints;
    if (!Array.isArray(checkpoints) || checkpoints.length > MAX_CHECKPOINTS) {
        throw new TrackInputError(`A map can have at most ${MAX_CHECKPOINTS} checkpoints.`);
    }
    const startAngle = trackInput.startAngle;
    if (typeof startAngle !== 'number' || !Number.isFinite(startAngle) || Math.abs(startAngle) > MAX_COORDINATE) {
        throw new TrackInputError('Start heading is out of range.');
    }
    const track: TrackShape = {
        name: trackInput.name.trim(),
        outer: points(trackInput.outer, MAX_WALL_POINTS, 'Outer wall'),
        inner: points(trackInput.inner, MAX_WALL_POINTS, 'Inner wall'),
        startLine: gate(trackInput.startLine),
        startPos: point(trackInput.startPos),
        startAngle,
        checkpoints: checkpoints.map(gate),
    };
    if (trackInput.cornerRadius !== undefined) {
        track.cornerRadius = cornerRadius(trackInput.cornerRadius, 'Track corner rounding is out of range.');
    }
    if (trackInput.ground !== undefined) {
        if (!isTrackGroundKey(trackInput.ground)) {
            throw new TrackInputError('Unknown track ground.');
        }
        track.ground = trackInput.ground as string;
    }
    return track;
}

export function normalizeDraftLoop(value: unknown): Point[] {
    return points(value ?? [], MAX_DRAFT_POINTS, 'Unfinished road');
}
