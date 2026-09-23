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
    });

    it('unlocks stages as the medal total climbs, one at a time', () => {
        const silver = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7500, medal: 'silver' },
        });
        expect(silver.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);

        const gold = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7100, medal: 'gold' },
        });
        expect(gold.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);

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

    it('clears the retired local-only Campaign results on bootstrap', async () => {
        const storage = new Map();
        vi.stubGlobal('localStorage', {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key),
        });
        globalThis.localStorage.setItem('MiniRacerCampaignPending:numbered-v1', JSON.stringify({
            'numbered-v1-00': { bestTimeMs: 8_250 },
        }));
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                ranked: true,
                progress: { resultsByRaceId: {} },
                standingsByRaceId: {},
            }),
        });

        await getCampaignBootstrap();

        expect(globalThis.localStorage.getItem('MiniRacerCampaignPending:numbered-v1')).toBeNull();
    });

    it('marks an unavailable Campaign bootstrap as non-authoritative', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'unavailable',
            authoritative: false,
            ranked: false,
        });
    });

    it('does not treat an unranked HTTP 200 Campaign bootstrap as authoritative', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                ranked: false,
                signedIn: false,
                progress: { resultsByRaceId: {} },
            }),
        });

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'unavailable',
            authoritative: false,
            ranked: false,
        });
    });

    it('keeps a signed-in Campaign promotion pending state non-authoritative', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                ranked: true,
                signedIn: true,
                guestPromotionPending: true,
                campaignProgressPromotionPending: true,
                progress: { resultsByRaceId: {} },
            }),
        });

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'unavailable',
            authoritative: false,
            ranked: true,
            signedIn: true,
        });
    });

    it('keeps Campaign playable when only a non-Campaign promotion remains pending', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                ranked: true,
                signedIn: true,
                guestPromotionPending: true,
                campaignProgressPromotionPending: false,
                progress: { resultsByRaceId: {} },
            }),
        });

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'available',
            authoritative: true,
            ranked: true,
        });
    });
});
