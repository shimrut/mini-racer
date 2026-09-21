import { describe, expect, it, vi } from 'vitest';
import { modeRouterEngineMethods } from '../game/modes/engine-methods.js';

function createEngine(overrides = {}) {
    return {
        ...modeRouterEngineMethods,
        status: 'ready',
        currentChallengeRun: null,
        activeRaceMode: 'home',
        activeCampaignStage: { raceId: 'numbered-v1-00' },
        activeHeadToHead: { challengeId: 'challenge-1' },
        hasAnyData: true,
        isReturningPlayer: true,
        reset: vi.fn(),
        clearDailyChallengeRun: vi.fn(),
        startOverlay: { showStartOverlay: vi.fn() },
        lobbyUi: { showHome: vi.fn(), showDaily: vi.fn() },
        journeys: { endAttempt: vi.fn(), startAttempt: vi.fn() },
        restartDailyChallenge: vi.fn(),
        handleCampaignWin: vi.fn(),
        handleHeadToHeadWin: vi.fn(),
        handleDailyChallengeWin: vi.fn(),
        handleDailyChallengeLapCompleted: vi.fn(),
        showCampaignLobby: vi.fn(() => 'campaign-lobby'),
        showChallengeLobby: vi.fn(() => 'challenge-lobby'),
        loadChallengeLobby: vi.fn(() => 'challenge-lobby'),
        dailyCarousel: { getSelectedChallenge: vi.fn(() => ({ id: 'daily-visible' })) },
        campaignCarousel: {
            getSelectedChallenge: vi.fn(() => ({
                id: 'numbered-v1-03',
                unlocked: true,
            })),
        },
        openDailyCarouselStandings: vi.fn(),
        openCampaignStandings: vi.fn(),
        syncReadyBackgroundTrack: vi.fn(() => Promise.resolve()),
        currentDailyChallenge: { id: 'daily-today', trackKey: 'albertGardens' },
        ...overrides,
    };
}

describe('mode router', () => {
    it('sends a finish to the handler for the active mode', () => {
        const winData = { lapTime: 8.25 };

        const campaign = createEngine({ activeRaceMode: 'campaign' });
        campaign.handleActiveRaceWin(winData);
        expect(campaign.handleCampaignWin).toHaveBeenCalledWith(winData);
        expect(campaign.handleDailyChallengeWin).not.toHaveBeenCalled();

        const challenge = createEngine({ activeRaceMode: 'challenge' });
        challenge.handleActiveRaceWin(winData);
        expect(challenge.handleHeadToHeadWin).toHaveBeenCalledWith(winData);

        const daily = createEngine({ activeRaceMode: 'daily' });
        daily.handleActiveRaceWin(winData);
        expect(daily.handleDailyChallengeWin).toHaveBeenCalledWith(winData);

        const home = createEngine({ activeRaceMode: 'home' });
        home.handleActiveRaceWin(winData);
        expect(home.handleDailyChallengeWin).toHaveBeenCalledWith(winData);
    });

    it('routes lap completions through the shared Daily handler for every mode', () => {
        const engine = createEngine({ activeRaceMode: 'campaign' });
        engine.handleActiveRaceLapCompleted(4.5, { completedLaps: 1 });
        expect(engine.handleDailyChallengeLapCompleted).toHaveBeenCalledWith(
            4.5,
            { completedLaps: 1 },
        );
    });

    it('restarts Daily through its own retry path and other modes in place', () => {
        const daily = createEngine({ activeRaceMode: 'daily', currentChallengeRun: {} });
        daily.restartActiveRace();
        expect(daily.restartDailyChallenge).toHaveBeenCalledWith({ reason: 'restart' });
        expect(daily.reset).not.toHaveBeenCalled();

        const campaign = createEngine({ activeRaceMode: 'campaign', currentChallengeRun: {} });
        campaign.restartActiveRace();
        expect(campaign.restartDailyChallenge).not.toHaveBeenCalled();
        expect(campaign.reset).toHaveBeenCalledWith(true, {
            preserveDailyChallenge: true,
            showStartOverlay: false,
        });
        expect(campaign.journeys.startAttempt).toHaveBeenCalledWith({ mode: 'campaign', reason: 'restart' });
    });

    it('counts a Head to Head restart as a start', () => {
        const challenge = createEngine({
            activeRaceMode: 'challenge',
            currentChallengeRun: {},
            recordHeadToHeadStart: vi.fn(),
        });
        challenge.restartActiveRace();
        expect(challenge.recordHeadToHeadStart).toHaveBeenCalledTimes(1);

        const campaign = createEngine({
            activeRaceMode: 'campaign',
            currentChallengeRun: {},
            recordHeadToHeadStart: vi.fn(),
        });
        campaign.restartActiveRace();
        expect(campaign.recordHeadToHeadStart).not.toHaveBeenCalled();
    });

    it('does not restart a non-Daily mode with no active run', () => {
        const campaign = createEngine({ activeRaceMode: 'campaign', currentChallengeRun: null });
        campaign.restartActiveRace();
        expect(campaign.reset).not.toHaveBeenCalled();
    });

    it('returns to the lobby that owns the active mode', () => {
        const campaign = createEngine({ activeRaceMode: 'campaign' });
        expect(campaign.returnToActiveLobby()).toBe('campaign-lobby');

        const challenge = createEngine({ activeRaceMode: 'challenge' });
        expect(challenge.returnToActiveLobby()).toBe('challenge-lobby');
        expect(challenge.showChallengeLobby).toHaveBeenCalledTimes(1);
        expect(challenge.loadChallengeLobby).not.toHaveBeenCalled();

        const daily = createEngine({ activeRaceMode: 'daily' });
        daily.returnToActiveLobby();
        expect(daily.lobbyUi.showDaily).toHaveBeenCalled();
    });

    it('clears campaign context when leaving for Home or Daily', () => {
        const home = createEngine({ activeRaceMode: 'campaign' });
        home.showHomeLobby();
        expect(home.activeRaceMode).toBe('home');
        expect(home.activeCampaignStage).toBeNull();
        expect(home.activeHeadToHead).toBeNull();
        expect(home.clearDailyChallengeRun).toHaveBeenCalled();

        const daily = createEngine({ activeRaceMode: 'campaign' });
        daily.showDailyLobby();
        expect(daily.activeRaceMode).toBe('daily');
        expect(daily.activeCampaignStage).toBeNull();
        expect(daily.activeHeadToHead).toBeNull();
    });

    it("puts the day's track back behind Home after racing something else", () => {
        const engine = createEngine({
            activeRaceMode: 'campaign',
            currentDailyChallenge: { id: 'daily-today', trackKey: 'ardennesRidge' },
        });
        engine.showHomeLobby();
        expect(engine.syncReadyBackgroundTrack).toHaveBeenCalledWith({
            id: 'daily-today',
            trackKey: 'ardennesRidge',
        });
    });

    it('tears down a live run before showing a lobby', () => {
        const engine = createEngine({ activeRaceMode: 'campaign', currentChallengeRun: {} });
        engine.showDailyLobby();
        expect(engine.reset).toHaveBeenCalledWith(false, { showStartOverlay: false });
    });

    it('opens Daily standings for the currently centred challenge', () => {
        const engine = createEngine({ activeRaceMode: 'daily' });
        engine.openVisibleLobbyStandings('daily');
        expect(engine.openDailyCarouselStandings).toHaveBeenCalledWith({
            id: 'daily-visible',
        });
    });

    it('opens Campaign standings for the currently centred unlocked stage', () => {
        const engine = createEngine({ activeRaceMode: 'campaign' });
        engine.openVisibleLobbyStandings('campaign');
        expect(engine.openCampaignStandings).toHaveBeenCalledWith(
            { id: 'numbered-v1-03', unlocked: true },
            { returnMode: 'close' },
        );
    });

    it('does not open standings outside Daily or Campaign', () => {
        const home = createEngine({ activeRaceMode: 'home' });
        home.openVisibleLobbyStandings('home');
        expect(home.openDailyCarouselStandings).not.toHaveBeenCalled();
        expect(home.openCampaignStandings).not.toHaveBeenCalled();
    });

    it('opens Campaign standings for a centred locked stage', () => {
        const locked = createEngine({
            activeRaceMode: 'campaign',
            campaignCarousel: {
                getSelectedChallenge: vi.fn(() => ({
                    id: 'numbered-v1-04',
                    unlocked: false,
                })),
            },
        });
        locked.openVisibleLobbyStandings('campaign');
        expect(locked.openCampaignStandings).toHaveBeenCalledWith(
            { id: 'numbered-v1-04', unlocked: false },
            { returnMode: 'close' },
        );
    });
});
