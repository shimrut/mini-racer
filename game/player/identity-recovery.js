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

/**
 * A finish must be recorded whether or not identity comes back. Recovery can sit behind an overlay
 * the player has not answered — an unfinished transfer waiting on Retry, or the progress chooser —
 * and a race that already ran still owes its result to whoever owned it. So `work` waits for
 * recovery, but not indefinitely.
 */
export const PLAYER_IDENTITY_READY_TIMEOUT_MS = 10_000;

/** Runs `work` now when identity is already known; otherwise after one recovery attempt. */
export function runAfterPlayerIdentityReady(engine, work) {
    if (engine?.playerProfileAuthoritative !== false) {
        work();
        return;
    }
    let ran = false;
    const runOnce = () => {
        if (ran) return;
        ran = true;
        work();
    };
    const timeoutId = setTimeout(runOnce, PLAYER_IDENTITY_READY_TIMEOUT_MS);
    void recoverPlayerIdentity(engine).finally(() => {
        clearTimeout(timeoutId);
        runOnce();
    });
}
