import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { isValidPbGhostTrace, type PbGhostTrace } from './pb-ghost-trace.js';

// A compact, lossless way to store a ghost in Redis and in blob storage. The
// game never sees it: the server unpacks a ghost before it sends one.
//
// Layout (version 1), every number a variable-length integer:
//   version, schemaVersion, sampleIntervalMs, finishTimeMs,
//   origin x, origin y, origin angle, step count,
//   then every x step, then every y step, then every angle step.
// Each step is stored as its change from the step before, which is small for a
// moving car. Signed numbers use zigzag. The bytes are brotli-compressed, then
// written as base64, because a Redis value is text.

const PACK_VERSION = 1;
const BROTLI_QUALITY = 9;
// Larger numbers could lose precision in zigzag; a real ghost is far below.
const MAX_PACKED_MAGNITUDE = 2 ** 31;

function zigzag(value: number): number {
    return value >= 0 ? value * 2 : -value * 2 - 1;
}

function unzigzag(value: number): number {
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function writeVarints(values: readonly number[]): Buffer {
    const bytes: number[] = [];
    for (const value of values) {
        let rest = value;
        while (rest >= 128) {
            bytes.push((rest % 128) | 128);
            rest = Math.floor(rest / 128);
        }
        bytes.push(rest);
    }
    return Buffer.from(bytes);
}

function readVarints(bytes: Buffer): number[] {
    const values: number[] = [];
    let value = 0;
    let scale = 1;
    for (const byte of bytes) {
        value += (byte % 128) * scale;
        if (byte < 128) {
            values.push(value);
            value = 0;
            scale = 1;
        } else {
            scale *= 128;
            if (scale > 2 ** 49) throw new Error('Packed ghost number is too long.');
        }
    }
    if (scale !== 1) throw new Error('Packed ghost ends inside a number.');
    return values;
}

function fitsPacking(trace: PbGhostTrace): boolean {
    const numbers = [trace.schemaVersion, trace.sampleIntervalMs, trace.finishTimeMs, ...trace.origin, ...trace.deltas];
    return numbers.every((value) => Number.isSafeInteger(value) && Math.abs(value) < MAX_PACKED_MAGNITUDE);
}

function encode(trace: PbGhostTrace): string {
    const steps = trace.deltas.length / 3;
    const planes = [0, 1, 2].flatMap((axis) => {
        const plane: number[] = [];
        let previous = 0;
        for (let step = 0; step < steps; step += 1) {
            const value = trace.deltas[step * 3 + axis];
            plane.push(zigzag(value - previous));
            previous = value;
        }
        return plane;
    });
    const raw = writeVarints([
        PACK_VERSION,
        trace.schemaVersion,
        trace.sampleIntervalMs,
        trace.finishTimeMs,
        zigzag(trace.origin[0]),
        zigzag(trace.origin[1]),
        zigzag(trace.origin[2]),
        steps,
        ...planes,
    ]);
    return brotliCompressSync(raw, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
    }).toString('base64');
}

// The ghost a packed string holds, or null when it is not a valid packed ghost.
export function unpackPbGhostTrace(packed: unknown): PbGhostTrace | null {
    if (typeof packed !== 'string' || !packed) return null;
    try {
        const values = readVarints(brotliDecompressSync(Buffer.from(packed, 'base64')));
        const [version, schemaVersion, sampleIntervalMs, finishTimeMs, x, y, angle, steps] = values;
        if (version !== PACK_VERSION || values.length !== 8 + steps * 3) return null;
        const planes = [0, 1, 2].map((axis) => values.slice(8 + axis * steps, 8 + (axis + 1) * steps));
        const deltas: number[] = [];
        const previous = [0, 0, 0];
        for (let step = 0; step < steps; step += 1) {
            for (let axis = 0; axis < 3; axis += 1) {
                previous[axis] += unzigzag(planes[axis][step]);
                deltas.push(previous[axis]);
            }
        }
        const trace = {
            schemaVersion,
            sampleIntervalMs,
            finishTimeMs,
            origin: [unzigzag(x), unzigzag(y), unzigzag(angle)],
            deltas,
        };
        return isValidPbGhostTrace(trace) ? trace : null;
    } catch (_error) {
        return null;
    }
}

function sameTrace(a: PbGhostTrace, b: PbGhostTrace): boolean {
    return JSON.stringify([a.schemaVersion, a.sampleIntervalMs, a.finishTimeMs, a.origin, a.deltas])
        === JSON.stringify([b.schemaVersion, b.sampleIntervalMs, b.finishTimeMs, b.origin, b.deltas])
        && Object.keys(a).length === 5;
}

// The packed form of a ghost, or null when the ghost cannot be packed without
// a loss: a packed ghost is always unpacked once and compared before use.
export function packPbGhostTrace(trace: unknown): string | null {
    if (!isValidPbGhostTrace(trace) || !fitsPacking(trace)) return null;
    const packed = encode(trace);
    const unpacked = unpackPbGhostTrace(packed);
    return unpacked && sameTrace(trace, unpacked) ? packed : null;
}

// The ghost a stored run holds, in either form: the plain `ghost`, or a packed
// `ghostPacked`. Null when it holds neither.
export function storedRunGhost(value: Record<string, unknown> | null | undefined): PbGhostTrace | null {
    if (!value) return null;
    if (isValidPbGhostTrace(value.ghost)) return value.ghost;
    return unpackPbGhostTrace(value.ghostPacked);
}
