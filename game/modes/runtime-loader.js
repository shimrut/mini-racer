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
