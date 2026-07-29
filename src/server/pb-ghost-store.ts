import { redisCompressed as redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import type { Competition } from './competition.js';
import {
    createTrackFingerprint,
    isValidPbGhostTrace,
    PB_GHOST_SCHEMA_VERSION,
    PB_GHOST_SIMULATION_REVISION,
    type PbGhostTrace,
} from './pb-ghost-trace.js';
import {
    acquireRedisLock,
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
} from './redis-lock.js';
import { encodeRedisCompressedValue } from './redis-compressed-value.js';
import { normalizeLapCompletionTimesSec } from '../../game/shared/lap-completion-times.js';

export type PlayerTrackPbRecord = {
    schemaVersion: typeof PB_GHOST_SCHEMA_VERSION;
    trackKey: string;
    trackFingerprint: string;
    simulationRevision: typeof PB_GHOST_SIMULATION_REVISION;
    rulesRevision: 0 | 1;
    lapCount: 1 | 2 | 3;
    bestTimeMs: number;
    checkpointTimesSec: number[] | null;
    lapCompletionTimesSec: number[] | null;
    ghost: PbGhostTrace | null;
    updatedAt: string;
};

const PB_LOCK_TTL_MS = 30_000;

/**
 * A record is only interchangeable with another run of the same race, so the
 * stored rules revision and lap count are what a reader checks before trusting
 * one. Revision 0 predates multi-lap and is always a single lap.
 */
function getCompetitionRaceIdentity(competition: Competition): {
    rulesRevision: 0 | 1;
    lapCount: 1 | 2 | 3;
} {
    if (competition.rulesRevision !== 1) {
        return { rulesRevision: 0, lapCount: 1 };
    }
    return { rulesRevision: 1, lapCount: competition.lapCount };
}

function playerField(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

export function challengeCollectionKey(challengeId: string): string {
    return `dailygp:challenge-pbs:${challengeId}`;
}

function playerChallengeLockKey(competitionId: string, playerId: string): string {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `dailygp:challenge-pb-lock:${competitionId}:${playerHash}`;
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
        const ghost = isValidPbGhostTrace(value.ghost)
            ? value.ghost
            : null;
        const rulesRevision = value.rulesRevision === 1 ? 1 : 0;
        const lapCount = rulesRevision === 1 && (value.lapCount === 2 || value.lapCount === 3)
            ? value.lapCount
            : 1;
        return {
            schemaVersion: PB_GHOST_SCHEMA_VERSION,
            trackKey: value.trackKey,
            trackFingerprint: value.trackFingerprint,
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            rulesRevision,
            lapCount,
            bestTimeMs: Math.round(Number(value.bestTimeMs)),
            checkpointTimesSec: Array.isArray(value.checkpointTimesSec)
                ? value.checkpointTimesSec.map(Number).filter(Number.isFinite)
                : null,
            lapCompletionTimesSec: normalizeLapCompletionTimesSec(
                Number(value.bestTimeMs) / 1000,
                value.lapCompletionTimesSec,
                lapCount,
            ),
            ghost,
            updatedAt: value.updatedAt,
        };
    } catch (_error) {
        return null;
    }
}

async function readCompatibleRecord({
    playerId,
    competition,
    track,
}: {
    playerId: string;
    competition: Competition;
    track: Record<string, any>;
}): Promise<PlayerTrackPbRecord | null> {
    const collectionKey = competition.pbHashKey;
    const field = playerField(playerId);
    const raw = await redis.hGet(collectionKey, field);
    const record = parseRecord(raw);
    const fingerprint = createTrackFingerprint(track);
    const raceIdentity = getCompetitionRaceIdentity(competition);
    if (!record) {
        if (raw) await redis.hDel(collectionKey, [field]);
        return null;
    }
    if (
        record.trackKey !== competition.trackKey
        || record.trackFingerprint !== fingerprint
        || record.simulationRevision !== PB_GHOST_SIMULATION_REVISION
        || record.rulesRevision !== raceIdentity.rulesRevision
        || record.lapCount !== raceIdentity.lapCount
    ) {
        await redis.hDel(collectionKey, [field]);
        return null;
    }
    return record;
}

export async function getPlayerTrackPbRecord(input: {
    playerId: string;
    competition: Competition;
    track: Record<string, any>;
}): Promise<PlayerTrackPbRecord | null> {
    return readCompatibleRecord(input);
}

export async function upsertPlayerTrackPersonalBest({
    playerId,
    competition,
    track,
    bestTimeMs,
    checkpointTimesSec,
    lapCompletionTimesSec = null,
    ghost,
    retainedPersonalBest = null,
    updatedAt = new Date().toISOString(),
}: {
    playerId: string;
    competition: Competition;
    track: Record<string, any>;
    bestTimeMs: number;
    checkpointTimesSec: number[] | null;
    lapCompletionTimesSec?: number[] | null;
    ghost: PbGhostTrace | null;
    retainedPersonalBest?: {
        bestTimeMs: number;
        checkpointTimesSec: number[] | null;
        lapCompletionTimesSec?: number[] | null;
        updatedAt: string;
    } | null;
    updatedAt?: string;
}): Promise<{ record: PlayerTrackPbRecord; improved: boolean }> {
    const trackKey = competition.trackKey;
    // A permanent competition has no deadline to miss. A time-boxed one still
    // does, and writing a PB no reader would ever accept is worse than failing.
    const ttlSeconds = competition.ttlSeconds;
    if (ttlSeconds != null && ttlSeconds <= 0) {
        throw new Error('Personal best retention deadline has passed.');
    }

    const lockKey = playerChallengeLockKey(competition.id, playerId);
    const lock = await acquireRedisLock(lockKey, PB_LOCK_TTL_MS, redis);
    if (!lock) {
        throw new Error('Personal best update already in progress.');
    }
    try {
        const existing = await readCompatibleRecord({ playerId, competition, track });
        const trackFingerprint = createTrackFingerprint(track);
        const raceIdentity = getCompetitionRaceIdentity(competition);
        const current: PlayerTrackPbRecord = {
            schemaVersion: PB_GHOST_SCHEMA_VERSION,
            trackKey,
            trackFingerprint,
            simulationRevision: PB_GHOST_SIMULATION_REVISION,
            ...raceIdentity,
            bestTimeMs: Math.round(bestTimeMs),
            checkpointTimesSec,
            lapCompletionTimesSec: normalizeLapCompletionTimesSec(
                bestTimeMs / 1000,
                lapCompletionTimesSec,
                raceIdentity.lapCount,
            ),
            ghost,
            updatedAt,
        };
        const retained = retainedPersonalBest && Number.isFinite(retainedPersonalBest.bestTimeMs)
            ? {
                schemaVersion: PB_GHOST_SCHEMA_VERSION,
                trackKey,
                trackFingerprint,
                simulationRevision: PB_GHOST_SIMULATION_REVISION,
                ...raceIdentity,
                bestTimeMs: Math.round(retainedPersonalBest.bestTimeMs),
                checkpointTimesSec: retainedPersonalBest.checkpointTimesSec,
                lapCompletionTimesSec: normalizeLapCompletionTimesSec(
                    retainedPersonalBest.bestTimeMs / 1000,
                    retainedPersonalBest.lapCompletionTimesSec,
                    raceIdentity.lapCount,
                ),
                ghost: null,
                updatedAt: retainedPersonalBest.updatedAt,
            } satisfies PlayerTrackPbRecord
            : null;
        const candidates = [
            existing ? { source: 'existing' as const, record: existing } : null,
            retained ? { source: 'retained' as const, record: retained } : null,
            { source: 'current' as const, record: current },
        ].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
        const winner = candidates.reduce((best, candidate) => {
            if (candidate.record.bestTimeMs < best.record.bestTimeMs) return candidate;
            if (candidate.record.bestTimeMs > best.record.bestTimeMs) return best;
            if (candidate.record.ghost && !best.record.ghost) return candidate;
            return best;
        });
        if (winner.source === 'existing') {
            return { record: existing!, improved: false };
        }

        const record = winner.record;
        const transaction = await beginOwnedRedisLockTransaction(lock, redis);
        if (!transaction) {
            throw new Error('Personal best lock ownership was lost.');
        }
        const collectionKey = competition.pbHashKey;
        await transaction.hSet(collectionKey, {
            [playerField(playerId)]: encodeRedisCompressedValue(JSON.stringify(record)),
        });
        if (ttlSeconds != null) {
            await transaction.expire(collectionKey, ttlSeconds);
        }
        const transactionResults = await transaction.exec();
        if (!Array.isArray(transactionResults) || transactionResults.length === 0) {
            throw new Error('Personal best lock ownership was lost.');
        }
        return { record, improved: winner.source === 'current' };
    } finally {
        try {
            await releaseRedisLock(lock, redis);
        } catch (error) {
            // Lock cleanup is best-effort; it must not replace a committed outcome.
            console.error('Challenge PB lock cleanup failed:', error);
        }
    }
}

export async function seedPlayerTrackPersonalBest(input: Omit<
    Parameters<typeof upsertPlayerTrackPersonalBest>[0],
    'ghost'
>): Promise<{ record: PlayerTrackPbRecord; improved: boolean }> {
    return upsertPlayerTrackPersonalBest({ ...input, ghost: null });
}
