import {
    CAMPAIGN_ID,
    getCampaignStage,
} from '../../game/campaign/manifest.js';

/**
 * How one stored record stands against what this build can use.
 *
 * The ordinary gameplay readers answer `null` for four different situations, and every caller
 * treats that `null` as "absent". A transfer cannot. It is about to replace an account from this
 * record and then delete it, so it must tell the four apart:
 *
 * - `absent`     Nothing is stored. This is normal, and it is not evidence of loss.
 * - `valid`      The record parses and matches this build. Copy it.
 * - `obsolete`   The record is well formed, but a supported track, campaign, or simulation change
 *                made it unusable. The player already cannot see it. It needs no person to look
 *                at it, and it must not be copied into ranked data.
 * - `malformed`  The record is damaged, or it names another player. This is the only kind that
 *                needs a reviewed repair, so its source is kept.
 *
 * `updatedAt` rides along on `obsolete` because the retention a preserved record inherits is
 * derived from it. It is `null` when the stored value carried no usable timestamp.
 */
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

/** True when a classification must stop the transfer and wait for a person. */
export function requiresReviewedRecovery(
    classification: StoredRecordClassification<unknown>,
): boolean {
    return classification.state === 'malformed';
}

/**
 * True when a classification carries data worth copying. `obsolete` is deliberately excluded:
 * the record is real, but no reader accepts it, so copying it would move dead weight into the
 * account's ranked rows.
 */
export function carriesCopyableData(
    classification: StoredRecordClassification<unknown>,
): boolean {
    return classification.state === 'valid';
}

/**
 * Three outcomes, told apart by a string rather than by `true | false | null`.
 *
 * A `null` arm cannot be narrowed away when `strictNullChecks` is off, so every read of `value` or
 * `reason` below was unchecked in a build that never type-checked this file. The names also say
 * what each arm means at the call site.
 */
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

/**
 * Pulls a usable `updatedAt` out of a stored value without judging the rest of it.
 *
 * Retention for a source held for review is derived from when that data was last touched, and a
 * record can be damaged in one field while still saying honestly when it was written. Reading the
 * timestamp only from records that classified as usable throws away the very evidence a damaged
 * record was kept for, and leaves it with no deadline at all.
 */
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
    /** Rows this build can use, keyed by race id. */
    rows: Record<string, CampaignProgressRow>;
    /** Rows a supported campaign change made unusable. Kept so a copy can report them. */
    obsoleteRaceIds: string[];
};

/**
 * Classifies one stored Campaign progress row.
 *
 * `parseCampaignProgress` answers an empty progress for damaged JSON and silently drops a result
 * it cannot read. Under a replacing transfer that empty answer overwrites the account. This
 * separates a campaign that legitimately changed under the player's feet from a row that broke.
 */
export function classifyStoredCampaignProgress(
    raw: string | null | undefined,
): StoredRecordClassification<ClassifiedCampaignProgress> {
    const json = readJson(raw);
    if (json.ok === 'empty') return { state: 'absent' };
    if (json.ok === 'damaged') return { state: 'malformed', reason: json.reason };

    const value = json.value;
    // Another campaign's progress under this player's key is not this transfer's to interpret.
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

/**
 * One result inside a Campaign progress row. A race the manifest no longer names, or a stage it
 * redefined, is a supported change. A row whose time or timestamp is unusable is damage.
 */
function classifyCampaignResultRow(
    raceId: string,
    candidate: unknown,
): StoredRecordClassification<CampaignProgressRow> {
    // The key exists, so something was written under it. A null or undefined value there is a
    // row that was lost, not a row that was never there, and it must not read as absent: under a
    // replacing transfer "absent" is what empties the account.
    if (candidate === null || candidate === undefined) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { state: 'malformed', reason: 'not_an_object' };
    }
    const row = candidate as Record<string, unknown>;
    const updatedAt = readTimestamp(row.updatedAt);

    // Damage is checked before the manifest, so a broken row is never excused as a retired stage.
    if (
        !Number.isSafeInteger(row.bestTimeMs)
        || Number(row.bestTimeMs) <= 0
        || typeof row.updatedAt !== 'string'
        || !row.updatedAt
    ) {
        return { state: 'malformed', reason: 'missing_fields' };
    }
    // Types before values. A field of the wrong type cannot be compared against the manifest, so
    // treating a mismatch as a supported change would call damage an obsolete stage.
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
    // The key and the row must agree on which race this is, or neither can be trusted to name it.
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

/**
 * Classifies one stored leaderboard entry.
 *
 * An entry naming another player is the one case here that is never a supported change: it means
 * two identities were crossed, and no automatic repair may guess which one owns the time.
 */
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
    // Types before values, the same as the progress and personal-best classifiers. A field of the
    // wrong type differs from what the stage expects, and reading that difference as a supported
    // change is how damage gets called obsolete and then quietly dropped.
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
    // A run accepted under an earlier validation policy is a supported legacy representation.
    // It stays readable for the player, but a transfer must not promote it into ranked data.
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
