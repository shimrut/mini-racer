import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    bootAnalytics,
    createGhostCompactionController,
    createGhostMoveController,
    loadAnalyticsSummary,
    renderAnalyticsMessage,
    renderAnalyticsSummary,
    renderGhostCompaction,
    renderGhostMove,
    renderStorageSummary,
} from '../pages/mod-analytics.js';

function analyticsDom() {
    const html = readFileSync(new URL('../pages/mod-analytics.html', import.meta.url), 'utf8');
    return new JSDOM(html, { url: 'http://localhost' });
}

function modes({ daily = {}, campaign = {}, challenge = {} } = {}) {
    return [
        { mode: 'daily', starts: 0, finishes: 0, players: 0, ...daily },
        { mode: 'campaign', starts: 0, finishes: 0, players: 0, ...campaign },
        { mode: 'challenge', starts: 0, finishes: 0, players: 0, ...challenge },
    ];
}

function summaryFixture(overrides = {}) {
    const today = {
        date: '2026-08-15',
        players: 4,
        newPlayers: 1,
        returningPlayers: 3,
        guestPlayers: 2,
        challengeCreates: 1,
        podiumPlays: 7,
        podiumReplays: 4,
        modes: modes({
            daily: { starts: 6, finishes: 3, players: 4 },
            campaign: { starts: 5, finishes: 5, players: 2 },
        }),
    };
    return {
        from: '2026-07-02',
        to: '2026-08-15',
        today,
        days: [
            {
                date: '2026-08-14',
                players: 2,
                newPlayers: 0,
                returningPlayers: 2,
                guestPlayers: 1,
                challengeCreates: 0,
                podiumPlays: 2,
                podiumReplays: 1,
                modes: modes({ daily: { starts: 2, finishes: 1, players: 2 } }),
            },
            today,
        ],
        months: [
            {
                month: '2026-07',
                players: 20,
                newPlayers: 20,
                returningPlayers: 0,
                guestPlayers: 9,
                challengeCreates: 3,
                modes: modes({ daily: { players: 18 } }),
            },
            {
                month: '2026-08',
                players: 29,
                newPlayers: 11,
                returningPlayers: 18,
                guestPlayers: 12,
                challengeCreates: 4,
                modes: modes({ daily: { players: 27 } }),
            },
        ],
        cohorts: [
            {
                date: '2026-08-14',
                players: 4,
                d1: { retained: 2, rate: 50 },
                d2: { retained: 1, rate: 25 },
                d3: { retained: null, rate: null },
                d7: { retained: null, rate: null },
                d14: { retained: null, rate: null },
                d30: { retained: null, rate: null },
            },
            {
                date: '2026-08-15',
                players: 6,
                d1: { retained: null, rate: null },
                d2: { retained: null, rate: null },
                d3: { retained: null, rate: null },
                d7: { retained: null, rate: null },
                d14: { retained: null, rate: null },
                d30: { retained: null, rate: null },
            },
        ],
        ...overrides,
    };
}

describe('moderator analytics page', () => {
    it('shows the newest 10 cohort days and adds 10 older days with Load more', () => {
        const { window } = analyticsDom();
        const blank = { retained: null, rate: null };
        const cohorts = Array.from({ length: 23 }, (_, index) => ({
            date: `2026-07-${String(index + 1).padStart(2, '0')}`,
            players: index + 1,
            d1: blank, d2: blank, d3: blank, d7: blank, d14: blank, d30: blank,
        }));
        renderAnalyticsSummary(window.document, summaryFixture({ cohorts }));
        const { document } = window;
        const rowDates = () => [...document.querySelectorAll('.analytics-table--cohorts tbody th')]
            .map((cell) => cell.title);
        const loadMore = () => document.querySelector('#analytics-cohorts .analytics-button');

        expect(rowDates()).toHaveLength(10);
        expect(rowDates()[0]).toBe('2026-07-23');
        expect(rowDates()[9]).toBe('2026-07-14');

        loadMore().click();
        expect(rowDates()).toHaveLength(20);
        expect(rowDates()[19]).toBe('2026-07-04');
        expect(document.activeElement).toBe(loadMore());

        loadMore().click();
        expect(rowDates()).toHaveLength(23);
        expect(rowDates()[22]).toBe('2026-07-01');
        expect(loadMore()).toBeNull();
    });

    it('renders the summary panel, chart, modes, months, and daily rows', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture());
        const { document } = window;

        expect(document.getElementById('analytics-range').textContent).toBe('2026-07-02 to 2026-08-15');
        expect(document.getElementById('analytics-windows').textContent).toContain('Today');
        expect(document.getElementById('analytics-windows').textContent).toContain('Players');
        expect(document.getElementById('analytics-windows').textContent).toContain('Play Now');
        expect(document.getElementById('analytics-windows').textContent).toContain('View Replays');
        expect(document.getElementById('analytics-modes').textContent).toContain('7 Play Now');
        expect(document.getElementById('analytics-days').textContent).toContain('Play Now');
        expect(document.getElementById('analytics-windows').textContent).toContain('4');
        expect(document.getElementById('analytics-modes').textContent).toContain('Modes today');
        expect(document.getElementById('analytics-modes').textContent).toContain('Challenge');
        expect(document.getElementById('analytics-months').textContent).toContain('29');
        expect(document.getElementById('analytics-months').textContent).toContain('2026-07');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('Cohort retention');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('D2');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('D3');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('D14');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('50% (2)');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('25% (1)');
        expect(document.getElementById('analytics-cohorts').textContent).toContain('Exact UTC-day return');
        expect(document.querySelector('.analytics-table--cohorts')).toBeTruthy();
        expect(document.getElementById('analytics-trend').textContent).toContain('Returning');
        expect(document.querySelector('.analytics-chart')).toBeTruthy();
        expect(document.querySelectorAll('.analytics-chart__hit')).toHaveLength(2);
        expect(document.getElementById('analytics-days').textContent).toContain('Aug 15');
        expect(document.querySelector('.analytics-table')).toBeTruthy();
        expect(document.querySelector('#analytics-days .analytics-table__today th').textContent).toBe('Aug 15');
        expect(document.querySelector('.analytics-summary')).toBeTruthy();
        expect(document.querySelectorAll('.analytics-kpi')).toHaveLength(6);
        expect(document.querySelectorAll('.analytics-spark')).toHaveLength(0);
        expect(document.querySelector('.analytics-range__note')).toBeNull();
        expect(document.querySelectorAll('.analytics-card__note')).toHaveLength(0);
        expect(document.getElementById('analytics-windows').textContent)
            .not.toContain('Signed-in accounts that started a race');
    });

    it('limits a full retained history to a readable recent chart window', () => {
        const { window } = analyticsDom();
        const firstDay = new Date(Date.UTC(2025, 8, 7));
        const days = Array.from({ length: 365 }, (_, index) => {
            const date = new Date(firstDay.getTime() + (index * 24 * 60 * 60 * 1000));
            return {
                date: date.toISOString().slice(0, 10),
                players: 1,
                newPlayers: 1,
                returningPlayers: 0,
                guestPlayers: 0,
                challengeCreates: 0,
                podiumPlays: 0,
                podiumReplays: 0,
                modes: modes(),
            };
        });
        renderAnalyticsSummary(window.document, summaryFixture({
            from: days[0].date,
            to: days.at(-1).date,
            today: days.at(-1),
            days,
        }));

        expect(window.document.getElementById('analytics-trend').textContent)
            .toContain('Players per day · last 45 days');
        expect(window.document.querySelectorAll('.analytics-chart__hit')).toHaveLength(45);
    });

    it('shows how far the recording of old races has come', () => {
        for (const [racedListFill, text] of [
            [{ state: 'waiting' }, 'Old races recorded: not started'],
            [{ state: 'working', boardsDone: 120, boards: 1400 }, 'Old races recorded: 120 of 1,400 boards'],
            [{ state: 'done', completedAt: '2026-09-27T10:00:00.000Z', boards: 1400 }, 'Old races recorded: done'],
        ]) {
            const { window } = analyticsDom();
            renderStorageSummary(window.document, ({
                storage: { totalBytes: 1536, groups: [] },
                racedListFill,
            }));
            expect(window.document.getElementById('analytics-storage').textContent).toContain(text);
        }
    });

    it('shows the ghost move with its choice, a progress bar and the figures', () => {
        const status = {
            choice: 'all',
            mode: 'move',
            days: { moving: 1, waiting: 0, done: 4, restoring: 0, restored: 0 },
            eligibleDays: 8,
            waitingDays: 4,
            moved: 12345,
            restored: 0,
            freed: 3 * 1024 * 1024,
            deleted: 7,
            held: 3,
            blob: { bytes: 2.5 * 1024 * 1024, objects: 12000, measuredDays: 4 },
            blobError: { message: 'app not allowed to use blob storage', at: '2026-10-07T07:43:00.000Z' },
        };
        const { window } = analyticsDom();
        const onChoose = vi.fn();
        renderGhostMove(window.document, { status, onChoose });
        const card = window.document.getElementById('analytics-ghost-move');

        expect(card.hidden).toBe(false);
        const pressed = [...card.querySelectorAll('button[aria-pressed="true"]')].map((node) => node.textContent);
        expect(pressed).toEqual(['Move all']);
        const bar = card.querySelector('[role="progressbar"]');
        expect(bar.getAttribute('aria-valuenow')).toBe('4');
        expect(bar.getAttribute('aria-valuemax')).toBe('8');
        expect(card.querySelector('.analytics-progress__fill').style.width).toBe('50%');
        expect(card.textContent).toContain('Running · 4 of 8 finished days done · 4 waiting');
        expect(card.textContent).toContain('Moved 12,345 runs · Redis payload removed 3.0 MB');
        expect(card.textContent).toContain('Held 3 runs · blob 2.5 MB in 12,000 objects (measured on 4 of 5 days)');
        expect(card.textContent).toContain('Blob storage refused: app not allowed to use blob storage');

        // While a move runs, the tabs are locked and the one action is Pause.
        const buttons = [...card.querySelectorAll('button')].map((node) => [node.textContent, node.disabled]);
        expect(buttons).toEqual([['Move one day', true], ['Move all', true], ['Restore', true], ['Pause', false]]);
        [...card.querySelectorAll('button')].find((node) => node.textContent === 'Pause').click();
        expect(onChoose).toHaveBeenCalledWith('off');
    });

    it('lets a tab only pick the ghost move, and starts it from Run', () => {
        const status = { choice: 'off', days: {}, eligibleDays: 69, waitingDays: 69, blob: {} };
        const { window } = analyticsDom();
        const onSelect = vi.fn();
        const onChoose = vi.fn();
        const render = (selected) => {
            renderGhostMove(window.document, { status, selected, onSelect, onChoose });
            return window.document.getElementById('analytics-ghost-move');
        };
        const button = (card, label) => [...card.querySelectorAll('button')].find((node) => node.textContent === label);

        let card = render(null);
        expect([...card.querySelectorAll('button')].map((node) => [node.textContent, node.disabled])).toEqual([
            ['Move one day', false], ['Move all', false], ['Restore', false], ['Run', false],
        ]);
        expect(button(card, 'Move one day').getAttribute('aria-pressed')).toBe('true');
        expect(card.textContent).toContain('Not started · 0 of 69 finished days done · 69 waiting');

        button(card, 'Move all').click();
        expect(onSelect).toHaveBeenCalledWith('all');
        expect(onChoose).not.toHaveBeenCalled();

        card = render('all');
        expect(button(card, 'Move all').getAttribute('aria-pressed')).toBe('true');
        button(card, 'Run').click();
        expect(onChoose).toHaveBeenCalledWith('all');
    });

    it('shows each compaction step with its progress and the one action it allows', () => {
        const step = (overrides = {}) => ({
            total: 0, checked: 0, packed: 0, savedBytes: 0, startedAt: null, finishedAt: null, ...overrides,
        });
        const buttons = (card) => [...card.querySelectorAll('button')].map((node) => [node.textContent, node.disabled]);
        const render = (state) => {
            const { window } = analyticsDom();
            const onAction = vi.fn();
            renderGhostCompaction(window.document, { state, onAction });
            return { card: window.document.getElementById('analytics-ghost-compaction'), onAction };
        };

        const fresh = render({ running: null, writePacked: false, steps: { expired: step(), campaign: step() } });
        expect(buttons(fresh.card)).toEqual([['Start', false], ['Start', true]]);
        expect(fresh.card.textContent).toContain('New best times are saved compact from the first Start.');

        const running = render({
            running: 'expired',
            writePacked: true,
            steps: {
                expired: step({ total: 400, checked: 100, packed: 90, savedBytes: 120 * 1024, startedAt: '2026-10-07T10:00:00Z' }),
                campaign: step(),
            },
        });
        expect(buttons(running.card)).toEqual([['Pause', false], ['Start', true]]);
        expect(running.card.textContent).toContain('Running · 100 of 400 ghosts checked · 90 compacted · 120 KB saved');
        expect(running.card.querySelector('.analytics-progress__fill').style.width).toBe('25%');
        running.card.querySelector('button').click();
        expect(running.onAction).toHaveBeenCalledWith('pause', 'expired');

        const done = render({
            running: null,
            writePacked: true,
            steps: {
                expired: step({
                    total: 400, checked: 400, skipped: 3, startedAt: '2026-10-07T10:00:00Z', finishedAt: '2026-10-07T11:00:00Z',
                }),
                campaign: step({ total: 900, checked: 50, startedAt: '2026-10-07T11:05:00Z' }),
            },
        });
        expect(buttons(done.card)).toEqual([['Run again', false], ['Resume', false]]);
        expect(done.card.textContent).toContain('Done 2026-10-07');
        expect(done.card.textContent).toContain('0 B saved · 3 skipped, for Run again');
        expect(done.card.textContent).toContain('Paused · 50 of 900 ghosts checked');
        // A step with no skipped rows says nothing about them.
        expect(done.card.textContent.match(/skipped/g)).toHaveLength(1);
    });

    it('starts a compaction step and shows the reason a start is refused', async () => {
        const { window } = analyticsDom();
        const state = { running: null, writePacked: false, steps: { expired: {}, campaign: {} } };
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ ...state, running: 'expired' }) })
            .mockResolvedValueOnce({ status: 409, ok: false, json: async () => ({}) })
            .mockResolvedValueOnce({ status: 409, ok: false, json: async () => ({ error: 'Another step is running.' }) });
        const controller = createGhostCompactionController(window.document, fetchImpl);

        await controller.act('start', 'expired');
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/ghost-compaction', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ action: 'start', step: 'expired' }),
        }));
        const card = window.document.getElementById('analytics-ghost-compaction');
        expect([...card.querySelectorAll('button')][0].textContent).toBe('Pause');

        await controller.act('start', 'campaign');
        expect(card.textContent).toContain('Finish the step before this one first.');
        // The server's reason is shown when it gives one.
        await controller.act('start', 'campaign');
        expect(card.textContent).toContain('Another step is running.');
    });

    it('saves a choice and reads the move again only while the Storage tab is open', async () => {
        vi.useFakeTimers();
        try {
            const { window } = analyticsDom();
            const status = { choice: 'off', days: {}, eligibleDays: 0, blob: {} };
            const fetchImpl = vi.fn(async (_url, init) => ({
                status: 200,
                ok: true,
                json: async () => (init?.method === 'POST' ? { ...status, choice: JSON.parse(init.body).choice } : status),
            }));
            const controller = createGhostMoveController(window.document, fetchImpl, { pollMs: 1000 });

            controller.setActive(true);
            await vi.advanceTimersByTimeAsync(2500);
            expect(fetchImpl).toHaveBeenCalledTimes(3);
            const button = (label) => [...window.document.querySelectorAll('#analytics-ghost-move button')]
                .find((node) => node.textContent === label);
            const pressed = () => window.document.querySelector('#analytics-ghost-move button[aria-pressed="true"]').textContent;

            // A tab saves nothing; Run saves the picked tab, and Pause saves Off.
            button('Move all').click();
            expect(fetchImpl).toHaveBeenCalledTimes(3);
            expect(pressed()).toBe('Move all');
            button('Run').click();
            await vi.waitFor(() => expect(button('Pause')).toBeTruthy());
            expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/ghost-archive', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ choice: 'all' }),
            }));
            button('Pause').click();
            await vi.waitFor(() => expect(button('Run')).toBeTruthy());
            expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/ghost-archive', expect.objectContaining({
                body: JSON.stringify({ choice: 'off' }),
            }));
            expect(pressed()).toBe('Move all');

            controller.setActive(false);
            const calls = fetchImpl.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5000);
            expect(fetchImpl).toHaveBeenCalledTimes(calls);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows Unavailable on the Storage tab when the size walk failed', () => {
        const { window } = analyticsDom();
        renderStorageSummary(window.document, { storage: null });
        expect(window.document.getElementById('analytics-storage').textContent).toContain('Unavailable');
    });

    it('shows Redis occupancy by family when the summary includes it', () => {
        const { window } = analyticsDom();
        renderStorageSummary(window.document, ({
            storage: {
                totalBytes: 1536,
                groups: [
                    {
                        label: 'Ghost replays',
                        detail: 'Packed traces',
                        bytes: 1024,
                        keys: 12,
                        rows: 40,
                        estimated: true,
                    },
                    {
                        label: 'Analytics',
                        bytes: 512,
                        keys: 3,
                        rows: 3,
                        estimated: false,
                    },
                ],
            },
        }));
        const storage = window.document.getElementById('analytics-storage').textContent;

        expect(storage).toContain('1.5 KB');
        expect(storage).toContain('Ghost replays');
        expect(storage).toContain('~1.0 KB');
        expect(storage).toContain('Analytics');
        expect(window.document.querySelector('#analytics-storage .analytics-table')).toBeTruthy();
    });

    it('reports the day-over-day direction on each tile', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture());
        const deltas = [...window.document.querySelectorAll('.analytics-kpi__delta')]
            .map((node) => `${node.dataset.direction}:${node.textContent}`);

        expect(deltas[0]).toContain('up:▲ 2');
        expect(deltas[0]).toContain('vs yesterday');
        expect(deltas.some((delta) => delta.startsWith('flat'))).toBe(false);
    });

    it('omits zero-change rows from the compact summary panel', () => {
        const { window } = analyticsDom();
        const day = {
            date: '2026-08-15',
            players: 4,
            newPlayers: 1,
            returningPlayers: 3,
            guestPlayers: 2,
            podiumPlays: 7,
            podiumReplays: 4,
            modes: modes(),
        };
        renderAnalyticsSummary(window.document, summaryFixture({ days: [day, { ...day }] }));

        expect(window.document.querySelectorAll('.analytics-kpi__delta')).toHaveLength(0);
    });

    it('drops the chart when a single day is stored', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture({
            days: [{ date: '2026-08-15', players: 4, newPlayers: 1, returningPlayers: 3, modes: modes() }],
        }));

        expect(window.document.querySelector('.analytics-chart')).toBeNull();
        expect(window.document.getElementById('analytics-trend').textContent)
            .toContain('Not enough days recorded yet');
        expect(window.document.getElementById('analytics-days').textContent).toContain('Aug 15');
    });

    it('renders an empty subreddit without days or months', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, {
            from: '2026-07-02',
            to: '2026-08-15',
            today: {},
            days: [],
            months: [],
            cohorts: [],
        });

        expect(window.document.getElementById('analytics-windows').textContent).toContain('0');
        expect(window.document.getElementById('analytics-months').textContent).toContain('No months recorded yet');
        expect(window.document.getElementById('analytics-cohorts').textContent).toContain('No cohorts recorded yet');
        expect(window.document.getElementById('analytics-modes').textContent).toContain('No races today');
        expect(window.document.getElementById('analytics-days').textContent).toContain('No stored days yet');
        expect(window.document.getElementById('analytics-main').hidden).toBe(false);
    });

    it('locks the page when the summary is forbidden', async () => {
        const { window } = analyticsDom();
        const fetchImpl = vi.fn(async () => ({ status: 403, ok: false }));
        await expect(loadAnalyticsSummary(fetchImpl)).resolves.toEqual({
            error: 'Moderator access required.',
        });
        renderAnalyticsMessage(window.document, 'Moderator access required.');

        expect(window.document.getElementById('analytics-status').textContent).toBe(
            'Moderator access required.',
        );
        expect(window.document.getElementById('analytics-windows').hidden).toBe(true);
        expect(window.document.getElementById('analytics-main').hidden).toBe(true);
        expect(window.document.getElementById('analytics-trend').hidden).toBe(true);
    });

    it('shows every section again after a failed load is retried', () => {
        const { window } = analyticsDom();
        renderAnalyticsMessage(window.document, 'Could not load the summary.');
        renderAnalyticsSummary(window.document, summaryFixture());

        for (const id of ['analytics-windows', 'analytics-main', 'analytics-trend', 'analytics-modes',
            'analytics-cohorts', 'analytics-months', 'analytics-days']) {
            expect(window.document.getElementById(id).hidden).toBe(false);
        }
    });

    it('opens on Players and loads each other tab once, the first time it opens', async () => {
        const { window } = analyticsDom();
        const { document } = window;
        const fetchImpl = vi.fn(async (url) => ({
            status: 200,
            ok: true,
            json: async () => (url.startsWith('/api/analytics/storage')
                ? { storage: { totalBytes: 2048, groups: [] }, racedListFill: null }
                : url.startsWith('/api/analytics/ghost-archive')
                    ? { choice: 'off', days: {}, eligibleDays: 0, blob: {} }
                    : url.startsWith('/api/analytics/ghost-compaction')
                    ? { running: null, writePacked: false, steps: { expired: {}, campaign: {} } }
                    : url.startsWith('/api/analytics/challenges')
                    ? { date: '2026-08-15', items: [], nextOffset: null }
                    : summaryFixture()),
        }));
        const tab = (name) => document.getElementById(`analytics-tab-${name}`);
        const panel = (name) => document.getElementById(`analytics-panel-${name}`);

        await bootAnalytics(document, fetchImpl);
        expect(tab('players').getAttribute('aria-selected')).toBe('true');
        expect(panel('players').hidden).toBe(false);
        expect(panel('storage').hidden).toBe(true);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['/api/analytics/summary']);

        tab('storage').click();
        await vi.waitFor(() => expect(document.getElementById('analytics-storage').textContent).toContain('2.0 KB'));
        expect(panel('storage').hidden).toBe(false);
        expect(panel('players').hidden).toBe(true);
        tab('challenges').click();
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
            '/api/analytics/summary',
            '/api/analytics/ghost-compaction',
            '/api/analytics/ghost-archive',
            '/api/analytics/storage',
            '/api/analytics/challenges?offset=0&period=today',
        ]);

        tab('storage').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        expect(tab('players').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab('players'));
    });
});
