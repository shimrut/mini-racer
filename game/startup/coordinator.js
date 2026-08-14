const MODE_KEYS = new Set(['home', 'daily', 'campaign', 'challenge']);

const MODE_LABELS = {
    home: 'Home',
    daily: 'Daily',
    campaign: 'Campaign',
    challenge: 'Head to Head',
};

function normalizeMode(mode) {
    return MODE_KEYS.has(mode) ? mode : 'home';
}

function phase(onPhase, progress, label) {
    onPhase?.({ progress, label });
}

/**
 * Runs the selected mode's startup to completion and only then reveals the lobby.
 * Graphics and race data are both started up front: the graphics never wait on a
 * server answer they do not need, and nothing here gives up on a slow request.
 */
export async function runInitialStartupPlan({
    mode,
    prepareRuntime,
    startGraphics,
    startRaceData,
    onPhase,
    onReady,
    onError,
} = {}) {
    const selectedMode = normalizeMode(mode);
    const modeLabel = MODE_LABELS[selectedMode];

    try {
        phase(onPhase, 10, `Loading ${modeLabel}…`);
        await prepareRuntime?.(selectedMode);

        const graphics = Promise.resolve(startGraphics?.(selectedMode));
        const raceData = Promise.resolve(startRaceData?.(selectedMode));
        // Both groups are in flight from here, so a race-data failure must not count as
        // unhandled while the graphics are still being awaited.
        raceData.catch(() => {});

        phase(onPhase, 40, 'Loading graphics…');
        await graphics;
        phase(onPhase, 75, 'Loading race data…');
        const result = await raceData;

        phase(onPhase, 95, `Displaying ${modeLabel}…`);
        await onReady?.({ mode: selectedMode, result });
        return { mode: selectedMode, result };
    } catch (error) {
        await onError?.({ mode: selectedMode, error });
        throw error;
    }
}

export function selectModeSecondaryStartupTasks(mode) {
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === 'challenge') return ['daily', 'campaign'];
    if (normalizedMode === 'daily') return ['campaign'];
    if (normalizedMode === 'campaign') return ['daily'];
    return ['daily', 'campaign'];
}
