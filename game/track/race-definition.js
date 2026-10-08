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

// Draws the new track first, then closes the finish screen and fades the lobby.
export async function revealInstalledRace(engine) {
    engine.resize?.({ render: true });
    engine.modal?.closeModal?.();
    const transition = engine.startOverlay?.beginRaceStartTransition?.();
    if (!transition) engine.startOverlay?.hideStartOverlay?.();
    await transition;
}

// Retry and Restart adopt a new definition; collision resets keep the attempt's own.
export async function reloadChangedRaceTrack(engine, { isStillCurrent = () => true, ...options } = {}) {
    if (hasCurrentTrackDefinition(engine)) return;
    const trackKey = engine.currentTrackKey;
    const challenge = engine.activeDailyChallenge;
    // The one definition load allowed here: a removed override can reveal an unloaded built-in.
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
