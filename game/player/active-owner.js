let activePlayerOwnerId = null;

/**
 * One id per webview load. The signed-in account cannot change without a reload. A finish before
 * identity answers is stamped with this phone's guest id. This visit can attach that run to the
 * named account; a later sign-in cannot. Last visit's guest run waits for that guest or an explicit
 * progress choice.
 */
const PLAYER_SESSION_ID = (() => {
    const randomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : null;
    return randomUUID || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();

export function getPlayerSessionId() {
    return PLAYER_SESSION_ID;
}

/**
 * The account queued results belong to, as named by the server. It is deliberately session state and
 * never read from storage: the signed-in account can differ from the one that raced, and a stale owner
 * would submit one player's run under another's name.
 */
export function getActivePlayerOwnerId() {
    return activePlayerOwnerId;
}

export function setActivePlayerOwnerId(ownerPlayerId) {
    const nextOwnerId = typeof ownerPlayerId === 'string' && ownerPlayerId.trim()
        ? ownerPlayerId.trim()
        : null;
    const changed = nextOwnerId !== activePlayerOwnerId;
    activePlayerOwnerId = nextOwnerId;
    return { ownerPlayerId: activePlayerOwnerId, changed };
}

export function clearActivePlayerOwnerId() {
    activePlayerOwnerId = null;
}
