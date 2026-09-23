import { formatRaceClock } from '../../../game/shared/race-time-text.js';

export function formatRaceTime(bestTimeMs: number): string {
    return formatRaceClock(bestTimeMs);
}

export function formatHeadToHeadTime(timeMs: number): string {
    const seconds = Math.floor(timeMs / 1000);
    const milliseconds = timeMs % 1000;
    return `${seconds}.${String(milliseconds).padStart(3, '0')}`;
}

export function formatChallengeResultTime(timeMs: number): string {
    return `${(timeMs / 1000).toFixed(3)}s`;
}

const SHORT_MONTH_NAMES = Object.freeze([
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

export function formatChallengeDate(value: string, includeYear = false): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;

    const [, year, monthText, dayText] = match;
    const month = Number(monthText);
    const day = Number(dayText);
    const monthName = SHORT_MONTH_NAMES[month - 1];
    if (!monthName || day < 1 || day > 31) return value;

    return `${day} ${monthName}${includeYear ? ` ${year}` : ''}`;
}
