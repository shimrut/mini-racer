import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    loadAnalyticsSummary,
    renderAnalyticsMessage,
    renderAnalyticsSummary,
} from '../mod-analytics.js';

function analyticsDom() {
    const html = readFileSync(new URL('../mod-analytics.html', import.meta.url), 'utf8');
    return new JSDOM(html, { url: 'http://localhost' });
}

function summaryFixture(overrides = {}) {
    return {
        from: '2026-07-02',
        to: '2026-08-15',
        today: {
            date: '2026-08-15',
            uniquePlayers: 4,
            newPlayers: 1,
            returningPlayers: 3,
            dailyFinishes: 2,
            campaignStarts: 5,
            challengeCreates: 1,
            challengeFinishes: 0,
        },
        windows: [
            { days: 7, uniquePlayers: 11, playerDays: 14 },
            { days: 14, uniquePlayers: 18, playerDays: 22 },
            { days: 30, uniquePlayers: 29, playerDays: 40 },
        ],
        days: [
            { date: '2026-08-14', uniquePlayers: 3, newPlayers: 0, returningPlayers: 3, dailyFinishes: 1 },
            {
                date: '2026-08-15',
                uniquePlayers: 4,
                newPlayers: 1,
                returningPlayers: 3,
                dailyFinishes: 2,
                campaignStarts: 5,
                challengeCreates: 1,
                challengeFinishes: 0,
            },
        ],
        tracks: {
            daily: [{ trackName: 'Classic Circuit', count: 2 }],
            campaign: [],
            challenge: [{ trackName: 'Classic Circuit', count: 1 }],
        },
        ...overrides,
    };
}

describe('moderator analytics page', () => {
    it('renders headline tiles, the chart, tracks, and daily rows', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture());
        const { document } = window;

        expect(document.getElementById('analytics-range').textContent).toBe('2026-07-02 to 2026-08-15');
        expect(document.getElementById('analytics-windows').textContent).toContain('Active players today');
        expect(document.getElementById('analytics-windows').textContent).toContain('4');
        expect(document.getElementById('analytics-reach').textContent).toContain('29');
        expect(document.getElementById('analytics-reach').textContent).toContain('days played per player');
        expect(document.getElementById('analytics-today').textContent).toContain('Daily finishes');
        expect(document.getElementById('analytics-trend').textContent).toContain('Returning');
        expect(document.querySelector('.analytics-chart')).toBeTruthy();
        expect(document.querySelectorAll('.analytics-chart__hit')).toHaveLength(2);
        expect(document.getElementById('analytics-tracks').textContent).toContain('Classic Circuit');
        expect(document.getElementById('analytics-tracks').textContent).toContain('None yet');
        expect(document.getElementById('analytics-days').textContent).toContain('Aug 15');
        expect(document.querySelector('.analytics-table')).toBeTruthy();
        expect(document.querySelector('.analytics-table__today th').textContent).toBe('Aug 15');
    });

    it('reports the day-over-day direction on each tile', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture());
        const deltas = [...window.document.querySelectorAll('.analytics-kpi__delta')]
            .map((node) => `${node.dataset.direction}:${node.textContent}`);

        expect(deltas[0]).toContain('up:▲ 1');
        expect(deltas[0]).toContain('vs yesterday');
        expect(deltas.some((delta) => delta.startsWith('flat'))).toBe(false);
    });

    it('drops the chart when a single day is stored', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture({
            days: [{ date: '2026-08-15', uniquePlayers: 4, newPlayers: 1, returningPlayers: 3 }],
        }));

        expect(window.document.querySelector('.analytics-chart')).toBeNull();
        expect(window.document.getElementById('analytics-trend').textContent)
            .toContain('Not enough days recorded yet');
        expect(window.document.getElementById('analytics-days').textContent).toContain('Aug 15');
    });

    it('renders an empty subreddit without days or tracks', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, {
            from: '2026-07-02',
            to: '2026-08-15',
            today: {},
            windows: [],
            days: [],
            tracks: { daily: [], campaign: [], challenge: [] },
        });

        expect(window.document.getElementById('analytics-windows').textContent).toContain('0');
        expect(window.document.getElementById('analytics-reach').textContent).toContain('No windows yet');
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

        for (const id of ['analytics-windows', 'analytics-main', 'analytics-trend', 'analytics-reach',
            'analytics-today', 'analytics-tracks', 'analytics-days']) {
            expect(window.document.getElementById(id).hidden).toBe(false);
        }
    });
});
