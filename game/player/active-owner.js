let activePlayerOwnerId = null;

const PLAYER_SESSION_ID = (() => {
    const randomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : null;
    return randomUUID || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();

export function getPlayerSessionId() {
    return PLAYER_SESSION_ID;
}

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
