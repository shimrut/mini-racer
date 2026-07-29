import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CAMPAIGN_REQUEST_TIMEOUT_MS,
    deriveCampaignProgress,
    submitCampaignRun,
} from '../game/campaign/service.js';

describe('campaign client progress', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('starts with only Number Zero unlocked', () => {
        const progress = deriveCampaignProgress();
        expect(progress.unlockedRaceIds).toEqual(['numbered-v1-00']);
        expect(progress.continueRaceId).toBe('numbered-v1-00');
    });

    it('unlocks the next stage only with Gold or Author', () => {
        const silver = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7500, medal: 'silver' },
        });
        expect(silver.unlockedRaceIds).toEqual(['numbered-v1-00']);

        const gold = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7100, medal: 'gold' },
        });
        expect(gold.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);
    });

    it('aborts a Campaign request that never settles', async () => {
        vi.useFakeTimers();
        globalThis.fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new DOMException('Campaign request timed out', 'AbortError'));
            });
        }));

        const request = submitCampaignRun({
            raceId: 'numbered-v1-00',
            trackKey: 'numberZero',
            replay: { revision: 1, segments: [] },
        });
        const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

        await vi.advanceTimersByTimeAsync(CAMPAIGN_REQUEST_TIMEOUT_MS);
        await rejection;
    });
});
