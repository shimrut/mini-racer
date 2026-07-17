import { redisCompressed as redis } from '@devvit/redis';
import { createHash, randomUUID } from 'node:crypto';
import { DAILY_GP_PLAYER_PROFILE_TTL_SECONDS } from './daily-gp-model.js';
import {
    createTrackFingerprint,
    PB_GHOST_SCHEMA_VERSION,
    PB_GHOST_SIMULATION_REVISION,
    type PbGhostTrace,
} from './pb-ghost-trace.js';

export type PlayerTrackPbRecord = {
    schemaVersion: typeof PB_GHOST_SCHEMA_VERSION;
    trackKey: string;
    trackFingerprint: string;
    simulationRevision: typeof PB_GHOST_SIMULATION_REVISION;
    bestTimeMs: number;
    checkpointTimesSec: number[] | null;
    ghost: PbGhostTrace | null;
    updatedAt: string;
};

const PB_LOCK_TTL_MS = 5_000;

function playerCollectionKey(playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `dailygp:track-pbs:${playerHash}`;
}

function playerTrackLockKey(playerId: string, trackKey: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `dailygp:track-pb-lock:${playerHash}:${trackKey}`;
}

function parseRecord(raw: string | null | undefined): PlayerTrackPbRecord | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<PlayerTrackPbRecord>;
        if (
            value.schemaVersion !== PB_GHOST_SCHEMA_VERSION
            || typeof value.trackKey !== 'string'
            || !value.trackKey
            || typeof value.trackFingerprint !== 'string'
            || value.simulationRevision !== PB_GHOST_SIMULATION_REVISION
            || !Number.isFinite(value.bestTimeMs)
            || typeof value.updatedAt !== 'string'
        ) {
            return null;
        }
        const ghost = value.ghost && typeof value.ghost === 'object'
            && value.ghost.schemaVersion === PB_GHOST_SCHEMA_VERSION
            && value.ghost.sampleRateHz === 20
            && Array.isArray(value.ghost.samples)
            && value.ghost.samples.length >= 2
            && value.ghost.samples.length <= 4_000
            && value.ghost.samples.every((sample) => (
                Array.isArray(sample)
                && sample.length === 4
                && sample.every(Number.isInteger)
            ))
            ? value.ghost as PbGhostTrace
            : null;
        return {
            schemaVersion: PB_GHOST_SCHEMA_VERSION,
            trackKey: value.trackKey,
            trackFingerprint: value.trackFingerprint,
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            bestTimeMs: Math.round(Number(value.bestTimeMs)),
            checkpointTimesSec: Array.isArray(value.checkpointTimesSec)
                ? value.checkpointTimesSec.map(Number).filter(Number.isFinite)
                : null,
            ghost,
            updatedAt: value.updatedAt,
        };
    } catch (_error) {
        return null;
    }
}

async function readCompatibleRecord({
    playerId,
    trackKey,
    track,
}: {
    playerId: string;
    trackKey: string;
    track: Record<string, any>;
}): Promise<PlayerTrackPbRecord | null> {
    const collectionKey = playerCollectionKey(playerId);
    const raw = await redis.hGet(collectionKey, trackKey);
    const record = parseRecord(raw);
    const fingerprint = createTrackFingerprint(track);
    if (!record) {
        if (raw) await redis.hDel(collectionKey, [trackKey]);
        return null;
    }
    if (
        record.trackKey !== trackKey
        || record.trackFingerprint !== fingerprint
        || record.simulationRevision !== PB_GHOST_SIMULATION_REVISION
    ) {
        await redis.hDel(collectionKey, [trackKey]);
        return null;
    }
    return record;
}

async function releaseLock(key: string, value: string): Promise<void> {
    const storedValue = await redis.get(key);
    if (storedValue === value) {
        await redis.del(key);
    }
}

export async function getPlayerTrackPbRecord(input: {
    playerId: string;
    trackKey: string;
    track: Record<string, any>;
}): Promise<PlayerTrackPbRecord | null> {
    return readCompatibleRecord(input);
}

export async function upsertPlayerTrackPersonalBest({
    playerId,
    isGuest,
    trackKey,
    track,
    bestTimeMs,
    checkpointTimesSec,
    ghost,
    updatedAt = new Date().toISOString(),
}: {
    playerId: string;
    isGuest: boolean;
    trackKey: string;
    track: Record<string, any>;
    bestTimeMs: number;
    checkpointTimesSec: number[] | null;
    ghost: PbGhostTrace | null;
    updatedAt?: string;
}): Promise<{ record: PlayerTrackPbRecord; improved: boolean }> {
    const lockKey = playerTrackLockKey(playerId, trackKey);
    const lockValue = randomUUID();
    const acquired = await redis.set(lockKey, lockValue, {
        nx: true,
        expiration: new Date(Date.now() + PB_LOCK_TTL_MS),
    });
    if (!acquired) {
        throw new Error('Personal best update already in progress.');
    }

    try {
        const existing = await readCompatibleRecord({ playerId, trackKey, track });
        if (existing && existing.bestTimeMs <= bestTimeMs) {
            return { record: existing, improved: false };
        }

        const record: PlayerTrackPbRecord = {
            schemaVersion: PB_GHOST_SCHEMA_VERSION,
            trackKey,
            trackFingerprint: createTrackFingerprint(track),
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            bestTimeMs: Math.round(bestTimeMs),
            checkpointTimesSec,
            ghost,
            updatedAt,
        };
        const collectionKey = playerCollectionKey(playerId);
        await redis.hSet(collectionKey, { [trackKey]: JSON.stringify(record) });
        if (isGuest) {
            await redis.expire(collectionKey, DAILY_GP_PLAYER_PROFILE_TTL_SECONDS);
        }
        return { record, improved: true };
    } finally {
        await releaseLock(lockKey, lockValue);
    }
}

export async function seedPlayerTrackPersonalBest(input: Omit<
    Parameters<typeof upsertPlayerTrackPersonalBest>[0],
    'ghost'
>): Promise<{ record: PlayerTrackPbRecord; improved: boolean }> {
    return upsertPlayerTrackPersonalBest({ ...input, ghost: null });
}

export async function deleteAllPlayerTrackPersonalBests(playerId: string): Promise<void> {
    await redis.del(playerCollectionKey(playerId));
}
