import { getServerAnalyticsSummary } from './analytics-store.js';
import { getServerStorageUsage } from './storage-usage.js';
import { readRacedListFillStatus } from '../player/raced-list-fill.js';

export async function getModeratorAnalyticsSummary({
    getSummary = getServerAnalyticsSummary,
    getStorage = getServerStorageUsage,
    getRacedListFill = readRacedListFillStatus,
}: {
    getSummary?: typeof getServerAnalyticsSummary;
    getStorage?: typeof getServerStorageUsage;
    getRacedListFill?: typeof readRacedListFillStatus;
} = {}) {
    const [summary, storage, racedListFill] = await Promise.all([
        getSummary(),
        getStorage().catch((error) => {
            console.error('Failed to measure Mini Racer Redis storage:', error);
            return null;
        }),
        getRacedListFill().catch((error) => {
            console.error('Failed to read the raced list fill status:', error);
            return null;
        }),
    ]);
    return { ...summary, storage, racedListFill };
}
