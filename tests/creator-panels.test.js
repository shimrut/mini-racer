// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatorPanels } from '../tools/mapmaker/creator-panels.js';

function jsonResponse(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

const dailyView = {
    schedule: { keys: ['circuit', 'sunlitTemple', 'royalPlateau'], revision: 3, source: 'stored' },
    latestTrackKey: 'sunlitTemple',
    latestChallengeDate: '2026-09-30',
    tracks: [
        { key: 'circuit', name: 'Classic Circuit', source: 'app', played: true, ready: true, liveGround: true, series: null },
        { key: 'sunlitTemple', name: 'Sunlit Temple', source: 'app', played: true, ready: true, liveGround: true, series: null },
        { key: 'royalPlateau', name: 'Royal Plateau', source: 'app', played: false, ready: true, liveGround: true, series: null },
        { key: 'nightLoop', name: 'Night Loop', source: 'creator', played: false, ready: true, liveGround: true, series: null },
        { key: 'halfLoop', name: 'Half Loop', source: 'creator', played: false, ready: false, liveGround: true, series: null },
        { key: 'numberOne', name: 'Number One', source: 'app', played: true, ready: true, liveGround: true, series: 'numbered-v1' },
    ],
};

function setupDom() {
    document.body.innerHTML = `
        <section id="creator-daily-view"></section>
        <section id="creator-series-view"></section>
        <section id="creator-copy-view"></section>`;
}

function buttonsByText(root, text) {
    return [...root.querySelectorAll('button')].filter((button) => button.textContent === text);
}

beforeEach(() => {
    setupDom();
    vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => vi.unstubAllGlobals());

describe('Creator Daily list', () => {
    it('adds a ready track as the next Daily, then saves the list from its revision', async () => {
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'PUT') {
                const body = JSON.parse(options.body);
                return jsonResponse({ ...dailyView, schedule: { ...dailyView.schedule, keys: body.keys, revision: 4 } });
            }
            return jsonResponse(dailyView);
        });
        vi.stubGlobal('fetch', fetchMock);
        const setStatus = vi.fn();
        const panels = new CreatorPanels({ onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus });
        await panels.loadDaily();

        const root = document.getElementById('creator-daily-view');
        const options = [...root.querySelectorAll('select option')].map((option) => option.value);
        expect(options).toEqual(['', 'nightLoop']);
        root.querySelector('select').value = 'nightLoop';
        buttonsByText(root, 'Add as next Daily')[0].click();
        expect(panels.dailyKeys).toEqual(['circuit', 'sunlitTemple', 'nightLoop', 'royalPlateau']);

        await panels.saveDaily();
        const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
        expect(put[0]).toBe('/api/creator/daily');
        expect(JSON.parse(put[1].body)).toEqual({
            keys: ['circuit', 'sunlitTemple', 'nightLoop', 'royalPlateau'],
            baseRevision: 3,
        });
        expect(panels.dailyDirty).toBe(false);
        expect(setStatus).toHaveBeenCalledWith('Saved the Daily list.');
    });

    it('keeps the latest Daily in the list', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(dailyView)));
        const panels = new CreatorPanels({ onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadDaily();
        const removeButtons = buttonsByText(document.getElementById('creator-daily-view'), '✕');
        expect(removeButtons.map((button) => button.disabled)).toEqual([false, true, false]);
    });
});

describe('Creator Campaign Planner', () => {
    const seriesView = {
        series: [{
            id: 'night-v1',
            name: 'Night Races',
            ground: 'tarmac',
            stages: [{ trackKey: 'nightLoop', laps: 1, requiredMedals: 0 }],
            status: 'published',
            publishedStageCount: 1,
            revision: 5,
        }],
        appSeries: [{ id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', stages: [], live: true }],
        tracks: [
            { key: 'nightLoop', name: 'Night Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'night-v1' },
            { key: 'dayLoop', name: 'Day Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: null },
            { key: 'snowLoop', name: 'Snow Loop', ground: 'snow', source: 'creator', ready: true, usedBy: null },
            { key: 'numberOne', name: 'Number One', ground: 'tarmac', source: 'app', ready: true, usedBy: 'numbered-v1' },
            { key: 'dailyLoop', name: 'Daily Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'daily' },
        ],
    };

    it('adds a free track on the same ground after the live stages, and saves the series', async () => {
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'PUT') return jsonResponse({ series: { ...seriesView.series[0], revision: 6 } });
            return jsonResponse(seriesView);
        });
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');

        const root = document.getElementById('creator-series-view');
        const addSelect = root.querySelector('.creator-adder select');
        expect([...addSelect.options].map((option) => option.value)).toEqual(['', 'dayLoop']);
        addSelect.value = 'dayLoop';
        buttonsByText(root, 'Add stage')[0].click();
        expect(panels.seriesDraft.stages.at(-1)).toEqual({ trackKey: 'dayLoop', laps: 1, requiredMedals: 2 });
        expect(buttonsByText(root, '✕')[0].disabled).toBe(true);

        await panels.saveSeries();
        const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
        expect(put[0]).toBe('/api/creator/series/night-v1');
        expect(JSON.parse(put[1].body)).toMatchObject({ baseRevision: 5, stages: [{ trackKey: 'nightLoop' }, { trackKey: 'dayLoop' }] });
    });
});

describe('Creator copy screen', () => {
    it('shows what a copy would do, and runs it after a confirmation', async () => {
        const preview = { copied: ['babylonRace'], played: 90, dailyList: 'would-copy', extra: { series: { copied: ['dirt-v1'] } } };
        const fetchMock = vi.fn(async (url, options) => (options?.method === 'POST'
            ? jsonResponse({ report: { ...preview, dryRun: false, dailyList: 'copied', failed: [] } })
            : jsonResponse({ report: null, preview })));
        vi.stubGlobal('fetch', fetchMock);
        const onTracksChanged = vi.fn();
        const panels = new CreatorPanels({ onOpenTrack: vi.fn(), onTracksChanged, setStatus: vi.fn() });
        await panels.loadCopy();
        const root = document.getElementById('creator-copy-view');
        expect(root.textContent).toContain('1 unplayed tracks to copy.');
        expect(root.textContent).toContain('1 hidden series to copy as drafts.');
        await panels.runCopy();
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
        expect(onTracksChanged).toHaveBeenCalled();
    });
});
