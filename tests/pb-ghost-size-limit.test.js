import { describe, expect, it } from 'vitest';
import { normalizePbGhostRecord } from '../game/ghost/pb-ghost.js';
import { PB_GHOST_MAX_ENCODED_BYTES } from '../game/shared/pb-ghost-format.js';
import { createPbGhostTraceRecorder, isValidPbGhostTrace } from '../src/server/competition/pb-ghost-trace.ts';

// Pins both ghost size limits before they merge: the phone counts characters, the server UTF-8 bytes.

function smallTrace() {
    return {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: 100,
        origin: [0, 0, 0],
        deltas: [10, 0, 0, 10, 0, 0],
    };
}

// The trace with a filler field, so that its JSON has `size` characters.
function traceOfSize(size, letter = 'x') {
    const trace = { ...smallTrace(), filler: '' };
    const emptySize = JSON.stringify(trace).length;
    trace.filler = letter.repeat((size - emptySize) / letter.length);
    expect(JSON.stringify(trace).length).toBe(size);
    return trace;
}

function phoneAccepts(trace) {
    return normalizePbGhostRecord({ bestTimeMs: 100, ghost: trace }) !== null;
}

describe('ghost size limit', () => {
    it('accepts a ghost at the limit and refuses one letter more, on both sides', () => {
        const atLimit = traceOfSize(PB_GHOST_MAX_ENCODED_BYTES);
        const overLimit = traceOfSize(PB_GHOST_MAX_ENCODED_BYTES + 1);

        expect(phoneAccepts(atLimit)).toBe(true);
        expect(isValidPbGhostTrace(atLimit)).toBe(true);
        expect(phoneAccepts(overLimit)).toBe(false);
        expect(isValidPbGhostTrace(overLimit)).toBe(false);
    });

    it('today differs for other letters: the phone accepts what the server refuses', () => {
        // "é" is 1 character and 2 UTF-8 bytes. "🏁" is 2 characters and 4 bytes.
        for (const letter of ['é', '🏁']) {
            const trace = traceOfSize(PB_GHOST_MAX_ENCODED_BYTES - 1000, letter);
            expect(Buffer.byteLength(JSON.stringify(trace), 'utf8')).toBeGreaterThan(PB_GHOST_MAX_ENCODED_BYTES);

            expect(phoneAccepts(trace), letter).toBe(true);
            expect(isValidPbGhostTrace(trace), letter).toBe(false);
        }
    });

    it('agrees for a ghost that the recorder makes, because it holds only numbers', () => {
        const pose = (timeSec) => ({
            timeSec,
            position: { x: 20 * Math.cos(timeSec), y: 12 * Math.sin(timeSec) },
            angle: timeSec + Math.PI / 2,
        });
        const recorder = createPbGhostTraceRecorder(pose(0));
        for (let frame = 1; frame < 60 * 40; frame += 1) recorder.sample(pose(frame / 60));
        const trace = recorder.finish(pose(40));

        expect(JSON.stringify(trace)).toMatch(/^[\x20-\x7e]+$/);
        expect(phoneAccepts(trace)).toBe(true);
        expect(isValidPbGhostTrace(trace)).toBe(true);
    });
});
