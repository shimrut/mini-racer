import {
    CAMPAIGN_ID,
    getCampaignStage,
} from '../../../game/campaign/manifest.js';

export type StoredRecordClassification<T> =
    | { state: 'absent' }
    | { state: 'valid'; record: T }
    | { state: 'obsolete'; reason: ObsoleteReason; updatedAt: string | null }
    | { state: 'malformed'; reason: MalformedReason };

export type ObsoleteReason =
    | 'schema_version'
    | 'simulation_revision'
    | 'track_fingerprint'
    | 'track_retired'
    | 'stage_retired'
    | 'stage_redefined'
    | 'race_identity'
    | 'validation_method';

export type MalformedReason =
    | 'unparseable'
    | 'not_an_object'
    | 'missing_fields'
    | 'key_mismatch'
    | 'wrong_campaign'
    | 'wrong_player';

type ReadJsonResult =
    | { ok: 'parsed'; value: Record<string, unknown> }
    | { ok: 'damaged'; reason: MalformedReason }
    | { ok: 'empty' };

function readJson(raw: string | null | undefined): ReadJsonResult {
    if (raw === null || raw === undefined || raw === '') return { ok: 'empty' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        return { ok: 'damaged', reason: 'unparseable' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: 'damaged', reason: 'not_an_object' };
    }
    return { ok: 'parsed', value: parsed as Record<string, unknown> };
}

function readTimestamp(value: unknown): string | null {
    return typeof value === 'string' && value && Number.isFinite(Date.parse(value))
        ? value
        : null;
}

export function readStoredUpdatedAt(raw: string | null | undefined): string | null {
    const json = readJson(raw);
    if (json.ok !== 'parsed') return null;
    return readTimestamp(json.value.updatedAt);
}

export type CampaignProgressRow = {
    raceId: string;
    trackKey: string;
    lapCount: number;
    rulesRevision: number;
    bestTimeMs: number;
    updatedAt: string;
};

export type ClassifiedCampaignProgress = {
    startedAt: string | null;
    updatedAt: string | null;
    rows: Record<string, CampaignProgressRow>;
    obsoleteRaceIds: string[];
};

export function classifyStoredCampaignProgress(
    raw: string | null | undefined,
): StoredRecordClassification<ClassifiedCampaignProgress> {
    const json = readJson(raw);
    if (json.ok === 'empty') return { state: 'absent' };
    if (json.ok === 'damaged') return { state: 'malformed', reason: json.reason };

    const value = json.value;
    if (value.campaignId !== CAMPAIGN_ID) {
        return { state: 'malformed', reason: 'wrong_campaign' };
    }

    const rows: Record<string, CampaignProgressRow> = Object.create(null);
    const obsoleteRaceIds: string[] = [];
    const results = value.resultsByRaceId;
    if (results !== undefined && results !== null) {
        if (typeof results !== 'object' || Array.isArray(results)) {
            return { state: 'malformed', reason: 'missing_fields' };
        }
        for (const [raceId, candidate] of Object.entries(results as Record<string, unknown>)) {
            const row = classifyCampaignResultRow(raceId, candidate);
            if (row.state === 'malformed') return { state: 'malformed', reason: row.reason };
            if (row.state === 'obsolete') {
                obsoleteRaceIds.push(raceId);
                continue;
            }
            if (row.state === 'valid') rows[raceId] = row.record;
        }
    }

    return {
        state: 'valid',
        record: {
            startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
            rows,
            obsoleteRaceIds,
        },
    };
}

function classifyCampaignResultRow(
    raceId: string,
    candidate: unknown,
): StoredRecordClassification<CampaignProgressRow> {
    if (candidate === null || candidate === undefined) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { state: 'malformed', reason: 'not_an_object' };
    }
    const row = candidate as Record<string, unknown>;
    const updatedAt = readTimestamp(row.updatedAt);

    if (
        !Number.isSafeInteger(row.bestTimeMs)
        || Number(row.bestTimeMs) <= 0
        || typeof row.updatedAt !== 'string'
        || !row.updatedAt
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (
        typeof row.trackKey !== 'string'
        || !row.trackKey
        || typeof row.lapCount !== 'number'
        || !Number.isInteger(row.lapCount)
        || typeof row.rulesRevision !== 'number'
        || !Number.isInteger(row.rulesRevision)
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (typeof row.raceId !== 'string' || row.raceId !== raceId) {
        return { state: 'malformed', reason: 'key_mismatch' };
    }

    const stage = getCampaignStage(raceId);
    if (!stage) return { state: 'obsolete', reason: 'stage_retired', updatedAt };
    if (
        row.trackKey !== stage.trackKey
        || row.lapCount !== stage.lapCount
        || row.rulesRevision !== stage.rulesRevision
    ) {
        return { state: 'obsolete', reason: 'stage_redefined', updatedAt };
    }

    return {
        state: 'valid',
        record: {
            raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            rulesRevision: stage.rulesRevision,
            bestTimeMs: Math.round(Number(row.bestTimeMs)),
            updatedAt: row.updatedAt,
        },
    };
}

export type ClassifiedLeaderboardEntry = {
    playerId: string;
    trackKey: string | null;
    bestTimeMs: number;
    completedLaps: number | null;
    validationMethod: string | null;
    updatedAt: string;
};

export function classifyStoredLeaderboardEntry(
    raw: string | null | undefined,
    expectedPlayerId: string,
    stage: { trackKey: string; lapCount: number } | null,
): StoredRecordClassification<ClassifiedLeaderboardEntry> {
    const json = readJson(raw);
    if (json.ok === 'empty') return { state: 'absent' };
    if (json.ok === 'damaged') return { state: 'malformed', reason: json.reason };

    const value = json.value;
    if (
        typeof value.playerId !== 'string'
        || !value.playerId
        || !Number.isFinite(value.bestTimeMs)
        || typeof value.updatedAt !== 'string'
        || !value.updatedAt
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (value.playerId !== expectedPlayerId) {
        return { state: 'malformed', reason: 'wrong_player' };
    }

    const updatedAt = readTimestamp(value.updatedAt);
    if (value.trackKey !== undefined && (typeof value.trackKey !== 'string' || !value.trackKey)) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (
        value.completedLaps !== undefined
        && (typeof value.completedLaps !== 'number' || !Number.isInteger(value.completedLaps))
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (value.validationMethod !== undefined && typeof value.validationMethod !== 'string') {
        return { state: 'malformed', reason: 'missing_fields' };
    }

    const trackKey = typeof value.trackKey === 'string' && value.trackKey ? value.trackKey : null;
    if (stage) {
        if (trackKey && trackKey !== stage.trackKey) {
            return { state: 'obsolete', reason: 'track_retired', updatedAt };
        }
        if (value.completedLaps !== undefined && value.completedLaps !== stage.lapCount) {
            return { state: 'obsolete', reason: 'stage_redefined', updatedAt };
        }
    }
    if (value.validationMethod !== undefined && value.validationMethod !== 'strict-replay') {
        return { state: 'obsolete', reason: 'validation_method', updatedAt };
    }

    return {
        state: 'valid',
        record: {
            playerId: value.playerId,
            trackKey,
            bestTimeMs: Number(value.bestTimeMs),
            completedLaps: typeof value.completedLaps === 'number' ? value.completedLaps : null,
            validationMethod: typeof value.validationMethod === 'string'
                ? value.validationMethod
                : null,
            updatedAt: value.updatedAt,
        },
    };
}
