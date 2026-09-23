import { describe, expect, it } from 'vitest';
import {
    isValidPbGhostTrace,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SCHEMA_VERSION,
} from '../src/server/competition/pb-ghost-trace.ts';

function validTrace(overrides = {}) {
    return {
        schemaVersion: PB_GHOST_SCHEMA_VERSION,
        sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
        finishTimeMs: 50,
        origin: [0, 0, 0],
        deltas: [1, 2, 3],
        ...overrides,
    };
}

describe('pb-ghost-trace wave 2', () => {
    it('rejects traces whose schema version is not the current version', () => {
        expect(isValidPbGhostTrace(validTrace({ schemaVersion: PB_GHOST_SCHEMA_VERSION + 1 }))).toBe(false);
    });

    it('rejects traces with a non-integer finish time', () => {
        expect(isValidPbGhostTrace(validTrace({ finishTimeMs: 50.1 }))).toBe(false);
    });

    it('rejects traces with the wrong sample interval constant', () => {
        expect(isValidPbGhostTrace(validTrace({ sampleIntervalMs: 51 }))).toBe(false);
    });

    it('rejects traces whose delta length is not a multiple of three', () => {
        expect(isValidPbGhostTrace(validTrace({ deltas: [1, 2] }))).toBe(false);
        expect(isValidPbGhostTrace(validTrace({ deltas: [1, 2, 3, 4] }))).toBe(false);
    });
});
