import { getServerAnalyticsSummary } from './analytics-store.js';
import { getServerStorageUsage } from './storage-usage.js';
import { readRacedListFillStatus } from '../player/raced-list-fill.js';

// The Players tab: player counts only.
export async function getModeratorAnalyticsSummary({
    getSummary = getServerAnalyticsSummary,
}: {
    getSummary?: typeof getServerAnalyticsSummary;
} = {}) {
    return getSummary();
}

// The Storage tab's Redis card: size and raced-list fill, each failing alone; the ghost move has its own request.
export async function getModeratorStorageSummary({
    getStorage = getServerStorageUsage,
    getRacedListFill = readRacedListFillStatus,
}: {
    getStorage?: typeof getServerStorageUsage;
    getRacedListFill?: typeof readRacedListFillStatus;
} = {}) {
    const [storage, racedListFill] = await Promise.all([
        getStorage().catch((error) => {
            console.error('Failed to measure Mini Racer Redis storage:', error);
            return null;
        }),
        getRacedListFill().catch((error) => {
            console.error('Failed to read the raced list fill status:', error);
            return null;
        }),
    ]);
    return { storage, racedListFill };
}
