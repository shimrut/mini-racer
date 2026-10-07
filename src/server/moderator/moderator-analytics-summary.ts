import { getServerAnalyticsSummary } from './analytics-store.js';
import { getServerStorageUsage } from './storage-usage.js';
import { readRacedListFillStatus } from '../player/raced-list-fill.js';
import { readDailyGhostArchiveStatus } from '../daily/daily-ghost-archive.js';

// The Players tab: player counts only.
export async function getModeratorAnalyticsSummary({
    getSummary = getServerAnalyticsSummary,
}: {
    getSummary?: typeof getServerAnalyticsSummary;
} = {}) {
    return getSummary();
}

// The Storage tab: the Redis size, the raced-list fill, and the ghost move.
// Each part fails on its own, so one failure leaves the others shown.
export async function getModeratorStorageSummary({
    getStorage = getServerStorageUsage,
    getRacedListFill = readRacedListFillStatus,
    getDailyGhostArchive = () => readDailyGhostArchiveStatus(),
}: {
    getStorage?: typeof getServerStorageUsage;
    getRacedListFill?: typeof readRacedListFillStatus;
    getDailyGhostArchive?: () => ReturnType<typeof readDailyGhostArchiveStatus>;
} = {}) {
    const [storage, racedListFill, dailyGhostArchive] = await Promise.all([
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
    return { storage, racedListFill, dailyGhostArchive };
}
