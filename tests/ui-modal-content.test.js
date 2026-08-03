import { afterEach, describe, expect, it, vi } from 'vitest';
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

        expect(deltaEl.textContent).toBe('-0.880s');
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

        expect(deltaEl.textContent).toBe('+0.120s');
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
        expect(component.formatTime(62.34567)).toBe('01:02.346');
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

    it('renders accessible Race actions only for eligible opponent rows', () => {
        const originalDocument = global.document;
        const dom = new JSDOM('<div id="leaderboard"></div>');
        global.document = dom.window.document;
        const container = dom.window.document.getElementById('leaderboard');
        const component = new ModalContentUi();

        const opponent = {
            rank: 1,
            displayName: 'Fast Racer',
            bestTime: 6.4,
            opponentRaceAvailable: true,
        };
        component.renderScoreboardList(container, {
            topRows: [
                opponent,
                { rank: 2, displayName: 'No Ghost', bestTime: 7.2, opponentRaceAvailable: false },
                {
                    rank: 3,
                    displayName: 'You',
                    bestTime: 8.1,
                    isCurrentPlayer: true,
                    opponentRaceAvailable: true,
                },
            ],
            currentPlayerRow: { rank: 3, displayName: 'You', bestTime: 8.1, isCurrentPlayer: true },
            totalCount: 3,
            leaderboardEntryCount: 3,
        }, 'campaign', 'circuit', null, { raceOpponentEnabled: true });

        const rows = container.querySelectorAll('.leaderboard-row');
        expect(rows[0].classList.contains('is-raceable')).toBe(true);
        expect(rows[0].getAttribute('role')).toBe('button');
        expect(rows[0].getAttribute('tabindex')).toBe('0');
        expect(rows[0].getAttribute('aria-label')).toBe("Race Fast Racer's ghost");
        const raceIcon = rows[0].querySelector('.leaderboard-row__race-icon');
        expect(raceIcon?.getAttribute('viewBox')).toBe('0 0 384 512');
        expect(raceIcon?.getAttribute('fill')).toBe('currentColor');
        expect(raceIcon?.querySelector('path')?.getAttribute('d')).toContain('M40.1 467.1');
        expect(raceIcon?.textContent).toBe('');
        expect(rows[0]._opponentRaceEntry).toBe(opponent);
        expect(rows[1].classList.contains('is-raceable')).toBe(false);
        expect(rows[2].classList.contains('is-raceable')).toBe(false);

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

/**
 * Every element the renderer creates replays the row entrance animation, and a
 * standings screen publishes the same rows two or three times per open —
 * cached, refreshing, then fetched. These pin the rows to the elements already
 * on screen so a refresh rewrites text instead of re-dealing the list.
 */
describe('leaderboard row patching', () => {
    const originalDocument = global.document;

    function mountLeaderboard(html = '<div id="leaderboard"></div>') {
        const dom = new JSDOM(html);
        global.document = dom.window.document;
        return {
            container: dom.window.document.getElementById('leaderboard'),
            component: new ModalContentUi(),
        };
    }

    afterEach(() => {
        global.document = originalDocument;
    });

    it('keeps the same row elements when a refresh republishes the standings', () => {
        const { container, component } = mountLeaderboard();
        const snapshot = (twoName, twoTime) => ({
            topRows: [
                { rank: 1, displayName: 'One', bestTime: 10.5 },
                { rank: 2, displayName: twoName, bestTime: twoTime },
            ],
            totalCount: 2,
            leaderboardEntryCount: 2,
        });

        component.renderScoreboardList(container, snapshot('Two', 11.25), 'daily', 'circuit');
        const firstPass = [...container.querySelectorAll('.leaderboard-row')];
        expect(firstPass).toHaveLength(2);

        component.renderScoreboardList(container, snapshot('Renamed', 9.75), 'daily', 'circuit');
        const secondPass = [...container.querySelectorAll('.leaderboard-row')];

        expect(secondPass).toHaveLength(2);
        expect(secondPass[0]).toBe(firstPass[0]);
        expect(secondPass[1]).toBe(firstPass[1]);
        expect(secondPass[1].querySelector('.combined-row-name').textContent).toBe('Renamed');
        expect(secondPass[1].querySelector('.combined-row-time').textContent).toBe('00:09.750');
        expect(container.querySelectorAll('.leaderboard-section')).toHaveLength(1);
    });

    it('creates only the appended rows when the next standings page lands', () => {
        const { container, component } = mountLeaderboard();
        const page = (count, hasMore) => ({
            topRows: Array.from({ length: count }, (unused, index) => ({
                rank: index + 1,
                displayName: `Racer ${index + 1}`,
                bestTime: 10 + index,
            })),
            pageLimit: 2,
            hasMore,
            totalCount: count,
            leaderboardEntryCount: count,
        });

        component.renderScoreboardList(container, page(2, true), 'daily', 'circuit');
        const firstPage = [...container.querySelectorAll('.leaderboard-row')];

        component.renderScoreboardList(container, page(4, false), 'daily', 'circuit');
        const merged = [...container.querySelectorAll('.leaderboard-row')];

        expect(merged).toHaveLength(4);
        expect(merged.slice(0, 2)).toEqual(firstPage);
        expect(merged[3].querySelector('.combined-row-name').textContent).toBe('Racer 4');
        // The pagination line went away with hasMore, so nothing stale is left
        // sitting between the rows and the end of the list.
        expect(container.querySelector('.leaderboard-pagination-state')).toBe(null);
    });

    it('drops the handler from a row that stops being raceable', () => {
        const { container, component } = mountLeaderboard();
        const opponent = {
            rank: 1,
            displayName: 'Fast Racer',
            bestTime: 6.4,
            opponentRaceAvailable: true,
        };

        component.renderScoreboardList(container, {
            topRows: [opponent],
            totalCount: 1,
            leaderboardEntryCount: 1,
        }, 'campaign', 'circuit', null, { raceOpponentEnabled: true });

        const row = container.querySelector('.leaderboard-row');
        row.onclick = () => {};
        expect(row.classList.contains('is-raceable')).toBe(true);

        component.renderScoreboardList(container, {
            topRows: [{ ...opponent, opponentRaceAvailable: false }],
            totalCount: 1,
            leaderboardEntryCount: 1,
        }, 'campaign', 'circuit', null, { raceOpponentEnabled: true });

        expect(container.querySelector('.leaderboard-row')).toBe(row);
        expect(row.classList.contains('is-raceable')).toBe(false);
        expect(row.getAttribute('role')).toBe(null);
        expect(row.getAttribute('tabindex')).toBe(null);
        expect(row.onclick).toBe(null);
        expect(row._opponentRaceEntry).toBe(undefined);
        expect(row.querySelector('.leaderboard-row__race')).toBe(null);
    });

    it('replaces the loading line with rows when the fetch answers', () => {
        const { container, component } = mountLeaderboard();

        component.renderScoreboardList(container, { isLoading: true }, 'daily', 'circuit');
        expect(container.querySelector('.leaderboard-loading-state')).not.toBe(null);
        expect(container.querySelectorAll('.leaderboard-row')).toHaveLength(0);

        component.renderScoreboardList(container, {
            topRows: [{ rank: 1, displayName: 'One', bestTime: 10.5 }],
            totalCount: 1,
            leaderboardEntryCount: 1,
        }, 'daily', 'circuit');

        expect(container.querySelector('.combined-empty-msg')).toBe(null);
        expect(container.querySelectorAll('.leaderboard-row')).toHaveLength(1);
        expect(container.querySelectorAll('.leaderboard-section')).toHaveLength(1);
    });

    it('leaves the rows below in place when one drops out of the middle', () => {
        const { container, component } = mountLeaderboard();
        const withRanks = (ranks) => ({
            topRows: ranks.map((rank) => ({
                rank,
                displayName: `Racer ${rank}`,
                bestTime: 10 + rank,
            })),
            totalCount: ranks.length,
            leaderboardEntryCount: ranks.length,
        });

        component.renderScoreboardList(container, withRanks([1, 2, 3, 4]), 'daily', 'circuit');
        const before = [...container.querySelectorAll('.leaderboard-row')];

        component.renderScoreboardList(container, withRanks([1, 2, 4]), 'daily', 'circuit');
        const after = [...container.querySelectorAll('.leaderboard-row')];

        expect(after).toHaveLength(3);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        // Rank 4 keeps its own element rather than inheriting rank 3's, so it
        // is not re-inserted and does not replay the entrance.
        expect(after[2]).toBe(before[3]);
        expect(after[2].querySelector('.combined-row-name').textContent).toBe('Racer 4');
    });

    it('reuses rows for a tied rank instead of collapsing them onto one key', () => {
        const { container, component } = mountLeaderboard();
        const tied = {
            topRows: [
                { rank: 1, displayName: 'One', bestTime: 10.5 },
                { rank: 1, displayName: 'Also One', bestTime: 10.5 },
            ],
            totalCount: 2,
            leaderboardEntryCount: 2,
        };

        component.renderScoreboardList(container, tied, 'daily', 'circuit');
        const firstPass = [...container.querySelectorAll('.leaderboard-row')];
        expect(firstPass).toHaveLength(2);

        component.renderScoreboardList(container, tied, 'daily', 'circuit');
        const secondPass = [...container.querySelectorAll('.leaderboard-row')];

        expect(secondPass).toEqual(firstPass);
        expect(secondPass[1].querySelector('.combined-row-name').textContent).toBe('Also One');
    });
});
