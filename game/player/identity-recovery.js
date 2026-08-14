import { getPlayerProgressState } from '../storage.js';

/**
 * One identity chase used after Continue Offline and again at a queued PB finish.
 * Never opens the sync-failure prompt. In-flight calls share one request.
 */
export async function recoverPlayerIdentity(engine) {
    if (engine?.playerProfileAuthoritative) return true;
    if (engine?._playerIdentityRecoveryPromise) {
        return engine._playerIdentityRecoveryPromise;
    }

    const run = (async () => {
        try {
            const state = await getPlayerProgressState();
            if (state?.authoritative === true) {
                engine.stopPlayerProfileRecovery?.();
                await engine.applyPlayerProgressState?.(state);
                return true;
            }
        } catch (error) {
            console.error('Error recovering player profile state:', error);
        }
        return false;
    })();

    engine._playerIdentityRecoveryPromise = run;
    try {
        return await run;
    } finally {
        if (engine._playerIdentityRecoveryPromise === run) {
            engine._playerIdentityRecoveryPromise = null;
        }
    }
}

/** Runs `work` now when identity is already known; otherwise after one recovery attempt. */
export function runAfterPlayerIdentityReady(engine, work) {
    if (engine?.playerProfileAuthoritative !== false) {
        work();
        return;
    }
    void recoverPlayerIdentity(engine).finally(work);
}
