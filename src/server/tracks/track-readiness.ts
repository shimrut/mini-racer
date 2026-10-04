import medalTimes from '../../../game/medals/medal-times.json' with { type: 'json' };
import { BUILT_IN_TRACKS } from '../../../game/track/tracks.js';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';
import { getMedalRowError } from '../../../game/track/authoring/medal-rules.js';
import { readStoredTrack } from './track-store.js';
import { TrackInputError, type TrackShape, type Point } from './track-shape.js';
import { assertCreatorTrackAccess } from './creator-track-access.js';

export function getTrackCompletenessError(track: TrackShape, draftLoop: readonly Point[], medalRow: unknown): string | null {
    if (draftLoop.length || track.outer.length < 3 || track.inner.length < 3) return 'Finish the road.';
    const quality = validateTrackQuality(track);
    if (quality.hasErrors) return quality.issues.find((issue: { severity: string }) => issue.severity === 'error')?.message
        ?? 'The track did not pass the checks.';
    return getMedalRowError(medalRow);
}

export function isBuiltInTrackComplete(trackKey: string): boolean {
    const track = BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
    return Boolean(track) && !getTrackCompletenessError(track, [], (medalTimes as Record<string, unknown>)[trackKey]);
}

// Admission uses the current record, rather than the request's cached overlay
// or the migration's trusted checks flag. All four raw medal times are needed.
export async function readCompleteTrack(trackKey: string, username?: string) {
    const stored = await readStoredTrack(trackKey);
    if (username !== undefined) await assertCreatorTrackAccess(stored, username);
    const track = stored?.track ?? BUILT_IN_TRACKS[trackKey as keyof typeof BUILT_IN_TRACKS];
    if (!track) throw new TrackInputError(`The game has no track called ${trackKey}.`);
    const medalRow = stored ? stored.medalRow : (medalTimes as Record<string, unknown>)[trackKey];
    const error = getTrackCompletenessError(track, stored?.draftLoop ?? [], medalRow);
    if (error) throw new TrackInputError(`${track.name}: ${error}`);
    return { track, medalRow, stored };
}
