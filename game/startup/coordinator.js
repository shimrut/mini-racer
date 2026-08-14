const MODE_KEYS = new Set(['home', 'daily', 'campaign', 'challenge']);

export const INITIAL_LOADER_BUDGET_MS = 800;
export const INITIAL_LOADER_MAX_MS = 1_000;
const INITIAL_LOADER_FADE_MS = 160;

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

export async function runInitialStartupPlan({
    mode,
    prepareRuntime,
    loadPlayer,
    loadHomeTrack,
    loadDailyContract,
    loadDailyTrack,
    loadCampaignContract,
    loadCampaignTrack,
    loadChallenge,
    loadCar,
    onPhase,
    onHandoff,
    onReady,
    onError,
    loaderBudgetMs = INITIAL_LOADER_BUDGET_MS,
    loaderMaxMs = INITIAL_LOADER_MAX_MS,
    startedAtMs = null,
} = {}) {
    const selectedMode = normalizeMode(mode);
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const loaderStartedAt = Number.isFinite(startedAtMs) ? startedAtMs : now();
    let handoffPromise = null;
    const handoff = (reason) => {
        if (!handoffPromise) {
            const remainingMs = Math.max(0, loaderMaxMs - (now() - loaderStartedAt));
            const fadeMs = Math.min(INITIAL_LOADER_FADE_MS, remainingMs);
            handoffPromise = Promise.resolve(onHandoff?.({
                mode: selectedMode,
                reason,
                fadeMs,
            }));
        }
        return handoffPromise;
    };
    const elapsedBeforePlanMs = Math.max(0, now() - loaderStartedAt);
    const budgetTimer = setTimeout(() => {
        void handoff('budget');
    }, Math.max(0, loaderBudgetMs - elapsedBeforePlanMs));

    try {
        phase(onPhase, 10, `Loading ${MODE_LABELS[selectedMode]}…`);
        await prepareRuntime?.(selectedMode);

        let result = null;
        if (selectedMode === 'challenge') {
            phase(onPhase, 35, 'Loading Head to Head challenge…');
            const challengePromise = Promise.resolve(loadChallenge?.({
                onTrackPhase: () => phase(onPhase, 65, 'Preparing Head to Head track…'),
                onGhostPhase: () => phase(onPhase, 80, 'Preparing opponent ghost…'),
            }));
            const playerPromise = Promise.resolve(loadPlayer?.({ handoff })).catch((error) => {
                console.error('Error loading player profile for Head to Head:', error);
                return null;
            });
            result = await challengePromise;
            phase(onPhase, 88, 'Syncing player identity…');
            await playerPromise;
            void Promise.resolve(loadCar?.())
                .catch((error) => console.error('Error loading player car:', error));
        } else if (selectedMode === 'campaign') {
            phase(onPhase, 30, 'Fetching player profile…');
            await loadPlayer?.({ handoff });
            phase(onPhase, 50, 'Loading Campaign progress…');
            result = await loadCampaignContract?.();
            phase(onPhase, 70, 'Preparing Campaign track…');
            await loadCampaignTrack?.(result);
            phase(onPhase, 85, 'Loading player car…');
            void Promise.resolve(loadCar?.())
                .catch((error) => console.error('Error loading player car:', error));
        } else if (selectedMode === 'daily') {
            phase(onPhase, 30, 'Fetching player profile…');
            const playerPromise = Promise.resolve(loadPlayer?.({ handoff }));
            const dailyPromise = Promise.resolve(loadDailyContract?.());
            await playerPromise;
            phase(onPhase, 50, 'Loading Daily challenge…');
            result = await dailyPromise;
            phase(onPhase, 70, 'Preparing Daily track…');
            await loadDailyTrack?.(result);
            phase(onPhase, 85, 'Loading player car…');
            void Promise.resolve(loadCar?.())
                .catch((error) => console.error('Error loading player car:', error));
        } else {
            phase(onPhase, 30, 'Fetching player profile…');
            const playerPromise = Promise.resolve(loadPlayer?.({ handoff }));
            const trackPromise = Promise.resolve(loadHomeTrack?.());
            await playerPromise;
            phase(onPhase, 70, 'Preparing Home track…');
            await trackPromise;
            phase(onPhase, 85, 'Loading player car…');
            void Promise.resolve(loadCar?.())
                .catch((error) => console.error('Error loading player car:', error));
        }

        phase(onPhase, 95, `Displaying ${MODE_LABELS[selectedMode]}…`);
        await onReady?.({ mode: selectedMode, result });
        await handoff('ready');
        return { mode: selectedMode, result };
    } catch (error) {
        await onError?.({ mode: selectedMode, error });
        await handoff('error');
        throw error;
    } finally {
        clearTimeout(budgetTimer);
    }
}

export function selectModeSecondaryStartupTasks(mode) {
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === 'challenge') return ['daily', 'campaign'];
    if (normalizedMode === 'daily') return ['campaign'];
    if (normalizedMode === 'campaign') return ['daily'];
    return ['daily', 'campaign'];
}
