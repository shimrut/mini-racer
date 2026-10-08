import medalTimes from '../../../game/medals/medal-times.json' with { type: 'json' };
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';
import { getMedalRowError } from '../../../game/track/authoring/medal-rules.js';
import { readStoredTrack } from './track-store.js';
import { TrackInputError, normalizeTrackShape, type TrackShape, type Point } from './track-shape.js';
import { assertCreatorTrackAccess } from './creator-track-access.js';
import { matchesAppTrack } from './track-copy.js';
import { createTrackFingerprint } from '../competition/pb-ghost-trace.js';

export function getTrackCompletenessError(
    track: TrackShape, draftLoop: readonly Point[], medalRow: unknown, appTrackKey?: string,
): string | null {
    if (draftLoop.length || track.outer.length < 3 || track.inner.length < 3) return 'Finish the road.';
    // Published app layouts predate some checks: admit their exact contract, recheck any edit.
    if (appTrackKey && matchesAppTrack({
        key: appTrackKey,
        track: normalizeTrackShape(track),
        draftLoop: [],
        medalRow: medalRow as Parameters<typeof matchesAppTrack>[0]['medalRow'],
        fingerprint: createTrackFingerprint(track),
    })) return getMedalRowError(medalRow);
    const quality = validateTrackQuality(track);
    if (quality.hasErrors) return quality.issues.find((issue: { severity: string }) => issue.severity === 'error')?.message
        ?? 'The track did not pass the checks.';
    return getMedalRowError(medalRow);
}

export function isBuiltInTrackComplete(trackKey: string): boolean {
    const track = BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
    return Boolean(track) && !getTrackCompletenessError(track, [], (medalTimes as Record<string, unknown>)[trackKey], trackKey);
}

// Uses the current record, not a cache or trusted flag, and needs all four raw medal times.
export async function readCompleteTrack(trackKey: string, username?: string) {
    const stored = await readStoredTrack(trackKey);
    if (username !== undefined) await assertCreatorTrackAccess(stored, username);
    const track = stored?.track ?? BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
    if (!track) throw new TrackInputError(`The game has no track called ${trackKey}.`);
    const medalRow = stored ? stored.medalRow : (medalTimes as Record<string, unknown>)[trackKey];
    const error = getTrackCompletenessError(track, stored?.draftLoop ?? [], medalRow, trackKey);
    if (error) throw new TrackInputError(`${track.name}: ${error}`);
    return { track, medalRow, stored };
}
