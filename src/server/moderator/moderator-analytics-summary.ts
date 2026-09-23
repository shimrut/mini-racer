import { getServerAnalyticsSummary } from './analytics-store.js';
import { getServerStorageUsage } from './storage-usage.js';

export async function getModeratorAnalyticsSummary({
    getSummary = getServerAnalyticsSummary,
    getStorage = getServerStorageUsage,
}: {
    getSummary?: typeof getServerAnalyticsSummary;
    getStorage?: typeof getServerStorageUsage;
} = {}) {
    const [summary, storage] = await Promise.all([
        getSummary(),
        getStorage().catch((error) => {
            console.error('Failed to measure Mini Racer Redis storage:', error);
            return null;
        }),
    ]);
    return { ...summary, storage };
}
