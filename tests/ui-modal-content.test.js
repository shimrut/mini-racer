import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ModalContentUi } from '../game/race/ui-modal-content.js?v=2.08';

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
    it('renders modal action button text, icon, and shortcut hint', () => {
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

        const button = {
            children: [],
            replaceChildren: vi.fn(function replaceChildren() {
                this.children = [];
            }),
            appendChild(node) {
                this.children.push(node);
            }
        };
        const icon = { kind: 'icon' };

        const component = new ModalContentUi({});
        vi.spyOn(component, 'createModalActionIcon').mockReturnValue(icon);

        component.setModalActionButtonContent(button, 'Race Again', { shortcutLabel: 'R', iconName: 'retry' });

        expect(button.replaceChildren).toHaveBeenCalledTimes(1);
        expect(button.children[0]).toBe(icon);
        expect(button.children[1].className).toBe('modal-action-label');
        expect(button.children[1].textContent).toBe('Race Again');
        expect(button.children[2].nodeType).toBe('text');
        expect(button.children[3].className).toBe('modal-btn-kbd');
        expect(button.children[3].textContent).toBe('R');

        global.document = originalDocument;
    });

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
});
