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
const newPool = getNewPool(dayIndex, TRACKS);
const step = getStepForTrackCount(newPool.length);
const index = Math.abs(dayIndex * step) % newPool.length;
console.log(`For ${targetDate}: Pool Length = ${newPool.length}, step = ${step}, index = ${index}, track = ${newPool[index]}`);

const targetDate2 = '2026-06-04';
const dayIndex2 = getUtcDayIndexForChallengeDate(targetDate2);
const newPool2 = getNewPool(dayIndex2, TRACKS);
const step2 = getStepForTrackCount(newPool2.length);
const index2 = Math.abs(dayIndex2 * step2) % newPool2.length;
console.log(`For ${targetDate2}: Pool Length = ${newPool2.length}, step = ${step2}, index = ${index2}, track = ${newPool2[index2]}`);

