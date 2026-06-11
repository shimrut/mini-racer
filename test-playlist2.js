import { TRACKS } from './game/track/tracks.js';
const DAILY_TRACK_STEP_SEED = 17;
function getStepForTrackCount(trackCount) {
    if (trackCount <= 1) return 1;
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    let step = Math.min(DAILY_TRACK_STEP_SEED, trackCount - 1);
    while (step > 1 && gcd(step, trackCount) !== 1) {
        step -= 1;
    }
    return Math.max(1, step);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function getUtcDayIndexForChallengeDate(challengeDate) {
    const date = new Date(`${challengeDate}T00:00:00.000Z`);
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
    ) / DAY_MS);
}

const LEGACY_DAILY_GP_TRACK_KEYS = [
    'circuit', 'sunlitTemple', 'royalPlateau', 'mistwoodSerpent', 'harborParkLoop',
    'jadeSpiralCircuit', 'cedarRidgeCircuit', 'twinRise', 'sakuraWeave', 'kettleRun',
    'carbonBend', 'moebiusStrip', 'blueSector', 'alloyRing', 'twistedCanyon',
    'greenTroll', 'desertBridge', 'templeStraight', 'harborPrincipality', 'serpentCrossing',
    'ardennesRidge', 'pretzelArena', 'albertGardens', 'caspianBoulevard', 'velvetWombat',
    'cobaltRun', 'pebblePass', 'zenithRun', 'speedAltar', 'groundControl', 'crystalineHarbor',
];

const DAILY_GP_TRACK_RELEASES = [
    { trackKey: 'ironHook', startsOn: '2026-06-03' },
    { trackKey: 'greatBazaar', startsOn: '2026-06-03' },
    { trackKey: 'circuitPromax', startsOn: '2026-06-03' },
    { trackKey: 'stretchingCat', startsOn: '2026-06-03' },
    { trackKey: 'turboShell', startsOn: '2026-06-03' },
];

function getOldPool(dayIndex, availableTrackKeys) {
    const available = new Set(availableTrackKeys);
    const scheduledTrackKeys = [];
    const scheduledSet = new Set();
    for (const trackKey of LEGACY_DAILY_GP_TRACK_KEYS) {
        if (available.has(trackKey)) {
            scheduledTrackKeys.push(trackKey);
            scheduledSet.add(trackKey);
        }
    }
    for (const release of DAILY_GP_TRACK_RELEASES) {
        if (available.has(release.trackKey)) {
            scheduledSet.add(release.trackKey);
            if (dayIndex >= getUtcDayIndexForChallengeDate(release.startsOn)) {
                scheduledTrackKeys.push(release.trackKey);
            }
        }
    }
    return scheduledTrackKeys.length ? scheduledTrackKeys : [...available];
}

function getNewPool(dayIndex, availableTracks) {
    const scheduledTrackKeys = [];
    for (const trackKey of Object.keys(availableTracks)) {
        const track = availableTracks[trackKey];
        const releaseDate = track?.releaseDate;
        if (!releaseDate) continue;
        if (dayIndex >= getUtcDayIndexForChallengeDate(releaseDate)) {
            scheduledTrackKeys.push(trackKey);
        }
    }
    return scheduledTrackKeys.length ? scheduledTrackKeys : Object.keys(availableTracks);
}

// SIMULATE PRE-REFACTOR STATE vs POST-REFACTOR STATE
// Before refactor, `TRACKS` did not have releaseDates.
// The `availableTrackKeys` passed was Object.keys(PRE_REFACTOR_TRACKS)
// Let's assume PRE_REFACTOR_TRACKS keys were EXACTLY the same.

const dates = [
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-06',
    '2026-06-07',
    '2026-06-08',
    '2026-06-09',
];

for (const date of dates) {
    const dayIndex = getUtcDayIndexForChallengeDate(date);
    
    const oldPool = getOldPool(dayIndex, Object.keys(TRACKS));
    const stepOld = getStepForTrackCount(oldPool.length);
    const indexOld = Math.abs(dayIndex * stepOld) % oldPool.length;
    const oldTrack = oldPool[indexOld];
    
    const newPool = getNewPool(dayIndex, TRACKS);
    const stepNew = getStepForTrackCount(newPool.length);
    const indexNew = Math.abs(dayIndex * stepNew) % newPool.length;
    const newTrack = newPool[indexNew];
    
    console.log(`[${date}] Old: ${oldTrack} | New: ${newTrack}`);
}
