import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ModalContentUi } from '../game/race/ui-modal-content.js';

function createClassList() {
    const classes = new Set();
    return {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
            const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
            if (shouldAdd) classes.add(name);
            else classes.delete(name);
            return shouldAdd;
        },
    };
}

describe('ui modal content helpers', () => {
    it('renders a list of lap times with a PB header', () => {
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn((tagName) => ({
                tagName,
                className: '',
                textContent: '',
                dataset: {},
                children: [],
                appendChild(node) {
                    this.children.push(node);
                }
            })),
            createTextNode: vi.fn((text) => ({ nodeType: 'text', textContent: text }))
        };

        const container = {
            children: [],
            appendChild(node) {
                this.children.push(node);
            }
        };
        const lapTimes = [19.5, 20.1];

        const component = new ModalContentUi({});
        component.renderLapTimesList(container, lapTimes, 19.5, 19.5);

        expect(container.children[0].className).toBe('runs-header-row');
        expect(container.children[1].className).toBe('lap-times-list');

        global.document = originalDocument;
    });

    it('colors PB delta green when the lap beats personal best', () => {
        const component = new ModalContentUi();
        const deltaEl = {
            textContent: '',
            classList: createClassList(),
            closest: vi.fn(() => ({
                hidden: false,
                setAttribute: vi.fn(),
                removeAttribute: vi.fn(),
            })),
        };

        component._applyCombinedWinPbDelta(deltaEl, 48.12, 49.0, null, -0.88);

        expect(deltaEl.textContent).toBe('-0.88s');
        expect(deltaEl.classList.contains('is-gain')).toBe(true);
        expect(deltaEl.classList.contains('is-loss')).toBe(false);
    });

    it('shows slower-lap PB delta as delta vs PB in win view', () => {
        const component = new ModalContentUi();
        const deltaEl = {
            textContent: '',
            classList: createClassList(),
            closest: vi.fn(() => ({
                hidden: false,
                setAttribute: vi.fn(),
                removeAttribute: vi.fn(),
            })),
        };

        component._applyCombinedWinPbDelta(deltaEl, 6.55, 6.43, null, 0.12);

        expect(deltaEl.textContent).toBe('+0.12s');
        expect(deltaEl.classList.contains('is-gain')).toBe(false);
        expect(deltaEl.classList.contains('is-loss')).toBe(true);
    });

    it('hides PB delta when there is no previous personal best to compare', () => {
        const component = new ModalContentUi();
        const statRow = {
            hidden: false,
            setAttribute: vi.fn(),
            removeAttribute: vi.fn(),
        };
        const deltaEl = {
            textContent: '',
            classList: createClassList(),
            closest: vi.fn(() => statRow),
        };

        component._applyCombinedWinPbDelta(deltaEl, 51.2, null);

        expect(deltaEl.textContent).toBe('No lap times yet');
        expect(statRow.hidden).toBe(false);
    });

    it('renders a current player row from snapshot-level rank data', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;

        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        component.renderScoreboardList(container, {
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: { bestTime: 17.6 },
            totalCount: 2,
            leaderboardEntryCount: 2,
            playerRank: 1,
            playerRankLabel: '#1',
        }, 'daily', 'circuit');

        expect(container.textContent).toContain('1');
        expect(container.textContent).toContain('You');
        expect(container.textContent).toContain('17.60');
        expect(container.textContent).not.toContain('No scores recorded yet.');

        global.document = originalDocument;
    });

    it('formats leaderboard times to millisecond precision', () => {
        const component = new ModalContentUi();

        expect(component.formatLeaderboardTime(62.34567)).toBe('01:02.346');
        expect(component.formatTime(62.34567)).toBe('01:02.35');
    });

    it('does not create a phantom current player row when rank is missing', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;

        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        component.renderScoreboardList(container, {
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 5,
            leaderboardEntryCount: 0,
            playerRank: null,
            playerRankLabel: null,
        }, 'daily', 'circuit');

        const ranks = [...container.querySelectorAll('.combined-row-rank')].map((node) => node.textContent);
        expect(ranks[0]).toBe('1');
        expect(ranks).not.toContain('0');
        expect(container.textContent).not.toContain('You');

        global.document = originalDocument;
    });

    it('renders only the loaded scored page and a pagination sentinel', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;
        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        component.renderScoreboardList(container, {
            topRows: [
                { rank: 1, displayName: 'Leader', bestTime: 12.3 },
                { rank: 2, displayName: 'Second', bestTime: 12.5 },
            ],
            nearbyRows: [{ rank: 154, displayName: 'You', bestTime: 42.3, isCurrentPlayer: true }],
            currentPlayerRow: { rank: 154, displayName: 'You', bestTime: 42.3, isCurrentPlayer: true },
            leaderboardEntryCount: 300,
            totalCount: 300,
            pageOffset: 0,
            pageLimit: 50,
            hasMore: true,
            nextOffset: 50,
        }, 'daily', 'circuit');

        expect(container.textContent).toContain('Leader');
        expect(container.textContent).not.toContain('You');
        expect(container.querySelector('.leaderboard-pagination-state')).not.toBe(null);
        expect(container.querySelectorAll('.leaderboard-row')).toHaveLength(2);

        global.document = originalDocument;
    });

    it('renders a trailing share affordance on the player row and reserved slots on the rest', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;
        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        component.renderScoreboardList(container, {
            topRows: [
                { rank: 1, displayName: 'SHIMROOT', bestTime: 6.4, isCurrentPlayer: true },
                { rank: 2, displayName: 'Other', bestTime: 9.1 },
            ],
            currentPlayerRow: { rank: 1, displayName: 'SHIMROOT', bestTime: 6.4, isCurrentPlayer: true },
            totalCount: 2,
            leaderboardEntryCount: 2,
        }, 'daily', 'circuit', null, { shareBest: { challengeId: 'daily-1', bestTime: 6.4 } });

        const rows = container.querySelectorAll('.leaderboard-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].classList.contains('is-shareable')).toBe(true);
        expect(rows[0].getAttribute('role')).toBe('button');
        expect(rows[0].getAttribute('tabindex')).toBe('0');
        expect(rows[0].querySelector('.leaderboard-row__share')).not.toBe(null);
        expect(rows[1].classList.contains('is-shareable')).toBe(false);
        expect(rows[1].querySelector('.leaderboard-row__share')).toBe(null);

        const actionSlots = container.querySelectorAll('.leaderboard-row__action');
        expect(actionSlots).toHaveLength(2);

        global.document = originalDocument;
    });

    it('omits the trailing action slots when no share option is provided', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;
        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        component.renderScoreboardList(container, {
            topRows: [
                { rank: 1, displayName: 'SHIMROOT', bestTime: 6.4, isCurrentPlayer: true },
                { rank: 2, displayName: 'Other', bestTime: 9.1 },
            ],
            currentPlayerRow: { rank: 1, displayName: 'SHIMROOT', bestTime: 6.4, isCurrentPlayer: true },
            totalCount: 2,
            leaderboardEntryCount: 2,
        }, 'daily', 'circuit');

        expect(container.querySelector('.leaderboard-row__action')).toBe(null);
        expect(container.querySelector('.leaderboard-row__share')).toBe(null);
        expect(container.querySelector('.leaderboard-row.is-shareable')).toBe(null);

        global.document = originalDocument;
    });

    it('paints combined RANK status on first open instead of dashes or a hidden column', () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="combined">
                <div id="combined-hero-medal"></div>
                <div id="combined-stats-right-group" hidden aria-hidden="true"></div>
                <div id="combined-rank-value"></div>
                <div id="combined-rank-total"></div>
                <div id="combined-time"></div>
                <div id="combined-best-lap"></div>
                <div id="combined-stat-label-1"></div>
                <div id="combined-stat-label-2"></div>
                <div id="combined-next-medal-stat"></div>
                <div id="combined-next-medal-icon-slot"></div>
                <div id="combined-next-medal-time"></div>
            </div>
        `);
        global.document = dom.window.document;
        const container = dom.window.document.getElementById('combined');
        const component = new ModalContentUi();
        const rightGroup = container.querySelector('#combined-stats-right-group');
        const rankValue = container.querySelector('#combined-rank-value');

        component.renderCombinedResults(container, {
            time: 12.34,
            bestLap: 12.34,
            scoreboardSnapshot: {
                isLoading: true,
                statusText: 'Submitting...',
                submissionStage: 'submitting',
                verificationState: 'pending',
            },
        });
        expect(rankValue.textContent).toBe('Submitting...');
        expect(rightGroup.hidden).toBe(false);

        component.renderCombinedResults(container, {
            time: 12.34,
            bestLap: 12.34,
            scoreboardSnapshot: {
                isLoading: false,
                verificationState: 'error',
                submissionStage: 'error',
                statusText: 'Run too long to rank.',
            },
        });
        expect(rankValue.textContent).toBe(
            'Run too long to rank.',
        );
        expect(rightGroup.hidden).toBe(false);

        component.renderCombinedResults(container, {
            time: 12.34,
            bestLap: 12.34,
            scoreboardSnapshot: {
                isLoading: false,
                playerRankLabel: '#3',
                totalCount: 40,
            },
        });
        expect(rankValue.querySelector('.rank-num')?.textContent).toBe('3');
        expect(container.querySelector('#combined-rank-total').textContent).toBe('of 40');
        expect(rightGroup.hidden).toBe(false);

        global.document = originalDocument;
    });
});
