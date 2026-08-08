import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CAMPAIGN_REQUEST_TIMEOUT_MS,
    deriveCampaignProgress,
    getCampaignBootstrap,
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

    it('unlocks stages as the medal total climbs, one at a time', () => {
        // Silver is two medals: enough for the 1-medal gate on stage 01.
        const silver = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7500, medal: 'silver' },
        });
        expect(silver.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);

        // Improving that same stage to Gold pays stage 02's price of 3, but
        // stage 02 stays shut: stage 01 has not been raced yet.
        const gold = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7100, medal: 'gold' },
        });
        expect(gold.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);

        // A medal on stage 01 is what opens it.
        const both = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7100, medal: 'gold' },
            'numbered-v1-01': { bestTimeMs: 10_000, medal: 'bronze' },
        });
        expect(both.unlockedRaceIds).toEqual([
            'numbered-v1-00',
            'numbered-v1-01',
            'numbered-v1-02',
        ]);
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

    it('marks a successful Campaign bootstrap as authoritative', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                ranked: true,
                signedIn: false,
                stages: [],
                progress: { resultsByRaceId: {} },
                standingsByRaceId: {},
            }),
        });

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'available',
            authoritative: true,
            ranked: true,
        });
    });

    it('marks an unavailable Campaign bootstrap as non-authoritative', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'unavailable',
            authoritative: false,
            ranked: false,
        });
    });
});
