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

describe('moderator analytics page', () => {
    it('renders unique windows, today, tracks, and daily rows', () => {
        const { window } = analyticsDom();
        renderAnalyticsSummary(window.document, {
            from: '2026-07-02',
            to: '2026-08-15',
            today: {
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
                { date: '2026-08-14', uniquePlayers: 3, newPlayers: 0, returningPlayers: 3 },
                { date: '2026-08-15', uniquePlayers: 4, newPlayers: 1, returningPlayers: 3 },
            ],
            tracks: {
                daily: [{ trackName: 'Classic Circuit', count: 2 }],
                campaign: [],
                challenge: [{ trackName: 'Classic Circuit', count: 1 }],
            },
        });

        expect(window.document.getElementById('analytics-range').textContent).toBe(
            '2026-07-02 to 2026-08-15',
        );
        expect(window.document.getElementById('analytics-windows').textContent).toContain('4');
        expect(window.document.getElementById('analytics-windows').textContent).toContain('29');
        expect(window.document.getElementById('analytics-today').textContent).toContain('Returning');
        expect(window.document.getElementById('analytics-tracks').textContent).toContain('Classic Circuit');
        expect(window.document.getElementById('analytics-tracks').textContent).toContain('None yet');
        expect(window.document.getElementById('analytics-windows').textContent).toContain('player-days');
        expect(window.document.getElementById('analytics-trend').textContent).toContain('Unique players');
        expect(window.document.querySelector('.analytics-chart')).toBeTruthy();
        expect(window.document.getElementById('analytics-days').textContent).toContain('2026-08-15');
        expect(window.document.querySelector('.analytics-table')).toBeTruthy();
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
    });
});
