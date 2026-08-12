import { normalizeCarUnlockSnapshot } from '../car/car-unlock-policy.js';

const PLAYER_PROFILE_CACHE_STORAGE_KEY = 'VectorGpPlayerProfileCache';
const MAX_CACHED_OWNERS = 3;

/**
 * The last confirmed profile for each recent owner, so a bootstrap outage can present what the
 * server last said instead of the all-locked default. Never holds a guest token: a cache that can
 * authorize a request is a credential, and this one is only ever used for presentation.
 */
function readCacheState() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return { lastOwnerId: null, owners: {} };
    }

    try {
        const raw = window.localStorage.getItem(PLAYER_PROFILE_CACHE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return {
            lastOwnerId: typeof parsed?.lastOwnerId === 'string' && parsed.lastOwnerId
                ? parsed.lastOwnerId
                : null,
            owners: parsed?.owners && typeof parsed.owners === 'object' && !Array.isArray(parsed.owners)
                ? parsed.owners
                : {},
        };
    } catch (error) {
        console.error('Error reading cached player profile:', error);
        return { lastOwnerId: null, owners: {} };
    }
}

function writeCacheState(cacheState) {
    if (typeof window === 'undefined' || !window.localStorage) return false;

    try {
        window.localStorage.setItem(
            PLAYER_PROFILE_CACHE_STORAGE_KEY,
            JSON.stringify(cacheState),
        );
        return true;
    } catch (error) {
        console.error('Error writing cached player profile:', error);
        return false;
    }
}

function normalizeOwnerId(ownerId) {
    return typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null;
}

function normalizeCachedProfile(cached) {
    if (!cached || typeof cached !== 'object') return null;
    return {
        hasAnyData: cached.hasAnyData === true,
        isReturningPlayer: cached.isReturningPlayer === true,
        redditUsername: typeof cached.redditUsername === 'string' && cached.redditUsername.trim()
            ? cached.redditUsername.trim()
            : null,
        playerPreferences: cached.playerPreferences && typeof cached.playerPreferences === 'object'
            ? cached.playerPreferences
            : null,
        carUnlocks: cached.carUnlocks ? normalizeCarUnlockSnapshot(cached.carUnlocks) : null,
        updatedAt: typeof cached.updatedAt === 'string' ? cached.updatedAt : null,
    };
}

/** The owner of the last authoritative bootstrap on this browser — the only owner a fallback may present. */
export function readLastConfirmedProfileOwnerId() {
    return readCacheState().lastOwnerId;
}

export function readCachedPlayerProfile(ownerId) {
    const owner = normalizeOwnerId(ownerId);
    if (!owner) return null;
    return normalizeCachedProfile(readCacheState().owners[owner]);
}

export function writeCachedPlayerProfile(ownerId, state) {
    const owner = normalizeOwnerId(ownerId);
    if (!owner || !state) return null;

    const cached = {
        ...normalizeCachedProfile(state),
        updatedAt: new Date().toISOString(),
    };
    const { owners } = readCacheState();
    delete owners[owner];
    const retained = Object.entries(owners)
        .sort(([, a], [, b]) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
        .slice(0, MAX_CACHED_OWNERS - 1);
    writeCacheState({
        lastOwnerId: owner,
        owners: { [owner]: cached, ...Object.fromEntries(retained) },
    });
    return cached;
}

export function clearCachedPlayerProfiles() {
    writeCacheState({ lastOwnerId: null, owners: {} });
}
