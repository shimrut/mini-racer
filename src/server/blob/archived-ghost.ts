import type { Competition } from '../competition/competition.js';
import { isMovedPbRecord } from '../competition/pb-ghost-archive-ref.js';
import {
    classifyStoredPbRecordFor,
    movedRowText,
    type PlayerTrackPbRecord,
} from '../competition/pb-ghost-store.js';
import type { PbGhostTrace } from '../competition/pb-ghost-trace.js';
import { createBlobSession, createDevvitBlobStore, type BlobStore } from './blob-store.js';
import { ghostBlobPrefixForBoard, verifyArchivedCopy } from './ghost-archive-copy.js';

// Race readers: a moved ghost is read from blob storage and checked; any failure means "unavailable now".
// Readers never write: the row stays as it is whatever the read returns.

// One read inside a player request; a slow store must not hold the race.
const READ_CALL_MS = 2_500;
const READ_DEADLINE_MS = 3_000;
const READ_CALLS_PER_SECOND = 10;
const WARN_EVERY_MS = 60 * 60 * 1000;
let lastWarnAt = Number.NEGATIVE_INFINITY;

function warnUnavailable(reason: string, board: string, now: number, error?: unknown): void {
    if (now - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = now;
    console.warn(`Moved ghost unavailable (${reason}) on ${board}; this server logs at most one an hour.`, error ?? '');
}

export type MovedGhostReadOptions = {
    store?: BlobStore;
    now?: () => number;
};

export async function readMovedPbGhost(
    record: PlayerTrackPbRecord,
    competition: Competition,
    track: Record<string, any>,
    { store, now = Date.now }: MovedGhostReadOptions = {},
): Promise<PbGhostTrace | null> {
    const ref = record.ghostArchive;
    const stubText = movedRowText(record);
    const prefix = ghostBlobPrefixForBoard(competition.pbHashKey);
    if (!isMovedPbRecord(record) || !ref || !stubText || !prefix || !track) return null;
    try {
        const session = createBlobSession({
            store: store ?? createDevvitBlobStore(),
            deadlineMs: now() + READ_DEADLINE_MS,
            callTimeoutMs: READ_CALL_MS,
            maxCallsPerSecond: READ_CALLS_PER_SECOND,
        });
        const checked = verifyArchivedCopy({ copy: await session.get(ref.key), ref, stubText, prefix });
        if (checked.ok === false) {
            warnUnavailable(checked.code, competition.pbHashKey, now());
            return null;
        }
        // The copy must still fit the live race, and its ghost must end at the best time.
        if (
            classifyStoredPbRecordFor(checked.fullText, competition, track).state !== 'valid'
            || checked.ghost.finishTimeMs !== record.bestTimeMs
        ) {
            warnUnavailable('incompatible', competition.pbHashKey, now());
            return null;
        }
        return checked.ghost;
    } catch (error) {
        warnUnavailable('read_failed', competition.pbHashKey, now(), error);
        return null;
    }
}

export type ResolvedPbRecord = {
    record: PlayerTrackPbRecord | null;
    // True when the row holds a moved ghost that could not be read now; the game asks again later.
    ghostUnavailable: boolean;
};

// Puts a moved row's ghost back on the record for one answer; other records pass through unchanged.
export async function resolveMovedPbGhost(
    record: PlayerTrackPbRecord | null,
    competition: Competition,
    track: Record<string, any>,
    options: MovedGhostReadOptions = {},
): Promise<ResolvedPbRecord> {
    if (!record || !isMovedPbRecord(record)) return { record, ghostUnavailable: false };
    const ghost = await readMovedPbGhost(record, competition, track, options);
    return ghost
        ? { record: { ...record, ghost }, ghostUnavailable: false }
        : { record, ghostUnavailable: true };
}

// What the game receives: no blob reference, and a flag when a moved ghost could not be read now.
export function toGamePbRecord<Record extends { ghostArchive?: unknown }>(
    record: Record | null,
    ghostUnavailable: boolean,
): (Omit<Record, 'ghostArchive'> & { ghostUnavailable?: true }) | null {
    if (!record) return null;
    const { ghostArchive: _reference, ...rest } = record;
    return ghostUnavailable ? { ...rest, ghostUnavailable: true } : rest;
}
