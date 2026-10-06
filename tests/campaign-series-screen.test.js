// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas; the pictures are drawn by the carousel code, tested elsewhere.
// Only Numbers is live from the app data. These tests need a second live
// series, as if the Creator had made it live.
vi.mock('../game/campaign/series-rules.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isAppCampaignSeriesLive: (series) => ['numbered-v1', 'dirt-v1'].includes(series?.id),
}));
vi.mock('../game/ui/track-carousel.js', () => ({
    renderTrackPreviewCanvas: vi.fn(),
    trackPreviewPixelScale: () => 1,
}));
// Mini Rally is held back from players; these tests need it live.
vi.mock('../game/track/live-grounds.js', () => import('./helpers/live-grounds-with-dirt.js'));
import { buildCampaignSeriesRows, renderCampaignSeriesList } from '../game/lobby/campaign-series-screen.js';
import { LobbyUi } from '../game/lobby/ui.js';
import { clearStoredSeriesForTests, registerStoredSeries } from '../game/campaign/stored-series.js';

afterEach(() => clearStoredSeriesForTests());

describe('Campaign series screen', () => {
    it('lists every series on a live ground with its ground, stage count and medals', () => {
        const rows = buildCampaignSeriesRows({
            seriesId: 'numbered-v1',
            series: [{ id: 'numbered-v1', medalCount: 23, stageCount: 17, finished: false }],
        });
        expect(rows.map((row) => [row.name, row.infoParts])).toEqual([
            ['Numbers', ['Street · 17 stages', '23/68 medals']],
            ['Mini Rally', ['Dirt · 10 stages', '0/40 medals']],
        ]);
        expect(rows[0].current).toBe(true);
    });

    it('pictures the first stage, or a track of the ground while a series has no stages', () => {
        const rows = buildCampaignSeriesRows({});
        expect(rows.map((row) => row.previewTrackKey))
            .toEqual(['numberZero', 'countryRoad']);
    });

    it('shows mixed published stages using actual surfaces and the first stage picture', () => {
        registerStoredSeries([{
            id: 'mixed-v1', name: 'Mixed Races', ground: 'snow', grounds: ['dirt', 'tarmac'],
            stages: [
                { trackKey: 'countryRoad', laps: 1, requiredMedals: 0 },
                { trackKey: 'numberZero', laps: 1, requiredMedals: 2 },
            ],
        }]);
        const row = buildCampaignSeriesRows({ series: [{ id: 'mixed-v1', medalCount: 3 }] })
            .find((entry) => entry.id === 'mixed-v1');
        expect(row).toMatchObject({
            previewTrackKey: 'countryRoad', infoParts: ['Mixed · 2 stages', '3/8 medals'],
        });
    });

    it('lists a series made live in the Creator, whatever its stage surfaces', () => {
        registerStoredSeries([{
            id: 'held-v1', name: 'Held Races', ground: 'tarmac', grounds: ['tarmac', 'snow'],
            stages: [
                { trackKey: 'numberZero', laps: 1, requiredMedals: 0 },
                { trackKey: 'snowCircuit', laps: 1, requiredMedals: 2 },
            ],
        }]);
        expect(buildCampaignSeriesRows({}).find((row) => row.id === 'held-v1')?.infoParts)
            .toEqual(['Mixed · 2 stages', '0/8 medals']);
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
        expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
        expect(buttons[0].querySelector('.lobby-mode-action__label').textContent).toBe('Numbers');

        buttons[0].click();
        buttons[1].click();
        expect(onChoose).toHaveBeenCalledTimes(2);
        expect(onChoose).toHaveBeenNthCalledWith(1, 'numbered-v1');
        expect(onChoose).toHaveBeenNthCalledWith(2, 'dirt-v1');

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

    it('keeps Campaign as the normal series-screen action without a dropdown', () => {
        const onSelectCampaign = vi.fn();
        const lobby = mountLobby({ onSelectCampaign });
        const series = [
            { id: 'numbered-v1', name: 'Numbers', stageCount: 17, medalCount: 0 },
            { id: 'dirt-v1', name: 'Mini Rally', stageCount: 10, medalCount: 0 },
        ];
        const button = document.getElementById('lobby-switch-campaign-btn');
        for (const state of [
            { view: 'stages', seriesId: 'numbered-v1', series },
            { view: 'stages', seriesId: 'numbered-v1', series: [series[0]] },
            { view: 'series', seriesId: 'numbered-v1', series },
        ]) {
            lobby.showCampaign(state);
            button.click();
            expect(button.hasAttribute('aria-haspopup')).toBe(false);
            expect(document.getElementById('campaign-series-btn')).toBeNull();
            expect(document.getElementById('campaign-series-menu')).toBeNull();
        }
        expect(onSelectCampaign).toHaveBeenCalledTimes(3);
        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series });
        lobby.setCampaignSelectedStage({ trackName: 'Number Zero', laps: 2, unlocked: true });
        const selection = document.querySelector('[data-lobby-mode-selection]');
        expect(selection.hidden).toBe(false);
        expect(selection.textContent).toContain('Number Zero');
        expect(selection.textContent).toContain('2 Laps');
        lobby.showDaily({});
        button.click();
        expect(onSelectCampaign).toHaveBeenCalledTimes(4);
    });

    it('shows the series list and hides the stages and Start Race in the series view', () => {
        const lobby = mountLobby({});
        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series: [] });
        expect(document.getElementById('campaign-series-list').hidden).toBe(false);
        expect(document.getElementById('campaign-carousel').hidden).toBe(true);
        expect(document.getElementById('campaign-primary-btn').closest('.lobby-primary-row').hidden).toBe(true);
        expect(document.body.dataset.campaignView).toBe('series');
        expect(document.getElementById('lobby-switch-campaign-btn').hasAttribute('aria-haspopup')).toBe(false);

        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [] });
        expect(document.getElementById('campaign-series-list').hidden).toBe(true);
        expect(document.getElementById('campaign-carousel').hidden).toBe(false);
        expect(document.body.dataset.campaignView).toBe('stages');
    });

    it('shows the selected series name and restores Campaign on the series list and Daily', () => {
        const lobby = mountLobby({});
        const series = [
            { id: 'numbered-v1', name: 'Numbers', stageCount: 17, medalCount: 0 },
            { id: 'dirt-v1', name: 'A very long Campaign series name', stageCount: 10, medalCount: 0 },
        ];
        const button = document.getElementById('lobby-switch-campaign-btn');
        const label = button.querySelector('.lobby-mode-switch__label');
        lobby.showCampaign({ view: 'series', seriesId: 'numbered-v1', series });
        expect(label.textContent).toBe('Campaign');
        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series });
        expect(label.textContent).toBe('Numbers');
        lobby.showCampaign({ view: 'stages', seriesId: 'dirt-v1', series });
        expect(label.textContent).toBe('A very long Campaign series name');
        expect(button.title).toBe(label.textContent);
        lobby.showCampaign({ view: 'series', seriesId: 'dirt-v1', series });
        expect(label.textContent).toBe('Campaign');
        lobby.showDaily();
        expect(label.textContent).toBe('Campaign');
        lobby.showCampaign({ view: 'stages', seriesId: 'numbered-v1', series: [] });
        expect(label.textContent).toBe('Numbers');
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
