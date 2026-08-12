const runtimeCache = new Map();
const runtimeImporters = {
    daily: () => import('../daily-challenge/engine-methods.js'),
    campaign: () => import('../campaign/engine-methods.js'),
    challenge: () => import('../head-to-head/engine-methods.js'),
};

function normalizeMethods(module) {
    return module && typeof module === 'object'
        ? Object.fromEntries(Object.entries(module).filter(([name]) => (
            name.endsWith('EngineMethods') && module[name] && typeof module[name] === 'object'
        )))
        : {};
}

export async function loadModeRuntime(mode = 'home') {
    const normalizedMode = runtimeImporters[mode] ? mode : 'home';
    if (runtimeCache.has(normalizedMode)) return runtimeCache.get(normalizedMode);

    const sharedPromise = import('../challenge-run/engine-methods.js');
    const modePromise = runtimeImporters[normalizedMode]
        ? runtimeImporters[normalizedMode]()
        : Promise.resolve(null);
    const [sharedModule, modeModule] = await Promise.all([sharedPromise, modePromise]);
    const methods = {
        ...(sharedModule?.challengeRunEngineMethods || {}),
        ...Object.values(normalizeMethods(modeModule)).reduce(
            (all, current) => ({ ...all, ...current }),
            {},
        ),
    };
    const runtime = { mode: normalizedMode, methods };
    runtimeCache.set(normalizedMode, runtime);
    return runtime;
}

export function clearModeRuntimeCacheForTests() {
    runtimeCache.clear();
}

const RUNTIME_MODES = new Set(['daily', 'campaign', 'challenge']);

function normalizeRuntimeMode(mode) {
    if (mode === 'challenge') return 'challenge';
    return RUNTIME_MODES.has(mode) ? mode : 'home';
}

function resolveActiveRuntimeMode(activeRaceMode, launchMode) {
    if (RUNTIME_MODES.has(activeRaceMode)) return activeRaceMode;
    if (RUNTIME_MODES.has(launchMode)) return launchMode;
    return null;
}

export function createModeRuntimeController(RealTimeRacerClass) {
    const loaded = new Map();

    async function load(mode) {
        const normalized = normalizeRuntimeMode(mode);
        if (loaded.has(normalized)) return loaded.get(normalized);
        const runtime = await loadModeRuntime(normalized);
        loaded.set(normalized, runtime);
        return runtime;
    }

    function install(runtime) {
        Object.assign(RealTimeRacerClass.prototype, runtime.methods);
    }

    return {
        async prefetch(mode) {
            return load(mode);
        },
        async ensure(mode, activeRaceMode = null, launchMode = null) {
            const normalized = normalizeRuntimeMode(mode);
            const runtime = await load(normalized);
            install(runtime);
            const activeNormalized = resolveActiveRuntimeMode(activeRaceMode, launchMode);
            if (
                activeNormalized
                && activeNormalized !== normalized
                && loaded.has(activeNormalized)
            ) {
                install(loaded.get(activeNormalized));
            }
            return runtime;
        },
        clearForTests() {
            loaded.clear();
            clearModeRuntimeCacheForTests();
        },
    };
}
