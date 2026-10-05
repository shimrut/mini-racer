import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { CAMPAIGN_ID, getCampaignSeries, getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { clearStoredSeriesForTests, registerStoredSeries } from '../game/campaign/stored-series.js';
import { getCampaignBootstrap } from '../game/campaign/service.js';
import { clearStoredTrackChecksForTests } from '../game/track/stored-track-service.js';
import { resetVerificationQueueForTests } from '../game/scoreboard/verification-queue.js';

const CREATOR_SERIES = {
    id: 'night-v1', name: 'Night Races', ground: 'tarmac',
    stages: [
        { trackKey: 'babylonRace', laps: 1, requiredMedals: 0 },
        { trackKey: 'smallSteps', laps: 1, requiredMedals: 1 },
        { trackKey: 'numberZero', laps: 1, requiredMedals: 2 },
    ],
};

function context(seriesId) {
    const engine = Object.create(RealTimeRacer.prototype);
    Object.assign(engine, campaignEngineMethods, {
        launchTarget: { mode: 'campaign', seriesId },
        campaignSeriesId: seriesId,
        status: 'ready', activeRaceMode: 'home',
        playerProfileAuthoritative: true,
        loadRaceDefinitions: vi.fn(async () => undefined),
        loadCampaignRaceDefinitions: vi.fn(async () => undefined),
        prepareRaceTrack: vi.fn(async (_, target) => ({ trackKey: target.trackKey })),
        applyCarUnlockSnapshot: vi.fn(),
        paintCampaignCarousel: vi.fn(),
        startOverlay: { showStartOverlay: vi.fn(), setReady: vi.fn(), setInteractive: vi.fn() },
        lobbyUi: { getMode: () => 'campaign', showCampaign: vi.fn(), setCampaignPrimaryLoading: vi.fn() },
    });
    engine.showCampaignLobby = vi.fn(engine.showCampaignLobby);
    return engine;
}

function responseBody(seriesId, stages, resultsByRaceId = {}) {
    return {
        campaignId: seriesId, ranked: true, signedIn: true, stages,
        storedSeries: [CREATOR_SERIES], storedTracks: [],
        progress: { resultsByRaceId }, standingsByRaceId: {},
    };
}

function serveBootstrap(body) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200, json: async () => body,
    })));
}

beforeEach(() => {
    clearStoredSeriesForTests();
    clearStoredTrackChecksForTests();
    resetVerificationQueueForTests();
    const storage = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
    });
    localStorage.setItem('MiniRacerCampaignSeries:v1', CAMPAIGN_ID);
});

afterEach(() => {
    clearStoredSeriesForTests();
    clearStoredTrackChecksForTests();
    resetVerificationQueueForTests();
    vi.unstubAllGlobals();
});

describe('playing a specific Campaign from a completion post', () => {
    it.each([
        ['fresh viewer', [], 0],
        ['returning viewer with earlier Bronze medals', ['bronze', 'bronze'], 2],
        ['finished viewer', ['gold', 'gold', 'gold'], 2],
    ])('opens the last unlocked stage for a %s, including a cold Creator catalog', async (_, medals, selectedIndex) => {
        registerStoredSeries([CREATOR_SERIES]);
        const stages = getCampaignSeriesStages(CREATOR_SERIES.id);
        clearStoredSeriesForTests();
        expect(getCampaignSeries(CREATOR_SERIES.id)).toBeNull();
        const results = Object.fromEntries(medals.map((medal, index) => [
            stages[index].raceId, { bestTimeMs: 10_000, medal },
        ]));
        serveBootstrap(responseBody(CREATOR_SERIES.id, stages, results));
        const engine = context(CREATOR_SERIES.id);

        const launch = await engine.prepareInitialCampaignLaunch({ prepareTrack: false, loadPersonalBest: false });

        expect(new URL(fetch.mock.calls[0][0]).searchParams.get('seriesId')).toBe(CREATOR_SERIES.id);
        expect(engine.campaignVerifiedBootstrap.campaignId).toBe(CREATOR_SERIES.id);
        expect(engine.selectedCampaignStageId).toBe(stages[selectedIndex].raceId);
        expect(launch.stage.raceId).toBe(stages[selectedIndex].raceId);
        const warm = await engine.warmCampaignRaceDefinitions();
        expect(warm.stage.raceId).toBe(stages[selectedIndex].raceId);

        await engine.displayInitialModeReady('campaign');
        expect(engine.showCampaignLobby).toHaveBeenLastCalledWith({ refresh: false, view: 'stages' });
        expect(engine.campaignLobbyState.seriesId).toBe(CREATOR_SERIES.id);
    });

    it('keeps the normal launcher default and series screen when multiple series exist', async () => {
        registerStoredSeries([CREATOR_SERIES]);
        const stages = getCampaignSeriesStages(CREATOR_SERIES.id);
        serveBootstrap(responseBody(CREATOR_SERIES.id, stages, {
            [stages[0].raceId]: { bestTimeMs: 10_000, medal: 'bronze' },
            [stages[1].raceId]: { bestTimeMs: 10_000, medal: 'bronze' },
        }));
        const engine = context(CREATOR_SERIES.id);
        engine.launchTarget = { mode: 'campaign' };
        const launch = await engine.prepareInitialCampaignLaunch({ prepareTrack: false, loadPersonalBest: false });
        expect(launch.stage.raceId).toBe(stages[0].raceId);
        await engine.displayInitialModeReady('campaign');
        expect(engine.showCampaignLobby).toHaveBeenLastCalledWith({ refresh: false, view: 'series' });
        expect(engine.campaignLobbyState.view).toBe('series');
    });

    it('refuses to substitute Numbers when a specific series is no longer available', async () => {
        serveBootstrap(responseBody(CAMPAIGN_ID, getCampaignSeriesStages(CAMPAIGN_ID)));
        await expect(getCampaignBootstrap({ seriesId: 'removed-v1' })).resolves.toMatchObject({
            campaignId: 'removed-v1', availability: 'unavailable', authoritative: false,
        });
        const engine = context('removed-v1');
        await expect(engine.prepareInitialCampaignLaunch({ prepareTrack: false, loadPersonalBest: false }))
            .rejects.toThrow('Campaign progress is not authoritative.');
        expect(engine.activeCampaignStage).toBeUndefined();
        expect(engine.showCampaignLobby).not.toHaveBeenCalled();
        expect(fetch.mock.calls.every(([url]) => new URL(url).searchParams.get('seriesId') === 'removed-v1')).toBe(true);
    });
});
