// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Only Numbers is live until the Creator publishes another series. With one
// series, the Campaign opens its stages, with no series screen and no series choice.

vi.mock('../game/ui/track-carousel.js', () => ({
    renderTrackPreviewCanvas: vi.fn(),
    trackPreviewPixelScale: () => 1,
}));
vi.mock('../game/ui/track-start-picture.js', () => ({
    renderTrackStartPicture: vi.fn(),
}));
vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getCampaignBootstrap: vi.fn(),
    getCampaignAggregate: vi.fn(),
}));

const { campaignHasSeriesChoice, getCampaignFinalStage } = await import('../game/campaign/manifest.js');
const { getCampaignAggregate } = await import('../game/campaign/service.js');
const { campaignEngineMethods } = await import('../game/campaign/engine-methods.js');
const { LobbyUi } = await import('../game/lobby/ui.js');
const { buildCampaignSeriesRows } = await import('../game/lobby/campaign-series-screen.js');

const NUMBERS = { id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', stageCount: 16, medalCount: 0 };

function createContext() {
    return {
        status: 'ready',
        activeRaceMode: 'campaign',
        campaignBootstrap: null,
        campaignLobbyState: null,
        _campaignBootstrapReady: false,
        startOverlay: { showStartOverlay: vi.fn() },
        lobbyUi: {
            showCampaign: vi.fn(),
            getMode: vi.fn(() => 'campaign'),
            setCampaignPrimaryLoading: vi.fn(),
            setCampaignSelectedStage: vi.fn(),
        },
        campaignCarousel: { isEmpty: vi.fn(() => false) },
        reset: vi.fn(),
        paintCampaignCarousel: vi.fn(),
        ...campaignEngineMethods,
    };
}

function mountLobby(handlers) {
    const html = readFileSync(join(process.cwd(), 'pages/game.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    const lobby = new LobbyUi(handlers);
    lobby.bind();
    return lobby;
}

describe('Campaign with one live series', () => {
    it('has no series choice', () => {
        expect(campaignHasSeriesChoice()).toBe(false);
    });

    // Mini Rally and Formula Mini are drafts in the Creator, so they are not
    // live and the series screen does not list them.
    it('keeps the app series other than Numbers off the series screen', () => {
        expect(buildCampaignSeriesRows({}).map((row) => row.name)).toEqual(['Numbers']);
    });

    it('opens the stages, not the series screen', () => {
        const context = createContext();
        context.showCampaignLobby({ view: 'series', refresh: false });
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('stages');

        context.backToCampaignSeries();
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('stages');
    });

    it('opens the series list from Home even with only one live series', () => {
        const context = createContext();
        context.modal = { showCampaignFinished: vi.fn() };
        context.showCampaignFinishedNow({ title: 'Numbers', seriesId: 'numbered-v1' });
        const actions = context.modal.showCampaignFinished.mock.calls[0][1];

        actions.primaryAction();

        expect(actions.primaryActionLabel).toBe('Home');
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('series');
    });

    function standingsContext(series) {
        const context = createContext();
        context.campaignLobbyState = { series };
        let payload = null;
        context.modal = {
            showRunsModal: vi.fn((...args) => { payload = args[4]; }),
            updateModalScoreboardSnapshot: vi.fn(),
            isRunsViewActive: () => true,
            matchesModalScoreboardContext: ({ challengeId }) => challengeId === payload?.scoreboardChallengeId,
        };
        return { context, payload: () => payload };
    }

    function aggregateBody(seriesId, extra = {}) {
        return {
            seriesId,
            finalStageId: getCampaignFinalStage(seriesId).raceId,
            ready: true,
            totalCount: 2,
            topRows: [{ rank: 1, displayName: 'Rival', bestTime: 100 }],
            ...extra,
        };
    }

    it('opens the Campaign leaderboard of a series, with the series names on the rail', async () => {
        getCampaignAggregate.mockReset();
        getCampaignAggregate.mockResolvedValueOnce({ ok: true, body: aggregateBody('numbered-v1') });
        const { context } = standingsContext([{ id: 'numbered-v1', finished: true }]);

        await context.openCampaignSeriesStandings();

        const [, , , returnMode, options] = context.modal.showRunsModal.mock.calls[0];
        expect(returnMode).toBe('close');
        expect(options).toMatchObject({
            scoreboardMode: 'campaign-aggregate',
            scoreboardChallengeId: 'numbered-v1',
            scoreboardTitle: 'Numbers',
            scoreboardSnapshot: { isLoading: true },
            selectedLeaderboardDayId: 'numbered-v1',
            leaderboardRailNamed: true,
            leaderboardDayOptions: [expect.objectContaining({ challengeId: 'numbered-v1', dayNumberLabel: 'Numbers' })],
        });
        expect(getCampaignAggregate).toHaveBeenCalledWith('numbered-v1');
        expect(context.modal.updateModalScoreboardSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ totalCount: 2 }),
        );
    });

    it('shows the board it loaded before at once, and refreshes it once each time it opens', async () => {
        getCampaignAggregate.mockReset();
        getCampaignAggregate.mockResolvedValue({ ok: true, body: aggregateBody('numbered-v1') });
        const { context, payload } = standingsContext([{ id: 'numbered-v1', finished: true }]);

        await context.openCampaignSeriesStandings();
        payload().onClose();
        await context.openCampaignSeriesStandings();

        expect(context.modal.showRunsModal.mock.calls[1][4].scoreboardSnapshot)
            .toMatchObject({ totalCount: 2, isRefreshing: true });
        expect(getCampaignAggregate).toHaveBeenCalledTimes(2);

        // The rail goes back to a board that this opening already refreshed.
        payload().onSelectLeaderboardDay('numbered-v1');
        await Promise.resolve();
        expect(context.modal.showRunsModal.mock.calls[2][4].scoreboardSnapshot)
            .toMatchObject({ totalCount: 2 });
        expect(context.modal.showRunsModal.mock.calls[2][4].scoreboardSnapshot.isRefreshing).toBeUndefined();
        expect(getCampaignAggregate).toHaveBeenCalledTimes(2);
    });

    it('waits while the server fills the Campaign leaderboard, and stops when it closes', async () => {
        vi.useFakeTimers();
        getCampaignAggregate.mockReset();
        getCampaignAggregate.mockResolvedValue({ ok: true, body: aggregateBody('numbered-v1', { ready: false }) });
        const { context, payload } = standingsContext([{ id: 'numbered-v1', finished: true }]);

        await context.openCampaignSeriesStandings('numbered-v1');
        expect(context.modal.updateModalScoreboardSnapshot).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(getCampaignAggregate).toHaveBeenCalledTimes(2);

        payload().onClose();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getCampaignAggregate).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('opens no Campaign leaderboard while no series is finished', async () => {
        getCampaignAggregate.mockReset();
        const context = createContext();
        context.campaignLobbyState = { series: [{ id: 'numbered-v1', finished: false }] };
        context.modal = { showRunsModal: vi.fn() };

        await context.openCampaignSeriesStandings();

        expect(context.modal.showRunsModal).not.toHaveBeenCalled();
        expect(getCampaignAggregate).not.toHaveBeenCalled();
    });

    it('opens the Campaign leaderboard from Standings on the series screen, and stage standings on the stages screen', async () => {
        const { modeRouterEngineMethods: modeEngineMethods } = await import('../game/modes/engine-methods.js');
        const context = {
            campaignLobbyView: 'series',
            openCampaignSeriesStandings: vi.fn(),
            openCampaignStandings: vi.fn(),
            campaignCarousel: { getSelectedChallenge: () => ({ id: 'stage-1' }) },
        };
        modeEngineMethods.openVisibleLobbyStandings.call(context, 'campaign');
        expect(context.openCampaignSeriesStandings).toHaveBeenCalledTimes(1);
        expect(context.openCampaignStandings).not.toHaveBeenCalled();

        context.campaignLobbyView = 'stages';
        modeEngineMethods.openVisibleLobbyStandings.call(context, 'campaign');
        expect(context.openCampaignStandings).toHaveBeenCalledWith({ id: 'stage-1' }, { returnMode: 'close' });
    });

    it('shows Standings on the series screen only once a series is finished', () => {
        const lobby = mountLobby({});
        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series: [{ ...NUMBERS, finished: false }] });
        expect(document.body.dataset.campaignSeriesStandings).toBeUndefined();
        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series: [{ ...NUMBERS, finished: true }] });
        expect(document.body.dataset.campaignSeriesStandings).toBe('true');
        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [{ ...NUMBERS, finished: true }] });
        expect(document.body.dataset.campaignSeriesStandings).toBeUndefined();
    });

    it('hides the series choice, and goes Home on Escape', async () => {
        const onBack = vi.fn();
        const onBackToCampaignSeries = vi.fn();
        const lobby = mountLobby({ onBack, onBackToCampaignSeries });

        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [NUMBERS] });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(document.getElementById('lobby-switch-campaign-btn').hasAttribute('aria-haspopup')).toBe(false);
        expect(document.getElementById('campaign-series-list').hidden).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onBackToCampaignSeries).not.toHaveBeenCalled();
        expect(onBack).toHaveBeenCalledWith('campaign');
    });
});
