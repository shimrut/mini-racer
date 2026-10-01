import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { LobbyUi } from '../game/lobby/ui.js';
import { setButtonBlock } from '../game/ui/dom.js';
import { trackEngineMethods } from '../game/track/engine-methods.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { PREPARATION_SLOTS } from '../game/track/race-preparation.js';

let originalDocument;

beforeEach(() => {
    originalDocument = global.document;
    const dom = new JSDOM(`
        <button id="daily-challenge-start-btn"><span class="main-menu__label"></span></button>
        <p id="daily-start-message" hidden></p>
        <button id="campaign-primary-btn"><span class="main-menu__label"></span></button>
        <p id="campaign-start-message" hidden></p>
    `, { url: 'https://example.com/' });
    global.document = dom.window.document;
});

afterEach(() => {
    global.document = originalDocument;
    vi.restoreAllMocks();
});

describe('a Start button with several reasons to stay disabled', () => {
    it('is enabled only when no reason is left', () => {
        const button = document.getElementById('daily-challenge-start-btn');
        setButtonBlock(button, 'summary', true);
        setButtonBlock(button, 'track', true);
        setButtonBlock(button, 'summary', false);
        expect(button.disabled).toBe(true);
        setButtonBlock(button, 'track', false);
        expect(button.disabled).toBe(false);
    });
});

describe('lobby Start and the selected race track', () => {
    it('keeps Daily Start disabled until its track is ready, and Retry Start enabled', () => {
        const lobby = new LobbyUi();
        const start = document.getElementById('daily-challenge-start-btn');

        lobby.setStartTrackReady('daily', false);
        expect(start.disabled).toBe(true);
        expect(start.textContent).not.toContain('Loading');

        lobby.setRaceStartError('daily', 'Track failed to load. Tap Retry Start.');
        expect(start.disabled).toBe(false);
        expect(start.textContent).toContain('Retry Start');

        lobby.clearRaceStartError('daily');
        expect(start.disabled).toBe(true);
        lobby.setStartTrackReady('daily', true);
        expect(start.disabled).toBe(false);
    });

    it('keeps Campaign Start disabled until the stage track is ready', () => {
        const lobby = new LobbyUi();
        const start = document.getElementById('campaign-primary-btn');
        lobby.setCampaignSelectedStage({ id: 'numbered-v1-01', unlocked: true, trackKey: 'circuit' });
        expect(start.disabled).toBe(false);

        lobby.setStartTrackReady('campaign', false);
        expect(start.disabled).toBe(true);
        lobby.setRaceStartError('campaign', 'Track failed to load. Tap Retry Start.');
        expect(start.disabled).toBe(false);
        lobby.clearRaceStartError('campaign');
        lobby.setStartTrackReady('campaign', true);
        expect(start.disabled).toBe(false);
    });
});

describe('the engine and the selected lobby card', () => {
    function engine(overrides = {}) {
        return {
            ...trackEngineMethods,
            ...dailyChallengeEngineMethods,
            status: 'ready',
            lobbyUi: { setStartTrackReady: vi.fn(), setRaceStartError: vi.fn() },
            ...overrides,
        };
    }

    it('marks the selected Daily card ready only when its track is prepared', () => {
        const challenge = { id: 'day-1', trackKey: 'smallSteps' };
        const prepared = { trackKey: 'smallSteps' };
        const racer = engine({
            dailyCarousel: { getSelectedChallenge: () => challenge },
            findPreparedRaceTrack: vi.fn(() => null),
        });
        racer.syncDailyStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('daily', false);

        racer.findPreparedRaceTrack.mockReturnValue(prepared);
        racer.syncDailyStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('daily', true);
        expect(racer.findPreparedRaceTrack).toHaveBeenCalledWith('smallSteps', challenge);
    });

    it('marks a locked Campaign stage as no race, and an unlocked one by its track', () => {
        const racer = {
            ...campaignEngineMethods,
            lobbyUi: { setStartTrackReady: vi.fn() },
            campaignCarousel: { getSelectedChallenge: () => ({ id: 's1', trackKey: 'circuit', unlocked: false }) },
            canStartRaceTrack: vi.fn(() => true),
        };
        racer.syncCampaignStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('campaign', null);

        racer.campaignCarousel.getSelectedChallenge = () => ({ id: 's1', trackKey: 'circuit', unlocked: true });
        racer.syncCampaignStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('campaign', true);
    });

    it('enables Start on a card whose layout is checked, before its track is drawn', async () => {
        vi.stubGlobal('window', {
            location: { hostname: 'reddit.example', pathname: '/game.html' },
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        });
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tracks: [] }) }));
        const { clearStoredTrackChecksForTests } = await import('../game/track/stored-track-service.js');
        clearStoredTrackChecksForTests();
        const challenge = { id: 'day-5', trackKey: 'smallSteps' };
        const racer = engine({ dailyCarousel: { getSelectedChallenge: () => challenge } });

        racer.syncDailyStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('daily', false);

        // One check for the whole list, when the lobby opens; nothing is drawn.
        racer.confirmRaceTracks(['smallSteps', 'numberOne']);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(racer.findPreparedRaceTrack('smallSteps', challenge)).toBeNull();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('daily', true);
        delete globalThis.fetch;
        vi.unstubAllGlobals();
    });

    it('prepares the card the carousel stopped on, in the selected slot', async () => {
        const prepareRaceTrack = vi.fn(async (slot, { beforeBuild }) => (await beforeBuild()) ? { trackKey: 'smallSteps' } : null);
        const challenge = { id: 'day-1', trackKey: 'smallSteps' };
        const racer = engine({
            prepareRaceTrack,
            startOverlay: { isStartOverlayVisible: () => true },
            dailyCarousel: { getSelectedChallenge: () => challenge },
            ensureDailyCarouselRank: vi.fn(async () => {}),
        });

        racer.handleDailyCarouselSettled({ challenge });
        await Promise.resolve();

        expect(prepareRaceTrack).toHaveBeenCalledWith(PREPARATION_SLOTS.SELECTED, expect.objectContaining({
            trackKey: 'smallSteps',
            challenge,
        }));
        expect(await prepareRaceTrack.mock.results[0].value).toEqual({ trackKey: 'smallSteps' });
    });

    it('stops the build when the player swipes to another card first', async () => {
        let selected = { id: 'day-1', trackKey: 'smallSteps' };
        let beforeBuild;
        const prepareRaceTrack = vi.fn((slot, target) => {
            beforeBuild = target.beforeBuild;
            return new Promise(() => {});
        });
        const racer = engine({ prepareRaceTrack });
        racer.prepareSelectedRaceTrack('daily', {
            trackKey: selected.trackKey,
            challenge: selected,
            isStillSelected: () => selected.id === 'day-1',
        });
        selected = { id: 'day-2', trackKey: 'numberOne' };

        expect(await beforeBuild()).toBe(false);
    });

    it('shows Retry Start when the selected track cannot be prepared', async () => {
        const racer = engine({
            prepareRaceTrack: vi.fn(async () => {
                throw new Error('The track layout could not be confirmed. Retry before racing.');
            }),
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        racer.prepareSelectedRaceTrack('daily', { trackKey: 'smallSteps' });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(racer.lobbyUi.setRaceStartError).toHaveBeenCalledWith('daily', 'Track failed to load. Tap Retry Start.');
    });

    it('confirms a saved Daily list in one request before its cards load', () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tracks: [] }) }));
        const racer = engine();
        racer.confirmRaceTracks(['albertGardens', 'bucharestScramble', 'budapestRun']);
        racer.confirmRaceTracks(['albertGardens', 'bucharestScramble', 'budapestRun']);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toBe('/api/tracks/stored?keys=albertGardens%2CbucharestScramble%2CbudapestRun');
        delete globalThis.fetch;
    });
});

describe('Campaign Next and the next stage track', () => {
    it('keeps Next disabled, and still the main action, until the track is ready', async () => {
        const { ModalShell } = await import('../game/race/ui-modal-shell.js');
        const dom = new JSDOM(`
            <div id="modal-combined-view"><div class="combined-actions">
                <button id="combined-restart-btn"><span class="combined-action-btn-label"></span></button>
                <button id="combined-next-btn"><span class="combined-action-btn-label"></span></button>
            </div></div>
        `, { url: 'https://example.com/' });
        global.document = dom.window.document;
        const shell = new ModalShell({});
        const next = document.getElementById('combined-next-btn');
        const action = vi.fn();

        shell._syncCombinedNextRace({ label: 'Next', enabled: true, action });
        shell.setCombinedNextRaceReady(false);
        expect(next.disabled).toBe(true);
        expect(next.classList.contains('combined-action-btn--primary')).toBe(true);

        shell.setCombinedNextRaceEnabled(true);
        expect(next.disabled).toBe(true);
        shell.setCombinedNextRaceReady(true);
        expect(next.disabled).toBe(false);

        shell.setCombinedNextRaceEnabled(false);
        expect(next.disabled).toBe(true);
    });

    function campaignRacer(overrides = {}) {
        return {
            ...campaignEngineMethods,
            modal: {
                setCombinedNextRaceReady: vi.fn(),
                matchesModalScoreboardContext: vi.fn(() => true),
            },
            findPreparedRaceTrack: vi.fn(() => null),
            ...overrides,
        };
    }

    it('prepares an unlocked next stage in the Next slot, then enables Next', async () => {
        const prepareRaceTrack = vi.fn(async (slot, { beforeBuild }) => (await beforeBuild()) ? { trackKey: 'circuit' } : null);
        const racer = campaignRacer({ prepareRaceTrack });
        racer.prepareCampaignNextTrack(
            { raceId: 'numbered-v1-01' },
            { unlocked: true, stage: { raceId: 'numbered-v1-02', trackKey: 'circuit', lapCount: 1 } },
        );
        expect(racer.modal.setCombinedNextRaceReady).toHaveBeenLastCalledWith(false);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(prepareRaceTrack).toHaveBeenCalledWith(PREPARATION_SLOTS.NEXT, expect.objectContaining({ trackKey: 'circuit' }));
        expect(racer.modal.matchesModalScoreboardContext).toHaveBeenCalledWith({ challengeId: 'numbered-v1-01' });
        expect(racer.modal.setCombinedNextRaceReady).toHaveBeenLastCalledWith(true);
    });

    it('enables Next at once when the next track is already prepared, and skips a locked stage', () => {
        const prepareRaceTrack = vi.fn();
        const racer = campaignRacer({
            prepareRaceTrack,
            findPreparedRaceTrack: vi.fn(() => ({ trackKey: 'circuit' })),
        });
        racer.prepareCampaignNextTrack(
            { raceId: 'numbered-v1-01' },
            { unlocked: true, stage: { raceId: 'numbered-v1-02', trackKey: 'circuit', lapCount: 1 } },
        );
        expect(racer.modal.setCombinedNextRaceReady).toHaveBeenCalledWith(true);
        expect(prepareRaceTrack).not.toHaveBeenCalled();

        racer.modal.setCombinedNextRaceReady.mockClear();
        racer.prepareCampaignNextTrack({ raceId: 'numbered-v1-01' }, { unlocked: false, stage: { trackKey: 'circuit' } });
        expect(racer.modal.setCombinedNextRaceReady).not.toHaveBeenCalled();
    });
});

describe('the screen stays until the new track is drawn', () => {
    async function resetEngine() {
        const { raceEngineMethods } = await import('../game/race/engine-methods.js');
        const calls = [];
        const engine = {
            ...raceEngineMethods,
            pendingStartFrame: null,
            currentTrack: { startPos: { x: 1, y: 2 }, startAngle: 0 },
            activeRunId: 0,
            skidMarks: { clear() {} },
            routeTrace: { clear() {} },
            runHistory: { clear() {} },
            particles: [],
            camera: { x: 0, y: 0 },
            zoom: 1,
            viewportWidth: 100,
            viewportHeight: 100,
            clearTimers() {},
            clearSteeringInput() {},
            clearDailyChallengeRun() {},
            clearRaceComparisonTarget() {},
            requestRender() {},
            resize: () => calls.push('resize'),
            modal: { closeModal: () => calls.push('closeModal') },
            hud: { setPauseVisible() {}, resetCountdown() {}, resetHud() {} },
            startOverlay: {
                hideStartOverlay: () => calls.push('hideStartOverlay'),
                showStartOverlay: () => calls.push('showStartOverlay'),
            },
        };
        return { engine, calls };
    }

    it('keeps the lobby and the finish screen when a race start resets', async () => {
        const { engine, calls } = await resetEngine();
        engine.reset(false, { showStartOverlay: false, keepScreen: true });
        expect(calls).not.toContain('closeModal');
        expect(calls).not.toContain('hideStartOverlay');
        expect(calls).not.toContain('showStartOverlay');

        engine.reset(false, { showStartOverlay: false });
        expect(calls).toContain('closeModal');
        expect(calls).toContain('hideStartOverlay');
    });

    it('draws the new track before the finish screen closes and the lobby fades', async () => {
        const { revealInstalledRace } = await import('../game/track/race-definition.js');
        const calls = [];
        await revealInstalledRace({
            resize: ({ render }) => calls.push(`draw:${render}`),
            modal: { closeModal: () => calls.push('closeModal') },
            startOverlay: {
                beginRaceStartTransition: () => {
                    calls.push('lobbyFade');
                    return Promise.resolve();
                },
            },
        });
        expect(calls).toEqual(['draw:true', 'closeModal', 'lobbyFade']);
    });
});
