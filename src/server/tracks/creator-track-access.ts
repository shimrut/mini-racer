import { redis } from '@devvit/redis';
import { readDailySchedule } from '../daily/daily-schedule-store.js';
import { listStoredSeries, STORED_SERIES_REVISION_KEY } from '../campaign/series-store.js';
import {
    listStoredTrackRecords, readStoredTrack, summarizeStoredTrack, STORED_TRACKS_REVISION_KEY, type StoredTrackRecord,
} from './track-store.js';
import { TrackInputError } from './track-shape.js';
import { TrackPlacementRetryError } from './track-placement-lock.js';

export function normalizedCreatorUsername(username: unknown): string {
    return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

// Membership is also checked for records written before sharedAt existed.
// Missing owners/origins remain private, rather than exposing an unaudited draft.
export async function readCreatorTrackPlacements(): Promise<Set<string>> {
    const [schedule, series] = await Promise.all([readDailySchedule(), listStoredSeries()]);
    return new Set([...schedule.keys, ...series.flatMap((entry) => entry.stages.map((stage) => stage.trackKey))]);
}

export function isPrivateCreatorTrack(record: StoredTrackRecord, placements: ReadonlySet<string>): boolean {
    return record.origin !== 'migrated' && !record.lockedAt && !record.sharedAt && !placements.has(record.key);
}

export function canAccessCreatorTrack(record: StoredTrackRecord, username: string, placements: ReadonlySet<string>): boolean {
    const owner = normalizedCreatorUsername(record.createdBy);
    return !isPrivateCreatorTrack(record, placements)
        || Boolean(owner && owner === normalizedCreatorUsername(username));
}

export async function assertCreatorTrackAccess(record: StoredTrackRecord | null, username: string): Promise<void> {
    if (record && !canAccessCreatorTrack(record, username, await readCreatorTrackPlacements())) {
        // Do not disclose the other account's draft name, shape, or revision.
        throw new TrackInputError('A track already uses this key. Choose another name.');
    }
}

export async function creatorTrackRecord(record: StoredTrackRecord) {
    return { ...record, privateDraft: isPrivateCreatorTrack(record, await readCreatorTrackPlacements()) };
}

async function withCreatorTrackSnapshot<T>(read: () => Promise<T>) {
    const revisions = async () => {
        const values = await redis.mGet([
            STORED_TRACKS_REVISION_KEY, STORED_SERIES_REVISION_KEY, 'dailygp:daily:schedule:v1',
        ]);
        if (!Array.isArray(values) || values.length !== 3) {
            throw new TrackPlacementRetryError('The tracks could not load. Try again.');
        }
        return values;
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await revisions();
        const [records, placements] = await Promise.all([read(), readCreatorTrackPlacements()]);
        const after = await revisions();
        if (JSON.stringify(before) === JSON.stringify(after)) return { records, placements };
    }
    // A newer assignment must never make an older private layout public.
    throw new TrackPlacementRetryError('The tracks could not load. Try again.');
}

export async function readCreatorTrack(trackKey: string, username: string) {
    const { records: record, placements } = await withCreatorTrackSnapshot(() => readStoredTrack(trackKey));
    if (!record) return null;
    return canAccessCreatorTrack(record, username, placements)
        ? { ...record, privateDraft: isPrivateCreatorTrack(record, placements) } : null;
}

export async function listCreatorTrackRecords(username: string) {
    const { records, placements } = await withCreatorTrackSnapshot(listStoredTrackRecords);
    return records.filter((record) => canAccessCreatorTrack(record, username, placements))
        .map((record) => ({ ...record, privateDraft: isPrivateCreatorTrack(record, placements) }));
}

export async function listCreatorTracks(username: string) {
    return (await listCreatorTrackRecords(username)).map((record) => ({
        ...summarizeStoredTrack(record), privateDraft: record.privateDraft,
    }));
}

// Placement makes a draft shared permanently. Its geometry and edit stamps
// stay unchanged; the revision invalidates old editor snapshots and caches.
export async function readTracksToShare(trackKeys: Iterable<string>, now: Date): Promise<StoredTrackRecord[]> {
    const records = await Promise.all([...new Set(trackKeys)].map(readStoredTrack));
    return records.flatMap((record) => record && record.origin !== 'migrated' && !record.lockedAt && !record.sharedAt
        ? [{ ...record, sharedAt: now.toISOString(), revision: record.revision + 1 }] : []);
}
