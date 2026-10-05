import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CAMPAIGN_REQUEST_TIMEOUT_MS,
    deriveCampaignProgress,
    getCampaignBootstrap,
    getCampaignAggregate,
    submitCampaignRun,
    previewCampaignResultsShare,
    confirmCampaignResultsShare,
} from '../game/campaign/service.js';
import { getCampaignStage } from '../game/campaign/manifest.js';
import { clearStoredSeriesForTests, isStoredSeriesListLoaded } from '../game/campaign/stored-series.js';

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

    it('requests the series aggregate through the normal authenticated player request', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: vi.fn().mockResolvedValue({ ready: true }),
        });
        await getCampaignAggregate('numbered-v1', { limit: 25, offset: 50 });
        const url = new URL(globalThis.fetch.mock.calls[0][0], 'http://localhost');
        expect(url.pathname).toBe('/api/campaign/aggregate');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ seriesId: 'numbered-v1', limit: '25', offset: '50' });
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
                storedTracks: [],
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
                storedTracks: [],
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

    describe('when the game knows the series list', () => {
        afterEach(() => clearStoredSeriesForTests());

        function answer(body) {
            return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
        }

        it('knows it after a good answer that leaves out an empty list', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue(answer({
                ranked: true,
                storedTracks: [],
                stages: [],
                progress: { resultsByRaceId: {} },
            }));

            await getCampaignBootstrap();

            expect(isStoredSeriesListLoaded()).toBe(true);
        });

        it('does not know it after a failed answer', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

            await getCampaignBootstrap();

            expect(isStoredSeriesListLoaded()).toBe(false);
        });

        it('does not know it after an HTTP error', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
                json: vi.fn().mockResolvedValue({ error: 'busy' }),
            });

            await getCampaignBootstrap();

            expect(isStoredSeriesListLoaded()).toBe(false);
        });

        it('knows it after a good answer for an unranked player', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue(answer({
                ranked: false,
                signedIn: false,
                progress: { resultsByRaceId: {} },
            }));

            await getCampaignBootstrap();

            expect(isStoredSeriesListLoaded()).toBe(true);
        });

        it('knows it when the list arrived but the stage tracks then failed to load', async () => {
            globalThis.fetch = vi.fn()
                .mockResolvedValueOnce(answer({
                    ranked: true,
                    campaignId: 'night-v1',
                    storedSeries: [{
                        id: 'night-v1',
                        name: 'Night Races',
                        ground: 'tarmac',
                        stages: [{ trackKey: 'nightOnlyTrack', laps: 1, requiredMedals: 0 }],
                    }],
                    stages: [{ raceId: 'night-v1-00', trackKey: 'nightOnlyTrack' }],
                    progress: { resultsByRaceId: {} },
                }))
                .mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() });

            await expect(getCampaignBootstrap({ seriesId: 'night-v1' })).resolves.toMatchObject({ availability: 'unavailable' });

            expect(isStoredSeriesListLoaded()).toBe(true);
            expect(getCampaignStage('night-v1-00')).not.toBeNull();
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
                storedTracks: [],
                progress: { resultsByRaceId: {} },
            }),
        });

        await expect(getCampaignBootstrap()).resolves.toMatchObject({
            availability: 'available',
            authoritative: true,
            ranked: true,
        });
    });

    it('previews only the series ID and retains the server disclosure', async () => {
        const body = { status: 'ready', shareToken: 'preview-token', username: 'RaceFan', title: 'I finished the Numbers campaign' };
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
        await expect(previewCampaignResultsShare({ seriesId: 'numbered-v1' })).resolves.toEqual({ ok: true, status: 200, body });
        const [url, options] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/campaign/share/preview');
        expect(JSON.parse(options.body)).toEqual({ seriesId: 'numbered-v1' });
    });

    it('publishes only after confirmation and sends only the server preview token', async () => {
        const body = { status: 'shared', postUrl: 'https://www.reddit.com/r/test/comments/shared' };
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
        await expect(confirmCampaignResultsShare('preview-token')).resolves.toEqual({ ok: true, status: 200, body });
        const [url, options] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/campaign/share/confirm');
        expect(JSON.parse(options.body)).toEqual({ shareToken: 'preview-token' });
    });

    it('requests an unknown Creator series by its ID and refuses a different campaign response', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ ranked: true, campaignId: 'numbered-v1', stages: [], progress: {} }),
        });
        await expect(getCampaignBootstrap({ seriesId: 'creator-target-v1' })).resolves.toMatchObject({
            campaignId: 'creator-target-v1', availability: 'unavailable',
        });
        expect(new URL(globalThis.fetch.mock.calls[0][0]).searchParams.get('seriesId')).toBe('creator-target-v1');
    });
});
