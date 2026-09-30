import { createHash } from 'node:crypto';
import { validateTrackQuality } from '../../../game/track/authoring/track-quality.js';
import {
    TrackInputError,
    normalizeDraftLoop,
    normalizeTrackShape,
    type Gate,
    type Point,
    type TrackShape,
} from '../tracks/track-shape.js';

export type { Gate, Point };
export type CommunityTrack = TrackShape;
export { TrackInputError as CommunityMapInputError };

export function normalizeCommunityDraft(input: unknown): { track: CommunityTrack; draftLoop: Point[] } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TrackInputError('Track data must be an object.');
    }
    const payload = input as Record<string, unknown>;
    return {
        track: normalizeTrackShape(payload.track),
        draftLoop: normalizeDraftLoop(payload.draftLoop),
    };
}

export function communityTrackSignature(track: CommunityTrack): string {
    return createHash('sha256').update(JSON.stringify(track)).digest('hex');
}

export function assertCommunityTrackPublishable(track: CommunityTrack): void {
    if (!track.name) {
        throw new TrackInputError('Give the map a name before publishing.');
    }
    const quality = validateTrackQuality(track);
    if (quality.hasErrors) {
        const problem = quality.issues.find((entry: { severity: string }) => entry.severity === 'error');
        throw new TrackInputError(problem?.message ?? 'Map geometry did not pass checks.');
    }
}
