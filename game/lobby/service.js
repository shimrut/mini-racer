import { getCampaignStageMedalCount } from '../campaign/manifest.js';
import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';
import { formatRaceClock } from '../shared/race-time-text.js';

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
    return formatRaceClock(safeMilliseconds);
}

export function formatLobbyGap(milliseconds) {
    const safeMilliseconds = toFiniteNumber(milliseconds);
    if (safeMilliseconds === null) return null;
    const rounded = Math.round(safeMilliseconds);
    const sign = rounded < 0 ? '−' : '+';
    const magnitude = Math.abs(rounded);
    const seconds = Math.floor(magnitude / 1000);
    const remainder = magnitude % 1000;
    return `${sign}${seconds}.${String(remainder).padStart(3, '0')}`;
}

function normalizeAvatarUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.startsWith('https://') ? trimmed : null;
}

function normalizeMedalName(medal) {
    return typeof medal === 'string' ? medal.trim().toLowerCase() : '';
}

function formatRemainingMedalsLabel(medalTotal, requiredMedals) {
    const remainingMedals = Math.max(0, requiredMedals - medalTotal);
    if (remainingMedals === 1) return 'One more medal needed';
    if (remainingMedals > 1) return `${remainingMedals} more medals needed`;
    return null;
}

export function isCampaignGoldMedal(medal) {
    const rank = STANDARD_MEDAL_TIER_RANK[normalizeMedalName(medal)];
    return rank !== undefined && rank >= STANDARD_MEDAL_TIER_RANK.gold;
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
    const trackKey = String(stage.trackKey ?? '');
    const laps = Math.max(1, Math.trunc(toFiniteNumber(stage.laps) ?? DEFAULT_LAPS[safeIndex] ?? 1));
    const unlocked = safeIndex === 0 || Boolean(stage.unlocked);
    const medal = typeof stage.medal === 'string' && stage.medal.trim()
        ? stage.medal.trim()
        : null;
    return {
        id: String(stage.id ?? stage.raceId ?? `numbered-v1-${safeIndex}`),
        index: safeIndex,
        numberLabel: String(stage.numberLabel ?? String(safeIndex).padStart(2, '0')),
        trackKey,
        trackName: String(stage.trackName ?? stage.title ?? defaultName),
        laps,
        unlocked,
        selected: Boolean(stage.selected),
        bestTimeMs,
        bestTimeLabel: bestTimeMs === null ? 'No time' : formatLobbyTime(bestTimeMs),
        medal,
        unlock: stage.unlock ?? null,
        standingsAvailable: Boolean(stage.standingsAvailable ?? stage.unlocked),
        playerRank: Number.isInteger(stage.playerRank) && stage.playerRank > 0
            ? stage.playerRank
            : null,
        standingsResolved: stage.standingsResolved !== false,
        verificationError: typeof stage.verificationError === 'string'
            && stage.verificationError.trim()
            ? stage.verificationError.trim()
            : null,
    };
}

export function normalizeCampaignLobbyState(state = {}) {
    const sourceStages = Array.isArray(state.stages) && state.stages.length
        ? state.stages
        : Array.from({ length: 10 }, (_, index) => ({ index, unlocked: index === 0 }));
    const normalized = sourceStages.map(normalizeCampaignStage);
    const medalTotal = normalized.reduce(
        (total, stage) => total + getCampaignStageMedalCount(normalizeMedalName(stage.medal)),
        0,
    );
    const stages = normalized.map((stage, index) => {
        if (stage.unlocked) {
            return { ...stage, unlockRequirementLabel: null, unlockProgress: null };
        }
        const previous = (stage.unlock?.previousRaceId
            ? normalized.find((candidate) => candidate.id === stage.unlock.previousRaceId)
            : null) || normalized[index - 1] || null;
        const awaitingPreviousMedal = Boolean(previous?.unlocked)
            && getCampaignStageMedalCount(normalizeMedalName(previous.medal)) === 0;
        const requiredMedals = Number(stage.unlock?.requiredMedals);
        const hasPrice = Number.isInteger(requiredMedals) && requiredMedals > 0;
        const previousMedalEarned = Boolean(previous)
            && getCampaignStageMedalCount(normalizeMedalName(previous.medal)) > 0;
        const unlockRequirements = [];
        if (previous) {
            unlockRequirements.push({
                id: 'previous-medal',
                copy: previousMedalEarned
                    ? `Medal earned on ${previous.trackName}`
                    : `Earn any medal on ${previous.trackName}`,
                satisfied: previousMedalEarned,
            });
        }
        if (hasPrice) {
            const remainingMedals = Math.max(0, requiredMedals - medalTotal);
            unlockRequirements.push({
                id: 'medal-total',
                copy: medalTotal >= requiredMedals
                    ? 'Medal total reached'
                    : 'Additional medals needed',
                satisfied: remainingMedals === 0,
                medalTotal,
                requiredMedals,
                remainingMedals,
            });
        }
        if (!unlockRequirements.length) {
            unlockRequirements.push({
                id: 'unlock',
                copy: 'More medals to unlock',
                satisfied: false,
            });
        }
        let label = 'More medals to unlock';
        if (awaitingPreviousMedal) {
            label = `Earn any medal on ${previous.trackName}`;
        } else if (hasPrice) {
            label = formatRemainingMedalsLabel(medalTotal, requiredMedals)
                || (previous && !previous.unlocked
                    ? 'Complete the previous stage first'
                    : 'More medals needed');
        }
        return {
            ...stage,
            unlockRequirementLabel: label,
            unlockRequirements,
            unlockProgress: hasPrice
                ? {
                    medalTotal,
                    requiredMedals,
                    awaitingPreviousMedal,
                }
                : null,
        };
    });
    const completed = Boolean(state.complete)
        || (stages.length > 0 && stages.every((stage) => isCampaignGoldMedal(stage.medal)));
    const goldCount = stages.filter((stage) => isCampaignGoldMedal(stage.medal)).length;
    const nextStage = stages.find((stage) => stage.unlocked && !isCampaignGoldMedal(stage.medal))
        || null;
    for (const stage of stages) stage.isNext = stage === nextStage;
    const resolved = state.resolved !== false;

    return {
        ...state,
        resolved,
        stages,
        complete: completed,
        goldCount,
        progressLabel: typeof state.progressLabel === 'string'
            ? state.progressLabel
            : `${goldCount} / ${stages.length} Gold`,
        primaryLabel: resolved ? 'Start Race' : null,
        nextStage,
    };
}

export function normalizeChallengeLobbyState(state = {}) {
    const targetTimeMs = toFiniteNumber(state.targetTimeMs);
    const signedIn = Boolean(state.signedIn);
    const canRace = state.canRace === undefined ? signedIn : Boolean(state.canRace);
    const available = state.available !== false && targetTimeMs !== null && targetTimeMs >= 0;
    const laps = Math.max(1, Math.trunc(toFiniteNumber(state.laps) ?? 1));
    const rawName = typeof state.challengerName === 'string'
        ? state.challengerName.trim()
        : '';
    const challengerName = rawName
        ? (rawName.startsWith('u/') ? rawName : `u/${rawName}`)
        : 'A racer';
    const beaten = state.outcome === 'won';
    const canRetry = Boolean(state.canRetry) && !beaten;
    const challengeLoading = Boolean(state.challengeLoading);
    const bestTimeMs = toFiniteNumber(state.bestTimeMs);
    const gapMs = beaten && bestTimeMs !== null && available
        ? Math.round(bestTimeMs) - Math.round(targetTimeMs)
        : null;
    const viewerBestTimeMs = toFiniteNumber(state.viewerBestTimeMs);
    const hasViewerBest = viewerBestTimeMs !== null && viewerBestTimeMs > 0;
    return {
        ...state,
        signedIn,
        canRace,
        available,
        beaten,
        gapMs,
        winMarginLabel: gapMs === null ? null : formatLobbyGap(gapMs).slice(1),
        canAccept: canRace && available && !beaten && !challengeLoading,
        canRetry,
        challengeLoading,
        challengerName,
        trackKey: typeof state.trackKey === 'string' && state.trackKey.trim()
            ? state.trackKey.trim()
            : null,
        trackName: typeof state.trackName === 'string' && state.trackName.trim()
            ? state.trackName.trim()
            : null,
        laps,
        targetTimeMs: available ? Math.round(targetTimeMs) : null,
        targetTimeLabel: available ? formatLobbyTime(targetTimeMs) : '--:--.---',
        viewerBestTimeMs: hasViewerBest ? Math.round(viewerBestTimeMs) : null,
        viewerBestTimeLabel: hasViewerBest ? formatLobbyTime(viewerBestTimeMs) : null,
        medal: typeof state.medal === 'string' && state.medal.trim()
            ? state.medal.trim()
            : null,
        challengerAvatarUrl: normalizeAvatarUrl(state.challengerAvatarUrl),
        viewerAvatarUrl: normalizeAvatarUrl(state.viewerAvatarUrl),
        statusMessage: typeof state.statusMessage === 'string' && state.statusMessage.trim()
            ? state.statusMessage.trim()
            : (!available
                ? 'This challenge is unavailable.'
                : (!canRace ? 'This challenge is unavailable right now.' : '')),
    };
}
