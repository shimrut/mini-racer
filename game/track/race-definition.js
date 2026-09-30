import { getLoadedClientTrack } from './client-registry.js';
import { getTrackDefinitionIdentity } from './definition-identity.js';

export const CHANGED_TRACK_RUN_MESSAGE = 'This track changed while you were racing. Retry to race the confirmed layout.';

export function hasChangedTrackDefinition(engine) {
    const latest = getLoadedClientTrack(engine.currentTrackKey);
    return Boolean(engine.currentTrack
        && (!latest || getTrackDefinitionIdentity(latest) !== getTrackDefinitionIdentity(engine.currentTrack)));
}

export function hasCurrentTrackDefinition(engine, trackKey = engine.currentTrackKey) {
    if (engine.currentTrackKey !== trackKey || !engine.trackCanvas) return false;
    return !engine.currentTrack || !hasChangedTrackDefinition(engine);
}

export function getStaleRunTrackReason(engine) {
    const attempt = engine.runTrackDefinitionIdentity;
    const latest = getLoadedClientTrack(engine.currentTrackKey);
    return attempt
        && (!latest || engine.runTrackKey !== engine.currentTrackKey || attempt !== getTrackDefinitionIdentity(latest))
        ? CHANGED_TRACK_RUN_MESSAGE
        : null;
}

// Explicit Retry/Restart adopts a new definition. Collision resets continue to
// use the fixed definition and runtime of the current attempt.
export async function reloadChangedRaceTrack(engine, options = {}) {
    if (hasCurrentTrackDefinition(engine)) return;
    await engine.loadTrack(engine.currentTrackKey, {
        loadPlayerProgress: false,
        preserveDailyChallengeContext: true,
        preserveDailyChallengeOnReset: true,
        showStartOverlayOnReset: false,
        ...options,
    });
}
