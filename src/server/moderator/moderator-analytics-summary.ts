import { getServerAnalyticsSummary } from './analytics-store.js';
import { getServerStorageUsage } from './storage-usage.js';
import { readRacedListFillStatus } from '../player/raced-list-fill.js';
import { readDailyGhostArchiveStatus } from '../daily/daily-ghost-archive.js';

export async function getModeratorAnalyticsSummary({
    getSummary = getServerAnalyticsSummary,
    getStorage = getServerStorageUsage,
    getRacedListFill = readRacedListFillStatus,
    getDailyGhostArchive = () => readDailyGhostArchiveStatus(),
}: {
    getSummary?: typeof getServerAnalyticsSummary;
    getStorage?: typeof getServerStorageUsage;
    getRacedListFill?: typeof readRacedListFillStatus;
    getDailyGhostArchive?: () => ReturnType<typeof readDailyGhostArchiveStatus>;
} = {}) {
    const [summary, storage, racedListFill, dailyGhostArchive] = await Promise.all([
        getSummary(),
        getStorage().catch((error) => {
            console.error('Failed to measure Mini Racer Redis storage:', error);
            return null;
        }),
        getRacedListFill().catch((error) => {
            console.error('Failed to read the raced list fill status:', error);
            return null;
        }),
        getDailyGhostArchive().catch((error) => {
            console.error('Failed to read the Daily ghost archive status:', error);
            return null;
        }),
    ]);
    return { ...summary, storage, racedListFill, dailyGhostArchive };
}
