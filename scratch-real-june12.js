import { getDailyGpTrackKeyForDayIndex } from './src/server/daily-gp-model.ts';
const dayIndex = Math.floor(new Date('2026-06-12T00:00:00Z').getTime() / 86400000);
console.log('Local client (current):', getDailyGpTrackKeyForDayIndex(dayIndex));
