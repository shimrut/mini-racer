const NUMBER_WORDS = [
    'Zero',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
];

const DEFAULT_LAPS = [1, 1, 1, 2, 2, 2, 3, 3, 3, 3];

function toFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function formatLobbyTime(milliseconds) {
    const safeMilliseconds = toFiniteNumber(milliseconds);
    if (safeMilliseconds === null || safeMilliseconds < 0) return '--:--.---';
    const rounded = Math.round(safeMilliseconds);
    const minutes = Math.floor(rounded / 60000);
    const seconds = Math.floor((rounded % 60000) / 1000);
    const remainder = rounded % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function normalizeBestTimeMs(stage) {
    const bestTimeMs = toFiniteNumber(stage?.bestTimeMs);
    if (bestTimeMs !== null && bestTimeMs >= 0) return Math.round(bestTimeMs);
    const bestTimeSec = toFiniteNumber(stage?.bestTimeSec);
    if (bestTimeSec !== null && bestTimeSec >= 0) return Math.round(bestTimeSec * 1000);
    return null;
}

export function normalizeCampaignStage(stage = {}, index = 0) {
    const safeIndex = Number.isInteger(stage.index) ? stage.index : index;
    const defaultName = `Number ${NUMBER_WORDS[safeIndex] || safeIndex}`;
    const bestTimeMs = normalizeBestTimeMs(stage);
    return {
        id: String(stage.id ?? stage.raceId ?? `numbered-v1-${safeIndex}`),
        index: safeIndex,
        numberLabel: String(stage.numberLabel ?? String(safeIndex).padStart(2, '0')),
        trackKey: String(stage.trackKey ?? ''),
        trackName: String(stage.trackName ?? stage.title ?? defaultName),
        laps: Math.max(1, Math.trunc(toFiniteNumber(stage.laps) ?? DEFAULT_LAPS[safeIndex] ?? 1)),
        unlocked: safeIndex === 0 || Boolean(stage.unlocked),
        selected: Boolean(stage.selected),
        bestTimeMs,
        bestTimeLabel: bestTimeMs === null ? 'No time' : formatLobbyTime(bestTimeMs),
        medal: typeof stage.medal === 'string' && stage.medal.trim()
            ? stage.medal.trim()
            : null,
        standingsAvailable: Boolean(stage.standingsAvailable ?? stage.unlocked),
    };
}

export function normalizeCampaignLobbyState(state = {}) {
    const sourceStages = Array.isArray(state.stages) && state.stages.length
        ? state.stages
        : Array.from({ length: 10 }, (_, index) => ({ index, unlocked: index === 0 }));
    const stages = sourceStages.map(normalizeCampaignStage);
    const completed = Boolean(state.complete)
        || (stages.length > 0 && stages.every((stage) => (
            stage.medal?.toLowerCase() === 'gold'
            || stage.medal?.toLowerCase() === 'author'
        )));
    const goldCount = stages.filter((stage) => (
        stage.medal?.toLowerCase() === 'gold'
        || stage.medal?.toLowerCase() === 'author'
    )).length;
    const nextStage = stages.find((stage) => stage.unlocked && !(
        stage.medal?.toLowerCase() === 'gold'
        || stage.medal?.toLowerCase() === 'author'
    )) || stages.find((stage) => stage.unlocked) || null;
    const hasProgress = Boolean(state.startedAt)
        || stages.some((stage) => stage.bestTimeMs !== null || stage.medal);

    return {
        ...state,
        stages,
        complete: completed,
        goldCount,
        progressLabel: typeof state.progressLabel === 'string'
            ? state.progressLabel
            : `${goldCount} / ${stages.length} Gold`,
        primaryLabel: completed
            ? null
            : (typeof state.primaryLabel === 'string'
                ? state.primaryLabel
                : (hasProgress ? 'Continue Campaign' : 'Start Campaign')),
        nextStage,
    };
}

export function normalizeChallengeLobbyState(state = {}) {
    const targetTimeMs = toFiniteNumber(state.targetTimeMs);
    const signedIn = Boolean(state.signedIn);
    const available = state.available !== false && targetTimeMs !== null && targetTimeMs >= 0;
    const laps = Math.max(1, Math.trunc(toFiniteNumber(state.laps) ?? 1));
    const rawName = typeof state.challengerName === 'string'
        ? state.challengerName.trim()
        : '';
    const challengerName = rawName
        ? (rawName.startsWith('u/') ? rawName : `u/${rawName}`)
        : 'A racer';

    return {
        ...state,
        signedIn,
        available,
        canAccept: signedIn && available,
        challengerName,
        opponentLabel: `${challengerName} challenges you`,
        trackLabel: typeof state.trackName === 'string' && state.trackName.trim()
            ? `${state.trackName.trim()} · ${laps} ${laps === 1 ? 'lap' : 'laps'}`
            : 'Track unavailable',
        laps,
        targetTimeMs: available ? Math.round(targetTimeMs) : null,
        targetTimeLabel: available ? formatLobbyTime(targetTimeMs) : '--:--.---',
        medal: typeof state.medal === 'string' && state.medal.trim()
            ? state.medal.trim()
            : null,
        statusMessage: !signedIn
            ? 'Sign in to accept this challenge.'
            : (!available ? 'This challenge is unavailable.' : ''),
    };
}
