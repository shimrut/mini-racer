const MODE_KEYS = new Set(['home', 'daily', 'campaign', 'challenge']);

function promiseOrResolved(value) {
    return value || Promise.resolve(null);
}

export function selectModeCriticalStartupPromises(mode, {
    playerHistory,
    carAsset,
    trackReady,
    dailyChallenge,
    personalBestGhost,
    campaignLaunch,
    challengeLobby,
} = {}) {
    const normalizedMode = MODE_KEYS.has(mode) ? mode : 'home';
    const shared = [
        promiseOrResolved(carAsset),
        promiseOrResolved(trackReady),
    ];
    if (normalizedMode === 'challenge') {
        return [promiseOrResolved(challengeLobby), ...shared];
    }
    if (normalizedMode === 'daily') {
        return [
            promiseOrResolved(playerHistory),
            promiseOrResolved(dailyChallenge),
            promiseOrResolved(personalBestGhost),
            ...shared,
        ];
    }
    if (normalizedMode === 'campaign') {
        return [
            promiseOrResolved(playerHistory),
            promiseOrResolved(campaignLaunch),
            ...shared,
        ];
    }
    return [promiseOrResolved(playerHistory), ...shared];
}

export function selectModeSecondaryStartupTasks(mode) {
    const normalizedMode = MODE_KEYS.has(mode) ? mode : 'home';
    if (normalizedMode === 'challenge') {
        return ['daily', 'campaign'];
    }
    if (normalizedMode === 'daily') return ['campaign'];
    if (normalizedMode === 'campaign') return ['daily'];
    return ['daily', 'campaign'];
}
