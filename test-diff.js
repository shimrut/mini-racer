import { TRACKS } from './game/track/tracks.js';

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
    { trackKey: 'redLagoon', startsOn: '2026-06-08' },
    { trackKey: 'copperVale', startsOn: '2026-06-08' },
    { trackKey: 'obsidianRidge', startsOn: '2026-06-08' },
    { trackKey: 'auroraRing', startsOn: '2026-06-08' },
    { trackKey: 'lanternPier', startsOn: '2026-06-08' },
    { trackKey: 'quartzHollow', startsOn: '2026-06-08' },
    { trackKey: 'needleChicane', startsOn: '2026-06-08' },
    { trackKey: 'cinderSpine', startsOn: '2026-06-08' },
    { trackKey: 'glassSerpent', startsOn: '2026-06-08' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function getUtcDayIndexForChallengeDate(challengeDate) {
    const date = new Date(`${challengeDate}T00:00:00.000Z`);
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
    ) / DAY_MS);
}

function getOldPool(dayIndex, availableTrackKeys = []) {
    const available = new Set(
        Array.isArray(availableTrackKeys)
            ? availableTrackKeys.filter((trackKey) => typeof trackKey === 'string' && trackKey)
            : [],
    );
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

function getNewPool(dayIndex, availableTracks = TRACKS) {
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
    return scheduledTrackKeys.length ? scheduledTrackKeys : Object.keys(availableTracks);
}

const targetDate = '2026-06-03';
const dayIndex = getUtcDayIndexForChallengeDate(targetDate);
const oldPool = getOldPool(dayIndex, Object.keys(TRACKS));
const newPool = getNewPool(dayIndex, TRACKS);

console.log('Old Pool Length:', oldPool.length);
console.log('New Pool Length:', newPool.length);

const diff = [];
for (let i = 0; i < Math.max(oldPool.length, newPool.length); i++) {
    if (oldPool[i] !== newPool[i]) {
        diff.push(`Index ${i}: Old=${oldPool[i]}, New=${newPool[i]}`);
    }
}
console.log('Differences:', diff);
