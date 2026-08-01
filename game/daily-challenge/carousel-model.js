/**
 * Card models for the Daily lobby track carousel.
 *
 * Kept free of DOM so the ordering, labelling and rank/medal rules can be
 * tested on their own — the carousel view only paints what this returns.
 */
import { getDailyChallengeRequiredLaps } from './labels.js';
import { getDailyChallengeTrackName } from './service.js';
import {
    getCombinedMedalStackTiers,
    getMedalForRaceTime,
} from '../medals/medal-timing.js';
import { TRACKS } from '../track/tracks.js';
import { formatLapsLabel } from '../shared/laps-label.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateKey(timeMs) {
    return Number.isFinite(timeMs)
        ? new Date(timeMs).toISOString().slice(0, 10)
        : null;
}

export function getDailyChallengeDateKey(challenge) {
    const challengeDate = challenge?.challengeDate;
    if (typeof challengeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(challengeDate)) {
        return challengeDate;
    }
    return toDateKey(Date.parse(challenge?.startsAt || ''));
}

/**
 * The carousel is read as a run of days, so the day is the card's headline.
 * "Today" and "Yesterday" carry further than a date does at a glance.
 */
export function formatDailyCarouselDayLabel(challenge, nowMs = Date.now()) {
    const dateKey = getDailyChallengeDateKey(challenge);
    if (!dateKey) return 'Daily';
    if (dateKey === toDateKey(nowMs)) return 'Today';
    if (dateKey === toDateKey(nowMs - DAY_MS)) return 'Yesterday';

    const timeMs = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (!Number.isFinite(timeMs)) return 'Daily';
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(timeMs));
}

export function buildDailyCarouselCards(challenges = [], {
    getSnapshot = () => null,
    nowMs = Date.now(),
} = {}) {
    const seen = new Set();
    const cards = [];

    for (const challenge of Array.isArray(challenges) ? challenges : []) {
        if (!challenge?.id || seen.has(challenge.id)) continue;
        if (!challenge.trackKey || !TRACKS[challenge.trackKey]) continue;
        seen.add(challenge.id);

        const requiredLaps = getDailyChallengeRequiredLaps(challenge);
        const bestTime = Number(challenge.trackPersonalBest?.bestTime);
        const hasBestTime = Number.isFinite(bestTime) && bestTime > 0;
        const snapshot = getSnapshot(challenge.id) || null;
        // '--' is the placeholder a snapshot uses for "no rank here"; showing it
        // raw reads as a broken value rather than as a track never raced.
        const rawRankLabel = typeof snapshot?.playerRankLabel === 'string'
            ? snapshot.playerRankLabel.trim()
            : '';
        const rankLabel = rawRankLabel && rawRankLabel !== '--' ? rawRankLabel : null;
        const medal = hasBestTime
            ? getMedalForRaceTime(challenge.trackKey, bestTime, requiredLaps)
            : null;
        const dayLabel = formatDailyCarouselDayLabel(challenge, nowMs);
        const lapsLabel = formatLapsLabel(requiredLaps);
        // No unit: the card's meta line is uppercased, and "18.00S" reads as a
        // typo. Matches how the campaign card states a best.
        const bestLabel = hasBestTime ? bestTime.toFixed(3) : null;

        cards.push({
            challengeId: challenge.id,
            challenge,
            trackKey: challenge.trackKey,
            trackName: getDailyChallengeTrackName(challenge),
            skin: challenge.skin || null,
            eyebrowLabel: dayLabel,
            isCurrent: dayLabel === 'Today',
            laps: requiredLaps,
            lapsLabel,
            bestLabel,
            metaLabel: bestLabel ? `${lapsLabel} · PB ${bestLabel}` : lapsLabel,
            medal,
            medalTiers: getCombinedMedalStackTiers(challenge.trackKey, medal),
            rankLabel,
            // No snapshot yet means the rank is still in flight, which reads very
            // differently from a snapshot that says the player has no time here.
            rankPending: !snapshot,
            locked: false,
        });
    }

    return cards;
}
