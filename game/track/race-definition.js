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

// Shows a race whose track is installed. The new track is drawn first. Then
// the finish screen closes and the lobby fades out, so the previous track
// never shows.
export async function revealInstalledRace(engine) {
    engine.resize?.({ render: true });
    engine.modal?.closeModal?.();
    const transition = engine.startOverlay?.beginRaceStartTransition?.();
    if (!transition) engine.startOverlay?.hideStartOverlay?.();
    await transition;
}

// Explicit Retry/Restart adopts a new definition. Collision resets continue to
// use the fixed definition and runtime of the current attempt.
export async function reloadChangedRaceTrack(engine, { isStillCurrent = () => true, ...options } = {}) {
    if (hasCurrentTrackDefinition(engine)) return;
    const trackKey = engine.currentTrackKey;
    const challenge = engine.activeDailyChallenge;
    // A removed override may reveal a built-in whose chunk was never needed
    // on entry. This explicit reload is the definition-loading exception.
    await engine.loadRaceDefinitions?.([trackKey], { challenge });
    if (!isStillCurrent()) return;
    const prepared = engine.readyRaceTrack?.('selected', trackKey, challenge);
    await engine.loadTrack(trackKey, {
        loadPlayerProgress: false,
        preserveDailyChallengeContext: true,
        preserveDailyChallengeOnReset: true,
        showStartOverlayOnReset: false,
        keepScreen: true,
        prepared: prepared ?? null,
        loadedOnly: typeof engine.loadRaceDefinitions === 'function',
        isStillCurrent,
        ...options,
    });
}
