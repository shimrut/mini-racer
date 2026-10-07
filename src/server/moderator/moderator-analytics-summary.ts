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

// The Storage tab's Redis card: the size, and the raced-list fill. Each part
// fails on its own, so one failure leaves the other shown. The ghost move has
// its own request, which the tab repeats while it is open.
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
