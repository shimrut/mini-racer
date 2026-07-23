import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CAMPAIGN_REQUEST_TIMEOUT_MS,
    deriveCampaignProgress,
    readLocalCampaignProgress,
    saveLocalCampaignFinish,
    startLocalCampaign,
    submitCampaignRun,
} from '../game/campaign/service.js';

function createRoot() {
    const values = new Map();
    return {
        localStorage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
        },
    };
}

describe('campaign client progress', () => {
    let root;
    let originalFetch;

    beforeEach(() => {
        root = createRoot();
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('starts with only Number Zero unlocked', () => {
        const progress = readLocalCampaignProgress(root);
        expect(progress.unlockedRaceIds).toEqual(['numbered-v1-00']);
        expect(progress.continueRaceId).toBe('numbered-v1-00');
    });

    it('starts idempotently and unlocks the next stage only with Gold or Author', () => {
        const started = startLocalCampaign(root);
        expect(started.startedAt).toBeTruthy();
        expect(startLocalCampaign(root).startedAt).toBe(started.startedAt);

        const silver = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7500, medal: 'silver' },
        }, started.startedAt);
        expect(silver.unlockedRaceIds).toEqual(['numbered-v1-00']);

        const gold = deriveCampaignProgress({
            'numbered-v1-00': { bestTimeMs: 7100, medal: 'gold' },
        }, started.startedAt);
        expect(gold.unlockedRaceIds).toEqual(['numbered-v1-00', 'numbered-v1-01']);
    });

    it('keeps only the fastest local guest finish', () => {
        const first = saveLocalCampaignFinish('numbered-v1-00', 7.1, root);
        const slower = saveLocalCampaignFinish('numbered-v1-00', 7.5, root);
        expect(slower.resultsByRaceId['numbered-v1-00'].bestTimeMs)
            .toBe(first.resultsByRaceId['numbered-v1-00'].bestTimeMs);
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
