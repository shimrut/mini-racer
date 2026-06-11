import { TRACKS } from '../track/tracks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PINNED_DAILY_GP_TRACKS_BY_DATE = Object.freeze({
    '2026-06-05': 'sunlitTemple',
    '2026-06-06': 'harborPrincipality',
    '2026-06-07': 'turboShell',
    '2026-06-08': 'desertBridge',
    '2026-06-09': 'circuitPromax',
    '2026-06-10': 'caspianBoulevard',
    '2026-06-11': 'lanternPier',
});

function getUtcDayIndexForChallengeDate(challengeDate) {
    const date = new Date(`${challengeDate}T00:00:00.000Z`);
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
    ) / DAY_MS);
}

function formatChallengeDateFromDayIndex(dayIndex) {
    return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

export function getPinnedDailyGpTrackKeyForDayIndex(dayIndex, availableTracks = TRACKS) {
    const challengeDate = formatChallengeDateFromDayIndex(dayIndex);
    const pinnedTrackKey = PINNED_DAILY_GP_TRACKS_BY_DATE[challengeDate];
    return pinnedTrackKey && availableTracks[pinnedTrackKey]
        ? pinnedTrackKey
        : null;
}

export function getDailyGpScheduledTrackPoolForDayIndex(dayIndex, availableTracks = TRACKS) {
    const scheduledTrackKeys = [];

    for (const trackKey of Object.keys(availableTracks)) {
        const track = availableTracks[trackKey];
        const releaseDate = track?.releaseDate;

        if (!releaseDate) {
            scheduledTrackKeys.push(trackKey);
            continue;
        }

        if (dayIndex >= getUtcDayIndexForChallengeDate(releaseDate)) {
            scheduledTrackKeys.push(trackKey);
        }
    }

    return scheduledTrackKeys.length
        ? scheduledTrackKeys
        : Object.keys(availableTracks);
}

export function getDailyGpTrackReleaseSchedule() {
    return Object.keys(TRACKS)
        .filter((trackKey) => TRACKS[trackKey].releaseDate)
        .map((trackKey) => ({
            trackKey,
            startsOn: TRACKS[trackKey].releaseDate
        }));
}
