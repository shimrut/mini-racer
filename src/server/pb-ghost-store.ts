import { redisCompressed as redis } from '@devvit/redis';
import type { Competition } from './competition.js';
import {
    createTrackFingerprint,
    isValidPbGhostTrace,
    PB_GHOST_SCHEMA_VERSION,
    PB_GHOST_SIMULATION_REVISION,
    type PbGhostTrace,
} from './pb-ghost-trace.js';
import {
    beginOwnedRedisLockTransaction,
    releaseRedisLock,
    type RedisLock,
} from './redis-lock.js';
import { encodeRedisCompressedValue } from './redis-compressed-value.js';
import { normalizeLapCompletionTimesSec } from '../../game/shared/lap-completion-times.js';
import type {
    ObsoleteReason,
    StoredRecordClassification,
} from './guest-transfer-source-classification.js';
import { playerFieldHash } from './value-guards.js';
import { acquireRedisLockWithRetry } from './redis-lock-retry.js';

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
const PB_LOCK_RETRY_DELAYS_MS = [20, 20, 20, 20];
const PB_READ_BATCH_SIZE = 10;

async function acquirePersonalBestLock(lockKey: string): Promise<RedisLock | null> {
    return acquireRedisLockWithRetry(lockKey, PB_LOCK_TTL_MS, PB_LOCK_RETRY_DELAYS_MS, redis);
}

function getCompetitionRaceIdentity(competition: Competition): {
    rulesRevision: 0 | 1;
    lapCount: 1 | 2 | 3;
} {
    if (competition.rulesRevision !== 1) {
        return { rulesRevision: 0, lapCount: 1 };
    }
    return { rulesRevision: 1, lapCount: competition.lapCount };
}

export function challengeCollectionKey(challengeId: string): string {
    return `dailygp:challenge-pbs:${challengeId}`;
}

function playerChallengeLockKey(competitionId: string, playerId: string): string {
    const playerHash = playerFieldHash(playerId);
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

function readCompatibleRecordValue(
    raw: string | null | undefined,
    competition: Competition,
    trackFingerprint: string,
    raceIdentity: { rulesRevision: 0 | 1; lapCount: 1 | 2 | 3 },
): PlayerTrackPbRecord | null {
    const record = parseRecord(raw);
    if (!record) return null;
    if (
        record.trackKey !== competition.trackKey
        || record.trackFingerprint !== trackFingerprint
        || record.simulationRevision !== PB_GHOST_SIMULATION_REVISION
        || record.rulesRevision !== raceIdentity.rulesRevision
        || record.lapCount !== raceIdentity.lapCount
    ) {
        return null;
    }
    return record;
}

export function classifyStoredPbRecordValue(
    raw: string | null | undefined,
    competition: Competition,
    trackFingerprint: string,
    raceIdentity: { rulesRevision: 0 | 1; lapCount: 1 | 2 | 3 },
): StoredRecordClassification<PlayerTrackPbRecord> {
    if (raw === null || raw === undefined || raw === '') return { state: 'absent' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return { state: 'malformed', reason: 'unparseable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { state: 'malformed', reason: 'not_an_object' };
    }

    const value = parsed as Record<string, unknown>;
    if (
        typeof value.trackKey !== 'string'
        || !value.trackKey
        || typeof value.trackFingerprint !== 'string'
        || !Number.isFinite(value.bestTimeMs)
        || typeof value.updatedAt !== 'string'
        || !value.updatedAt
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }

    const updatedAt = Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null;
    const obsolete = (reason: ObsoleteReason): StoredRecordClassification<PlayerTrackPbRecord> => (
        { state: 'obsolete', reason, updatedAt }
    );

    if (
        typeof value.schemaVersion !== 'number'
        || typeof value.simulationRevision !== 'number'
        || typeof value.rulesRevision !== 'number'
        || !Number.isInteger(value.rulesRevision)
        || typeof value.lapCount !== 'number'
        || !Number.isInteger(value.lapCount)
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }

    if (value.schemaVersion !== PB_GHOST_SCHEMA_VERSION) return obsolete('schema_version');
    if (value.simulationRevision !== PB_GHOST_SIMULATION_REVISION) {
        return obsolete('simulation_revision');
    }
    if (value.trackKey !== competition.trackKey) return obsolete('track_retired');
    if (value.trackFingerprint !== trackFingerprint) return obsolete('track_fingerprint');
    if (
        value.rulesRevision !== raceIdentity.rulesRevision
        || value.lapCount !== raceIdentity.lapCount
    ) {
        return obsolete('race_identity');
    }

    const record = parseRecord(raw);
    if (!record) return { state: 'malformed', reason: 'missing_fields' };
    return { state: 'valid', record };
}

export function classifyStoredPbRecordFor(
    raw: string | null | undefined,
    competition: Competition,
    track: Record<string, any>,
): StoredRecordClassification<PlayerTrackPbRecord> {
    return classifyStoredPbRecordValue(
        raw,
        competition,
        createTrackFingerprint(track),
        getCompetitionRaceIdentity(competition),
    );
}

async function readCompatibleRecord({
    playerId,
    competition,
    track,
    cleanupUnusable = false,
}: {
    playerId: string;
    competition: Competition;
    track: Record<string, any>;
    cleanupUnusable?: boolean;
}): Promise<PlayerTrackPbRecord | null> {
    const collectionKey = competition.pbHashKey;
    const field = playerFieldHash(playerId);
    const raw = await redis.hGet(collectionKey, field);
    const fingerprint = createTrackFingerprint(track);
    const raceIdentity = getCompetitionRaceIdentity(competition);
    const record = readCompatibleRecordValue(raw, competition, fingerprint, raceIdentity);
    if (!record) {
        if (raw && cleanupUnusable) await redis.hDel(collectionKey, [field]);
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

export async function getPlayerTrackPbRecords({
    playerIds,
    competition,
    track,
}: {
    playerIds: string[];
    competition: Competition;
    track: Record<string, any>;
}): Promise<Map<string, PlayerTrackPbRecord | null>> {
    const uniquePlayerIds = [...new Set(playerIds)];
    if (!uniquePlayerIds.length) return new Map();

    const trackFingerprint = createTrackFingerprint(track);
    const raceIdentity = getCompetitionRaceIdentity(competition);
    const batches = Array.from(
        { length: Math.ceil(uniquePlayerIds.length / PB_READ_BATCH_SIZE) },
        (_, index) => uniquePlayerIds.slice(
            index * PB_READ_BATCH_SIZE,
            (index + 1) * PB_READ_BATCH_SIZE,
        ),
    );
    const batchResults = await Promise.all(batches.map(async (batch) => {
        const rawRecords = await redis.hMGet(
            competition.pbHashKey,
            batch.map(playerFieldHash),
        );
        return batch.map((playerId, index) => [
            playerId,
            readCompatibleRecordValue(
                rawRecords[index],
                competition,
                trackFingerprint,
                raceIdentity,
            ),
        ] as const);
    }));

    return new Map(batchResults.flat());
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
    const ttlSeconds = competition.ttlSeconds;
    if (ttlSeconds != null && ttlSeconds <= 0) {
        throw new Error('Personal best retention deadline has passed.');
    }

    const lockKey = playerChallengeLockKey(competition.id, playerId);
    const lock = await acquirePersonalBestLock(lockKey);
    if (!lock) {
        throw new Error('Personal best update already in progress.');
    }
    try {
        const existing = await readCompatibleRecord({
            playerId,
            competition,
            track,
            cleanupUnusable: true,
        });
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
            [playerFieldHash(playerId)]: encodeRedisCompressedValue(JSON.stringify(record)),
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
