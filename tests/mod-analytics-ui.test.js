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
        ...overrides,
    };
}

describe('moderator analytics page', () => {
    it('renders headline tiles, the chart, modes, months, and daily rows', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture());
        const { document } = window;

        expect(document.getElementById('analytics-range').textContent).toBe('2026-07-02 to 2026-08-15');
        expect(document.getElementById('analytics-windows').textContent).toContain('Players today');
        expect(document.getElementById('analytics-windows').textContent).toContain('Podium Play Now');
        expect(document.getElementById('analytics-windows').textContent).toContain('Podium View Replays');
        expect(document.getElementById('analytics-modes').textContent).toContain('7 Play Now');
        expect(document.getElementById('analytics-days').textContent).toContain('Play Now');
        expect(document.getElementById('analytics-windows').textContent).toContain('4');
        expect(document.getElementById('analytics-modes').textContent).toContain('Modes today');
        expect(document.getElementById('analytics-modes').textContent).toContain('Challenge');
        expect(document.getElementById('analytics-months').textContent).toContain('29');
        expect(document.getElementById('analytics-months').textContent).toContain('2026-07');
        expect(document.getElementById('analytics-trend').textContent).toContain('Returning');
        expect(document.querySelector('.analytics-chart')).toBeTruthy();
        expect(document.querySelectorAll('.analytics-chart__hit')).toHaveLength(2);
        expect(document.getElementById('analytics-days').textContent).toContain('Aug 15');
        expect(document.querySelector('.analytics-table')).toBeTruthy();
        expect(document.querySelector('#analytics-days .analytics-table__today th').textContent).toBe('Aug 15');
        expect(document.getElementById('analytics-storage').textContent).toContain('Could not measure');
    });

    it('shows Redis occupancy by family when the summary includes it', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, summaryFixture({
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
                notCounted: ['Head to Head records expire quickly.'],
            },
        }));
        const storage = window.document.getElementById('analytics-storage').textContent;

        expect(storage).toContain('1.5 KB');
        expect(storage).toContain('Ghost replays');
        expect(storage).toContain('~1.0 KB');
        expect(storage).toContain('Analytics');
        expect(storage).toContain('Head to Head records expire quickly.');
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
        });

        expect(window.document.getElementById('analytics-windows').textContent).toContain('0');
        expect(window.document.getElementById('analytics-months').textContent).toContain('No months recorded yet');
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
            'analytics-months', 'analytics-storage', 'analytics-days']) {
            expect(window.document.getElementById(id).hidden).toBe(false);
        }
    });
});
