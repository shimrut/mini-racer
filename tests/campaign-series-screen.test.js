// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// jsdom has no canvas; the pictures are drawn by the carousel code, tested elsewhere.
vi.mock('../game/ui/track-carousel.js', () => ({
    renderTrackPreviewCanvas: vi.fn(),
    trackPreviewPixelScale: () => 1,
}));
import { buildCampaignSeriesRows, renderCampaignSeriesList } from '../game/lobby/campaign-series-screen.js';
import { LobbyUi } from '../game/lobby/ui.js';

describe('Campaign series screen', () => {
    it('lists every series, and marks a series with fewer than 2 stages Coming soon', () => {
        const rows = buildCampaignSeriesRows({
            seriesId: 'numbered-v1',
            series: [{ id: 'numbered-v1', medalCount: 23, stageCount: 16, finished: false }],
        });
        expect(rows.map((row) => [row.name, row.comingSoon, row.infoParts])).toEqual([
            ['Numbers', false, ['Tarmac · 16 stages', '23/64 medals']],
            ['Mini Rally', true, ['Dirt', 'Coming soon']],
            ['Sliders', true, ['Snow', 'Coming soon']],
            ['Formula Mini', true, ['Grip', 'Coming soon']],
        ]);
        expect(rows[0].current).toBe(true);
    });

    it('pictures the first stage, or a track of the ground while a series has no stages', () => {
        const rows = buildCampaignSeriesRows({});
        expect(rows.map((row) => row.previewTrackKey))
            .toEqual(['numberZero', 'countryRoad', 'snowCircuit', 'gripCircuit']);
    });

    it('shows medals in gold for a finished series', () => {
        const rows = buildCampaignSeriesRows({
            series: [{ id: 'numbered-v1', medalCount: 40, stageCount: 16, finished: true }],
        });
        expect(rows[0].finished).toBe(true);
    });

    it('opens only a live series, and keeps its rows when nothing changed', () => {
        const container = document.createElement('div');
        const onChoose = vi.fn();
        const rows = buildCampaignSeriesRows({ seriesId: 'numbered-v1', series: [] });
        renderCampaignSeriesList(container, rows, { onChoose });
        const buttons = [...container.querySelectorAll('button')];
        expect(buttons.map((button) => button.disabled)).toEqual([false, true, true, true]);
        expect(buttons[0].querySelector('.lobby-mode-action__label').textContent).toBe('Numbers');

        buttons[0].click();
        buttons[1].click();
        expect(onChoose).toHaveBeenCalledTimes(1);
        expect(onChoose).toHaveBeenCalledWith('numbered-v1');

        renderCampaignSeriesList(container, rows, { onChoose });
        expect(container.querySelector('button')).toBe(buttons[0]);
    });
});

describe('Campaign series screen in the lobby', () => {
    function mountLobby(handlers) {
        const html = readFileSync(join(process.cwd(), 'pages/game.html'), 'utf8');
        document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
        globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        const lobby = new LobbyUi(handlers);
        lobby.bind();
        return lobby;
    }

    function escape() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }

    it('shows the series list and hides the stages and Start Race in the series view', () => {
        const lobby = mountLobby({});
        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series: [] });
        expect(document.getElementById('campaign-series-list').hidden).toBe(false);
        expect(document.getElementById('campaign-carousel').hidden).toBe(true);
        expect(document.getElementById('campaign-primary-btn').closest('.lobby-primary-row').hidden).toBe(true);
        expect(document.body.dataset.campaignView).toBe('series');
        expect(document.querySelector('[data-campaign-series]').hidden).toBe(true);

        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [] });
        expect(document.getElementById('campaign-series-list').hidden).toBe(true);
        expect(document.getElementById('campaign-carousel').hidden).toBe(false);
        expect(document.body.dataset.campaignView).toBe('stages');
    });

    it('goes from the stages back to the series on Escape, and from the series to Home', async () => {
        const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
        const onBack = vi.fn();
        const onBackToCampaignSeries = vi.fn();
        const lobby = mountLobby({ onBack, onBackToCampaignSeries });

        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [] });
        await settle();
        escape();
        expect(onBackToCampaignSeries).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();

        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series: [] });
        await settle();
        escape();
        expect(onBack).toHaveBeenCalledWith('campaign');
    });
});
