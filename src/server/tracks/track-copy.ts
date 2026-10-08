import medalTimes from '../../../game/medals/medal-times.json' with { type: 'json' };
import { normalizeMedalRow as normalizeGameMedalRow } from '../../../game/medals/medal-timing.js';
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';
import { TrackInputError, normalizeTrackShape } from './track-shape.js';
import {
    MAX_TRACK_NAME_LENGTH,
    type StoredTrackLockReason,
    type StoredTrackRecord,
} from './track-store.js';

// A Redis copy must race exactly like the app track, medals and name included; the fingerprint skips rounding.

const APP_MEDAL_ROWS = medalTimes as Record<string, unknown>;

function sortedKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortedKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]));
}

function appTrack(trackKey: string): Record<string, unknown> | null {
    return (BUILT_IN_TRACKS as Record<string, Record<string, unknown>>)[trackKey] ?? null;
}

export function appMedalRow(trackKey: string) {
    return normalizeGameMedalRow(APP_MEDAL_ROWS[trackKey]) ?? null;
}

// An unfinished drawing or saved road line is moderator work, so the copy is not exact.
export function matchesAppTrack(
    record: Pick<StoredTrackRecord, 'key' | 'track' | 'medalRow' | 'fingerprint'>
        & Partial<Pick<StoredTrackRecord, 'draftLoop' | 'roadLine'>>,
): boolean {
    const source = appTrack(record.key);
    return Boolean(source)
        && !record.draftLoop?.length
        && !record.roadLine
        // Creator storage drops obsolete rendering fields from older app tracks.
        && JSON.stringify(sortedKeys(record.track)) === JSON.stringify(sortedKeys(
            normalizeTrackShape(source!, { maxNameLength: MAX_TRACK_NAME_LENGTH }),
        ))
        // The app and the Creator write the medal times in another order.
        && JSON.stringify(sortedKeys(record.medalRow ?? null)) === JSON.stringify(sortedKeys(appMedalRow(record.key)))
        && record.fingerprint === createTrackFingerprint(source!);
}

// A played app track copied locked, without authoring checks; a mismatch is refused before any write.
export function buildLockedTrackCopy(
    trackKey: string,
    { username, reason, now }: { username: string; reason: StoredTrackLockReason; now: Date },
): StoredTrackRecord {
    const source = appTrack(trackKey);
    if (!source) throw new TrackInputError(`The app has no track called ${trackKey}.`);
    const track = normalizeTrackShape(structuredClone(source), { maxNameLength: MAX_TRACK_NAME_LENGTH });
    const stamp = now.toISOString();
    const record: StoredTrackRecord = {
        version: 1,
        key: trackKey,
        track,
        draftLoop: [],
        medalRow: appMedalRow(trackKey),
        checksPassed: true,
        checkError: null,
        fingerprint: createTrackFingerprint(track),
        origin: 'migrated',
        revision: 1,
        createdAt: stamp,
        createdBy: username,
        updatedAt: stamp,
        updatedBy: username,
        lockedAt: stamp,
        lockReason: reason,
    };
    if (!matchesAppTrack(record)) throw new TrackInputError('The copy did not match the app track.');
    return record;
}
