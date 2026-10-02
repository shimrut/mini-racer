import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCampaignBootstrap = vi.fn();

// Two live series: Numbers and a 10-stage test series.
vi.mock('../game/campaign/series.json', async () => {
    const { readFileSync } = await import('node:fs');
    const real = JSON.parse(readFileSync(new URL('../game/campaign/series.json', import.meta.url), 'utf8'));
    const trackKeys = [
        'circuit', 'sunlitTemple', 'albertGardens', 'kettleRun', 'twinRise',
        'templeStraight', 'speedAltar', 'mistfallCircuit', 'doubleTrouble', 'sharkBite',
    ];
    return {
        default: {
            series: [
                real.series.find((series) => series.id === 'numbered-v1'),
                {
                    id: 'test-v1',
                    name: 'Test',
                    ground: 'tarmac',
                    stages: trackKeys.map((trackKey, index) => ({ trackKey, laps: 1, requiredMedals: index * 2 })),
                },
            ],
        },
    };
});
vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getCampaignBootstrap,
}));

const { campaignEngineMethods } = await import('../game/campaign/engine-methods.js');

function createContext() {
    return {
        status: 'ready',
        currentChallengeRun: null,
        hasAnyData: true,
        isReturningPlayer: false,
        activeRaceMode: 'campaign',
        campaignBootstrap: null,
        campaignLobbyState: null,
        _campaignBootstrapReady: false,
        _campaignBootstrapPromise: null,
        _campaignBootstrapRequestId: 0,
        selectedCampaignStageId: 'numbered-v1-04',
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

describe('choosing a Campaign series', () => {
    beforeEach(() => {
        getCampaignBootstrap.mockReset();
        getCampaignBootstrap.mockImplementation(async ({ seriesId }) => ({
            availability: 'available',
            authoritative: true,
            campaignId: seriesId,
            ranked: true,
            signedIn: false,
            stages: [],
            progress: { resultsByRaceId: {}, unlockedRaceIds: [], complete: false },
        }));
        globalThis.localStorage?.clear?.();
    });

    it('paints the stages after definitions resolve and asks the server for that series', async () => {
        const context = createContext();
        await context.selectCampaignSeries('test-v1');

        expect(context.selectedCampaignStageId).toBeNull();
        const painted = context.lobbyUi.showCampaign.mock.calls[0][0];
        expect(painted.seriesId).toBe('test-v1');
        expect(painted.stages.map((stage) => stage.id)).toHaveLength(10);
        expect(painted.stages[0].id).toBe('test-v1-00');
        expect(painted.series.map((series) => series.id)).toEqual(['numbered-v1', 'test-v1']);

        await context._campaignBootstrapPromise;
        expect(getCampaignBootstrap).toHaveBeenCalledWith({ seriesId: 'test-v1' });
    });

    it('ignores the series on screen and an unknown series', () => {
        const context = createContext();
        context.selectCampaignSeries('numbered-v1');
        context.selectCampaignSeries('dirt-v1');
        expect(context.lobbyUi.showCampaign).not.toHaveBeenCalled();
        expect(getCampaignBootstrap).not.toHaveBeenCalled();
    });

    it('shows the series view when the Campaign opens, and the stages after a race', () => {
        const context = createContext();
        context.showCampaignLobby({ view: 'series', refresh: false });
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('series');

        context.showCampaignLobby({ refresh: false });
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('stages');
    });

    it('opens the stages of a series row, and goes back to the series', async () => {
        const context = createContext();
        context.showCampaignLobby({ view: 'series', refresh: false });

        await context.openCampaignSeries('test-v1');
        const opened = context.lobbyUi.showCampaign.mock.calls.at(-1)[0];
        expect(opened.view).toBe('stages');
        expect(opened.seriesId).toBe('test-v1');
        await context._campaignBootstrapPromise;
        expect(getCampaignBootstrap).toHaveBeenCalledWith({ seriesId: 'test-v1' });

        context.backToCampaignSeries();
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0].view).toBe('series');

        context.openCampaignSeries('test-v1');
        expect(context.lobbyUi.showCampaign.mock.calls.at(-1)[0]).toMatchObject({
            view: 'stages',
            seriesId: 'test-v1',
        });
    });
});
