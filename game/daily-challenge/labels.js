import { getChallengeTimeMs } from '../shared/values.js';
import { DAY_MS } from '../shared/utc-day.js';
const MINUTE_MS = 60 * 1000;

export function isDailyChallengeLapCount(value) {
    return Number.isInteger(value) && value >= 1 && value <= 3;
}

export function getStrictDailyChallengeLapCount(challenge) {
    const lapCount = challenge?.objectiveParams?.lapCount;
    return isDailyChallengeLapCount(lapCount) ? lapCount : null;
}

export function getDailyChallengeRequiredLaps(challenge) {
    if (challenge?.objectiveType === 'multi_lap_total') {
        const lapCount = getStrictDailyChallengeLapCount(challenge);
        return lapCount && lapCount > 1 ? lapCount : 1;
    }
    return 1;
}

export function getDailyChallengeObjectiveLabel(challenge) {
    if (!challenge) return 'Daily Challenge';

    if (challenge.objectiveType === 'multi_lap_total') {
        const lapCount = getDailyChallengeRequiredLaps(challenge);
        return `${lapCount} ${lapCount === 1 ? 'lap' : 'laps'}`;
    }

    return '1 lap';
}

export function getDailyChallengeCopyLabels(challenge) {
    const objectiveType = challenge?.objectiveType || 'single_lap_fastest';

    if (objectiveType === 'multi_lap_total') {
        return {
            hudPrimaryLabel: 'RACE',
            primaryStatLabel: 'Race Time'
        };
    }

    return {
        hudPrimaryLabel: 'LAP',
        primaryStatLabel: 'Lap Time'
    };
}

export function formatDailyChallengeResultLabel(challenge, result) {
    if (!result || typeof result !== 'object') {
        return '--';
    }
    const bestTime = Number.isFinite(result?.bestTime) ? Number(result.bestTime) : null;
    return bestTime !== null ? `${bestTime.toFixed(3)}s` : '--';
}

export function formatDailyChallengeBestLabel(objectiveType, bestTime, completedLaps = null) {
    return Number.isFinite(bestTime) ? `${Number(bestTime).toFixed(3)}s` : '--';
}

export function formatDailyChallengeStatusDate(isoString) {
    const timeMs = Date.parse(isoString);
    if (!Number.isFinite(timeMs)) return '';

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: '2-digit',
        timeZone: 'UTC'
    }).format(new Date(timeMs));
}

export function formatDailyChallengeRemainingDuration(remainingMs) {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';

    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        const minutes = totalMinutes % 60;
        return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
    }

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function getDailyChallengeExpiry(challenge, nowMs = Date.now()) {
    const untilMs = Date.parse(challenge?.availableUntil || '');
    if (!Number.isFinite(untilMs)) return { label: '', refreshMs: null };

    const remainingMs = untilMs - nowMs;
    if (remainingMs <= 0) return { label: 'Expired', refreshMs: null };

    if (remainingMs < DAY_MS) {
        const remainingLabel = formatDailyChallengeRemainingDuration(remainingMs);
        return {
            label: remainingLabel ? `Expires in ${remainingLabel}` : 'Expires today',
            refreshMs: MINUTE_MS,
        };
    }

    const formattedDate = formatDailyChallengeStatusDate(challenge?.availableUntil);
    return {
        label: formattedDate ? `Expires on ${formattedDate}` : '',
        refreshMs: remainingMs - DAY_MS,
    };
}

export function getDailyChallengeCardStatus(challenge, nowMs = Date.now()) {
    const endsAtMs = getChallengeTimeMs(challenge, 'endsAt');
    const availableUntilMs = getChallengeTimeMs(challenge, 'availableUntil');

    if (Number.isFinite(endsAtMs) && nowMs < endsAtMs) {
        return {
            key: 'featured',
            label: 'Featured',
        };
    }

    if (Number.isFinite(availableUntilMs) && nowMs < availableUntilMs) {
        const remainingMs = availableUntilMs - nowMs;
        if (remainingMs < DAY_MS) {
            const remainingLabel = formatDailyChallengeRemainingDuration(remainingMs);
            return {
                key: 'available',
                label: remainingLabel ? `Expires in ${remainingLabel}` : 'Expires',
            };
        }

        const formattedDate = formatDailyChallengeStatusDate(challenge?.availableUntil);
        return {
            key: 'available',
            label: formattedDate ? `Expires on ${formattedDate}` : 'Expires',
        };
    }

    return {
        key: 'expired',
        label: 'Expired',
    };
}

