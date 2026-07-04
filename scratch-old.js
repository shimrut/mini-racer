import { getDailyGpScheduledTrackPoolForDayIndex } from './old_schedule.js';
import { TRACKS } from './old_tracks.js';
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
const dayIndex = Math.floor(new Date('2026-06-12T00:00:00Z').getTime() / 86400000);
const pool = getDailyGpScheduledTrackPoolForDayIndex(dayIndex, Object.keys(TRACKS));
const step = getStepForTrackCount(pool.length);
const index = Math.abs(dayIndex * step) % pool.length;
console.log('Old Server generated:', pool[index]);
