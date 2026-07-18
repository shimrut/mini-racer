export const LEADERBOARD_DECIMAL_PLACES_STORAGE_KEY = 'VectorGpLeaderboardDecimalPlaces';
export const LEADERBOARD_DECIMAL_PLACES_OPTIONS = Object.freeze([2, 3, 4]);
export const LEADERBOARD_DECIMAL_PLACES_DEFAULT = 2;

export function normalizeLeaderboardDecimalPlaces(value) {
    const parsed = Number(value);
    return LEADERBOARD_DECIMAL_PLACES_OPTIONS.includes(parsed)
        ? parsed
        : LEADERBOARD_DECIMAL_PLACES_DEFAULT;
}

export function getLeaderboardDecimalPlaces() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return LEADERBOARD_DECIMAL_PLACES_DEFAULT;
    }
    try {
        return normalizeLeaderboardDecimalPlaces(
            window.localStorage.getItem(LEADERBOARD_DECIMAL_PLACES_STORAGE_KEY),
        );
    } catch (error) {
        console.error('Error reading leaderboard decimal places preference:', error);
        return LEADERBOARD_DECIMAL_PLACES_DEFAULT;
    }
}

export function setLeaderboardDecimalPlaces(value) {
    const next = normalizeLeaderboardDecimalPlaces(value);
    if (typeof window === 'undefined' || !window.localStorage) {
        return next;
    }
    try {
        window.localStorage.setItem(LEADERBOARD_DECIMAL_PLACES_STORAGE_KEY, String(next));
    } catch (error) {
        console.error('Error writing leaderboard decimal places preference:', error);
    }
    return next;
}
