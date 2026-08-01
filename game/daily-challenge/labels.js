/** Pure daily-challenge copy / status helpers (no fetch or localStorage). */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The only lap counts supported by the persisted Daily challenge contract. */
export function isDailyChallengeLapCount(value) {
    return Number.isInteger(value) && value >= 1 && value <= 3;
}

export function getStrictDailyChallengeLapCount(challenge) {
    const lapCount = challenge?.objectiveParams?.lapCount;
    return isDailyChallengeLapCount(lapCount) ? lapCount : null;
}

function getChallengeTimeMs(challenge, field) {
    const value = challenge?.[field];
    if (typeof value !== 'string') return NaN;
    return Date.parse(value);
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

/** Short line for the mode-select daily challenge row (track name • …). */
export function getDailyChallengeModeSelectObjectiveLine(challenge) {
    return getDailyChallengeCopyLabels(challenge).modeSelectLine;
}

export function getDailyChallengeCopyLabels(challenge) {
    const objectiveType = challenge?.objectiveType || 'single_lap_fastest';

    if (objectiveType === 'multi_lap_total') {
        return {
            hudPrimaryLabel: 'RACE',
            primaryStatLabel: 'Race Time',
            bestSummaryLabel: 'Best Race',
            modeSelectLine: 'Best race time'
        };
    }

    return {
        hudPrimaryLabel: 'LAP',
        primaryStatLabel: 'Lap Time',
        bestSummaryLabel: 'Best Lap',
        modeSelectLine: 'Best lap time'
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

export function formatDailyChallengePlaylistAvailabilityLabel(challenge) {
    const until = challenge?.availableUntil;
    if (!until || typeof until !== 'string') return '';

    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return '';

    const remainingMs = untilMs - Date.now();
    if (remainingMs <= 0) return 'Expired';

    return formatDailyChallengeRemainingDuration(remainingMs);
}

export function getDailyChallengeModifierBadges(challenge) {
    return challenge ? [] : [];
}

export function getDailyChallengeModifierLabel(challenge) {
    return getDailyChallengeModifierBadges(challenge).join(' • ');
}
