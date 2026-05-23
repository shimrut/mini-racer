const PLAYER_ID_STORAGE_KEY = 'VectorGpScoreboardPlayerId';

function trimTrailingSlashes(value) {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function getBaseApiConfig() {
    const apiBaseUrl = '/api';

    return {
        serviceMode: 'proxy',
        apiBaseUrl,
        playerBootstrapUrl: `${apiBaseUrl}/player/bootstrap`,
        scoreboardSubmitUrl: `${apiBaseUrl}/scoreboard/submit`,
        scoreboardSnapshotUrl: `${apiBaseUrl}/scoreboard/snapshot`,
        dailyActiveUrl: `${apiBaseUrl}/daily/active`,
        dailySnapshotUrl: `${apiBaseUrl}/daily/snapshot`,
        dailySubmitUrl: `${apiBaseUrl}/daily/submit`
    };
}

function createPlayerId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    const randomHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${randomHex()}${randomHex()}-${randomHex()}-4${randomHex().slice(1)}-a${randomHex().slice(1)}-${randomHex()}${randomHex()}${randomHex()}`;
}

export function getOrCreatePlayerId(logLabel = 'scoreboard') {
    if (typeof window === 'undefined' || !window.localStorage) {
        return createPlayerId();
    }

    try {
        const storedId = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
        if (storedId) return storedId;

        const nextId = createPlayerId();
        window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, nextId);
        return nextId;
    } catch (error) {
        console.error(`Error accessing ${logLabel} player id:`, error);
        return createPlayerId();
    }
}

export function buildServiceHeaders(_config, extraHeaders = {}) {
    return { ...extraHeaders };
}

export function clampRequestLimit(limit, { defaultLimit, maxLimit = 100 } = {}) {
    if (!Number.isFinite(limit)) {
        return defaultLimit;
    }
    return Math.min(Math.max(Math.trunc(limit), 1), maxLimit);
}
