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

    it('adds a free track on another surface after the live stages, and saves the series', async () => {
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'PUT') return jsonResponse({ series: {
                ...seriesView.series[0], ...JSON.parse(options.body), revision: 6,
            } });
            return jsonResponse(structuredClone(seriesView));
        });
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');

        const root = document.getElementById('creator-series-view');
        const addSelect = root.querySelector('.creator-adder select');
        expect([...addSelect.options].map((option) => option.value)).toEqual(['', 'dayLoop', 'snowLoop']);
        expect(root.querySelector('.creator-series-fields select')).toBeNull();
        addSelect.value = 'snowLoop';
        buttonsByText(root, 'Add stage')[0].click();
        expect(panels.seriesDraft.stages.at(-1)).toEqual({ trackKey: 'snowLoop', laps: 1, requiredMedals: 2 });
        expect(buttonsByText(root, '✕')[0].disabled).toBe(true);
        expect(root.querySelector('.creator-series-fields').textContent).toContain('Mixed');
        expect(root.textContent).not.toContain('Other ground');
        expect(root.textContent).not.toContain('held back');

        await panels.saveSeries();
        const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
        expect(put[0]).toBe('/api/creator/series/night-v1');
        expect(JSON.parse(put[1].body)).toMatchObject({ ground: 'tarmac', baseRevision: 5,
            stages: [{ trackKey: 'nightLoop' }, { trackKey: 'snowLoop' }] });
    });

    it('offers every ready free surface and derives the label from the complete draft', async () => {
        const view = structuredClone(seriesView);
        view.series[0].ground = 'snow';
        view.series[0].grounds = ['tarmac'];
        view.series[0].stages.push({ trackKey: 'snowLoop', laps: 1, requiredMedals: 2 });
        view.tracks.push(
            ...['dirt', 'grip', 'water', 'space'].map((ground) => ({
                key: `${ground}Loop`, name: `${ground} Loop`, ground, ready: true, usedBy: null,
            })),
            { key: 'unfinishedSnow', name: 'Unfinished Snow', ground: 'snow', ready: false, usedBy: null },
        );
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(view)));
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('night-v1');
        const root = document.getElementById('creator-series-view');
        expect([...root.querySelector('.creator-adder select').options].map((option) => option.value))
            .toEqual(['', 'dayLoop', 'dirtLoop', 'gripLoop', 'spaceLoop', 'waterLoop']);
        expect(root.querySelector('.creator-series-fields').textContent).toContain('Mixed');
        expect(root.textContent).not.toContain('Other ground');
        expect(root.textContent).not.toContain('held back');
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
        expect(buttonsByText(root, 'Copy unplayed')[0].disabled).toBe(false);
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

describe('Creator copies of played tracks', () => {
    const copyView = {
        report: null,
        preview: { copied: [], played: 88, dailyList: 'kept' },
        playedDailies: { report: null, preview: { copied: ['albertGardens', 'smallSteps'], waiting: ['babylonRace'], alreadyStored: [] } },
        liveCampaign: { report: null, preview: { copied: ['numbered-v1'], tracks: ['numberZero', 'numberOne'], alreadyStored: [] } },
    };

    it('shows each copy with its own button, and disables a copy with nothing left', () => {
        vi.stubGlobal('fetch', vi.fn());
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        panels.receiveViews({ copyView, generation: 0 });
        const root = document.getElementById('creator-copy-view');
        expect(root.textContent).toContain('2 past Daily tracks to copy.');
        expect(root.textContent).toContain('1 wait until players can no longer race their Daily.');
        expect(root.textContent).toContain('1 live series to copy, with 2 stage tracks.');
        expect(buttonsByText(root, 'Copy unplayed')[0].disabled).toBe(true);
        expect(buttonsByText(root, 'Copy played Dailies')[0].disabled).toBe(false);
        expect(buttonsByText(root, 'Copy live Campaign')[0].disabled).toBe(false);
    });

    it('runs the played Daily copy, and shows its error only in its own section', async () => {
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'POST') return jsonResponse({ error: 'The copy is running already. Wait for it to finish.' }, 400);
            return jsonResponse(copyView);
        });
        vi.stubGlobal('fetch', fetchMock);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        panels.receiveViews({ copyView, generation: 0 });
        await panels.runCopy('played-dailies');
        expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')[0]).toContain('/api/creator/migration/played-dailies');
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Copy played Dailies?' }));
        const sections = [...document.querySelectorAll('#creator-copy-view .creator-copy-section')];
        expect(sections[1].textContent).toContain('Could not copy: The copy is running already.');
        expect(sections[0].textContent).not.toContain('Could not copy');
        expect(sections[2].textContent).not.toContain('Could not copy');
    });

    it('runs the live Campaign copy, then reloads the tracks and the other tabs', async () => {
        const report = { dryRun: false, ranAt: '2026-10-01T12:00:00.000Z', ranBy: 'RaceMod', copied: ['numbered-v1'], tracks: ['numberZero', 'numberOne'], alreadyStored: [], failed: [] };
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'POST') return jsonResponse({ report });
            if (String(url).includes('/api/creator/migration')) {
                return jsonResponse({ ...copyView, liveCampaign: { report, preview: { copied: [], tracks: [], alreadyStored: ['numbered-v1'] } } });
            }
            if (String(url).includes('/api/creator/daily')) return jsonResponse(dailyView);
            return jsonResponse({ series: [], appSeries: [], tracks: [] });
        });
        vi.stubGlobal('fetch', fetchMock);
        const onTracksChanged = vi.fn();
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged, setStatus: vi.fn() });
        panels.receiveViews({ copyView, generation: 0 });
        await panels.runCopy('live-campaign');
        expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')[0]).toContain('/api/creator/migration/live-campaign');
        expect(onTracksChanged).toHaveBeenCalled();
        const root = document.getElementById('creator-copy-view');
        expect(root.textContent).toContain('1 series and 2 tracks copied.');
        expect(buttonsByText(root, 'Copy live Campaign')[0].disabled).toBe(true);
        await vi.waitFor(() => expect(panels.dailyLoading || panels.seriesLoading).toBe(false));
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
        expect(document.getElementById('creator-copy-view').textContent).toContain('0 unplayed tracks to copy.');
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

describe('Creator Campaign fields keep typed text', () => {
    const draftView = {
        series: [{
            id: 'day-v1',
            name: 'Day Races',
            ground: 'tarmac',
            stages: [
                { trackKey: 'dayLoop', laps: 1, requiredMedals: 0 },
                { trackKey: 'duskLoop', laps: 1, requiredMedals: 2 },
                { trackKey: 'dawnLoop', laps: 1, requiredMedals: 4 },
            ],
            status: 'draft',
            publishedStageCount: 0,
            revision: 2,
        }],
        appSeries: [],
        tracks: [
            { key: 'dayLoop', name: 'Day Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'day-v1' },
            { key: 'duskLoop', name: 'Dusk Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'day-v1' },
            { key: 'dawnLoop', name: 'Dawn Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'day-v1' },
            { key: 'freeLoop', name: 'Free Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: null },
        ],
    };

    const root = () => document.getElementById('creator-series-view');
    const field = (name) => root().querySelector(`[data-field="${name}"]`);

    function type(input, text) {
        input.focus();
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // A click on Save takes the focus first, so the field sends its change event.
    function leave(input) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
    }

    function server({ hold = false } = {}) {
        const puts = [];
        const pendingPut = deferred();
        let view = structuredClone(draftView);
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'PUT') {
                const body = JSON.parse(options.body);
                puts.push({ url, body });
                const answer = jsonResponse({ series: { ...view.series[0], ...body,
                    id: decodeURIComponent(String(url).split('/').pop()), revision: body.baseRevision + 1 } });
                if (!hold) return answer;
                await pendingPut.promise;
                return answer;
            }
            if (String(url).includes('/api/creator/daily')) return jsonResponse(dailyView);
            if (String(url).includes('/api/creator/migration')) return jsonResponse({ report: null, preview: { copied: [] } });
            return jsonResponse(structuredClone(view));
        });
        vi.stubGlobal('fetch', fetchMock);
        return {
            puts,
            fetchMock,
            releasePut: () => pendingPut.resolve(),
            setView: (next) => { view = next; },
        };
    }

    async function openPanels() {
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadSeries('day-v1');
        return panels;
    }

    it('saves a typed name, key or medal target on the first Save click', async () => {
        const api = server();
        const panels = await openPanels();
        const save = buttonsByText(root(), 'Save')[0];
        expect(save.disabled).toBe(true);
        type(field('series-name'), 'Typed Name');
        type(field('stage-medals:duskLoop'), '3');
        leave(field('stage-medals:duskLoop'));
        expect(save.isConnected).toBe(true);
        expect(save.disabled).toBe(false);
        save.click();
        await vi.waitFor(() => expect(api.puts).toHaveLength(1));
        expect(api.puts[0].body).toMatchObject({ name: 'Typed Name', stages: [{}, { requiredMedals: 3 }, {}] });
        expect(api.puts[0].body.stages[1]).not.toHaveProperty('requiredMedalsText');

        await vi.waitFor(() => expect(panels.busy).toBe(false));
        await panels.startNewSeries();
        type(field('series-name'), 'Fresh Series');
        expect(field('series-id').value).toBe('fresh-series-v1');
        type(field('series-id'), 'my-key');
        type(field('series-name'), 'Fresh Series Two');
        leave(field('series-name'));
        expect(field('series-id').value).toBe('my-key');
        const newSave = buttonsByText(root(), 'Save')[0];
        newSave.click();
        await vi.waitFor(() => expect(api.puts).toHaveLength(2));
        expect(api.puts[1].url).toBe('/api/creator/series/my-key');
    });

    it('keeps a blank medal target blank through a refresh, and keeps the focus', async () => {
        const api = server();
        const panels = await openPanels();
        const medals = field('stage-medals:duskLoop');
        type(medals, '');
        expect(panels.seriesDraft.stages[1].requiredMedals).toBeNull();
        const error = medals.closest('li').querySelector('.creator-row-error');
        expect(error.hidden).toBe(false);

        await panels.loadSeries();
        expect(field('stage-medals:duskLoop')).toBe(medals);
        expect(medals.value).toBe('');
        expect(document.activeElement).toBe(medals);

        // A refresh that changes what the editor shows builds it again.
        const changed = structuredClone(draftView);
        changed.tracks.find((track) => track.key === 'freeLoop').ready = false;
        api.setView(changed);
        await panels.loadSeries();
        const rebuilt = field('stage-medals:duskLoop');
        expect(rebuilt).not.toBe(medals);
        expect(rebuilt.value).toBe('');
        expect(document.activeElement).toBe(rebuilt);
    });

    it('keeps text typed while a read is pending', async () => {
        server();
        const panels = await openPanels();
        const read = deferred();
        const fetchMock = globalThis.fetch;
        globalThis.fetch = vi.fn(async (...args) => {
            await read.promise;
            return fetchMock(...args);
        });
        const loading = panels.loadSeries();
        const name = field('series-name');
        type(name, 'Typed while reading');
        read.resolve();
        await loading;
        expect(field('series-name').value).toBe('Typed while reading');
        expect(document.activeElement).toBe(field('series-name'));
        expect(panels.seriesDirty).toBe(true);
    });

    it('keeps text typed while a save is pending, even when it gives the same number', async () => {
        const api = server({ hold: true });
        const panels = await openPanels();
        type(field('series-name'), 'Sent name');
        type(field('stage-medals:duskLoop'), '3');
        leave(field('stage-medals:duskLoop'));
        buttonsByText(root(), 'Save')[0].click();
        await vi.waitFor(() => expect(api.puts).toHaveLength(1));
        type(field('series-name'), 'Sent name and more');
        type(field('stage-medals:duskLoop'), '03');
        api.releasePut();
        await vi.waitFor(() => expect(panels.busy).toBe(false));
        expect(panels.seriesDirty).toBe(true);
        expect(field('series-name').value).toBe('Sent name and more');
        expect(field('stage-medals:duskLoop').value).toBe('03');
        expect(document.activeElement).toBe(field('stage-medals:duskLoop'));
        expect(panels.seriesDraft.revision).toBe(3);
    });

    it('acknowledges an unchanged save without replacing the draft or the fields', async () => {
        const api = server({ hold: true });
        const panels = await openPanels();
        const draft = panels.seriesDraft;
        type(field('stage-medals:duskLoop'), '3');
        leave(field('stage-medals:duskLoop'));
        const medals = field('stage-medals:duskLoop');
        buttonsByText(root(), 'Save')[0].click();
        await vi.waitFor(() => expect(api.puts).toHaveLength(1));
        api.releasePut();
        await vi.waitFor(() => expect(panels.busy).toBe(false));
        expect(panels.seriesDirty).toBe(false);
        expect(panels.seriesDraft).toBe(draft);
        expect(field('stage-medals:duskLoop')).toBe(medals);
        expect(draft.stages[1]).not.toHaveProperty('requiredMedalsText');
        type(medals, '5');
        expect(panels.seriesDraft.stages[1].requiredMedals).toBe(5);
    });

    it('gives the focus back to the same stage after a reorder', async () => {
        server();
        const panels = await openPanels();
        type(field('stage-medals:duskLoop'), '3');
        const [first, dusk, dawn] = panels.seriesDraft.stages;
        panels.seriesDraft.stages = [first, dawn, dusk];
        panels.renderSeries();
        expect(document.activeElement?.dataset.field).toBe('stage-medals:duskLoop');
        expect(document.activeElement.value).toBe('3');
    });

    it('shows the server values again when the series is opened again', async () => {
        server();
        const panels = await openPanels();
        type(field('stage-medals:duskLoop'), '');
        await panels.selectSeries('day-v1', { force: true });
        expect(field('stage-medals:duskLoop').value).toBe('2');
        expect(panels.seriesDraft.stages[1]).not.toHaveProperty('requiredMedalsText');
    });

    it('keeps a key that a save is using while the name changes', async () => {
        const api = server({ hold: true });
        const panels = await openPanels();
        await panels.startNewSeries();
        type(field('series-name'), 'Fresh Series');
        leave(field('series-name'));
        buttonsByText(root(), 'Save')[0].click();
        await vi.waitFor(() => expect(api.puts).toHaveLength(1));
        type(field('series-name'), 'Fresh Series Renamed');
        expect(panels.seriesDraft.id).toBe('fresh-series-v1');
        expect(field('series-id').disabled).toBe(true);
        api.releasePut();
        await vi.waitFor(() => expect(panels.busy).toBe(false));
        expect(panels.seriesDraft.id).toBe('fresh-series-v1');
    });
});

describe('Creator Daily list and series conflicts', () => {
    // The Daily list and series routes, with a revision check as the server has.
    function panelServer() {
        const server = {
            daily: structuredClone(dailyView),
            series: [{
                id: 'day-v1', name: 'Day Races', ground: 'tarmac',
                stages: [{ trackKey: 'nightLoop', laps: 1, requiredMedals: 0 }],
                status: 'draft', publishedStageCount: 0, revision: 2, updatedBy: 'OtherMod',
            }],
            puts: [],
            dropNextAnswer: false,
        };
        const seriesView = () => ({
            series: structuredClone(server.series),
            appSeries: [{ id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', stages: [], live: true }],
            tracks: [
                { key: 'nightLoop', name: 'Night Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: 'day-v1' },
                { key: 'dayLoop', name: 'Day Loop', ground: 'tarmac', source: 'creator', ready: true, usedBy: null },
            ],
        });
        vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
            const path = String(url);
            if (options.method === 'PUT' && path === '/api/creator/daily') {
                const body = JSON.parse(options.body);
                server.puts.push({ path, body });
                if (body.baseRevision !== server.daily.schedule.revision) {
                    return jsonResponse({ error: 'The Daily list changed on another device.' }, 409);
                }
                server.daily = { ...server.daily, schedule: { ...server.daily.schedule, keys: body.keys,
                    revision: server.daily.schedule.revision + 1 } };
                if (server.dropNextAnswer) {
                    server.dropNextAnswer = false;
                    throw new TypeError('Failed to fetch');
                }
                return jsonResponse(structuredClone(server.daily));
            }
            if (options.method === 'PUT' && path.startsWith('/api/creator/series/')) {
                const id = decodeURIComponent(path.split('/').pop());
                const body = JSON.parse(options.body);
                server.puts.push({ path, body });
                const existing = server.series.find((entry) => entry.id === id);
                if ((existing?.revision ?? 0) !== body.baseRevision) {
                    return jsonResponse({ error: 'This series changed on another device.' }, 409);
                }
                const { baseRevision: _base, ...content } = body;
                const saved = { ...(existing ?? { status: 'draft', publishedStageCount: 0 }), id, ...content,
                    name: content.name.trim(), revision: (existing?.revision ?? 0) + 1, updatedBy: 'ModOne' };
                server.series = [...server.series.filter((entry) => entry.id !== id), saved];
                if (server.dropNextAnswer) {
                    server.dropNextAnswer = false;
                    throw new TypeError('Failed to fetch');
                }
                return jsonResponse({ series: structuredClone(saved) });
            }
            if (path.includes('/api/creator/daily')) return jsonResponse(structuredClone(server.daily));
            if (path.includes('/api/creator/migration')) return jsonResponse({ report: null, preview: { copied: [] } });
            if (server.holdNextSeriesRead) {
                const hold = server.holdNextSeriesRead;
                server.holdNextSeriesRead = null;
                await hold.promise;
            }
            return jsonResponse(seriesView());
        }));
        return server;
    }

    function openPanels() {
        const choose = vi.fn(async () => 'cancel');
        const setStatus = vi.fn();
        const panels = new CreatorPanels({ confirm, choose, setStatus, onOpenTrack: vi.fn(), onTracksChanged: vi.fn() });
        return { panels, choose, setStatus };
    }

    it('sends a newer Daily list once when the server holds a list whose answer was lost', async () => {
        const server = panelServer();
        const { panels, choose } = openPanels();
        await panels.loadDaily();
        panels.dailyKeys = ['circuit', 'royalPlateau', 'sunlitTemple'];
        panels.dailyDirty = true;
        server.dropNextAnswer = true;
        await panels.saveDaily();
        expect(server.daily.schedule.revision).toBe(4);
        panels.dailyKeys = ['circuit', 'sunlitTemple', 'royalPlateau', 'nightLoop'];
        await panels.saveDaily();
        expect(choose).not.toHaveBeenCalled();
        expect(server.puts.map((put) => put.body.baseRevision)).toEqual([3, 3, 4]);
        expect(server.daily.schedule.keys).toEqual(['circuit', 'sunlitTemple', 'royalPlateau', 'nightLoop']);
        expect(panels.dailyDirty).toBe(false);
    });

    it('asks when another device saved the Daily list', async () => {
        const server = panelServer();
        const { panels, choose } = openPanels();
        await panels.loadDaily();
        server.daily.schedule = { ...server.daily.schedule, keys: ['circuit', 'sunlitTemple'], revision: 9 };
        panels.dailyKeys = ['circuit', 'royalPlateau', 'sunlitTemple'];
        panels.dailyDirty = true;
        choose.mockResolvedValueOnce('mine');
        await panels.saveDaily();
        expect(server.puts.at(-1).body.baseRevision).toBe(9);
        expect(server.daily.schedule.keys).toEqual(['circuit', 'royalPlateau', 'sunlitTemple']);

        server.daily.schedule = { ...server.daily.schedule, keys: ['circuit'], revision: 20 };
        panels.dailyKeys = ['circuit', 'nightLoop'];
        panels.dailyDirty = true;
        choose.mockResolvedValueOnce('theirs');
        await panels.saveDaily();
        expect(panels.dailyKeys).toEqual(['circuit']);
        expect(panels.dailyDirty).toBe(false);

        panels.dailyKeys = ['circuit', 'nightLoop'];
        panels.dailyDirty = true;
        server.daily.schedule = { ...server.daily.schedule, revision: 30 };
        await panels.saveDaily();
        expect(panels.dailyKeys).toEqual(['circuit', 'nightLoop']);
        expect(panels.dailyDirty).toBe(true);
    });

    it('sends a newer series once when the server holds a save whose answer was lost', async () => {
        const server = panelServer();
        const { panels, choose } = openPanels();
        await panels.loadSeries('day-v1');
        panels.seriesDraft.name = 'Sent A';
        panels.seriesDirty = true;
        server.dropNextAnswer = true;
        await panels.saveSeries();
        expect(server.series[0].revision).toBe(3);
        panels.seriesDraft.name = 'Edited B';
        await panels.saveSeries();
        expect(choose).not.toHaveBeenCalled();
        expect(server.puts.map((put) => put.body.baseRevision)).toEqual([2, 2, 3]);
        expect(server.series[0].name).toBe('Edited B');
        expect(panels.seriesDirty).toBe(false);
    });

    it('offers Save mine for a live series only when the draft keeps its live stages', async () => {
        const server = panelServer();
        const { panels, choose } = openPanels();
        await panels.loadSeries('day-v1');
        // Another device made the first stage live.
        server.series[0] = { ...server.series[0], status: 'published', publishedStageCount: 1, revision: 5 };
        const draft = panels.seriesDraft;
        draft.name = 'New Name';
        draft.stages.push({ trackKey: 'dayLoop', laps: 2, requiredMedals: 2 });
        panels.seriesDirty = true;
        choose.mockResolvedValueOnce('mine');
        await panels.saveSeries();
        expect(choose.mock.calls[0][0].choices.map((choice) => choice.value)).toEqual(['mine', 'theirs']);
        expect(server.puts.at(-1).body.baseRevision).toBe(5);
        expect(server.series[0].name).toBe('New Name');

        server.series[0] = { ...server.series[0], revision: 9 };
        panels.seriesDraft.stages[0].laps = 3;
        panels.seriesDirty = true;
        choose.mockResolvedValueOnce('theirs');
        await panels.saveSeries();
        expect(choose.mock.calls[1][0].choices.map((choice) => choice.value)).toEqual(['theirs']);
        expect(panels.seriesDraft.stages[0].laps).toBe(1);
        expect(panels.seriesDirty).toBe(false);
    });

    it('stops when another series is open by the time the read ends', async () => {
        const server = panelServer();
        const { panels, choose } = openPanels();
        await panels.loadSeries('day-v1');
        server.series[0] = { ...server.series[0], revision: 7, name: 'Their Name' };
        panels.seriesDraft.name = 'Mine';
        panels.seriesDirty = true;
        const read = deferred();
        server.holdNextSeriesRead = read;
        const saving = panels.saveSeries();
        await vi.waitFor(() => expect(server.puts).toHaveLength(1));
        await vi.waitFor(() => expect(panels.busy).toBe(false));
        panels.seriesDirty = false;
        await panels.startNewSeries();
        read.resolve();
        await saving;
        expect(choose).not.toHaveBeenCalled();
        expect(panels.seriesDraft.isNew).toBe(true);
        expect(server.series[0].name).toBe('Their Name');
    });
});

describe('Creator copy check', () => {
    const check = {
        checkedAt: '2026-10-01T10:00:00.000Z',
        checkedBy: 'RaceMod',
        tracks: { exact: ['smallSteps', 'numberOne'], locked: 2, changed: ['nightRun'], notCopied: [],
            problems: [{ key: 'albertGardens', problem: 'Players raced the app track, but the Redis copy differs from it.' }] },
        series: { exact: ['numbered-v1'], changed: [], problems: [], notCopied: [] },
        dailyList: 'exact',
    };

    it('shows the last check with its problems, and checks again on request', async () => {
        const calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url, options) => {
            calls.push([String(url), options?.method ?? 'GET']);
            if (String(url) === '/api/creator/migration/check') {
                return jsonResponse({ check: { ...check, tracks: { ...check.tracks, problems: [] } } });
            }
            return jsonResponse({ report: null, preview: { copied: [] }, check });
        }));
        const setStatus = vi.fn();
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus });
        await panels.loadCopy();
        const root = document.getElementById('creator-copy-view');
        expect(root.textContent).toContain('2 exact track copies, 2 of them locked.');
        expect(root.textContent).toContain('nightRun');
        expect(root.textContent).toContain('Daily list: an exact copy.');
        expect([...root.querySelectorAll('.creator-error')].map((node) => node.textContent))
            .toEqual(['albertGardens: Players raced the app track, but the Redis copy differs from it.']);
        expect(root.textContent).toContain('[track-copy]');

        buttonsByText(root, 'Check copies')[0].click();
        await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith('The check found no problems.', false));
        expect(calls).toContainEqual(['/api/creator/migration/check', 'POST']);
        expect(root.textContent).toContain('No problems.');
        expect(root.querySelectorAll('.creator-error')).toHaveLength(0);
    });
});

describe('Creator copy undo', () => {
    const view = (preview, report = null) => ({
        report: null,
        preview: { copied: [] },
        playedDailies: { report: null, preview: { copied: [] } },
        liveCampaign: { report: null, preview: { copied: [] } },
        undo: {
            unplayed: { preview: { removed: [], removedSeries: [], kept: [], dailyList: 'app' }, report: null },
            'played-dailies': { preview, report },
            'live-campaign': { preview: { removed: [], removedSeries: [], kept: [], dailyList: null }, report: null },
        },
    });

    it('asks, removes what the copy wrote, and shows what it kept and why', async () => {
        const preview = { removed: ['smallSteps', 'albertGardens'], removedSeries: [], kept: [], dailyList: null };
        const report = { ranAt: '2026-10-01T12:00:00.000Z', ranBy: 'RaceMod', removed: ['smallSteps'], removedSeries: [],
            kept: [{ key: 'albertGardens', reason: 'Changed since the copy, so it stays.' }], dailyList: null };
        let current = view(preview);
        const fetchMock = vi.fn(async (url, options) => {
            if (options?.method === 'POST') {
                current = view({ removed: [], removedSeries: [], kept: [], dailyList: null }, report);
                return jsonResponse({ report, check: {} });
            }
            return jsonResponse(current);
        });
        vi.stubGlobal('fetch', fetchMock);
        const setStatus = vi.fn();
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus });
        await panels.loadCopy();
        const root = document.getElementById('creator-copy-view');
        const undoButtons = buttonsByText(root, 'Undo copy');
        expect(undoButtons.map((button) => button.disabled)).toEqual([true, false, true]);

        await panels.runUndo('played-dailies');
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Undo the copy?', danger: true, message: expect.stringContaining('Remove 2 tracks from Redis?') }));
        expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')[0])
            .toBe('/api/creator/migration/undo/played-dailies');
        expect(setStatus).toHaveBeenCalledWith('Removed 1 tracks and 0 series from Redis.');
        const sections = [...root.querySelectorAll('.creator-copy-section')];
        expect(sections[1].textContent).toContain('Last undo:');
        expect(sections[1].textContent).toContain('albertGardens: Changed since the copy, so it stays.');
        expect(buttonsByText(root, 'Undo copy')[1].disabled).toBe(true);
    });

    it('sends nothing when the question is cancelled', async () => {
        const fetchMock = vi.fn(async () => jsonResponse(view({ removed: ['smallSteps'], removedSeries: [], kept: [], dailyList: null })));
        vi.stubGlobal('fetch', fetchMock);
        confirm.mockImplementation(async () => false);
        const panels = new CreatorPanels({ confirm, onOpenTrack: vi.fn(), onTracksChanged: vi.fn(), setStatus: vi.fn() });
        await panels.loadCopy();
        await panels.runUndo('played-dailies');
        expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    });
});
