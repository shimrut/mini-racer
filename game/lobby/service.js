import { getCampaignStageMedalCount } from '../campaign/manifest.js';
import { STANDARD_MEDAL_TIER_RANK } from '../medals/medal-timing.js';

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

function normalizeMedalName(medal) {
    return typeof medal === 'string' ? medal.trim().toLowerCase() : '';
}

/** Gold is what counts a stage as cleared: Author clears it too, nothing below does. */
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
        // Kept so a re-normalized state can still state what this stage costs.
        unlock: stage.unlock ?? null,
        standingsAvailable: Boolean(stage.standingsAvailable ?? stage.unlocked),
        playerRank: Number.isInteger(stage.playerRank) && stage.playerRank > 0
            ? stage.playerRank
            : null,
        standingsResolved: stage.standingsResolved !== false,
    };
}

export function normalizeCampaignLobbyState(state = {}) {
    const sourceStages = Array.isArray(state.stages) && state.stages.length
        ? state.stages
        : Array.from({ length: 10 }, (_, index) => ({ index, unlocked: index === 0 }));
    const normalized = sourceStages.map(normalizeCampaignStage);
    // A locked row that only says "Locked" hides the whole rule. Two things gate
    // a stage now, and the row names the one the player can go and do something
    // about: a stage they can already race but have not medalled is a single
    // run away, so it wins. Naming it further down the ladder would point at
    // tracks they cannot even reach yet, five rows all reading the same, so
    // every other locked stage quotes the total instead — that is the number
    // that tells them how far the campaign still runs.
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
        let label = 'More medals to unlock';
        if (awaitingPreviousMedal) {
            label = `A medal on ${previous.trackName} to unlock`;
        } else if (hasPrice) {
            label = `${medalTotal}/${requiredMedals} medals to unlock`;
        }
        return {
            ...stage,
            unlockRequirementLabel: label,
            // The card shows the count where an unlocked stage shows its rank,
            // so it needs the two numbers rather than the sentence.
            unlockProgress: hasPrice
                ? { medalTotal, requiredMedals, awaitingPreviousMedal }
                : null,
        };
    });
    const completed = Boolean(state.complete)
        || (stages.length > 0 && stages.every((stage) => isCampaignGoldMedal(stage.medal)));
    const goldCount = stages.filter((stage) => isCampaignGoldMedal(stage.medal)).length;
    // Strictly the stage the campaign is still asking for. Falling back to the
    // first unlocked stage once every one of them is Gold marked Stage 00 as the
    // live stage of a finished campaign, which is the one thing it is not.
    const nextStage = stages.find((stage) => stage.unlocked && !isCampaignGoldMedal(stage.medal))
        || null;
    for (const stage of stages) stage.isNext = stage === nextStage;
    // A provisional paint knows the stage list but not whose progress it is, so
    // it cannot say yet whether the centred stage is playable. Leaving the label
    // unset lets the lobby show its pending state instead of guessing.
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
        // The button races the stage the carousel has centred, so it names that
        // act and nothing else: campaign-level wording read as a claim about the
        // centred stage that was wrong on every stage but one.
        primaryLabel: resolved ? 'Start Race' : null,
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
