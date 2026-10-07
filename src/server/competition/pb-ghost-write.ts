import { redis } from '@devvit/redis';
import { packPbGhostTrace } from './pb-ghost-pack.js';
import { isValidPbGhostTrace } from './pb-ghost-trace.js';
import { encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';

// The switch that makes the best-time writer save ghosts packed. The Storage
// tab turns it on with the first ghost compaction step, after every server
// already reads packed ghosts.
export const WRITE_PACKED_GHOSTS_KEY = 'dailygp:ghost-compact:v1:write-packed';

// Each server reads the switch at most once a minute.
const CACHE_MS = 60_000;
let cache: { value: boolean; readAtMs: number } | null = null;

export async function shouldWritePackedGhosts(nowMs = Date.now()): Promise<boolean> {
    if (cache && nowMs - cache.readAtMs < CACHE_MS) return cache.value;
    let value = cache?.value ?? false;
    try {
        value = Boolean(await redis.get(WRITE_PACKED_GHOSTS_KEY));
    } catch (_error) {
    }
    cache = { value, readAtMs: nowMs };
    return value;
}

export async function turnOnPackedGhostWrites(nowMs = Date.now()): Promise<void> {
    await redis.set(WRITE_PACKED_GHOSTS_KEY, '1');
    notePackedGhostWritesOn(nowMs);
}

// For a caller that saved the switch in its own transaction: this server
// writes packed from now on, without waiting for its next read.
export function notePackedGhostWritesOn(nowMs = Date.now()): void {
    cache = { value: true, readAtMs: nowMs };
}

export function resetPackedGhostWriteCacheForTests(): void {
    cache = null;
}

// How the best-time writer stores a record: packed once the switch is on,
// plain before, and plain when the ghost cannot be packed exactly.
export function encodeStoredPbRecord(record: Record<string, unknown>, writePacked: boolean): string {
    if (writePacked && isValidPbGhostTrace(record.ghost)) {
        const ghostPacked = packPbGhostTrace(record.ghost);
        if (ghostPacked) return encodeRedisCompressedValue(JSON.stringify({ ...record, ghost: null, ghostPacked }));
    }
    return encodeRedisCompressedValue(JSON.stringify(record));
}
