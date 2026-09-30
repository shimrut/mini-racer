// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatorPanels } from '../tools/mapmaker/creator-panels.js';

function jsonResponse(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
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

// The page dialog answers yes. Reddit's frame ignores window.confirm and
// answers no, so a panel that still used it would stop.
const confirm = vi.fn(async () => true);

beforeEach(() => {
    setupDom();
    confirm.mockClear();
    confirm.mockImplementation(async () => true);
    vi.stubGlobal('confirm', vi.fn(() => false));
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
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus });
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
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadDaily();
        const removeButtons = buttonsByText(document.getElementById('creator-daily-view'), '✕');
        expect(removeButtons.map((button) => button.disabled)).toEqual([false, true, false]);
    });

    it('retains reordered entries during Save and uses the acknowledged revision for the next Save', async () => {
        const pending = deferred();
        const fetchMock = vi.fn(async (_url, options) => options?.method === 'PUT'
            ? pending.promise : jsonResponse(dailyView));
        vi.stubGlobal('fetch', fetchMock);
        const setStatus = vi.fn();
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus });
        await panels.loadDaily();
        panels.moveDaily(2, 1);
        const sent = [...panels.dailyKeys];
        const saving = panels.saveDaily();
        panels.moveDaily(1, 0);
        const edited = [...panels.dailyKeys];
        expect(panels.hasUnsavedChanges()).toBe(true);
        pending.resolve(jsonResponse({ ...dailyView, schedule: { keys: sent, revision: 4 } }));
        await saving;
        expect(panels.dailyKeys).toEqual(edited);
        expect(panels.dailyDirty).toBe(true);
        expect(panels.daily.schedule.revision).toBe(4);
        expect(setStatus).toHaveBeenLastCalledWith(expect.stringContaining('still unsaved'));
        fetchMock.mockImplementation(async (_url, options) => {
            const body = JSON.parse(options.body);
            expect(body).toEqual({ keys: edited, baseRevision: 4 });
            return jsonResponse({ ...dailyView, schedule: { keys: body.keys, revision: 5 } });
        });
        await panels.saveDaily();
        expect(panels.dailyDirty).toBe(false);
    });

    it('deduplicates pending reads and never applies a read over newer Daily edits', async () => {
        const pending = deferred();
        const fetchMock = vi.fn(async () => jsonResponse(dailyView));
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadDaily();
        fetchMock.mockImplementation(() => pending.promise);
        const loading = panels.loadDaily();
        await panels.loadDaily();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        panels.moveDaily(2, 0);
        const edited = [...panels.dailyKeys];
        pending.resolve(jsonResponse(dailyView));
        await loading;
        expect(panels.dailyKeys).toEqual(edited);
        expect(panels.dailyDirty).toBe(true);
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
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
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

    it('keeps newer series edits and acknowledges only the sent snapshot', async () => {
        const pending = deferred();
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'PUT') return pending.promise;
            if (String(url).includes('/api/creator/daily')) return jsonResponse(dailyView);
            if (String(url).includes('/api/creator/migration')) return jsonResponse({ report: null, preview: { copied: [] } });
            return jsonResponse(structuredClone(seriesView));
        });
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        panels.seriesDraft.name = 'Sent name';
        panels.seriesDirty = true;
        const saving = panels.saveSeries();
        panels.seriesDraft.name = 'Later name';
        panels.seriesDraft.stages.push({ trackKey: 'dayLoop', laps: 2, requiredMedals: 2 });
        pending.resolve(jsonResponse({ series: { ...seriesView.series[0], name: 'Sent name', revision: 6 } }));
        await saving;
        expect(panels.seriesDraft.name).toBe('Later name');
        expect(panels.seriesDraft.stages.at(-1).laps).toBe(2);
        expect(panels.seriesDraft.revision).toBe(6);
        expect(panels.seriesDirty).toBe(true);
        expect(JSON.parse(fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body).stages).toHaveLength(1);
        // The save reloads the Daily list and the copy, but never the Campaign over newer edits.
        expect(fetchMock.mock.calls.filter(([url, options]) => options?.method === 'GET'
            && String(url).includes('/api/creator/series'))).toHaveLength(1);
    });

    it('does not select the saved series over a different draft selected during Save', async () => {
        const pending = deferred();
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'PUT'
            ? pending.promise : jsonResponse(structuredClone(seriesView))));
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        panels.seriesDirty = true;
        const saving = panels.saveSeries();
        await panels.startNewSeries();
        panels.seriesDraft.name = 'Another series';
        pending.resolve(jsonResponse({ series: { ...seriesView.series[0], revision: 6 } }));
        await saving;
        expect(panels.selectedSeriesId).toBeNull();
        expect(panels.seriesDraft.name).toBe('Another series');
        expect(panels.seriesDirty).toBe(true);
        expect(panels.seriesView.series.find((series) => series.id === 'night-v1').revision).toBe(6);
    });

    it('deduplicates reads and retains a draft selected while a read is pending', async () => {
        const pending = deferred();
        const fetchMock = vi.fn(async () => jsonResponse(structuredClone(seriesView)));
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        fetchMock.mockImplementation(() => pending.promise);
        const loading = panels.loadSeries();
        await panels.loadSeries();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        panels.startNewSeries();
        panels.seriesDraft.name = 'Keep this draft';
        pending.resolve(jsonResponse(structuredClone(seriesView)));
        await loading;
        expect(panels.seriesDraft.name).toBe('Keep this draft');
        expect(panels.seriesDirty).toBe(true);
    });

    it('offers only completed Campaign candidates and disables editing during publication', async () => {
        const pending = deferred();
        const view = structuredClone(seriesView);
        view.series[0].publishedStageCount = 0;
        view.series[0].status = 'draft';
        view.tracks.push({ key: 'unfinishedLoop', name: 'Unfinished', ground: 'tarmac', ready: false });
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'POST'
            ? pending.promise : jsonResponse(view)));
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        const root = document.getElementById('creator-series-view');
        expect([...root.querySelector('.creator-adder select').options].map((option) => option.value)).not.toContain('unfinishedLoop');
        const publishing = panels.publishSeries();
        await vi.waitFor(() => expect(panels.busy).toBe(true));
        expect([...root.querySelectorAll('input, button, select')].every((control) => control.disabled)).toBe(true);
        panels.startNewSeries();
        expect(panels.selectedSeriesId).toBe('night-v1');
        pending.resolve(jsonResponse({ series: { ...seriesView.series[0], revision: 6 } }));
        await publishing;
        expect(panels.busy).toBe(false);
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
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged, setStatus: vi.fn() });
        await panels.loadCopy();
        const root = document.getElementById('creator-copy-view');
        expect(root.textContent).toContain('1 unplayed tracks to copy.');
        expect(root.textContent).toContain('1 hidden series to copy as drafts.');
        await panels.runCopy();
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Copy' }));
        expect(window.confirm).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
        expect(onTracksChanged).toHaveBeenCalled();
    });

    it('sends nothing when the question is cancelled', async () => {
        const preview = { copied: ['babylonRace'], played: 90, dailyList: 'would-copy' };
        const fetchMock = vi.fn(async () => jsonResponse({ report: null, preview }));
        vi.stubGlobal('fetch', fetchMock);
        confirm.mockImplementation(async () => false);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadCopy();
        await panels.runCopy();
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
        expect(panels.busy).toBe(false);
    });

    it('shows the copy running, then its error, on the Copy screen', async () => {
        const preview = { copied: ['babylonRace'], played: 90, dailyList: 'would-copy' };
        const copy = deferred();
        vi.stubGlobal('fetch', vi.fn(async (url, options) => (options?.method === 'POST'
            ? copy.promise
            : jsonResponse({ report: null, preview }))));
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadCopy();
        const root = document.getElementById('creator-copy-view');
        const running = panels.runCopy();
        await vi.waitFor(() => expect(root.textContent).toContain('Copying the unplayed tracks…'));
        copy.resolve(jsonResponse({ error: 'Tracks are being updated. Try again.' }, 503));
        await running;
        expect(root.textContent).toContain('Could not copy: Tracks are being updated. Try again.');
        expect(buttonsByText(root, 'Copy now')[0].disabled).toBe(false);
    });
});

describe('Creator Campaign questions', () => {
    it('asks with the page dialog before a series goes live', async () => {
        const seriesView = {
            series: [{ id: 'night-v1', name: 'Night', ground: 'tarmac', stages: [], status: 'draft', publishedStageCount: 0, revision: 2 }],
            appSeries: [],
            tracks: [],
        };
        const fetchMock = vi.fn(async (url, options) => (options?.method === 'POST'
            ? jsonResponse({ series: { ...seriesView.series[0], status: 'published', revision: 3 } })
            : jsonResponse(seriesView)));
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        await panels.publishSeries();
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Make live' }));
        expect(window.confirm).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
    });
});

describe('Creator tabs keep their data', () => {
    const emptySeriesView = { series: [], appSeries: [], tracks: [] };
    const copyView = { report: null, preview: { copied: [], played: 88, dailyList: 'kept' } };

    function countingFetch({ dailyPut } = {}) {
        const calls = { daily: 0, series: 0, copy: 0 };
        vi.stubGlobal('fetch', vi.fn(async (url, options) => {
            if (String(url).includes('/api/creator/daily')) {
                if (options?.method === 'PUT') {
                    if (dailyPut) await dailyPut;
                    const body = JSON.parse(options.body);
                    return jsonResponse({ ...dailyView, schedule: { ...dailyView.schedule, keys: body.keys, revision: 4 } });
                }
                calls.daily += 1;
                return jsonResponse(dailyView);
            }
            if (String(url).includes('/api/creator/migration')) {
                calls.copy += 1;
                return jsonResponse(copyView);
            }
            calls.series += 1;
            return jsonResponse(emptySeriesView);
        }));
        return calls;
    }

    function openPanels() {
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        panels.receiveViews({ daily: dailyView, seriesView: emptySeriesView, copyView, generation: 0 });
        return panels;
    }

    it('fills every tab from the answers the Creator reads when it opens', () => {
        const calls = countingFetch();
        openPanels();
        expect(calls).toEqual({ daily: 0, series: 0, copy: 0 });
        expect(document.getElementById('creator-daily-view').textContent).toContain('Royal Plateau');
        expect(document.getElementById('creator-copy-view').textContent).toContain('88 played tracks stay in the app.');
    });

    it('reloads every tab at once after a track change, and keeps the earlier data on screen', async () => {
        const calls = countingFetch();
        const panels = openPanels();
        panels.refreshAll();
        expect(calls).toEqual({ daily: 1, series: 1, copy: 1 });
        const root = document.getElementById('creator-daily-view');
        expect(root.textContent).not.toContain('Loading the Daily list…');
        expect(root.textContent).toContain('Royal Plateau');
        await vi.waitFor(() => expect(panels.dailyLoading || panels.seriesLoading || panels.copyLoading).toBe(false));
    });

    it('ignores an answer that started before a save', () => {
        countingFetch();
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        panels.writeGeneration = 2;
        panels.receiveViews({ daily: dailyView, seriesView: emptySeriesView, copyView, generation: 1 });
        expect(panels.daily).toBeNull();
        expect(panels.copyView).toBeNull();
    });

    it('reloads the Campaign and the Copy tab after a Daily save ends', async () => {
        const save = deferred();
        const calls = countingFetch({ dailyPut: save.promise });
        const panels = openPanels();
        panels.dailyKeys = ['circuit', 'sunlitTemple', 'royalPlateau', 'nightLoop'];
        panels.dailyDirty = true;
        const saving = panels.saveDaily();
        panels.refresh('campaign');
        // A reload asked for during the save waits for the save.
        expect(calls.series).toBe(0);
        save.resolve();
        await saving;
        expect(calls).toMatchObject({ series: 1, copy: 1 });
    });
});
