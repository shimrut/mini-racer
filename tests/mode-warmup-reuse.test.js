import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { CAMPAIGN_ID, getCampaignSeriesStages } from '../game/campaign/manifest.js';
import { clearStoredSeriesForTests } from '../game/campaign/stored-series.js';
import { deriveCampaignProgress } from '../game/campaign/service.js';
import { cacheDailyChallengePlaylist, clearDailyChallengeClientCaches } from '../game/daily-challenge/service.js';
import { clearActivePlayerOwnerId, setActivePlayerOwnerId } from '../game/player/active-owner.js';
import { enqueueCampaignVerification, markCampaignVerificationError, resetVerificationQueueForTests } from '../game/scoreboard/verification-queue.js';
import { clearClientTrackRegistryForTests, getLoadedClientTrack } from '../game/track/client-registry.js';
import { getTrackDefinitionIdentity } from '../game/track/definition-identity.js';
import { PREPARATION_SLOTS, plainRaceChallenge } from '../game/track/race-preparation.js';
import { clearStoredTrackChecksForTests } from '../game/track/stored-track-service.js';
import { clearStoredTracksForTests, registerStoredTrack } from '../game/track/stored-tracks.js';

// Replace only the canvas build; definitions, preparation matching and HTTP stay real.
vi.mock('../game/track/assets.js', () => ({
    getTrackRuntimeAsset: vi.fn((trackKey, track) => ({ trackKey, track })),
    getTrackCanvasAsset: vi.fn((trackKey, track) => ({ canvas: { trackKey, track }, origin: { x: 0, y: 0 } })),
}));

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-03T10:00:00.000Z');
let daily;
let playlist;

function json(body) {
    return { ok: true, status: 200, json: async () => body };
}

function requests(route) {
    return fetch.mock.calls.filter(([url]) => new URL(String(url), 'https://game.example').pathname === route);
}

function dailyCards(nowMs) {
    const today = Math.floor(nowMs / DAY) * DAY;
    return Array.from({ length: 7 }, (_, index) => {
        const start = today - index * DAY;
        const challengeDate = new Date(start).toISOString().slice(0, 10);
        return {
            id: `daily-gp-${challengeDate}`,
            challengeDate,
            trackKey: 'circuit',
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(start + DAY).toISOString(),
            availableUntil: new Date(start + 7 * DAY).toISOString(),
            status: 'active',
            objectiveType: 'single_lap_fastest',
            objectiveParams: {},
            skin: 'default',
        };
    });
}

function bootstrapBody(resultsByRaceId = {}) {
    return {
        campaignId: CAMPAIGN_ID, ranked: true, signedIn: false,
        stages: getCampaignSeriesStages(CAMPAIGN_ID), storedTracks: [],
        progress: { resultsByRaceId }, standingsByRaceId: {},
    };
}

function racer(initialMode = 'home') {
    const engine = Object.create(RealTimeRacer.prototype);
    engine.activeRaceMode = initialMode;
    engine.qualityLevel = 0;
    engine.frameSkip = 0;
    engine.playerProfileAuthoritative = true;
    engine.prefetchModeRuntime = vi.fn(async (mode) => ({
        methods: mode === 'campaign' ? campaignEngineMethods : dailyChallengeEngineMethods,
    }));
    engine.installModeRuntime = vi.fn(async () => {});
    engine.loadingScreen = { begin: vi.fn(), dismiss: vi.fn(async () => {}), showError: vi.fn() };
    engine.startOverlay = { setReady: vi.fn(), setInteractive: vi.fn() };
    engine.setDailyChallengeLobbySummary = vi.fn();
    engine.showDailyLobby = vi.fn(() => { engine.activeRaceMode = 'daily'; });
    engine.showCampaignLobby = vi.fn(() => { engine.activeRaceMode = 'campaign'; });
    engine.showHomeLobby = vi.fn(() => { engine.activeRaceMode = 'home'; });
    engine.claimQueuedResultsForOwner = vi.fn();
    engine.scheduleVerificationQueueProcessing = vi.fn();
    engine.ensureCampaignBootstrap = campaignEngineMethods.ensureCampaignBootstrap;
    engine.applyCampaignLobbyBootstrap = vi.fn(campaignEngineMethods.applyCampaignLobbyBootstrap);
    engine.loadCampaignRaceDefinitions = campaignEngineMethods.loadCampaignRaceDefinitions;
    return engine;
}

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const entries = new Map();
    const storage = {
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, String(value)),
        removeItem: (key) => entries.delete(key),
    };
    const location = {
        origin: 'https://game.example', hostname: 'game.example',
        pathname: '/pages/game.html', search: '', protocol: 'https:',
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', { location, localStorage: storage });
    clearDailyChallengeClientCaches();
    clearStoredTrackChecksForTests();
    clearStoredTracksForTests();
    clearStoredSeriesForTests();
    clearClientTrackRegistryForTests();
    resetVerificationQueueForTests();
    setActivePlayerOwnerId('guest-one');
    playlist = dailyCards(NOW);
    daily = playlist[0];
    cacheDailyChallengePlaylist(playlist);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        const route = new URL(String(url), location.origin).pathname;
        if (route === '/api/daily/active') return json({ ...daily, storedTracks: [] });
        if (route === '/api/daily/playlist') return json({ challenges: playlist, storedTracks: [] });
        if (route === '/api/campaign/bootstrap') return json(bootstrapBody());
        if (route === '/api/tracks/stored') return json({ tracks: [] });
        throw new Error(`Unexpected mode warmup request: ${route}`);
    }));
});

afterEach(() => {
    clearActivePlayerOwnerId();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('completed mode warmup reuse', () => {
    it.each([
        ['daily', 'campaign', '/api/daily/active'],
        ['campaign', 'daily', '/api/campaign/bootstrap'],
        ['daily', 'home', '/api/daily/active'],
        ['campaign', 'challenge', '/api/campaign/bootstrap'],
    ])('reuses %s background warming from %s across repeated entries', async (mode, initialMode, route) => {
        const engine = racer(initialMode);
        engine.currentChallengeRun = { id: 'existing-attempt' };
        const warmed = await engine.warmRaceMode(mode);
        expect(requests(route)).toHaveLength(1);
        expect(engine.activeRaceMode).toBe(initialMode);
        expect(engine.currentChallengeRun).toEqual({ id: 'existing-attempt' });
        expect(engine.installModeRuntime).not.toHaveBeenCalled();

        await engine.activateMode(mode);
        engine.activeRaceMode = initialMode;
        await engine.activateMode(mode);

        expect(requests(route)).toHaveLength(1);
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
        expect(engine.activeRaceMode).toBe(mode);
        if (mode === 'daily') expect(engine.currentDailyChallenge.id).toBe(warmed.challenge.id);
        else expect(engine.campaignBootstrap.authoritative).toBe(true);
    });

    it('shares an in-flight Campaign request and retains its result for the next entry', async () => {
        const engine = racer('daily');
        const response = new Promise((resolve) => { engine.releaseBootstrap = resolve; });
        const fixtureFetch = fetch;
        vi.stubGlobal('fetch', vi.fn((url, options) => {
            const route = new URL(String(url), 'https://game.example').pathname;
            return route === '/api/campaign/bootstrap' ? response : fixtureFetch(url, options);
        }));
        const background = engine.warmRaceMode('campaign');
        await vi.waitFor(() => expect(requests('/api/campaign/bootstrap')).toHaveLength(1));
        expect(engine.warmRaceMode('campaign')).toBe(background);
        const entry = engine.activateMode('campaign');
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.showCampaignLobby).not.toHaveBeenCalled();

        engine.releaseBootstrap(json(bootstrapBody()));
        await Promise.all([background, entry]);
        engine.activeRaceMode = 'daily';
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.showCampaignLobby).toHaveBeenCalledTimes(2);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it.each(['daily', 'campaign'])('retains the initial %s contract when returning to that mode', async (mode) => {
        const engine = racer(mode);
        if (mode === 'daily') {
            const challenge = await engine.loadDailyChallengeCritical({
                prepareTrack: false, loadPersonalBest: false, throwOnError: true,
            });
            await engine.prepareRaceTrack(PREPARATION_SLOTS.DAILY, { trackKey: challenge.trackKey, challenge });
        } else {
            const { stage } = await campaignEngineMethods.prepareInitialCampaignLaunch.call(engine, {
                prepareTrack: false, loadPersonalBest: false,
            });
            await engine.prepareRaceTrack(PREPARATION_SLOTS.CAMPAIGN, {
                trackKey: stage.trackKey, challenge: plainRaceChallenge(stage.trackKey),
            });
        }
        await engine.displayInitialModeReady(mode);
        const route = mode === 'daily' ? '/api/daily/active' : '/api/campaign/bootstrap';
        expect(requests(route)).toHaveLength(1);
        engine.activeRaceMode = 'home';
        await engine.activateMode(mode);

        expect(requests(route)).toHaveLength(1);
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('keeps later accepted Campaign progress when an older warmup exists', async () => {
        const engine = racer('daily');
        const oldWarmup = await engine.warmRaceMode('campaign');
        const [firstStage] = getCampaignSeriesStages(CAMPAIGN_ID);
        const result = { raceId: firstStage.raceId, bestTimeMs: 8000, medal: 'gold' };
        const accepted = {
            ...engine.campaignVerifiedBootstrap,
            progress: deriveCampaignProgress({ [firstStage.raceId]: result }, '2026-10-03T10:01:00.000Z'),
        };
        engine.applyCampaignLobbyBootstrap(accepted);
        expect(oldWarmup.bootstrap.progress.resultsByRaceId[firstStage.raceId]).toBeUndefined();
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.campaignVerifiedBootstrap).toBe(accepted);
        expect(engine.campaignBootstrap.progress.resultsByRaceId[firstStage.raceId]).toMatchObject(result);
        const loaderCount = engine.loadingScreen.begin.mock.calls.length;
        engine.activeRaceMode = 'daily';
        await engine.activateMode('campaign');
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(loaderCount);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('uses accepted Campaign progress that arrives during background preparation', async () => {
        const engine = racer('daily');
        const actualPrepare = engine.prepareRaceTrack;
        let releasePreparation;
        let preparationPaused = false;
        const pendingPreparation = new Promise((resolve) => { releasePreparation = resolve; });
        engine.prepareRaceTrack = vi.fn(async (...args) => {
            const record = await actualPrepare.apply(engine, args);
            if (!preparationPaused) {
                preparationPaused = true;
                await pendingPreparation;
            }
            return record;
        });
        const background = engine.warmRaceMode('campaign');
        await vi.waitFor(() => expect(preparationPaused).toBe(true));
        const [firstStage] = getCampaignSeriesStages(CAMPAIGN_ID);
        const result = { raceId: firstStage.raceId, bestTimeMs: 7000, medal: 'gold' };
        const accepted = {
            ...engine.campaignVerifiedBootstrap,
            progress: deriveCampaignProgress({ [firstStage.raceId]: result }, '2026-10-03T10:01:00.000Z'),
        };
        engine.applyCampaignLobbyBootstrap(accepted);
        releasePreparation();
        const warmed = await background;
        await engine.activateMode('campaign');

        expect(warmed.bootstrap).toBe(accepted);
        expect(warmed.stage.raceId).toBe(engine.campaignLobbyState.nextStage.id);
        expect(engine.campaignVerifiedBootstrap).toBe(accepted);
        expect(engine.campaignBootstrap.progress.resultsByRaceId[firstStage.raceId]).toMatchObject(result);
        expect(requests('/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('keeps a pending result provisional across reentry and removes it after rejection', async () => {
        const engine = racer('daily');
        const [stage] = getCampaignSeriesStages(CAMPAIGN_ID);
        enqueueCampaignVerification({
            raceId: stage.raceId, trackKey: stage.trackKey, bestTime: 7.3,
            lapCount: stage.lapCount, rulesRevision: stage.rulesRevision,
            replay: { revision: 1, segments: [] },
        });
        await engine.warmRaceMode('campaign');
        expect(engine.campaignBootstrap.progress.resultsByRaceId[stage.raceId]).toBeDefined();
        expect(engine.campaignVerifiedBootstrap.progress.resultsByRaceId[stage.raceId]).toBeUndefined();

        // A local rebuild must not put the pending time into the server's snapshot.
        engine.qualityLevel = 2;
        await engine.activateMode('campaign');
        expect(engine.campaignVerifiedBootstrap.progress.resultsByRaceId[stage.raceId]).toBeUndefined();

        markCampaignVerificationError(stage.raceId, 'Submission replay validation failed.');
        campaignEngineMethods.refreshCampaignVerificationOverlay.call(engine, { paint: false });
        engine.activeRaceMode = 'daily';
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.campaignVerifiedBootstrap.progress.resultsByRaceId[stage.raceId]).toBeUndefined();
        expect(engine.campaignBootstrap.progress.resultsByRaceId[stage.raceId]).toBeUndefined();
        expect(engine.campaignBootstrap.verificationErrors[stage.raceId]).toBe('Submission replay validation failed.');
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it.each(['daily', 'campaign'])('rebuilds %s for changed quality without fetching its contract again', async (mode) => {
        const engine = racer();
        const warmed = await engine.warmRaceMode(mode);
        const oldRecord = warmed.prepared;
        engine.qualityLevel = 2;
        await engine.activateMode(mode);

        const trackKey = mode === 'daily' ? warmed.challenge.trackKey : warmed.stage.trackKey;
        const challenge = mode === 'daily' ? warmed.challenge : plainRaceChallenge(trackKey);
        const rebuilt = engine.findPreparedRaceTrack(trackKey, challenge);
        expect(rebuilt).not.toBe(oldRecord);
        expect(rebuilt.optionsKey).toBe('2:0');
        expect(requests(mode === 'daily' ? '/api/daily/active' : '/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);

        engine.activeRaceMode = 'home';
        await engine.activateMode(mode);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('rebuilds a replaced Daily definition without refetching an unexpired contract', async () => {
        const engine = racer();
        const warmed = await engine.warmRaceMode('daily');
        const track = getLoadedClientTrack(warmed.challenge.trackKey);
        const changed = { ...track, cornerRadius: (track.cornerRadius ?? 3) + 1 };
        registerStoredTrack({ key: warmed.challenge.trackKey, name: track.name, track: changed });
        await engine.activateMode('daily');

        const rebuilt = engine.findPreparedRaceTrack(warmed.challenge.trackKey, warmed.challenge);
        expect(rebuilt).not.toBe(warmed.prepared);
        expect(rebuilt.identity).toBe(getTrackDefinitionIdentity(changed));
        expect(engine.currentDailyChallenge.id).toBe(warmed.challenge.id);
        expect(requests('/api/daily/active')).toHaveLength(1);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('refreshes the featured Daily after its day ends', async () => {
        const engine = racer('campaign');
        const warmed = await engine.warmRaceMode('daily');
        const nextDay = Date.parse(warmed.challenge.endsAt) + 1;
        Date.now.mockReturnValue(nextDay);
        playlist = dailyCards(nextDay);
        daily = playlist[0];
        await engine.activateMode('daily');

        expect(requests('/api/daily/active')).toHaveLength(2);
        expect(engine.currentDailyChallenge.id).toBe(daily.id);
        expect(engine.currentDailyChallenge.id).not.toBe(warmed.challenge.id);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('refreshes a Daily whose pending preparation finishes after UTC midnight', async () => {
        const engine = racer('campaign');
        const actualPrepare = engine.prepareRaceTrack;
        let releasePreparation;
        let preparationPaused = false;
        const pendingPreparation = new Promise((resolve) => { releasePreparation = resolve; });
        engine.prepareRaceTrack = vi.fn(async (...args) => {
            const record = await actualPrepare.apply(engine, args);
            if (!preparationPaused) {
                preparationPaused = true;
                await pendingPreparation;
            }
            return record;
        });
        const oldDailyId = daily.id;
        const background = engine.warmRaceMode('daily');
        await vi.waitFor(() => expect(preparationPaused).toBe(true));
        expect(requests('/api/daily/active')).toHaveLength(1);
        const nextDay = Date.parse(daily.endsAt) + 1;
        Date.now.mockReturnValue(nextDay);
        playlist = dailyCards(nextDay);
        daily = playlist[0];
        releasePreparation();
        const warmed = await background;
        expect(engine.activeRaceMode).toBe('campaign');
        await engine.activateMode('daily');

        expect(requests('/api/daily/active')).toHaveLength(2);
        expect(warmed.challenge.id).toBe(daily.id);
        expect(warmed.playlist.some((challenge) => challenge.id === daily.id)).toBe(true);
        expect(engine.currentDailyChallenge.id).toBe(daily.id);
        expect(engine.currentDailyChallenge.id).not.toBe(oldDailyId);
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('refreshes Campaign when the same owner receives a new profile state', async () => {
        const engine = racer('daily');
        await engine.warmRaceMode('campaign');
        await engine.applyPlayerProgressState({ authoritative: true }, { loadCar: false });
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(2);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('does not apply a late Campaign bootstrap belonging to the previous owner', async () => {
        const engine = racer('daily');
        const [stage] = getCampaignSeriesStages(CAMPAIGN_ID);
        let releaseOldResponse;
        let bootstrapCount = 0;
        const oldResponse = new Promise((resolve) => { releaseOldResponse = resolve; });
        const fixtureFetch = fetch;
        vi.stubGlobal('fetch', vi.fn((url, options) => {
            const route = new URL(String(url), 'https://game.example').pathname;
            if (route !== '/api/campaign/bootstrap') return fixtureFetch(url, options);
            bootstrapCount += 1;
            return bootstrapCount === 1 ? oldResponse : Promise.resolve(json(bootstrapBody({
                [stage.raceId]: { raceId: stage.raceId, bestTimeMs: 7500, medal: 'author' },
            })));
        }));
        const background = engine.warmRaceMode('campaign');
        await vi.waitFor(() => expect(requests('/api/campaign/bootstrap')).toHaveLength(1));
        setActivePlayerOwnerId('guest-two');
        releaseOldResponse(json(bootstrapBody({
            [stage.raceId]: { raceId: stage.raceId, bestTimeMs: 9000, medal: 'gold' },
        })));
        await background;
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(2);
        expect(engine.applyCampaignLobbyBootstrap).toHaveBeenCalledTimes(1);
        expect(engine.campaignBootstrap.progress.resultsByRaceId[stage.raceId].bestTimeMs).toBe(7500);
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });

    it('does not fall back to the previous owner Campaign when the new owner request fails', async () => {
        const engine = racer('daily');
        await engine.warmRaceMode('campaign');
        const oldBootstrap = engine.campaignVerifiedBootstrap;
        const [stage] = getCampaignSeriesStages(CAMPAIGN_ID);
        const fixtureFetch = fetch;
        let failBootstrap = true;
        vi.stubGlobal('fetch', vi.fn((url, options) => {
            const route = new URL(String(url), 'https://game.example').pathname;
            if (route !== '/api/campaign/bootstrap') return fixtureFetch(url, options);
            return Promise.resolve(json(failBootstrap
                ? { ...bootstrapBody(), ranked: false }
                : bootstrapBody({
                    [stage.raceId]: { raceId: stage.raceId, bestTimeMs: 7500, medal: 'author' },
                })));
        }));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        setActivePlayerOwnerId('guest-two');
        await engine.activateMode('campaign');

        expect(requests('/api/campaign/bootstrap')).toHaveLength(1);
        expect(engine.showCampaignLobby).not.toHaveBeenCalled();
        expect(engine.getReadyRaceMode('campaign')).toBeNull();
        expect(engine.loadingScreen.showError).toHaveBeenCalledTimes(1);
        expect(engine.activeRaceMode).toBe('daily');
        failBootstrap = false;
        const retry = engine.loadingScreen.showError.mock.calls[0][1];
        retry();
        await vi.waitFor(() => expect(engine.showCampaignLobby).toHaveBeenCalledTimes(1));

        expect(requests('/api/campaign/bootstrap')).toHaveLength(2);
        expect(engine.campaignVerifiedBootstrap).not.toBe(oldBootstrap);
        expect(engine.campaignBootstrap.progress.resultsByRaceId[stage.raceId].bestTimeMs).toBe(7500);
        expect(engine.activeRaceMode).toBe('campaign');
    });

    it('reopens the loader for a ready-mode runtime failure and retries without another contract request', async () => {
        const engine = racer('campaign');
        await engine.warmRaceMode('daily');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        engine.installModeRuntime.mockRejectedValueOnce(new Error('Runtime installation failed.'));
        await engine.activateMode('daily');

        expect(engine.showDailyLobby).not.toHaveBeenCalled();
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.loadingScreen.showError).toHaveBeenCalledTimes(1);
        expect(engine.loadingScreen.begin.mock.invocationCallOrder[0])
            .toBeLessThan(engine.loadingScreen.showError.mock.invocationCallOrder[0]);
        const retry = engine.loadingScreen.showError.mock.calls[0][1];
        retry();
        await vi.waitFor(() => expect(engine.showDailyLobby).toHaveBeenCalledTimes(1));
        expect(requests('/api/daily/active')).toHaveLength(1);
        expect(engine.loadingScreen.dismiss).toHaveBeenCalledTimes(1);
        expect(engine.activeRaceMode).toBe('daily');
    });

    it('revalidates a ready contract when the owner changes during mode installation', async () => {
        const engine = racer('daily');
        await engine.warmRaceMode('campaign');
        let releaseInstallation;
        const pendingInstallation = new Promise((resolve) => { releaseInstallation = resolve; });
        engine.installModeRuntime.mockReturnValueOnce(pendingInstallation);
        const entry = engine.activateMode('campaign');
        await vi.waitFor(() => expect(engine.installModeRuntime).toHaveBeenCalledTimes(1));
        expect(engine.loadingScreen.begin).not.toHaveBeenCalled();
        setActivePlayerOwnerId('guest-two');
        releaseInstallation();
        await entry;

        expect(requests('/api/campaign/bootstrap')).toHaveLength(2);
        expect(engine.loadingScreen.begin).toHaveBeenCalledTimes(1);
        expect(engine.showCampaignLobby).toHaveBeenCalledTimes(1);
        expect(engine.activeRaceMode).toBe('campaign');
        expect(engine.loadingScreen.showError).not.toHaveBeenCalled();
    });
});
