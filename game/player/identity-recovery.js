import { getPlayerProgressState } from '../storage.js';

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

export const PLAYER_IDENTITY_READY_TIMEOUT_MS = 10_000;

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
