import { getDailyGpScheduledTrackPoolForDayIndex as getOldPool } from './game/shared/daily-gp-track-schedule.js';

function simulate(poolSize) {
    const arr = [];
    for (let i = 0; i < 5; i++) {
        const dayIndex = 20616 + i;
        const step = 17;
        const index = Math.abs(dayIndex * step) % poolSize;
        arr.push(index);
    }
    return arr;
}

console.log("36 pool:", simulate(36));
console.log("45 pool:", simulate(45));
