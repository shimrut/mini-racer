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
            waitForQuietMoment: async () => {},
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
            findPreparedRaceTrack: vi.fn(() => ({ trackKey: 'circuit' })),
        };
        racer.syncCampaignStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('campaign', null);

        racer.campaignCarousel.getSelectedChallenge = () => ({ id: 's1', trackKey: 'circuit', unlocked: true });
        racer.syncCampaignStartReadiness();
        expect(racer.lobbyUi.setStartTrackReady).toHaveBeenLastCalledWith('campaign', true);
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
