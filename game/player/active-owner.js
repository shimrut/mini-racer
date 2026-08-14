let activePlayerOwnerId = null;

/**
 * One id per webview load. The signed-in account cannot change without a reload. A finish before
 * identity answers is stamped with who this phone already is. A later sign-in cannot take that run.
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
