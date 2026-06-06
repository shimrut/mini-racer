const DAY_MS = 24 * 60 * 60 * 1000;

// Freeze the legacy order so adding tracks to TRACKS never remaps historical dates.
const LEGACY_DAILY_GP_TRACK_KEYS = [
    'circuit',
    'sunlitTemple',
    'royalPlateau',
    'mistwoodSerpent',
    'harborParkLoop',
    'jadeSpiralCircuit',
    'cedarRidgeCircuit',
    'twinRise',
    'sakuraWeave',
    'kettleRun',
    'carbonBend',
    'moebiusStrip',
    'blueSector',
    'alloyRing',
    'twistedCanyon',
    'greenTroll',
    'desertBridge',
    'templeStraight',
    'harborPrincipality',
    'serpentCrossing',
    'ardennesRidge',
    'pretzelArena',
    'albertGardens',
    'caspianBoulevard',
    'velvetWombat',
    'cobaltRun',
    'pebblePass',
    'zenithRun',
    'speedAltar',
    'groundControl',
    'crystalineHarbor',
];

const DAILY_GP_TRACK_RELEASES = [
    { trackKey: 'ironHook', startsOn: '2026-06-03' },
    { trackKey: 'greatBazaar', startsOn: '2026-06-03' },
    { trackKey: 'circuitPromax', startsOn: '2026-06-03' },
    { trackKey: 'stretchingCat', startsOn: '2026-06-03' },
    { trackKey: 'turboShell', startsOn: '2026-06-03' },
];

function getUtcDayIndexForChallengeDate(challengeDate) {
    const date = new Date(`${challengeDate}T00:00:00.000Z`);
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
    ) / DAY_MS);
}

export function getDailyGpScheduledTrackPoolForDayIndex(dayIndex, availableTrackKeys = []) {
    const available = new Set(
        Array.isArray(availableTrackKeys)
            ? availableTrackKeys.filter((trackKey) => typeof trackKey === 'string' && trackKey)
            : [],
    );
    const scheduledTrackKeys = [];

    for (const trackKey of LEGACY_DAILY_GP_TRACK_KEYS) {
        if (available.has(trackKey)) {
            scheduledTrackKeys.push(trackKey);
        }
    }

    for (const release of DAILY_GP_TRACK_RELEASES) {
        if (
            available.has(release.trackKey)
            && dayIndex >= getUtcDayIndexForChallengeDate(release.startsOn)
        ) {
            scheduledTrackKeys.push(release.trackKey);
        }
    }

    return scheduledTrackKeys.length
        ? scheduledTrackKeys
        : [...available];
}

export function getDailyGpTrackReleaseSchedule() {
    return DAILY_GP_TRACK_RELEASES.map((release) => ({ ...release }));
}
