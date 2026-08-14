const PLAYER_ID_STORAGE_KEY = 'VectorGpScoreboardPlayerId';
const GUEST_PLAYER_TOKEN_STORAGE_KEY = 'VectorGpGuestPlayerToken';
const GUEST_OWNER_PREFIX = 'guest:';
let ephemeralPlayerId = null;
let ephemeralGuestPlayerToken = null;
let hasEphemeralGuestPlayerToken = false;

function createPlayerId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    const randomHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${randomHex()}${randomHex()}-${randomHex()}-4${randomHex().slice(1)}-a${randomHex().slice(1)}-${randomHex()}${randomHex()}${randomHex()}`;
}

export function getOrCreatePlayerId(logLabel = 'scoreboard') {
    if (typeof window === 'undefined' || !window.localStorage) {
        ephemeralPlayerId ||= createPlayerId();
        return ephemeralPlayerId;
    }

    try {
        if (ephemeralPlayerId) return ephemeralPlayerId;
        const storedId = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
        if (storedId) return storedId;

        const nextId = createPlayerId();
        window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, nextId);
        return nextId;
    } catch (error) {
        console.error(`Error accessing ${logLabel} player id:`, error);
        ephemeralPlayerId ||= createPlayerId();
        return ephemeralPlayerId;
    }
}

export function toGuestOwnerId(playerId) {
    if (typeof playerId !== 'string' || !playerId.trim()) return null;
    const trimmed = playerId.trim();
    return trimmed.startsWith(GUEST_OWNER_PREFIX) ? trimmed : `${GUEST_OWNER_PREFIX}${trimmed}`;
}

export function getPhoneGuestOwnerId() {
    return toGuestOwnerId(getOrCreatePlayerId('player identity'));
}

export function rotateGuestPlayerIdentity(logLabel = 'scoreboard') {
    const nextId = createPlayerId();
    ephemeralPlayerId = nextId;

    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, nextId);
        } catch (error) {
            console.error(`Error rotating ${logLabel} player id:`, error);
        }
    }

    setGuestPlayerToken(null);
    return nextId;
}

// A guest id is retained for token recovery, then retired only after a successful Reddit promotion.

export function getGuestPlayerToken() {
    if (hasEphemeralGuestPlayerToken) {
        return ephemeralGuestPlayerToken;
    }
    if (typeof window === 'undefined' || !window.localStorage) {
        return ephemeralGuestPlayerToken;
    }

    try {
        const storedToken = window.localStorage.getItem(GUEST_PLAYER_TOKEN_STORAGE_KEY);
        return storedToken && storedToken.trim()
            ? storedToken.trim()
            : ephemeralGuestPlayerToken;
    } catch (error) {
        console.error('Error reading guest player token:', error);
        return ephemeralGuestPlayerToken;
    }
}

export function setGuestPlayerToken(token) {
    const normalizedToken = typeof token === 'string' && token.trim()
        ? token.trim()
        : null;
    ephemeralGuestPlayerToken = normalizedToken;
    hasEphemeralGuestPlayerToken = true;

    if (typeof window === 'undefined' || !window.localStorage) {
        return normalizedToken;
    }

    try {
        if (normalizedToken) {
            window.localStorage.setItem(GUEST_PLAYER_TOKEN_STORAGE_KEY, normalizedToken);
        } else {
            window.localStorage.removeItem(GUEST_PLAYER_TOKEN_STORAGE_KEY);
        }
    } catch (error) {
        console.error('Error writing guest player token:', error);
    }

    return normalizedToken;
}
