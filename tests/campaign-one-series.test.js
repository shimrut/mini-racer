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
vi.mock('../game/campaign/service.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getCampaignBootstrap: vi.fn(),
}));

const { campaignHasSeriesChoice } = await import('../game/campaign/manifest.js');
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

    it('hides the series choice, and goes Home on Escape', async () => {
        const onBack = vi.fn();
        const onBackToCampaignSeries = vi.fn();
        const lobby = mountLobby({ onBack, onBackToCampaignSeries });

        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [NUMBERS] });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(document.querySelector('[data-campaign-series]').hidden).toBe(true);
        expect(document.getElementById('campaign-series-list').hidden).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onBackToCampaignSeries).not.toHaveBeenCalled();
        expect(onBack).toHaveBeenCalledWith('campaign');
    });
});
