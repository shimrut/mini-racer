import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    bootAnalytics,
    createChallengeAnalyticsController,
    loadChallengeAnalyticsPage,
    renderAnalyticsMessage,
    renderAnalyticsSummary,
    renderChallengeAnalytics,
} from '../pages/mod-analytics.js';

function analyticsDom() {
    const html = readFileSync(new URL('../pages/mod-analytics.html', import.meta.url), 'utf8');
    return new JSDOM(html, { url: 'http://localhost' });
}

function counts(overrides = {}) {
    return { views: 0, uniqueViewers: 0, clicks: 0, acceptClicks: 0, ownOpens: 0, ...overrides };
}

function trackFixture(overrides = {}) {
    return {
        trackKey: 'mountainPass',
        trackName: 'Mountain Pass',
        trackingStartedAt: '2026-10-04T09:00:00.000Z',
        today: counts({ views: 120, uniqueViewers: 40, clicks: 52, acceptClicks: 42, ownOpens: 10 }),
        lifetime: counts({ views: 1234, uniqueViewers: 300, clicks: 470, acceptClicks: 450, ownOpens: 20 }),
        ...overrides,
    };
}

function page(items = [trackFixture()], nextOffset = null, date = '2026-10-05') {
    return { date, items, nextOffset };
}

function response(payload, status = 200) {
    return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function trackRows(document) {
    return [...document.querySelectorAll('#analytics-challenges tbody tr')];
}

function rowCounts(row) {
    return [...row.querySelectorAll('td')].map((cell) => cell.textContent);
}

function button(document, label) {
    return [...document.querySelectorAll('#analytics-challenges button')]
        .find((node) => node.textContent === label);
}

describe('challenge analytics by track', () => {
    it('defaults to Today with one compact row per track and a UTC date', () => {
        const { window: { document } } = analyticsDom();
        renderChallengeAnalytics(document, {
            items: [
                trackFixture({ challengerUsername: 'PrivateName', postUrl: 'https://www.reddit.com/comments/abc/' }),
                trackFixture({ trackKey: 'centralDistrict', trackName: 'Central District', today: counts() }),
            ],
            date: '2026-10-05',
            loaded: true,
        });

        const section = document.getElementById('analytics-challenges');
        expect(section.hidden).toBe(false);
        expect(section.textContent).toContain('Challenges by track');
        expect(section.textContent).toContain('Today · 2026-10-05 UTC');
        expect(button(document, 'Today').getAttribute('aria-pressed')).toBe('true');
        expect(button(document, 'Lifetime').getAttribute('aria-pressed')).toBe('false');
        expect([...section.querySelectorAll('thead th')].map((cell) => cell.textContent))
            .toEqual(['Track', 'Views', 'Unique viewers', 'Clicks']);
        const rows = trackRows(document);
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('th').textContent).toBe('Mountain Pass');
        expect(rows[0].querySelector('th').title).toBe('Tracking since Oct 4, 2026');
        expect(rowCounts(rows[0])).toEqual(['120', '40', '52']);
        expect(rowCounts(rows[1])).toEqual(['0', '0', '0']);
        expect(section.textContent).not.toContain('PrivateName');
        expect(section.querySelector('a')).toBeNull();
        expect(section.textContent).not.toContain('Issued');
    });

    it('switches to lifetime metrics locally and includes today', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn(async () => response(page()));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        button(document, 'Lifetime').click();

        expect(button(document, 'Lifetime').getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('analytics-challenges').textContent).toContain('Lifetime · includes today');
        expect(rowCounts(trackRows(document)[0])).toEqual(['1,234', '300', '470']);
        button(document, 'Today').click();
        expect(rowCounts(trackRows(document)[0])).toEqual(['120', '40', '52']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('includes author opens in Clicks and exposes the split without adding columns', () => {
        const { window: { document } } = analyticsDom();
        renderChallengeAnalytics(document, { items: [trackFixture()], date: '2026-10-05', loaded: true });
        let cells = trackRows(document)[0].querySelectorAll('td');
        expect(cells).toHaveLength(3);
        expect(cells[2].textContent).toBe('52');
        expect(cells[2].title).toBe('42 Accept Challenge · 10 Open Mini Racer');

        renderChallengeAnalytics(document, {
            items: [trackFixture({ lifetime: counts({ clicks: 7, ownOpens: 7 }) })],
            period: 'lifetime', loaded: true,
        });
        cells = trackRows(document)[0].querySelectorAll('td');
        expect(cells[2].textContent).toBe('7');
        expect(cells[2].title).toBe('0 Accept Challenge · 7 Open Mini Racer');
    });

    it('shows zero activity even before a track records its first event', () => {
        const { window: { document } } = analyticsDom();
        renderChallengeAnalytics(document, {
            items: [trackFixture({ trackingStartedAt: null, today: counts(), lifetime: counts() })],
            loaded: true,
        });
        expect(rowCounts(trackRows(document)[0])).toEqual(['0', '0', '0']);
        expect(trackRows(document)[0].querySelector('th').title).toBe('No events recorded yet');
    });

    it('renders untrusted track names as text without links or executable markup', () => {
        const { window: { document } } = analyticsDom();
        renderChallengeAnalytics(document, {
            items: [trackFixture({
                trackName: '<img src=x onerror=alert(1)><script>alert(1)</script>',
                postUrl: 'javascript:alert(1)',
            })],
            loaded: true,
        });
        const section = document.getElementById('analytics-challenges');
        expect(section.querySelector('img, script, a')).toBeNull();
        expect(trackRows(document)[0].textContent).toContain('<script>alert(1)</script>');
    });

    it('shows an empty state and keeps table scrolling inside a focusable region', () => {
        const { window: { document } } = analyticsDom();
        renderChallengeAnalytics(document, { loaded: true });
        expect(document.getElementById('analytics-challenges').textContent).toContain('No challenge activity yet');
        renderChallengeAnalytics(document, { items: [trackFixture()], loaded: true });
        const wrap = document.querySelector('#analytics-challenges .analytics-table-wrap');
        expect(wrap.tabIndex).toBe(0);
        expect(wrap.getAttribute('aria-label')).toBe('Challenge counts by track');
    });
});

describe('challenge track analytics loading', () => {
    it('requests a bounded page and rejects missing dates, malformed pages, and access errors', async () => {
        const payload = page([trackFixture()], 25);
        const fetchImpl = vi.fn(async () => response(payload));
        await expect(loadChallengeAnalyticsPage(fetchImpl, 0)).resolves.toEqual(payload);
        expect(fetchImpl).toHaveBeenCalledWith('/api/analytics/challenges?offset=0&period=today');
        for (const [status, error] of [
            [403, 'Moderator access required.'],
            [400, 'Challenge counts need a subreddit context.'],
            [500, 'Could not load challenge counts.'],
        ]) {
            await expect(loadChallengeAnalyticsPage(async () => response(null, status)))
                .resolves.toEqual({ error });
        }
        for (const invalid of [
            { items: [] }, page(null), page([], 0), page([], null, '<script>alert(1)</script>'),
        ]) {
            await expect(loadChallengeAnalyticsPage(async () => response(invalid)))
                .resolves.toEqual({ error: 'Could not load challenge counts.' });
        }
    });

    it('guards overlapping requests and appends each track once across pages', async () => {
        const { window: { document } } = analyticsDom();
        const first = deferred();
        const second = deferred();
        const fetchImpl = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        const firstLoad = controller.loadMore();
        expect(controller.loadMore()).toBe(firstLoad);
        expect(controller.refresh()).toBe(firstLoad);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(document.getElementById('analytics-challenges').getAttribute('aria-busy')).toBe('true');
        first.resolve(response(page([trackFixture()], 25)));
        await firstLoad;

        const secondLoad = controller.loadMore();
        expect(button(document, 'Load more').disabled).toBe(true);
        button(document, 'Load more').click();
        expect(controller.loadMore()).toBe(secondLoad);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=25&period=today');
        second.resolve(response(page([
            trackFixture(), trackFixture({ trackKey: 'centralDistrict', trackName: 'Central District' }),
        ])));
        await secondLoad;
        expect(trackRows(document)).toHaveLength(2);
        expect(trackRows(document)[1].textContent).toContain('Central District');
        expect(button(document, 'Load more')).toBeUndefined();
        await controller.loadMore();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('preserves rows after pagination failure and retries the failed offset', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture()], 25)))
            .mockRejectedValueOnce(new Error('Network unavailable'))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'next', trackName: 'Next Track' })])));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        await controller.loadMore();
        expect(trackRows(document)).toHaveLength(1);
        expect(document.querySelector('#analytics-challenges [role="status"]').textContent)
            .toBe('Could not load challenge counts.');
        button(document, 'Retry').click();
        await vi.waitFor(() => expect(trackRows(document)).toHaveLength(2));
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=25&period=today');
    });

    it('Refresh replaces all paginated rows and keeps the selected period', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture()], 25)))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'older', trackName: 'Older Track' })])))
            .mockResolvedValueOnce(response(page([trackFixture({ lifetime: counts({ views: 9000 }) })], null, '2026-10-06')));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        await controller.loadMore();
        button(document, 'Lifetime').click();
        button(document, 'Refresh').click();
        await vi.waitFor(() => expect(trackRows(document)).toHaveLength(1));
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=lifetime');
        expect(rowCounts(trackRows(document)[0])).toEqual(['9,000', '0', '0']);
        expect(button(document, 'Lifetime').getAttribute('aria-pressed')).toBe('true');
        button(document, 'Today').click();
        expect(document.getElementById('analytics-challenges').textContent).toContain('2026-10-06 UTC');
    });

    it('reloads the list from the top in the new order when the period changes', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture(), trackFixture({ trackKey: 'b', trackName: 'Busy Today' })], 25)))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'c', trackName: 'Busy Lifetime' })])));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        expect(trackRows(document)).toHaveLength(2);

        button(document, 'Lifetime').click();
        await vi.waitFor(() => expect(trackRows(document)).toHaveLength(1));

        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=lifetime');
        expect(trackRows(document)[0].textContent).toContain('Busy Lifetime');
        expect(document.getElementById('analytics-challenges').textContent).toContain('most viewed first');
    });

    it('preserves the previous date and rows when Refresh fails and Retry reloads from zero', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture()], 25)))
            .mockRejectedValueOnce(new Error('Network unavailable'))
            .mockResolvedValueOnce(response(page([trackFixture({ today: counts() })], null, '2026-10-06')));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        await controller.refresh();
        expect(rowCounts(trackRows(document)[0])).toEqual(['120', '40', '52']);
        expect(document.getElementById('analytics-challenges').textContent).toContain('2026-10-05 UTC');
        button(document, 'Retry').click();
        await vi.waitFor(() => expect(rowCounts(trackRows(document)[0])).toEqual(['0', '0', '0']));
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=today');
        expect(document.getElementById('analytics-challenges').textContent).toContain('2026-10-06 UTC');
    });

    it('discards a pagination page from the next UTC day and starts again at zero', async () => {
        const { window: { document } } = analyticsDom();
        const nextDay = deferred();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture()], 25)))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'discarded', trackName: 'Wrong Page' })], null, '2026-10-06')))
            .mockReturnValueOnce(nextDay.promise);
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        const loading = controller.loadMore();
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=today');
        expect(document.getElementById('analytics-challenges').textContent).not.toContain('Wrong Page');
        expect(trackRows(document)).toHaveLength(1);
        nextDay.resolve(response(page([trackFixture({ today: counts() })], null, '2026-10-06')));
        await loading;
        expect(trackRows(document)).toHaveLength(1);
        expect(rowCounts(trackRows(document)[0])).toEqual(['0', '0', '0']);
        expect(document.getElementById('analytics-challenges').textContent).toContain('2026-10-06 UTC');
    });

    it('retries from zero after a failed new-day reset instead of appending the old day', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(page([trackFixture()], 25)))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'discarded' })], null, '2026-10-06')))
            .mockRejectedValueOnce(new Error('Reset failed'))
            .mockResolvedValueOnce(response(page([trackFixture({ trackKey: 'new', trackName: 'New Day Track', today: counts() })], null, '2026-10-06')));
        const controller = createChallengeAnalyticsController(document, fetchImpl);
        await controller.loadMore();
        await controller.loadMore();
        expect(trackRows(document)).toHaveLength(1);
        expect(document.getElementById('analytics-challenges').textContent).toContain('2026-10-05 UTC');
        await controller.loadMore();
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=today');
        expect(trackRows(document)).toHaveLength(1);
        expect(trackRows(document)[0].textContent).toContain('New Day Track');
        expect(document.getElementById('analytics-challenges').textContent).not.toContain('Mountain Pass');
    });

    it('keeps the summary visible when challenge counts fail and allows Retry', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ today: { players: 9 }, days: [], months: [], cohorts: [] }))
            .mockResolvedValueOnce(response(null, 500))
            .mockResolvedValueOnce(response(page()));
        await bootAnalytics(document, fetchImpl);
        expect(document.getElementById('analytics-windows').hidden).toBe(false);
        expect(document.getElementById('analytics-windows').textContent).toContain('9');
        expect(document.getElementById('analytics-status').textContent).toBe('');
        // Challenge counts load when their tab opens.
        document.getElementById('analytics-tab-challenges').click();
        await vi.waitFor(() => expect(button(document, 'Retry')).toBeTruthy());
        button(document, 'Retry').click();
        await vi.waitFor(() => expect(trackRows(document)).toHaveLength(1));
        expect(fetchImpl).toHaveBeenLastCalledWith('/api/analytics/challenges?offset=0&period=today');
    });

    it('does not request challenge counts when the summary denies moderator access', async () => {
        const { window: { document } } = analyticsDom();
        const fetchImpl = vi.fn(async () => response(null, 403));
        await bootAnalytics(document, fetchImpl);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(document.getElementById('analytics-challenges').hidden).toBe(true);
        expect(document.getElementById('analytics-status').textContent).toBe('Moderator access required.');
    });

    it('clears and hides track rows with the rest of the page on an access error', () => {
        const { window: { document } } = analyticsDom();
        renderAnalyticsSummary(document, { days: [], months: [], cohorts: [] });
        renderChallengeAnalytics(document, { items: [trackFixture()], loaded: true });
        renderAnalyticsMessage(document, 'Moderator access required.');
        expect(document.getElementById('analytics-challenges').hidden).toBe(true);
        expect(trackRows(document)).toHaveLength(0);
    });
});
