export const DAY_MS = 24 * 60 * 60 * 1000;

export function getUtcDayIndex(date = new Date()) {
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ) / DAY_MS);
}

export function getUtcDayStart(dayIndex) {
    return new Date(dayIndex * DAY_MS);
}
