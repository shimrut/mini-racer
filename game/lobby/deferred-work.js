export function deferLobbyWorkUntilAfterPaint(engine, expectedMode, work) {
    if (!engine || typeof work !== 'function') return null;
    const token = (engine._deferredLobbyWorkToken || 0) + 1;
    engine._deferredLobbyWorkToken = token;

    const runIfCurrent = () => {
        if (engine._deferredLobbyWorkToken !== token) return;
        if (engine.activeRaceMode !== expectedMode) return;
        work();
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => {
            globalThis.requestAnimationFrame(runIfCurrent);
        });
    } else {
        setTimeout(runIfCurrent, 0);
    }
    return token;
}

export function cancelDeferredLobbyWork(engine) {
    if (!engine) return;
    engine._deferredLobbyWorkToken = (engine._deferredLobbyWorkToken || 0) + 1;
}
