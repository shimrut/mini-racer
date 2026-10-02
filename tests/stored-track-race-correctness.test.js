import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTrackDefinitionIdentity } from '../game/track/definition-identity.js';
import { getTrackCanvasAsset, getTrackRuntimeAsset } from '../game/track/assets.js';
import { clearStoredTracksForTests, getStoredTrack } from '../game/track/stored-tracks.js';
import { clearClientTrackRegistryForTests, loadClientTrack, loadRaceDefinitions } from '../game/track/client-registry.js';
import { clearStoredTrackChecksForTests, ensureStoredTracks, registerStoredTracksFromPayload } from '../game/track/stored-track-service.js';
import { CHANGED_TRACK_RUN_MESSAGE, getStaleRunTrackReason } from '../game/track/race-definition.js';
import { trackEngineMethods } from '../game/track/engine-methods.js';
import { raceEngineMethods } from '../game/race/engine-methods.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { headToHeadEngineMethods } from '../game/head-to-head/engine-methods.js';
import { modeRouterEngineMethods } from '../game/modes/engine-methods.js';
import { getActiveDailyChallenge } from '../game/daily-challenge/service.js';
import { fitTrackPreviewCanvas } from '../game/ui/track-carousel.js';
import { renderCachedTrackPreviewCanvas } from '../game/track/preview-renderer.js';
import { PREPARATION_SLOTS, plainRaceChallenge } from '../game/track/race-preparation.js';

vi.mock('../game/track/canvas.js', async (importOriginal) => ({
    ...await importOriginal(),
    buildTrackCanvas: vi.fn((track) => ({ canvas: { track }, origin: { x: 0, y: 0 } })),
}));
vi.mock('../game/track/preview-renderer.js', () => ({ renderCachedTrackPreviewCanvas: vi.fn() }));

function storedTrack(track = {}, metadata = {}) {
    return {
        key: 'circuit', name: 'Confirmed Circuit', ground: 'tarmac',
        medalRow: { author: 9, gold: 10, silver: 11, bronze: 12 },
        track: {
            outer: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }],
            inner: [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 25 }, { x: 5, y: 25 }],
            startLine: { p1: { x: 0, y: 10 }, p2: { x: 5, y: 10 } },
            startPos: { x: 2, y: 10 }, startAngle: 0,
            checkpoints: [{ p1: { x: 25, y: 15 }, p2: { x: 30, y: 15 } }],
            ...track,
        },
        ...metadata,
    };
}

function response(tracks) {
    return { ok: true, status: 200, json: async () => ({ tracks }) };
}

beforeEach(() => {
    clearStoredTracksForTests();
    clearStoredTrackChecksForTests();
    clearClientTrackRegistryForTests();
    vi.clearAllMocks();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('authoritative stored layout before racing', () => {
    it('waits for a built-in override on the dated-post startup path', async () => {
        let answer;
        vi.stubGlobal('window', { location: { hostname: 'reddit.example', pathname: '/game.html' } });
        vi.stubGlobal('devvit', { context: { postData: { challenge: {
            id: 'dated-post', trackKey: 'circuit', startsAt: '2026-09-30T00:00:00.000Z',
            endsAt: '2099-01-01T00:00:00.000Z', availableUntil: '2099-01-08T00:00:00.000Z',
        } } } });
        const fetchMock = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
        vi.stubGlobal('fetch', fetchMock);
        let settled = false;
        const challengeRequest = getActiveDailyChallenge().then((challenge) => { settled = true; return challenge; });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith('/api/tracks/stored?keys=circuit', expect.any(Object));
        answer(response([storedTrack({ cornerRadius: 0 })]));
        const challenge = await challengeRequest;
        const definition = await loadClientTrack(challenge.trackKey);
        expect(definition.name).toBe('Confirmed Circuit');
        expect(definition.cornerRadius).toBe(0);
    });

    it('retries a cosmetic negative cache and propagates failure instead of using a built-in', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(response([]))
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(response([storedTrack()]));
        vi.stubGlobal('fetch', fetchMock);
        await ensureStoredTracks(['circuit'], { includeBuiltIn: true });
        await expect(ensureStoredTracks(['circuit'], { requireConfirmation: true })).rejects.toThrow('offline');
        await ensureStoredTracks(['circuit'], { requireConfirmation: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(getStoredTrack('circuit')?.track.name).toBe('Confirmed Circuit');
    });

    it('rejects omitted arrays, malformed geometry and an absent custom key', async () => {
        const invalid = storedTrack({ outer: [{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
        expect(() => registerStoredTracksFromPayload([invalid], { confirmedTrackKeys: ['circuit'] })).toThrow('confirmed');
        expect(() => registerStoredTracksFromPayload([], { confirmedTrackKeys: ['missingLoop'] })).toThrow('confirmed');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        registerStoredTracksFromPayload(undefined, { confirmedTrackKeys: ['circuit'] });
        await expect(ensureStoredTracks(['circuit'], { requireConfirmation: true })).rejects.toThrow('confirmed');
    });

    it('uses an explicit empty authoritative payload without another request', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        registerStoredTracksFromPayload([], { confirmedTrackKeys: ['circuit'] });
        await ensureStoredTracks(['circuit'], { requireConfirmation: true });
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await loadClientTrack('circuit')).name).toBeTruthy();
    });

    it('adopts the app definition after an unplayed stored override is removed', async () => {
        registerStoredTracksFromPayload([storedTrack()], { confirmedTrackKeys: ['circuit'] });
        const previous = await loadClientTrack('circuit');
        const engine = {
            activeRaceMode: 'daily', currentTrackKey: 'circuit', currentTrack: previous, trackCanvas: {},
            activeDailyChallenge: { id: 'run', trackKey: 'circuit' }, currentChallengeRun: {},
            runTrackKey: 'circuit', runTrackDefinitionIdentity: getTrackDefinitionIdentity(previous),
            loadTrack: vi.fn(async function loadTrack() { this.currentTrack = await loadClientTrack('circuit'); }),
            reset: vi.fn(), restartDailyChallenge: dailyChallengeEngineMethods.restartDailyChallenge,
        };
        registerStoredTracksFromPayload([], { confirmedTrackKeys: ['circuit'] });
        expect(getStoredTrack('circuit')).toBeNull();
        expect(getStaleRunTrackReason(engine)).toBe(CHANGED_TRACK_RUN_MESSAGE);
        await engine.restartDailyChallenge();
        expect(engine.loadTrack).toHaveBeenCalledTimes(1);
        expect(engine.currentTrack).not.toBe(previous);
        expect(engine.reset).toHaveBeenCalledWith(true, expect.objectContaining({ preserveDailyChallenge: true }));
    });
});

describe('same-key assets and fixed active attempts', () => {
    it('starts a confirmed loaded same-key Daily with its own picture and no source request', async () => {
        vi.stubGlobal('window', {
            location: { hostname: 'reddit.example', pathname: '/game.html' },
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        });
        vi.stubGlobal('document', { activeElement: null });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        registerStoredTracksFromPayload([], { confirmedTrackKeys: ['kettleRun'] });
        await loadRaceDefinitions(['kettleRun']);
        const engine = {
            ...trackEngineMethods,
            status: 'ready', activeRaceMode: 'daily', trackLoadRequestId: 0,
            qualityLevel: 1, frameSkip: 0, activeGeometry: {},
            requestRender: vi.fn(), syncCurrentRunPolicy: vi.fn(),
            hud: { setGround: vi.fn(), setBestTime: vi.fn() },
            reset: vi.fn(), applyDailyChallenge: vi.fn(), startSequence: vi.fn(), resize: vi.fn(),
            startOverlay: { beginRaceStartTransition: vi.fn() },
        };
        const plain = await engine.prepareRaceTrack(PREPARATION_SLOTS.DAILY, {
            trackKey: 'kettleRun', challenge: plainRaceChallenge('kettleRun'),
        });
        await engine.loadTrack('kettleRun', {
            prepared: plain, loadPlayerProgress: false, preserveDailyChallengeContext: true,
        });
        const previousCanvas = engine.trackCanvas;
        const challenge = { id: 'desert-daily', trackKey: 'kettleRun', skin: 'desert' };
        await dailyChallengeEngineMethods.handleStartDailyChallenge.call(engine, challenge);
        expect(engine.startSequence).toHaveBeenCalledOnce();
        const selected = engine.findPreparedRaceTrack('kettleRun', challenge);
        expect(selected.presentation.key).not.toBe(plain.presentation.key);
        expect(engine.currentTrackPresentation).toBe(selected.presentation);
        expect(engine.trackCanvas).toBe(selected.canvasAsset.canvas);
        expect(engine.trackCanvas).not.toBe(previousCanvas);
        expect(engine.startSequence).toHaveBeenCalledOnce();
        expect(fetchMock).not.toHaveBeenCalled();
        engine.qualityLevel = 2;
        expect(engine.isInstalledRaceTrack('kettleRun', challenge)).toBe(false);
        expect(engine.readyRaceTrack(PREPARATION_SLOTS.SELECTED, 'kettleRun', challenge).optionsKey).toBe('2:0');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retains the expired active Daily when Restart is pressed', () => {
        const activeDailyChallenge = { id: 'expired-active', trackKey: 'circuit', availableUntil: '2000-01-01T00:00:00Z' };
        const engine = {
            activeDailyChallenge, currentTrackKey: 'circuit', currentTrack: null,
            handleStartDailyChallenge: vi.fn(), loadDailyChallengeCritical: vi.fn(), reset: vi.fn(),
        };
        dailyChallengeEngineMethods.restartDailyChallenge.call(engine);
        expect(engine.activeDailyChallenge).toBe(activeDailyChallenge);
        expect(engine.loadDailyChallengeCritical).not.toHaveBeenCalled();
        expect(engine.handleStartDailyChallenge).not.toHaveBeenCalled();
        expect(engine.reset).toHaveBeenCalledWith(true, expect.objectContaining({ preserveDailyChallenge: true }));
    });

    it.each([false, true])('does not install or report a late changed-track Restart after leaving (reject=%s)', async (reject) => {
        registerStoredTracksFromPayload([storedTrack({ cornerRadius: 0 })]);
        let complete;
        const recovery = new Promise((resolve, rejectLoad) => { complete = reject ? rejectLoad : resolve; });
        const engine = {
            ...trackEngineMethods,
            activeRaceMode: 'daily', currentTrackKey: 'circuit', currentTrack: storedTrack().track, trackCanvas: {},
            activeDailyChallenge: { id: 'run', trackKey: 'circuit' },
            loadRaceDefinitions: vi.fn(() => recovery), loadTrack: vi.fn(), reset: vi.fn(),
            showDailyLobby: vi.fn(), lobbyUi: { setRaceStartError: vi.fn() },
            restartDailyChallenge: dailyChallengeEngineMethods.restartDailyChallenge,
        };
        const restart = engine.restartDailyChallenge();
        engine.cancelRacePreparation();
        engine.activeRaceMode = 'home';
        complete(reject ? new Error('offline') : undefined);
        await restart;
        expect(engine.loadTrack).not.toHaveBeenCalled();
        expect(engine.reset).not.toHaveBeenCalled();
        expect(engine.showDailyLobby).not.toHaveBeenCalled();
        expect(engine.lobbyUi.setRaceStartError).not.toHaveBeenCalled();
    });

    it.each([
        ['global radius', (track) => { track.cornerRadius = 0; }],
        ['point radius', (track) => { track.outer[0].cornerRadius = 0; }],
        ['wall coordinates', (track) => { track.outer[0].x = -2; }],
        ['start position', (track) => { track.startPos.y = 12; }],
        ['ground', (track) => { track.ground = 'dirt'; }],
    ])('rebuilds runtime and canvas when %s changes, without modifying active assets', (_name, change) => {
        const original = storedTrack().track;
        const changed = structuredClone(original);
        change(changed);
        const runtime = getTrackRuntimeAsset('circuit', original);
        const canvas = getTrackCanvasAsset('circuit', original);
        expect(getTrackRuntimeAsset('circuit', changed)).not.toBe(runtime);
        expect(getTrackCanvasAsset('circuit', changed)).not.toBe(canvas);
        expect(getTrackRuntimeAsset('circuit', original)).toBe(runtime);
        expect(getTrackCanvasAsset('circuit', original)).toBe(canvas);
    });

    it('retains track object and assets across equivalent hydration and metadata changes', async () => {
        registerStoredTracksFromPayload([storedTrack()]);
        const original = await loadClientTrack('circuit');
        const runtime = getTrackRuntimeAsset('circuit', original);
        const canvas = getTrackCanvasAsset('circuit', original);
        registerStoredTracksFromPayload([storedTrack({}, { medalRow: { author: 8, gold: 9, silver: 10, bronze: 11 } })]);
        expect(await loadClientTrack('circuit')).toBe(original);
        registerStoredTracksFromPayload([storedTrack({}, { name: 'Renamed Circuit' })]);
        const renamed = await loadClientTrack('circuit');
        expect(renamed.name).toBe('Renamed Circuit');
        expect(getTrackRuntimeAsset('circuit', renamed)).toBe(runtime);
        expect(getTrackCanvasAsset('circuit', renamed)).toBe(canvas);
    });

    it('repaints an unchanged-size preview after a same-key layout change', () => {
        registerStoredTracksFromPayload([storedTrack()]);
        const canvas = { width: 320, height: 176, dataset: {}, parentElement: { offsetWidth: 320, offsetHeight: 176 } };
        fitTrackPreviewCanvas(canvas, { trackKey: 'circuit' });
        const firstKey = canvas.dataset.previewKey;
        const firstCacheKey = renderCachedTrackPreviewCanvas.mock.calls[0][1].cacheKey;
        registerStoredTracksFromPayload([storedTrack({ cornerRadius: 0 })]);
        expect(fitTrackPreviewCanvas(canvas, { trackKey: 'circuit' })).toBe(true);
        expect(canvas.dataset.previewKey).not.toBe(firstKey);
        expect(renderCachedTrackPreviewCanvas.mock.calls[1][1]).toMatchObject({ cornerRadius: 0 });
        expect(renderCachedTrackPreviewCanvas.mock.calls[1][1].cacheKey).not.toBe(firstCacheKey);
    });

    it('captures the actual attempt definition at countdown and rejects changed-layout Daily/Campaign finishes', async () => {
        vi.useFakeTimers();
        registerStoredTracksFromPayload([storedTrack()]);
        const original = await loadClientTrack('circuit');
        const engine = {
            activeRaceMode: 'daily', currentTrackKey: 'circuit', currentTrack: original, status: 'ready',
            pos: original.startPos, angle: 0, runtimeConfig: {}, activeTimers: [],
            activeDailyChallenge: { id: 'daily', trackKey: 'circuit' }, currentChallengeRun: {},
            scoreboardReplay: { reset: vi.fn() }, recordRunPoint: vi.fn(), syncChallengeHudPrimaryStats: vi.fn(),
            runHistory: { clear: vi.fn() }, startOverlay: { hideStartOverlay: vi.fn() },
            hud: { setPauseVisible: vi.fn(), showStartLights: vi.fn() },
            isValidatedWinData: () => true, handleInvalidDailyChallengeWin: vi.fn(), handleInvalidCampaignWin: vi.fn(),
        };
        raceEngineMethods.startSequence.call(engine);
        registerStoredTracksFromPayload([storedTrack({ cornerRadius: 0 })]);
        expect(engine.currentTrack).toBe(original);
        expect(getStaleRunTrackReason(engine)).toBe(CHANGED_TRACK_RUN_MESSAGE);
        dailyChallengeEngineMethods.handleDailyChallengeWin.call(engine, { lapTime: 10 });
        expect(engine.handleInvalidDailyChallengeWin).toHaveBeenCalledWith(CHANGED_TRACK_RUN_MESSAGE);
        engine.activeCampaignStage = { trackKey: 'circuit' };
        campaignEngineMethods.handleCampaignWin.call(engine, { lapTime: 10 });
        expect(engine.handleInvalidCampaignWin).toHaveBeenCalledWith(CHANGED_TRACK_RUN_MESSAGE);
    });

    it('rejects a stale H2H tie or loss before displaying a local verdict', async () => {
        const original = storedTrack().track;
        registerStoredTracksFromPayload([storedTrack({ cornerRadius: 0 })]);
        const engine = {
            currentTrackKey: 'circuit', currentTrack: original, runTrackKey: 'circuit',
            runTrackDefinitionIdentity: getTrackDefinitionIdentity(original),
            activeHeadToHead: { challengeId: 'h2h', trackKey: 'circuit', lapCount: 1, targetTimeMs: 10_000 },
            scoreboardReplay: { getPayload: () => ({ revision: 1 }) }, modal: { showModal: vi.fn() },
        };
        await headToHeadEngineMethods.handleHeadToHeadWin.call(engine, { lapTime: 12 });
        expect(engine.modal.showModal.mock.calls[0][2]).toMatchObject({
            challengeConfirmPhase: 'error', challengeConfirmError: CHANGED_TRACK_RUN_MESSAGE,
        });
    });

    it.each(['daily', 'campaign', 'challenge'])('adopts changed geometry only on explicit %s Retry and preserves its challenge', async (mode) => {
        const original = storedTrack().track;
        registerStoredTracksFromPayload([storedTrack({ cornerRadius: 0 })]);
        const engine = {
            activeRaceMode: mode, currentTrackKey: 'circuit', currentTrack: original, trackCanvas: {},
            activeDailyChallenge: { id: 'run', trackKey: 'circuit' }, currentChallengeRun: {},
            loadTrack: vi.fn(async function loadTrack(_key, options) {
                expect(options.preserveDailyChallengeOnReset).toBe(true);
                this.currentTrack = await loadClientTrack('circuit');
            }),
            reset: vi.fn(), restartDailyChallenge: dailyChallengeEngineMethods.restartDailyChallenge,
            restartActiveRace: modeRouterEngineMethods.restartActiveRace,
        };
        await engine.restartActiveRace();
        expect(engine.loadTrack).toHaveBeenCalledTimes(1);
        expect(engine.currentTrack.cornerRadius).toBe(0);
        expect(engine.reset).toHaveBeenCalledWith(true, expect.objectContaining({ preserveDailyChallenge: true }));
    });

    it('blocks a cached-card start when authoritative confirmation fails', async () => {
        vi.stubGlobal('window', {
            location: { hostname: 'reddit.example', pathname: '/game.html' },
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const engine = {
            ...trackEngineMethods,
            status: 'ready', currentTrackKey: 'circuit', trackCanvas: {},
            startSequence: vi.fn(), loadTrack: vi.fn(), applyDailyChallenge: vi.fn(),
            lobbyUi: { setRaceStartError: vi.fn() },
        };
        await dailyChallengeEngineMethods.handleStartDailyChallenge.call(engine, { id: 'cached-card', trackKey: 'circuit' });
        expect(engine.startSequence).not.toHaveBeenCalled();
        expect(engine.loadTrack).not.toHaveBeenCalled();
        expect(engine.lobbyUi.setRaceStartError).toHaveBeenCalledWith('daily', expect.stringContaining('Retry'));
    });
});
