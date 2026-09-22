const MODE_KEYS = new Set(['home', 'daily', 'campaign', 'challenge']);

export const MODE_LABELS = {
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

        const graphics = Promise.resolve(startGraphics?.(selectedMode, {
            onContractPhase: () => phase(onPhase, 30, `Loading ${modeLabel} data…`),
            onTrackPhase: () => phase(onPhase, 65, 'Preparing the track…'),
        }));
        const raceData = Promise.resolve(startRaceData?.(selectedMode));
        raceData.catch(() => {});

        await graphics;
        phase(onPhase, 85, 'Loading your progress…');
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
