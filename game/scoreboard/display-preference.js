import {
    LEADERBOARD_IDENTITY_CONSTRUCTED,
    normalizeLeaderboardIdentityPreference,
} from '../../src/shared/leaderboard-identity.js?v=1.91';

const LEADERBOARD_IDENTITY_STORAGE_KEY = 'VectorGpLeaderboardIdentityPreference';

export function getLeaderboardIdentityPreference() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return LEADERBOARD_IDENTITY_CONSTRUCTED;
    }

    try {
        return normalizeLeaderboardIdentityPreference(
            window.localStorage.getItem(LEADERBOARD_IDENTITY_STORAGE_KEY)
        );
    } catch (error) {
        console.error('Error reading leaderboard identity preference:', error);
        return LEADERBOARD_IDENTITY_CONSTRUCTED;
    }
}

export function setLeaderboardIdentityPreference(value) {
    const normalizedValue = normalizeLeaderboardIdentityPreference(value);
    if (typeof window === 'undefined' || !window.localStorage) {
        return normalizedValue;
    }

    try {
        window.localStorage.setItem(LEADERBOARD_IDENTITY_STORAGE_KEY, normalizedValue);
    } catch (error) {
        console.error('Error writing leaderboard identity preference:', error);
    }

    return normalizedValue;
}
