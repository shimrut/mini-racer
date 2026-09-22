import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { ModalContentUi } from '../game/race/ui-modal-content.js';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';

const {
    applyRankModalStatContent,
    getModalScoreboardStatusText,
    matchesModalScoreboardContext,
    showRunsModal,
    showModalLeaderboardPayload,
    renderLeaderboardStandaloneIntro,
    renderLeaderboardDayRail,
    updateModalScoreboardSnapshot,
    updateModalLeaderboardDayOptions,
    configureRunsModalHeader,
    updateModalRunSummary,
    dismissRunsView,
    bindLeaderboardPagination,
    bindLeaderboardDaySwipe,
    _wireLeaderboardRowShare,
    _wireLeaderboardOpponentRace,
    _showLeaderboardOpponentConfirmation,
    _leaderboardShareBestOption,
} = ModalShell.prototype;

describe('standings return flow', () => {
    it('returns to the finish sheet when its standings view is dismissed', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = (callback) => callback();
        const context = {
            _runsViewMode: 'close',
            _runsReturnView: 'combined',
            closeModal: vi.fn(),
            showMainModalView: vi.fn(),
            activateModalFocusTrap: vi.fn(),
            modal: {},
        };

        try {
            dismissRunsView.call(context);

            expect(context.showMainModalView).toHaveBeenCalledOnce();
            expect(context.closeModal).not.toHaveBeenCalled();

            context._runsReturnView = 'main';
            dismissRunsView.call(context);
            expect(context.closeModal).toHaveBeenCalledOnce();
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });
});

describe('a challenge finish that has spent its comment', () => {
    function finishContext(dom, spent, phase = 'lost') {
        return {
            modalCombinedView: dom.window.document.getElementById('finish'),
            content: new ModalContentUi(),
            _challengeFinishPhase: phase,
            _challengeFinishShareRequest: { kind: 'challenge-comment', challengeId: 'c1' },
            _challengeFinishCommentSpent: spent,
            _combinedResultsLapData: { challengeConfirmPhase: phase },
            combinedPlaylistBtn: dom.window.document.getElementById('combined-playlist-btn'),
            _setShareButtonLabel: ModalShell.prototype._setShareButtonLabel,
            _challengeCommentButtonText: ModalShell.prototype._challengeCommentButtonText,
            _bindClickAction: ModalShell.prototype._bindClickAction,
            _offerPostedConcedeNextChallenge: ModalShell.prototype._offerPostedConcedeNextChallenge,
            _bindNextChallengeButton: ModalShell.prototype._bindNextChallengeButton,
            _showLockedBragButton: ModalShell.prototype._showLockedBragButton,
            _openNextChallengePost: ModalShell.prototype._openNextChallengePost,
            _startShare: () => {},
            getNextChallenge: null,
        };
    }

    function finishDom() {
        return new JSDOM(`
            <div id="finish" class="active-view">
                <div id="combined-hero-medal"></div>
                <button id="combined-playlist-btn">
                    <span class="combined-action-btn-label">Comment</span>
                </button>
            </div>
        `);
    }

    it.each([
        ['posted', 'lost', 'brag'],
        ['unconfirmed', 'lost', 'brag'],
        ['posted', 'tie', 'brag'],
        [null, 'lost', 'concede'],
        [null, 'tie', 'tie'],
    ])('leaves the button %s on a %s when a late rank answer repaints it', async (spent, phase, expected) => {
        const originalDocument = global.document;
        const dom = finishDom();
        global.document = dom.window.document;
        const context = finishContext(dom, spent, phase);

        try {
            ModalShell.prototype.updateChallengeFinishHero.call(context, {
                bestUpdate: { mode: 'campaign', improved: false, bestTimeMs: 11_200, rank: 2 },
            });
            await context._nextChallengeLookup;

            if (expected === 'brag') {
                expect(context.combinedPlaylistBtn.disabled).toBe(true);
                expect(context.combinedPlaylistBtn.querySelector('.combined-action-btn-label').textContent)
                    .toBe('BRAG');
            } else {
                expect(context.combinedPlaylistBtn.disabled).toBe(false);
                expect(context.combinedPlaylistBtn.querySelector('.combined-action-btn-label').textContent)
                    .toBe(expected === 'tie' ? 'A TIE?' : 'CONCEDE');
            }
        } finally {
            global.document = originalDocument;
        }
    });

    it('offers Change Track after a posted concede when another post exists', async () => {
        const originalDocument = global.document;
        const dom = finishDom();
        global.document = dom.window.document;
        const openChallengePost = vi.fn(async () => undefined);
        const context = finishContext(dom, 'posted', 'lost');
        context.getNextChallenge = vi.fn(async () => ({
            ok: true,
            body: { status: 'ready', postUrl: 'https://reddit.com/r/miniracer/next' },
        }));
        context.openChallengePost = openChallengePost;

        try {
            ModalShell.prototype.updateChallengeFinishHero.call(context, {
                bestUpdate: { mode: 'campaign', improved: false, bestTimeMs: 11_200, rank: 2 },
            });
            await context._nextChallengeLookup;

            expect(context.combinedPlaylistBtn.disabled).toBe(false);
            expect(context.combinedPlaylistBtn.querySelector('.combined-action-btn-label').textContent)
                .toBe('CHANGE TRACK');
            await context.combinedPlaylistBtn.onclick();
            expect(openChallengePost).toHaveBeenCalledWith('https://reddit.com/r/miniracer/next');
        } finally {
            global.document = originalDocument;
        }
    });
});

describe('challenge finish correction', () => {
    it('repaints the opponent row when the asynchronous verdict changes', () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="finish" class="active-view">
                <div id="combined-hero-medal"></div>
                <div id="combined-opponent-stat" hidden aria-hidden="true">
                    <span id="combined-opponent-delta"></span>
                </div>
            </div>
        `);
        global.document = dom.window.document;
        const view = dom.window.document.getElementById('finish');
        const context = {
            modalCombinedView: view,
            content: new ModalContentUi(),
            _challengeFinishPhase: 'pending',
            _combinedResultsLapData: {
                challengeConfirmPhase: 'pending',
                challengeVerdict: { deltaSec: -0.1 },
            },
            combinedPlaylistBtn: null,
        };

        try {
            ModalShell.prototype.updateChallengeFinishHero.call(context, {
                phase: 'lost',
                verdict: { deltaSec: 0.253 },
            });

            expect(view.querySelector('#combined-opponent-stat').hidden).toBe(false);
            expect(view.querySelector('#combined-opponent-delta').textContent).toBe('+0.253s');
            expect(view.querySelector('#combined-opponent-delta').classList.contains('is-loss')).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    it('fills VS. YOUR PB from a held origin best that this run did not beat', () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="finish" class="active-view">
                <div id="combined-hero-medal"></div>
                <span id="combined-best-lap" class="combined-stat-value--placeholder">No lap times yet</span>
                <div id="combined-stats-right-group">
                    <div id="combined-rank-value"></div>
                    <div id="combined-rank-total"></div>
                </div>
            </div>
        `);
        global.document = dom.window.document;
        const view = dom.window.document.getElementById('finish');
        const context = {
            modalCombinedView: view,
            content: new ModalContentUi(),
            _challengeFinishPhase: 'lost',
            _combinedResultsLapData: {
                lapTime: 11.844,
                challengeConfirmPhase: 'lost',
                previousPersonalBestSec: null,
                challengeViewerBest: null,
            },
            combinedPlaylistBtn: null,
        };

        try {
            ModalShell.prototype.updateChallengeFinishHero.call(context, {
                bestUpdate: {
                    mode: 'campaign',
                    improved: false,
                    bestTimeMs: 11_200,
                    rank: 2,
                },
            });

            expect(view.querySelector('#combined-best-lap').textContent).toBe('+0.644s');
            expect(view.querySelector('#combined-best-lap').classList.contains('is-loss')).toBe(true);
            expect(view.querySelector('.rank-num').textContent).toBe('2');
            expect(context._combinedResultsLapData.previousPersonalBestSec).toBe(11.2);
        } finally {
            global.document = originalDocument;
        }
    });
});

function withLeaderboardIntroMethods(context = {}) {
    return {
        renderLeaderboardDayRail: ModalShell.prototype.renderLeaderboardDayRail,
        renderLeaderboardHeaderSummary: ModalShell.prototype.renderLeaderboardHeaderSummary,
        _syncLeaderboardDayRailSelection: ModalShell.prototype._syncLeaderboardDayRailSelection,
        ...context,
        configureRunsModalHeader: context.configureRunsModalHeader ?? vi.fn(),
    };
}

function createClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
            if (force === true) {
                classes.add(name);
                return true;
            }
            if (force === false) {
                classes.delete(name);
                return false;
            }
            if (classes.has(name)) {
                classes.delete(name);
                return false;
            }
            classes.add(name);
            return true;
        },
        values: () => Array.from(classes)
    };
}

function createTestElement(tagName = 'div') {
    const attributes = {};
    const element = {
        tagName,
        className: '',
        textContent: '',
        children: [],
        hidden: false,
        disabled: false,
        scrollLeft: 0,
        dataset: {},
        classList: createClassList(),
        setAttribute: vi.fn((name, value) => {
            attributes[name] = String(value);
            if (name === 'data-challenge-id') {
                element.dataset.challengeId = String(value);
            }
        }),
        getAttribute: vi.fn((name) => attributes[name] ?? null),
        removeAttribute: vi.fn(),
        toggleAttribute: vi.fn(),
        addEventListener: vi.fn(),
        append(...nodes) {
            for (const node of nodes) {
                this.children.push(node);
                node.parent = this;
            }
        },
        appendChild(node) {
            this.children.push(node);
            node.parent = this;
            return node;
        },
        insertBefore(node, referenceNode) {
            if (!referenceNode) {
                return this.appendChild(node);
            }
            const index = this.children.indexOf(referenceNode);
            if (index < 0) {
                return this.appendChild(node);
            }
            this.children.splice(index, 0, node);
            node.parent = this;
            return node;
        },
        prepend(...nodes) {
            this.children.unshift(...nodes);
        },
        replaceChildren() {
            this.children = [];
        },
        get firstChild() {
            return this.children[0] ?? null;
        },
        querySelector: vi.fn((selector) => {
            if (selector === '.leaderboard-day-rail') {
                return element.children.find((child) => child.className === 'leaderboard-day-rail') || null;
            }
            if (selector === '.leaderboard-section') {
                return element.children.find((child) => child.className === 'leaderboard-section') || null;
            }
            const challengeMatch = selector.match(/^\[data-challenge-id="([^"]+)"\]$/);
            if (challengeMatch) {
                const challengeId = challengeMatch[1];
                const findMatch = (node) => {
                    if (node.dataset?.challengeId === challengeId) return node;
                    for (const child of node.children || []) {
                        const match = findMatch(child);
                        if (match) return match;
                    }
                    return null;
                };
                return findMatch(element);
            }
            return null;
        }),
        remove: vi.fn(function remove() {
            const parent = element.parent;
            if (!parent) return;
            parent.children = parent.children.filter((child) => child !== element);
        }),
    };
    return element;
}

function setActiveView(view) {
    for (const v of [this.modalMainView, this.modalRunsView, this.modalCombinedView, this.modalPauseView]) {
        v?.classList?.remove('active-view');
    }
    view?.classList?.add('active-view');
}

describe('ui modal runs helpers', () => {
    it('switches standings days with deliberate horizontal swipes', () => {
        const listeners = new Map();
        const onSelectLeaderboardDay = vi.fn();
        const modalLapTimes = {
            addEventListener: vi.fn((event, handler) => listeners.set(event, handler)),
            removeEventListener: vi.fn((event) => listeners.delete(event)),
        };
        const context = {
            modalLapTimes,
            _modalRunsPayload: {
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions: [
                    { challengeId: 'today' },
                    { challengeId: 'yesterday' },
                    { challengeId: 'older' },
                ],
                onSelectLeaderboardDay,
            },
            _leaderboardSwipeStart: null,
            _leaderboardTouchStartHandler: null,
            _leaderboardTouchEndHandler: null,
            _leaderboardTouchCancelHandler: null,
            unbindLeaderboardDaySwipe: ModalShell.prototype.unbindLeaderboardDaySwipe,
        };
        const target = { closest: vi.fn(() => null) };

        bindLeaderboardDaySwipe.call(context);
        listeners.get('touchstart')({ target, touches: [{ clientX: 180, clientY: 100 }] });
        listeners.get('touchend')({ changedTouches: [{ clientX: 110, clientY: 106 }] });

        expect(onSelectLeaderboardDay).toHaveBeenCalledWith('yesterday');

        context._modalRunsPayload.selectedLeaderboardDayId = 'yesterday';
        listeners.get('touchstart')({ target, touches: [{ clientX: 110, clientY: 100 }] });
        listeners.get('touchend')({ changedTouches: [{ clientX: 180, clientY: 104 }] });

        expect(onSelectLeaderboardDay).toHaveBeenLastCalledWith('today');
    });

    it('ignores short, vertical, and control-origin standings gestures', () => {
        const listeners = new Map();
        const onSelectLeaderboardDay = vi.fn();
        const context = {
            modalLapTimes: {
                addEventListener: vi.fn((event, handler) => listeners.set(event, handler)),
                removeEventListener: vi.fn((event) => listeners.delete(event)),
            },
            _modalRunsPayload: {
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions: [
                    { challengeId: 'today' },
                    { challengeId: 'yesterday' },
                ],
                onSelectLeaderboardDay,
            },
            _leaderboardSwipeStart: null,
            _leaderboardTouchStartHandler: null,
            _leaderboardTouchEndHandler: null,
            _leaderboardTouchCancelHandler: null,
            unbindLeaderboardDaySwipe: ModalShell.prototype.unbindLeaderboardDaySwipe,
        };
        const content = { closest: vi.fn(() => null) };

        bindLeaderboardDaySwipe.call(context);
        listeners.get('touchstart')({ target: content, touches: [{ clientX: 180, clientY: 100 }] });
        listeners.get('touchend')({ changedTouches: [{ clientX: 145, clientY: 103 }] });
        listeners.get('touchstart')({ target: content, touches: [{ clientX: 180, clientY: 100 }] });
        listeners.get('touchend')({ changedTouches: [{ clientX: 110, clientY: 190 }] });
        listeners.get('touchstart')({
            target: { closest: vi.fn(() => ({})) },
            touches: [{ clientX: 180, clientY: 100 }],
        });
        listeners.get('touchend')({ changedTouches: [{ clientX: 110, clientY: 100 }] });

        expect(onSelectLeaderboardDay).not.toHaveBeenCalled();
    });

    it('keeps the date strip rendered alongside swipe navigation', () => {
        const originalDocument = global.document;
        const header = createTestElement('header');
        const modalLapTimes = createTestElement('div');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        try {
            renderLeaderboardStandaloneIntro.call(withLeaderboardIntroMethods({
                modalLapTimes,
                modalRunsView: {
                    querySelector: vi.fn((selector) => (
                        selector === '.reusable-modal-header' ? header : null
                    ))
                },
                _modalRunsPayload: {
                    showGlobalLeaderboard: true,
                    scoreboardChallengeId: 'today',
                    scoreboardTrackKey: 'circuit',
                    selectedLeaderboardDayId: 'today',
                    leaderboardDayOptions: [
                        { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
                        { challengeId: 'yesterday', dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
                        { challengeId: 'older', dayLabel: 'Mon', dateLabel: 'Jul 13', monthLabel: 'Jul', dayNumberLabel: '13' },
                    ],
                    scoreboardSnapshot: { playerRankLabel: '#2', leaderboardEntryCount: 2 },
                    onSelectLeaderboardDay: vi.fn(),
                },
                content: { formatTime: vi.fn(), formatLeaderboardTime: vi.fn() },
            }));

            const rail = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(rail).toBeTruthy();
            expect(rail.children).toHaveLength(3);
            expect(rail.children[0].disabled).toBe(false);
            expect(rail.children[0].getAttribute('aria-disabled')).toBe('true');
            const getChipLabels = (button) => {
                const stack = button.children[0];
                if (stack.children.length === 1) {
                    return stack.children[0].textContent;
                }
                return [
                    stack.children[0].textContent,
                    stack.children[1].textContent
                ];
            };
            expect(rail.children.map(getChipLabels)).toEqual([
                'Today',
                ['Jul', '14'],
                ['Jul', '13']
            ]);
            expect(rail.children[0].classList.contains('leaderboard-day-chip--today')).toBe(true);
            const dateStack = rail.children[1].children[0];
            expect(dateStack.className).toBe('leaderboard-day-chip__stack');
            expect(dateStack.children[0].className).toBe('leaderboard-day-chip__month');
            expect(dateStack.children[1].className).toBe('leaderboard-day-chip__day');
        } finally {
            global.document = originalDocument;
        }
    });

    it('preserves the day rail when only the standings snapshot changes', () => {
        const originalDocument = global.document;
        const header = createTestElement('header');
        const modalLapTimes = createTestElement('div');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const leaderboardDayOptions = [
            { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
            { challengeId: 'yesterday', dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
        ];
        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            modalRunsView: {
                classList: createClassList(['active-view']),
                querySelector: vi.fn((selector) => (
                    selector === '.reusable-modal-header' ? header : null
                )),
            },
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'today',
                scoreboardTrackKey: 'circuit',
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions,
                scoreboardSnapshot: { playerRankLabel: '#2', leaderboardEntryCount: 2 },
                onSelectLeaderboardDay: vi.fn(),
            },
            content: { renderScoreboardList: vi.fn() },
            bindLeaderboardPagination: vi.fn(),
            _wireLeaderboardRowShare: vi.fn(),
            _leaderboardShareBestOption: () => null,
        });

        try {
            renderLeaderboardStandaloneIntro.call(context);
            const railBefore = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(railBefore).toBeTruthy();

            updateModalScoreboardSnapshot.call(context, {
                playerRankLabel: '#1',
                leaderboardEntryCount: 5,
                isRefreshing: false,
            });

            const railAfter = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(railAfter).toBe(railBefore);
            expect(header.children.length).toBeGreaterThan(0);
            expect(context.content.renderScoreboardList).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('renders placeholder day chips as disabled until a challenge id is available', () => {
        const originalDocument = global.document;
        const modalLapTimes = createTestElement('motion');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'today',
                scoreboardTrackKey: 'circuit',
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions: [
                    { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
                    { challengeId: null, dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
                ],
                scoreboardSnapshot: { playerRankLabel: '#2' },
                onSelectLeaderboardDay: vi.fn(),
            },
        });

        try {
            renderLeaderboardDayRail.call(context);
            const rail = modalLapTimes.children.find((child) => child.className === 'leaderboard-day-rail');
            expect(rail?.children[1]?.disabled).toBe(true);
            expect(rail?.children[1]?.getAttribute('aria-disabled')).toBe('true');
        } finally {
            global.document = originalDocument;
        }
    });

    it('adapts the shared standings rail labels for Campaign stages', () => {
        const originalDocument = global.document;
        const modalLapTimes = createTestElement('motion');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'numbered-v1-00',
                scoreboardTrackKey: 'numberZero',
                leaderboardRailLabel: 'Campaign stages',
                selectedLeaderboardDayId: 'numbered-v1-00',
                leaderboardDayOptions: [
                    {
                        challengeId: 'numbered-v1-00',
                        monthLabel: 'Stage',
                        dayNumberLabel: '00',
                        dateLabel: 'Number Zero',
                        ariaLabel: 'View Number Zero campaign standings',
                    },
                    {
                        challengeId: 'numbered-v1-01',
                        monthLabel: 'Stage',
                        dayNumberLabel: '01',
                        dateLabel: 'Number One',
                        ariaLabel: 'View Number One campaign standings',
                    },
                ],
                scoreboardSnapshot: { playerRankLabel: '#2' },
                onSelectLeaderboardDay: vi.fn(),
            },
        });

        try {
            renderLeaderboardDayRail.call(context);
            const rail = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(rail.getAttribute('aria-label')).toBe('Campaign stages');
            expect(rail.children[1].getAttribute('aria-label'))
                .toBe('View Number One campaign standings');
        } finally {
            global.document = originalDocument;
        }
    });

    it('rebuilds the day rail when updateModalLeaderboardDayOptions is called', () => {
        const originalDocument = global.document;
        const modalLapTimes = createTestElement('motion');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const initialOptions = [
            { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
            { challengeId: null, dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
        ];
        const updatedOptions = [
            { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
            { challengeId: 'yesterday', dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
        ];
        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'today',
                scoreboardTrackKey: 'circuit',
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions: initialOptions,
                scoreboardSnapshot: { playerRankLabel: '#2' },
                onSelectLeaderboardDay: vi.fn(),
            },
            bindLeaderboardDaySwipe: vi.fn(),
        });

        try {
            const section = createTestElement('section');
            section.className = 'leaderboard-section';
            modalLapTimes.appendChild(section);

            renderLeaderboardDayRail.call(context);
            expect(modalLapTimes.children[0].className).toBe('leaderboard-day-rail');
            expect(modalLapTimes.children[1]).toBe(section);

            updateModalLeaderboardDayOptions.call(context, {
                leaderboardDayOptions: updatedOptions,
                onSelectLeaderboardDay: vi.fn(),
            });

            const updatedRail = modalLapTimes.children.find((child) => child.className === 'leaderboard-day-rail');
            expect(updatedRail).toBeTruthy();
            expect(modalLapTimes.children[0]).toBe(updatedRail);
            expect(modalLapTimes.children[1]).toBe(section);
            expect(updatedRail.children[1]?.disabled).toBe(false);
            expect(context.bindLeaderboardDaySwipe).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('rebuilds the day rail after the modal container is cleared', () => {
        const originalDocument = global.document;
        const modalLapTimes = createTestElement('div');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const leaderboardDayOptions = [
            { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
            { challengeId: 'yesterday', dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
        ];
        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'today',
                scoreboardTrackKey: 'circuit',
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions,
                scoreboardSnapshot: { playerRankLabel: '#2', leaderboardEntryCount: 2 },
                onSelectLeaderboardDay: vi.fn(),
            },
        });

        try {
            renderLeaderboardDayRail.call(context);
            expect(modalLapTimes.children.some((child) => child.className === 'leaderboard-day-rail')).toBe(true);

            modalLapTimes.replaceChildren();
            renderLeaderboardDayRail.call(context);

            const rail = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(rail).toBeTruthy();
            expect(rail.children).toHaveLength(2);
        } finally {
            global.document = originalDocument;
        }
    });

    it('updates day rail selection in place when only the selected day changes', () => {
        const originalDocument = global.document;
        const modalLapTimes = createTestElement('div');
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        const leaderboardDayOptions = [
            { challengeId: 'today', dayLabel: 'Today', dateLabel: 'Jul 15', monthLabel: 'Jul', dayNumberLabel: '15' },
            { challengeId: 'yesterday', dayLabel: 'Tue', dateLabel: 'Jul 14', monthLabel: 'Jul', dayNumberLabel: '14' },
        ];
        const context = withLeaderboardIntroMethods({
            modalLapTimes,
            _modalRunsPayload: {
                showGlobalLeaderboard: true,
                scoreboardChallengeId: 'today',
                scoreboardTrackKey: 'circuit',
                selectedLeaderboardDayId: 'today',
                leaderboardDayOptions,
                scoreboardSnapshot: { playerRankLabel: '#2', leaderboardEntryCount: 2 },
                onSelectLeaderboardDay: vi.fn(),
            },
        });

        try {
            renderLeaderboardDayRail.call(context);
            const railBefore = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            const yesterdayChip = railBefore.children[1];

            context._modalRunsPayload.selectedLeaderboardDayId = 'yesterday';
            renderLeaderboardDayRail.call(context);

            const railAfter = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(railAfter).toBe(railBefore);
            expect(yesterdayChip.classList.contains('is-selected')).toBe(true);
            expect(railBefore.children[0].classList.contains('is-selected')).toBe(false);
        } finally {
            global.document = originalDocument;
        }
    });

    it('loads the next leaderboard page when scrolling near the bottom', async () => {
        const onLoadMoreLeaderboard = vi.fn(async () => {});
        let scrollHandler = null;
        const paginationState = { textContent: '', classList: createClassList() };
        const modalLapTimes = {
            scrollHeight: 1000,
            scrollTop: 650,
            clientHeight: 200,
            addEventListener: vi.fn((event, handler) => {
                if (event === 'scroll') scrollHandler = handler;
            }),
            querySelector: vi.fn(() => paginationState),
        };
        const context = {
            modalLapTimes,
            _modalRunsPayload: {
                scoreboardSnapshot: { hasMore: true },
                onLoadMoreLeaderboard,
            },
            _leaderboardPageLoading: false,
            unbindLeaderboardPagination: vi.fn(),
        };

        bindLeaderboardPagination.call(context);
        await scrollHandler();

        expect(onLoadMoreLeaderboard).toHaveBeenCalledTimes(1);
        expect(paginationState.textContent).toBe('Loading more racers…');
    });

    it('opens leaderboard view without inherited result modal styling', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const originalDocument = global.document;
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
        global.document = {
            getElementById: vi.fn(() => null)
        };

        const modalClassList = createClassList([
            'active',
            'modal--win',
            'modal--pause'
        ]);
        const mainClassList = createClassList(['active-view']);
        const combinedClassList = createClassList(['active-view']);
        const runsClassList = createClassList();
        const modalLapTimes = { replaceChildren: vi.fn(), querySelector: vi.fn(() => null) };
        const context = {
            modal: { classList: modalClassList },
            modalTitle: {},
            modalLapTimes,
            modalMainView: { classList: mainClassList },
            modalCombinedView: { classList: combinedClassList },
            modalRunsView: { classList: runsClassList },
            backToMainBtn: {
                querySelector: vi.fn(() => ({ textContent: '' })),
                setAttribute: vi.fn(),
                focus: vi.fn()
            },
            content: {
                renderLapTimesList: vi.fn(),
                renderScoreboardList: vi.fn(),
                centerLeaderboardCurrentRow: vi.fn()
            },
            cancelPendingModalClose: vi.fn(),
            _hidePauseTrackPreview: vi.fn(),
            _setActiveView: setActiveView,
            getCurrentTrackKey: vi.fn(() => 'circuit'),
            isModalActive: vi.fn(() => true),
            activateModalFocusTrap: vi.fn(),
            _leaderboardShareBestOption: ModalShell.prototype._leaderboardShareBestOption,
            _wireLeaderboardRowShare: () => {}
        };

        try {
            showRunsModal.call(context, null, null, null, 'close', {
                scoreboardSnapshot: { isLoading: true },
                scoreboardTrackKey: 'circuit'
            });

            expect(modalClassList.values()).not.toContain('modal--win');
            expect(modalClassList.values()).not.toContain('modal--pause');
            expect(combinedClassList.contains('active-view')).toBe(false);
            expect(runsClassList.contains('active-view')).toBe(true);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            global.document = originalDocument;
        }
    });

    it('trims scoreboard status text and returns null for blanks', () => {
        expect(getModalScoreboardStatusText({ statusText: '  Pending verification  ' })).toBe('Pending verification');
        expect(getModalScoreboardStatusText({ statusText: '   ' })).toBe(null);
        expect(getModalScoreboardStatusText(null)).toBe(null);
    });

    it('routes leaderboard actions to the correct destination', () => {
        const openDailyChallengeLeaderboard = vi.fn();
        const openDailyChallengeLeaderboardForChallenge = vi.fn();
        const showTrackLeaderboardModal = vi.fn();
        const scoreboardSnapshot = { playerRankLabel: '#2' };

        showModalLeaderboardPayload.call({
            _modalRunsPayload: {
                scoreboardChallengeId: 'daily-1',
                scoreboardTrackKey: 'circuit',
                scoreboardSnapshot,
                scoreboardMode: TRACK_MODE_DAILY_GP
            },
            getLeaderboards: () => ({
                openDailyChallengeLeaderboard,
                openDailyChallengeLeaderboardForChallenge,
                showTrackLeaderboardModal
            })
        });

        expect(openDailyChallengeLeaderboardForChallenge).toHaveBeenCalledWith({
            id: 'daily-1',
            trackKey: 'circuit',
            scoreboardSnapshot,
        }, 'back');
        expect(openDailyChallengeLeaderboard).not.toHaveBeenCalled();
        expect(showTrackLeaderboardModal).not.toHaveBeenCalled();

        showModalLeaderboardPayload.call({
            _modalRunsPayload: {
                scoreboardChallengeId: null,
                scoreboardTrackKey: 'circuit',
                scoreboardMode: TRACK_MODE_DAILY_GP
            },
            getLeaderboards: () => ({
                openDailyChallengeLeaderboard,
                openDailyChallengeLeaderboardForChallenge,
                showTrackLeaderboardModal
            })
        });

        expect(showTrackLeaderboardModal).toHaveBeenCalledTimes(1);
        expect(showTrackLeaderboardModal).toHaveBeenLastCalledWith('circuit', 'back');
    });

    it('lets a finish supply its own standings screen instead of the Daily one', () => {
        const openDailyChallengeLeaderboardForChallenge = vi.fn();
        const showTrackLeaderboardModal = vi.fn();
        const onOpenStandings = vi.fn();

        showModalLeaderboardPayload.call({
            _modalRunsPayload: {
                scoreboardChallengeId: 'numbered-v1-03',
                scoreboardTrackKey: 'circuit',
                scoreboardSnapshot: { playerRankLabel: '#3' },
                onOpenStandings,
            },
            getLeaderboards: () => ({
                openDailyChallengeLeaderboardForChallenge,
                showTrackLeaderboardModal,
            })
        });

        expect(onOpenStandings).toHaveBeenCalledTimes(1);
        expect(openDailyChallengeLeaderboardForChallenge).not.toHaveBeenCalled();
        expect(showTrackLeaderboardModal).not.toHaveBeenCalled();
    });

    it('keeps the player rank in the header summary and moves time under the track name', () => {
        const originalDocument = global.document;
        const header = createTestElement('header');
        const modalLapTimes = createTestElement('div');
        const titleEl = createTestElement('span');
        const subtitleEl = createTestElement('span');
        subtitleEl.hidden = true;
        const modalRunsView = {
            querySelector: vi.fn((selector) => {
                if (selector === '.reusable-modal-header') return header;
                if (selector === '[data-modal-title]') return titleEl;
                if (selector === '[data-modal-subtitle]') return subtitleEl;
                if (selector === '[data-modal-close]') return null;
                return null;
            })
        };
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        try {
            renderLeaderboardStandaloneIntro.call(withLeaderboardIntroMethods({
                modalLapTimes,
                modalRunsView,
                _modalRunsPayload: {
                    showGlobalLeaderboard: true,
                    scoreboardChallengeId: 'daily-1',
                    scoreboardTrackKey: 'circuit',
                    scoreboardSnapshot: {
                        playerRankLabel: '#2',
                        currentPlayerRow: { bestTime: 42.317 },
                        totalCount: 13,
                        leaderboardEntryCount: 4
                    }
                },
                content: { formatTime: vi.fn(() => '42.32'), formatLeaderboardTime: vi.fn(() => '00:42.32') },
                configureRunsModalHeader,
                _runsViewMode: 'close'
            }));

            const summary = header.children.find((child) => (
                child.className === 'leaderboard-summary leaderboard-summary--header'
            ));
            expect(summary).toBeTruthy();
            expect(summary.children[0].textContent).toBe('#2');
            expect(summary.children[1].getAttribute('aria-label')).toBe('4 racers');
            expect(summary.children[1].children[0].textContent).toBe('4');
            expect(summary.children[1].children[1].classList.contains('leaderboard-summary__racer-icon')).toBe(true);
            expect(subtitleEl.textContent).toBe('00:42.32');
            expect(subtitleEl.hidden).toBe(false);
        } finally {
            global.document = originalDocument;
        }
    });

    it('renders rank loading as a compact header status', () => {
        const originalDocument = global.document;
        const header = createTestElement('header');
        const modalLapTimes = createTestElement('div');
        const modalRunsView = {
            querySelector: vi.fn((selector) => (
                selector === '.reusable-modal-header' ? header : null
            ))
        };
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        try {
            renderLeaderboardStandaloneIntro.call(withLeaderboardIntroMethods({
                modalLapTimes,
                modalRunsView,
                _modalRunsPayload: {
                    showGlobalLeaderboard: true,
                    scoreboardChallengeId: 'daily-1',
                    scoreboardTrackKey: 'circuit',
                    scoreboardSnapshot: { isLoading: true }
                }
            }));

            const summary = header.children.find((child) => (
                child.className === 'leaderboard-summary leaderboard-summary--header'
            ));
            const value = summary.children[0];
            const meta = summary.children[1];
            expect(value.classList.contains('is-loading')).toBe(true);
            expect(value.children[0].textContent).toBe('Rank');
            expect(value.children[1].className).toBe('modal-rank-spinner');
            expect(value.getAttribute('aria-label')).toBe('Loading your rank');
            expect(meta.hidden).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    it('keeps the cached rank visible with a compact refresh spinner', () => {
        const originalDocument = global.document;
        const header = createTestElement('header');
        const modalLapTimes = createTestElement('div');
        const modalRunsView = {
            querySelector: vi.fn((selector) => (
                selector === '.reusable-modal-header' ? header : null
            ))
        };
        global.document = {
            createElement: vi.fn((tagName) => createTestElement(tagName)),
            createElementNS: vi.fn((namespace, tagName) => createTestElement(tagName))
        };

        try {
            renderLeaderboardStandaloneIntro.call(withLeaderboardIntroMethods({
                modalLapTimes,
                modalRunsView,
                _modalRunsPayload: {
                    showGlobalLeaderboard: true,
                    scoreboardChallengeId: 'daily-1',
                    scoreboardTrackKey: 'circuit',
                    scoreboardSnapshot: {
                        playerRankLabel: '#2',
                        totalCount: 4,
                        leaderboardEntryCount: 4,
                        isRefreshing: true
                    }
                },
                content: { formatTime: vi.fn(), formatLeaderboardTime: vi.fn() }
            }));

            const summary = header.children.find((child) => (
                child.className === 'leaderboard-summary leaderboard-summary--header'
            ));
            const value = summary.children[0];
            const meta = summary.children[1];
            expect(value.textContent).toBe('#2');
            expect(value.classList.contains('is-refreshing')).toBe(true);
            expect(value.getAttribute('aria-label')).toBe('#2; refreshing standings');
            expect(value.toggleAttribute).toHaveBeenCalledWith('aria-busy', true);
            expect(value.children[0].className)
                .toBe('modal-rank-spinner leaderboard-refresh-spinner');
            expect(meta.hidden).toBe(false);
        } finally {
            global.document = originalDocument;
        }
    });

    it('builds a share-best option only when the player has a shareable time', () => {
        const ctx = {
            _modalRunsPayload: {
                scoreboardMode: TRACK_MODE_DAILY_GP,
                scoreboardChallengeId: 'daily-1',
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };

        expect(_leaderboardShareBestOption.call(ctx)).toEqual({
            challengeId: 'daily-1',
            bestTime: 42.317
        });

        const campaign = {
            _modalRunsPayload: {
                scoreboardMode: 'campaign',
                scoreboardChallengeId: 'numbered-v1-00',
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };
        expect(_leaderboardShareBestOption.call(campaign)).toBeNull();

        const noChallenge = {
            _modalRunsPayload: {
                scoreboardMode: TRACK_MODE_DAILY_GP,
                scoreboardChallengeId: null,
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };
        expect(_leaderboardShareBestOption.call(noChallenge)).toBeNull();

        const noTime = {
            _modalRunsPayload: {
                scoreboardMode: TRACK_MODE_DAILY_GP,
                scoreboardChallengeId: 'daily-1',
                scoreboardSnapshot: { currentPlayerRow: { bestTime: NaN } }
            }
        };
        expect(_leaderboardShareBestOption.call(noTime)).toBeNull();
    });

    it('wires the player row to share and ignores a disabled share button', () => {
        const shareBtn = createTestElement('button');
        shareBtn.disabled = false;
        const row = createTestElement('div');
        row.querySelector = vi.fn((sel) => (
            sel === '.leaderboard-row__share' ? shareBtn : null
        ));
        const modalLapTimes = createTestElement('div');
        modalLapTimes.querySelector = vi.fn((sel) => (
            sel === '.leaderboard-row.is-shareable' ? row : null
        ));
        const startShare = vi.fn();
        const ctx = {
            modalLapTimes,
            modalRunsView: {},
            _startShare: startShare,
            _modalRunsPayload: {
                scoreboardChallengeId: 'daily-1',
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };

        _wireLeaderboardRowShare.call(ctx);

        expect(typeof row.onclick).toBe('function');
        row.onclick();
        expect(startShare).toHaveBeenCalledTimes(1);
        expect(startShare.mock.calls[0][0]).toEqual({ source: 'standings', challengeId: 'daily-1' });
        expect(startShare.mock.calls[0][1]).toBe(shareBtn);

        shareBtn.disabled = true;
        row.onclick();
        expect(startShare).toHaveBeenCalledTimes(1);
    });

    it('wires eligible opponent rows for pointer and keyboard activation', () => {
        const entry = {
            rank: 2,
            displayName: 'Rival',
            bestTime: 9.1,
            opponentRaceAvailable: true,
        };
        const row = createTestElement('div');
        row._opponentRaceEntry = entry;
        const modalLapTimes = createTestElement('div');
        modalLapTimes.querySelectorAll = vi.fn((selector) => (
            selector === '.leaderboard-row.is-raceable' ? [row] : []
        ));
        const showConfirmation = vi.fn();
        const ctx = {
            modalLapTimes,
            _onRaceOpponent: vi.fn(),
            _showLeaderboardOpponentConfirmation: showConfirmation,
        };

        _wireLeaderboardOpponentRace.call(ctx);
        row.onclick();
        expect(showConfirmation).toHaveBeenCalledWith(entry, row);

        const preventDefault = vi.fn();
        row.onkeydown({ key: 'Enter', preventDefault });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(showConfirmation).toHaveBeenCalledTimes(2);
    });

    it('confirms an opponent with rank, time, and Campaign stage context', () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-runs-view" class="active-view">
                    <div id="modal-lap-times"></div>
                </div>
            </div>
        `);
        global.document = dom.window.document;
        const shell = new ModalShell({
            content: {
                formatLeaderboardTime: (time) => `00:0${time.toFixed(3)}`,
            },
        });
        const entry = {
            rank: 2,
            displayName: 'Rival',
            bestTime: 9.1,
            opponentRaceAvailable: true,
        };
        const onRaceOpponent = vi.fn();
        const triggerRow = dom.window.document.createElement('div');
        triggerRow.tabIndex = 0;
        dom.window.document.getElementById('modal-lap-times').appendChild(triggerRow);
        shell._onRaceOpponent = onRaceOpponent;
        shell._modalRunsPayload = {
            scoreboardMode: 'campaign',
            scoreboardTrackKey: 'circuit',
            selectedLeaderboardDayId: 'numbered-v1-02',
            leaderboardDayOptions: [{
                challengeId: 'numbered-v1-02',
                monthLabel: 'Stage',
                dayNumberLabel: '3',
            }],
        };

        _showLeaderboardOpponentConfirmation.call(shell, entry, triggerRow);

        const panel = dom.window.document.querySelector('.leaderboard-race-panel');
        expect(panel?.getAttribute('role')).toBe('dialog');
        expect(panel?.textContent).toContain('Race Rival?');
        expect(panel?.textContent).toContain('Classic Circuit · Stage 3');
        expect(panel?.textContent).toContain('#2 · 00:09.100');
        expect(dom.window.document.activeElement?.textContent).toBe('Race Ghost');

        const buttons = panel.querySelectorAll('button');
        buttons[0].click();
        expect(dom.window.document.querySelector('.leaderboard-race-panel')).toBe(null);
        expect(dom.window.document.activeElement).toBe(triggerRow);
        expect(onRaceOpponent).not.toHaveBeenCalled();

        _showLeaderboardOpponentConfirmation.call(shell, entry, triggerRow);
        dom.window.document.querySelectorAll('.leaderboard-race-panel button')[1].click();
        expect(onRaceOpponent).toHaveBeenCalledWith(entry);
        expect(dom.window.document.querySelector('.leaderboard-race-panel')).toBe(null);

        global.document = originalDocument;
    });

    it('matches modal scoreboard contexts for track and challenge payloads', () => {
        expect(matchesModalScoreboardContext.call({
            isModalActive: () => true,
            _modalRunsPayload: {
                scoreboardChallengeId: 'daily-1',
                scoreboardTrackKey: 'circuit',
                scoreboardMode: TRACK_MODE_DAILY_GP
            }
        }, { challengeId: 'daily-1' })).toBe(true);

        expect(matchesModalScoreboardContext.call({
            isModalActive: () => true,
            _modalRunsPayload: {
                scoreboardChallengeId: null,
                scoreboardTrackKey: 'circuit',
                scoreboardMode: TRACK_MODE_DAILY_GP
            }
        }, { trackKey: 'circuit', mode: TRACK_MODE_DAILY_GP })).toBe(true);
    });

    it('refreshes modal run summaries in-place when the main modal view is active', () => {
        const primaryValue = { textContent: '22.40s' };
        const modalLapTimes = { replaceChildren: vi.fn() };
        const renderLapTimesList = vi.fn();

        const context = {
            _modalRunsPayload: {
                lapTimesArray: [22.4, 22.9],
                bestTime: 22.4,
                currentTime: 22.4,
                scoreboardChallengeId: null,
                scoreboardTrackKey: 'circuit',
                scoreboardSnapshot: { isLoading: true, statusText: 'Verifying...' },
                scoreboardMode: TRACK_MODE_DAILY_GP,
                scoreboardSubhead: null,
                showGlobalLeaderboard: true,
                allowLeaderboardOpen: true
            },
            modalStatsRow: {
                querySelector: vi.fn((selector) => (
                    selector === '.modal-stat-stack:not([data-modal-rank-stat]) .modal-stat-value'
                        ? primaryValue
                        : null
                ))
            },
            modalLapTimes,
            modalMainView: {
                classList: {
                    contains: (className) => className === 'active-view'
                }
            },
            modalRunsView: {
                classList: {
                    contains: () => false
                }
            },
            content: {
                renderLapTimesList
            },
            showRunsModal: vi.fn(),
            _runsViewMode: 'back'
        };

        updateModalRunSummary.call(context, {
            bestTime: 22.18,
            currentTime: 22.18,
            lapTimesArray: [22.18, 22.4]
        });

        expect(context._modalRunsPayload).toMatchObject({
            bestTime: 22.18,
            currentTime: 22.18,
            lapTimesArray: [22.18, 22.4]
        });
        expect(primaryValue.textContent).toBe('22.180s');
        expect(modalLapTimes.replaceChildren).toHaveBeenCalledTimes(1);
        expect(renderLapTimesList).toHaveBeenCalledWith(
            modalLapTimes,
            [22.18, 22.4],
            22.18,
            22.18
        );
    });

    it('applies rank stat loading state using scoreboard display rules', () => {
        let statusNode = null;
        const spinnerNodes = [];
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn(() => ({
                className: '',
                dataset: {},
                textContent: '',
                setAttribute: vi.fn()
            }))
        };

        const valueNode = {
            replaceChildren: vi.fn(),
            toggleAttribute: vi.fn(),
            textContent: '',
            appendChild: vi.fn((node) => spinnerNodes.push(node))
        };
        const labelNode = {
            textContent: 'Rank'
        };
        const rankStat = {
            querySelector: vi.fn((selector) => {
                if (selector === '[data-modal-rank-value]') return valueNode;
                if (selector === '[data-modal-rank-status]') return statusNode;
                if (selector === '.modal-stat-label') return labelNode;
                return null;
            }),
            appendChild: vi.fn((node) => {
                statusNode = node;
            })
        };

        applyRankModalStatContent.call({}, rankStat, {
            playerRankLabel: null,
            isLoading: true,
            statusText: 'Pending verification'
        });

        expect(valueNode.textContent).toBe('Pending verification');
        expect(valueNode.toggleAttribute).toHaveBeenCalledWith('aria-busy', true);
        expect(spinnerNodes).toHaveLength(1);
        expect(labelNode.textContent).toBe('Rank pending');
        expect(statusNode).toBe(null);

        global.document = originalDocument;
    });

    it('shows terminal rank errors instead of hiding them behind fallback text', () => {
        let statusNode = null;
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn(() => ({
                className: '',
                dataset: {},
                textContent: '',
                setAttribute: vi.fn()
            }))
        };

        const valueNode = {
            replaceChildren: vi.fn(),
            toggleAttribute: vi.fn(),
            textContent: '',
            appendChild: vi.fn()
        };
        const labelNode = {
            textContent: 'Rank'
        };
        const rankStat = {
            querySelector: vi.fn((selector) => {
                if (selector === '[data-modal-rank-value]') return valueNode;
                if (selector === '[data-modal-rank-status]') return statusNode;
                if (selector === '.modal-stat-label') return labelNode;
                return null;
            }),
            appendChild: vi.fn((node) => {
                statusNode = node;
            })
        };

        applyRankModalStatContent.call({}, rankStat, {
            playerRankLabel: null,
            isLoading: false,
            verificationState: 'error',
            submissionStage: 'error',
            statusText: 'Submission failed'
        });

        expect(valueNode.textContent).toBe('Submission failed');
        expect(labelNode.textContent).toBe('Rank error');

        global.document = originalDocument;
    });

    it('opens the garage from the combined result modal button', () => {
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const openGarageModal = vi.fn();
        const button = { onclick: null };

        ModalShell.prototype._bindCombinedGarageBtn.call({
            _openGarageModal: openGarageModal
        }, button);

        expect(typeof button.onclick).toBe('function');

        button.onclick({
            preventDefault,
            stopPropagation,
        });

        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
        expect(openGarageModal).toHaveBeenCalledTimes(1);
    });

});

describe('Daily finish share chooser', () => {
    it('wires the Daily finish Share action without throwing', () => {
        const originalDocument = global.document;
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-main-view"></div>
                <div id="modal-runs-view"></div>
                <div id="modal-combined-view">
                    <div id="combined-stats-right-group"></div>
                    <div id="combined-hero-medal"></div>
                    <div class="combined-actions">
                        <button id="combined-menu-btn"></button>
                        <button id="combined-settings-btn"></button>
                        <button id="combined-garage-btn"></button>
                        <button id="combined-playlist-btn"><span class="combined-action-btn-label"></span></button>
                        <button id="combined-restart-btn"><span class="combined-action-btn-label"></span></button>
                        <button id="combined-next-btn"></button>
                    </div>
                </div>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        global.requestAnimationFrame = (callback) => callback();
        const shell = new ModalShell({
            content: { renderCombinedResults: vi.fn() },
            getCurrentTrackKey: () => 'number-zero',
        });
        shell.activateModalFocusTrap = vi.fn();
        shell.resetMenuKeyboardNav = vi.fn();
        const request = {
            source: 'finish',
            challengeId: 'daily-gp-2026-07-23',
            replay: { rulesRevision: 1 },
        };

        shell.showCombinedResults(
            { lapTime: 12.345, bestTime: 12.345, trackKey: 'number-zero' },
            { shareRequest: request },
        );

        const shareButton = dom.window.document.getElementById('combined-playlist-btn');
        expect(shareButton.querySelector('.combined-action-btn-label').textContent).toBe('SHARE');
        expect(typeof shareButton.onclick).toBe('function');

        shareButton.onclick();
        expect(dom.window.document.querySelector('.result-share-panel')).not.toBeNull();

        global.document = originalDocument;
        global.requestAnimationFrame = originalRequestAnimationFrame;
    });

    it('offers Comment Time and Issue Challenge for a Daily finish', () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">SHARE</span></button>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        const shell = new ModalShell();
        const startShare = vi.fn();
        shell._startShare = startShare;
        const request = {
            source: 'finish',
            challengeId: 'daily-gp-2026-07-23',
            replay: { rulesRevision: 1 },
        };

        shell._startShareChooser(
            request,
            shell.combinedPlaylistBtn,
            shell.modalCombinedView,
        );

        const panel = dom.window.document.querySelector('.result-share-panel');
        const buttons = [...panel.querySelectorAll('button')];
        expect(buttons.map((button) => button.textContent)).toEqual([
            'Comment Time',
            'Issue Challenge',
            'Cancel',
        ]);
        expect(shell.combinedPlaylistBtn.disabled).toBe(true);

        buttons[0].click();
        expect(startShare).toHaveBeenCalledWith(request, shell.combinedPlaylistBtn, shell.modalCombinedView);

        startShare.mockClear();
        shell._startShareChooser(request, shell.combinedPlaylistBtn, shell.modalCombinedView);
        [...dom.window.document.querySelectorAll('.result-share-panel button')][1].click();
        expect(startShare).toHaveBeenCalledWith({
            ...request,
            kind: 'head-to-head',
            source: 'daily',
        }, shell.combinedPlaylistBtn, shell.modalCombinedView);

        global.document = originalDocument;
    });

    it('prepares and posts a challenge loss Comment as text', async () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">COMMENT</span></button>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        const shell = new ModalShell({
            getRedditUsername: () => 'OtherRacer',
            previewShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status: 'ready',
                    shareToken: 'share-1',
                    username: 'OtherRacer',
                    commentText: '10.011s. Can’t believe I lost by 0.011s😤',
                },
            })),
            confirmShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status: 'commented',
                    commentText: '10.011s. Can’t believe I lost by 0.011s😤',
                },
            })),
            getNextChallenge: vi.fn(async () => ({
                ok: true,
                body: { status: 'ready', postUrl: 'https://reddit.com/r/miniracer/next' },
            })),
            openChallengePost: vi.fn(async () => undefined),
        });
        const request = {
            kind: 'challenge-comment',
            challengeId: 'challenge-1',
            reportedTimeMs: 10_011,
            outcome: 'lost',
        };

        try {
            const triggerButton = dom.window.document.getElementById('combined-playlist-btn');
            const hostView = dom.window.document.getElementById('modal-combined-view');
            await shell._startShare(request, triggerButton, hostView);

            const panel = dom.window.document.querySelector('.result-share-panel');
            expect(panel.querySelector('.result-share-panel__copy').textContent).toBe(
                '10.011s. Can’t believe I lost by 0.011s😤',
            );

            await panel.querySelector('.result-share-panel__button--primary').onclick();
            expect(panel.querySelector('.result-share-panel__title').textContent).toBe('Comment posted');
            expect(shell.confirmShare).toHaveBeenCalledWith('share-1', request);
            await shell._nextChallengeLookup;
            expect(triggerButton.querySelector('.combined-action-btn-label').textContent).toBe('CHANGE TRACK');
            expect(triggerButton.disabled).toBe(false);
            await triggerButton.onclick();
            expect(shell.openChallengePost).toHaveBeenCalledWith('https://reddit.com/r/miniracer/next');
        } finally {
            global.document = originalDocument;
        }
    });

    it('says a repeated tie is already posted without offering to post it again', async () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">A TIE?</span></button>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        const shell = new ModalShell({
            getRedditUsername: () => 'OtherRacer',
            previewShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status: 'already_commented',
                    username: 'OtherRacer',
                    commentText: 'I tried so hard and all I got was a tie 🙄',
                    commentUrl: 'https://reddit.com/r/miniracer/challenge1/comment1',
                },
            })),
            confirmShare: vi.fn(),
        });

        try {
            const triggerButton = dom.window.document.getElementById('combined-playlist-btn');
            const hostView = dom.window.document.getElementById('modal-combined-view');
            await shell._startShare({
                kind: 'challenge-comment',
                challengeId: 'challenge-1',
                reportedTimeMs: 10_000,
                outcome: 'tie',
            }, triggerButton, hostView);

            const panel = dom.window.document.querySelector('.result-share-panel');
            expect(panel.querySelector('.result-share-panel__title').textContent).toBe('Already posted');
            expect(panel.querySelector('.result-share-panel__copy').textContent).toBe(
                'I tried so hard and all I got was a tie 🙄',
            );
            expect(panel.querySelector('.result-share-panel__button--primary')).toBe(null);
            expect(shell.confirmShare).not.toHaveBeenCalled();
            expect(triggerButton.querySelector('.combined-action-btn-label').textContent).toBe('BRAG');
        } finally {
            global.document = originalDocument;
        }
    });

    it.each([
        ['created', 'Challenge created', 'Your verified challenge post is ready.'],
        ['already_created', 'Already posted', 'This time is already up.'],
    ])('tells the player what a challenge confirm returned: %s', async (status, expectedTitle, expectedCopy) => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">CHALLENGE</span></button>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        const shell = new ModalShell({
            getRedditUsername: () => 'Racer',
            previewShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status: 'ready',
                    challengeToken: 'challenge-token-1',
                    username: 'Racer',
                    title: 'Can you beat 25.640s on Number Three?',
                },
            })),
            confirmShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status,
                    challengeId: 'challenge-1',
                    postUrl: 'https://reddit.com/r/miniracer/challenge1',
                },
            })),
        });

        try {
            const triggerButton = dom.window.document.getElementById('combined-playlist-btn');
            const hostView = dom.window.document.getElementById('modal-combined-view');
            await shell._startShare({ kind: 'head-to-head', source: 'campaign' }, triggerButton, hostView);

            const panel = dom.window.document.querySelector('.result-share-panel');
            await panel.querySelector('.result-share-panel__button--primary').onclick();

            expect(panel.querySelector('.result-share-panel__title').textContent).toBe(expectedTitle);
            expect(panel.querySelector('.result-share-panel__copy').textContent).toBe(expectedCopy);
        } finally {
            global.document = originalDocument;
        }
    });

    it('offers no second Brag when Reddit cannot confirm the first', async () => {
        const originalDocument = global.document;
        const dom = new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">BRAG</span></button>
            </div>
        `, { url: 'http://localhost' });
        global.document = dom.window.document;
        const error = 'Reddit did not confirm this brag. Check the post before you brag again.';
        const shell = new ModalShell({
            getRedditUsername: () => 'Racer',
            previewShare: vi.fn(async () => ({
                ok: true,
                body: { status: 'ready', shareToken: 'share-1', username: 'Racer', commentText: 'Comfortable win.' },
            })),
            confirmShare: vi.fn(async () => ({
                ok: false,
                body: { status: 'comment_unconfirmed', error },
            })),
        });

        try {
            const triggerButton = dom.window.document.getElementById('combined-playlist-btn');
            const hostView = dom.window.document.getElementById('modal-combined-view');
            await shell._startShare({ kind: 'challenge-brag', acceptToken: 'accept-1' }, triggerButton, hostView);

            const panel = dom.window.document.querySelector('.result-share-panel');
            await panel.querySelector('.result-share-panel__button--primary').onclick();

            expect(panel.querySelector('.result-share-panel__status').textContent).toBe(error);
            expect(panel.querySelector('.result-share-panel__button--primary')).toBeNull();
            const close = panel.querySelector('.result-share-panel__button');
            expect(close.textContent).toBe('Close');
            close.onclick();
            expect(dom.window.document.querySelector('.result-share-panel')).toBeNull();
            expect(triggerButton.disabled).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    function shareDom() {
        return new JSDOM(`
            <div id="modal">
                <div id="modal-lap-times"></div>
                <div id="modal-combined-view"></div>
                <button id="combined-playlist-btn"><span class="combined-action-btn-label">BRAG</span></button>
            </div>
        `, { url: 'http://localhost' });
    }

    async function confirmWith(dom, body, request, previewBody = {}) {
        const shell = new ModalShell({
            getRedditUsername: () => 'Racer',
            previewShare: vi.fn(async () => ({
                ok: true,
                body: {
                    status: 'ready',
                    shareToken: 'share-1',
                    challengeToken: 'challenge-1',
                    username: 'Racer',
                    commentText: 'Comfortable win.',
                    title: 'Beat my time',
                    ...previewBody,
                },
            })),
            confirmShare: vi.fn(async () => ({ ok: false, body })),
        });
        const triggerButton = dom.window.document.getElementById('combined-playlist-btn');
        const hostView = dom.window.document.getElementById('modal-combined-view');
        await shell._startShare(request, triggerButton, hostView);
        const panel = dom.window.document.querySelector('.result-share-panel');
        await panel.querySelector('.result-share-panel__button--primary').onclick();
        return { shell, panel, triggerButton };
    }

    it.each([
        [
            'posted_without_link',
            'Reddit did not return a link to your comment.',
            'Your comment is up. Reddit did not return a link to it.',
        ],
    ])('shows a Brag as posted, with no Try Again, for %s', async (status, error, note) => {
        const originalDocument = global.document;
        const dom = shareDom();
        global.document = dom.window.document;

        try {
            const { shell, panel } = await confirmWith(
                dom,
                { status, error },
                { kind: 'challenge-brag', acceptToken: 'accept-1' },
            );

            expect(panel.querySelector('.result-share-panel__copy').textContent).toBe(note);
            expect(panel.querySelector('.result-share-panel__button--primary')).toBeNull();
            expect(panel.querySelector('.result-share-panel__button').textContent).toBe('Done');
            expect(shell._challengeFinishCommentSpent).toBe('posted');
        } finally {
            global.document = originalDocument;
        }
    });

    it('shows the user-attributed error when a comment is not the player\'s', async () => {
        const originalDocument = global.document;
        const dom = shareDom();
        global.document = dom.window.document;
        const error = 'Reddit user-attributed sharing is not available for this app version.';

        try {
            const { shell, panel } = await confirmWith(
                dom,
                { status: 'user_action_unavailable', error },
                { kind: 'challenge-brag', acceptToken: 'accept-1' },
            );

            const retry = panel.querySelector('.result-share-panel__button--primary');
            expect(retry.textContent).toBe('Try Again');
            expect(panel.querySelector('.result-share-panel__status').textContent).toBe(error);
            expect(shell._challengeFinishCommentSpent).toBeFalsy();
        } finally {
            global.document = originalDocument;
        }
    });

    it('keeps Create Challenge failing on user_action_unavailable', async () => {
        const originalDocument = global.document;
        const dom = shareDom();
        global.document = dom.window.document;
        const error = 'Reddit user-attributed posting is not available for this app version.';

        try {
            const { panel } = await confirmWith(
                dom,
                { status: 'user_action_unavailable', error },
                { kind: 'head-to-head', source: 'daily' },
            );

            const retry = panel.querySelector('.result-share-panel__button--primary');
            expect(retry.textContent).toBe('Try Again');
            expect(panel.querySelector('.result-share-panel__status').textContent).toBe(error);
        } finally {
            global.document = originalDocument;
        }
    });
});

describe('combined finish next race button', () => {
    function combinedActionsDom() {
        return new JSDOM(`
            <div id="modal-combined-view">
                <div class="combined-actions">
                    <button id="combined-restart-btn" class="combined-action-btn combined-action-btn--primary"><span class="combined-action-btn-label">RETRY</span></button>
                    <button id="combined-menu-btn"><span class="combined-action-btn-label">HOME</span></button>
                    <button id="combined-next-btn" hidden style="display: none;"><span class="combined-action-btn-label">NEXT</span></button>
                </div>
            </div>
        `);
    }

    function nextButtonContext(dom) {
        return {
            _syncCombinedNextRace: ModalShell.prototype._syncCombinedNextRace,
            setCombinedNextRaceEnabled: ModalShell.prototype.setCombinedNextRaceEnabled,
            _bindClickAction: ModalShell.prototype._bindClickAction,
            _setShareButtonLabel: ModalShell.prototype._setShareButtonLabel,
            get combinedNextBtn() {
                return dom.window.document.getElementById('combined-next-btn');
            },
            get combinedRestartBtn() {
                return dom.window.document.getElementById('combined-restart-btn');
            },
            modalCombinedView: dom.window.document.getElementById('modal-combined-view'),
        };
    }

    const isAccented = (button) => button.classList.contains('combined-action-btn--primary');

    it('pairs an offered next race with Home and runs its action', () => {
        const dom = combinedActionsDom();
        const context = nextButtonContext(dom);
        const action = vi.fn();

        context._syncCombinedNextRace({
            label: 'Next',
            ariaLabel: 'Race Number One',
            enabled: true,
            action,
        });

        const button = context.combinedNextBtn;
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        expect(button.querySelector('.combined-action-btn-label').textContent).toBe('NEXT');
        expect(button.getAttribute('aria-label')).toBe('Race Number One');
        expect(context.modalCombinedView.querySelector('.combined-actions')
            .classList.contains('combined-actions--with-next')).toBe(true);

        button.onclick();
        expect(action).toHaveBeenCalledTimes(1);

        expect(isAccented(button)).toBe(true);
        expect(isAccented(context.combinedRestartBtn)).toBe(false);
    });

    it('shows a gated next race as a dead button rather than hiding it', () => {
        const dom = combinedActionsDom();
        const context = nextButtonContext(dom);
        const action = vi.fn();

        context._syncCombinedNextRace({
            label: 'Next',
            ariaLabel: 'One more medal needed',
            enabled: false,
            action,
        });

        const button = context.combinedNextBtn;
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-label')).toBe('One more medal needed');
        expect(button.onclick).toBe(null);
        expect(isAccented(button)).toBe(false);
        expect(isAccented(context.combinedRestartBtn)).toBe(true);
    });

    it('keeps the row to Home alone on a finish with nothing after it', () => {
        const dom = combinedActionsDom();
        const context = nextButtonContext(dom);

        context._syncCombinedNextRace({ enabled: true, action: vi.fn() });
        context._syncCombinedNextRace(null);

        const button = context.combinedNextBtn;
        expect(button.hidden).toBe(true);
        expect(button.style.display).toBe('none');
        expect(button.onclick).toBe(null);
        expect(context.modalCombinedView.querySelector('.combined-actions')
            .classList.contains('combined-actions--with-next')).toBe(false);
    });

    it('closes an offered next race when a late verdict takes the stage back', () => {
        const dom = combinedActionsDom();
        const context = nextButtonContext(dom);

        context._syncCombinedNextRace({ enabled: true, action: vi.fn() });
        expect(context.setCombinedNextRaceEnabled(false)).toBe(true);
        expect(context.combinedNextBtn.disabled).toBe(true);
        expect(isAccented(context.combinedNextBtn)).toBe(false);
        expect(isAccented(context.combinedRestartBtn)).toBe(true);

        context._syncCombinedNextRace(null);
        expect(context.setCombinedNextRaceEnabled(true)).toBe(false);
    });

    it('rebinds Next after a pending offer is later unlocked', () => {
        const dom = combinedActionsDom();
        const context = nextButtonContext(dom);
        const action = vi.fn();

        context._syncCombinedNextRace({
            label: 'Next',
            enabled: false,
            action,
        });
        expect(context.combinedNextBtn.disabled).toBe(true);
        expect(context.combinedNextBtn.onclick).toBe(null);

        expect(context.setCombinedNextRaceEnabled(true)).toBe(true);
        expect(context.combinedNextBtn.disabled).toBe(false);
        context.combinedNextBtn.onclick();
        expect(action).toHaveBeenCalledTimes(1);
    });
});

describe('combined finish head to head win actions', () => {
    function winSheetDom() {
        return new JSDOM(`
            <div id="modal">
                <div id="modal-main-view"></div>
                <div id="modal-runs-view"></div>
                <div id="modal-combined-view">
                    <div id="combined-stats-right-group"></div>
                    <div id="combined-hero-medal"></div>
                    <div class="combined-actions">
                        <button id="combined-restart-btn" class="combined-action-btn combined-action-btn--primary"><span class="combined-action-btn-label">RETRY</span></button>
                        <button id="combined-playlist-btn" class="combined-action-btn"><span class="combined-action-btn-label">SHARE TIME</span></button>
                        <p id="combined-mode-shortcuts-label" hidden>Try other modes</p>
                        <button id="combined-more-btn" class="combined-action-btn" hidden style="display: none;"><span class="combined-action-btn-label">MORE</span></button>
                        <button id="combined-garage-btn"></button>
                        <button id="combined-menu-btn" class="combined-action-btn"><span class="combined-action-btn-label">HOME</span></button>
                        <button id="combined-next-btn" hidden style="display: none;"></button>
                        <button id="combined-settings-btn"></button>
                    </div>
                </div>
            </div>
        `, { url: 'http://localhost' });
    }

    function withWinSheet(run) {
        const originalDocument = global.document;
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const dom = winSheetDom();
        global.document = dom.window.document;
        global.requestAnimationFrame = (callback) => callback();
        const shell = new ModalShell({
            content: { renderCombinedResults: vi.fn() },
            getCurrentTrackKey: () => 'number-zero',
        });
        shell.activateModalFocusTrap = vi.fn();
        shell.resetMenuKeyboardNav = vi.fn();
        try {
            run(shell, dom.window.document);
        } finally {
            global.document = originalDocument;
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    }

    const byId = (doc, id) => doc.getElementById(id);
    const isAccented = (button) => button.classList.contains('combined-action-btn--primary');

    it('keeps the mode shortcuts out of an ordinary finish sheet', () => {
        withWinSheet((shell, doc) => {
            shell.showCombinedResults(
                { lapTime: 12.345, bestTime: 12.345, trackKey: 'number-zero' },
                { restartAction: vi.fn() },
            );

            const more = byId(doc, 'combined-more-btn');
            expect(more.hidden).toBe(true);
            expect(more.style.display).toBe('none');
            expect(more.onclick).toBe(null);
            expect(byId(doc, 'combined-mode-shortcuts-label').hidden).toBe(true);
            expect(byId(doc, 'combined-menu-btn').textContent.trim()).toBe('HOME');
            expect(byId(doc, 'combined-restart-btn').hidden).toBe(false);
            expect(isAccented(byId(doc, 'combined-restart-btn'))).toBe(true);
            expect(isAccented(byId(doc, 'combined-playlist-btn'))).toBe(false);
        });
    });

    it.each([
        ['lost', 'CONCEDE', 'Concede this challenge'],
        ['tie', 'A TIE?', 'Comment that you tied this challenge'],
    ])('enables the comment on a settled %s', (phase, label, aria) => {
        withWinSheet((shell, doc) => {
            shell.showCombinedResults(
                {
                    lapTime: 8.011,
                    bestTime: 8,
                    trackKey: 'number-zero',
                    challengeFinish: true,
                    challengeConfirmPhase: phase,
                },
                {
                    modalKind: 'win',
                    restartAction: vi.fn(),
                    shareRequest: {
                        kind: 'challenge-comment',
                        challengeId: 'challenge-1',
                        reportedTimeMs: 8_011,
                        outcome: phase,
                    },
                    shareEnabled: true,
                },
            );

            const comment = byId(doc, 'combined-playlist-btn');
            expect(comment.querySelector('.combined-action-btn-label').textContent).toBe(label);
            expect(comment.disabled).toBe(false);
            expect(comment.getAttribute('aria-label')).toBe(aria);
        });
    });

    it('starts the next finish with nothing spent', () => {
        withWinSheet((shell, doc) => {
            shell._challengeFinishCommentSpent = 'posted';

            shell.showCombinedResults(
                {
                    lapTime: 8.011,
                    bestTime: 8,
                    trackKey: 'number-zero',
                    challengeFinish: true,
                    challengeConfirmPhase: 'lost',
                },
                {
                    restartAction: vi.fn(),
                    shareRequest: { kind: 'challenge-comment', challengeId: 'challenge-2' },
                    shareEnabled: true,
                },
            );

            expect(shell._challengeFinishCommentSpent).toBeNull();
            expect(byId(doc, 'combined-playlist-btn').disabled).toBe(false);
        });
    });

    it('trades Improve for the other modes once the duel is won', () => {
        withWinSheet((shell, doc) => {
            const daily = vi.fn();
            const campaign = vi.fn();
            shell.showCombinedResults(
                { lapTime: 7.5, bestTime: 8, trackKey: 'number-zero', challengeFinish: true },
                { restartAction: vi.fn(), secondaryAction: vi.fn() },
            );

            expect(shell.setChallengeWinActions({
                dailyAction: daily,
                campaignAction: campaign,
            })).toBe(true);

            const improve = byId(doc, 'combined-restart-btn');
            expect(improve.hidden).toBe(true);
            expect(improve.style.display).toBe('none');
            expect(improve.onclick).toBe(null);
            expect(isAccented(improve)).toBe(false);
            expect(isAccented(byId(doc, 'combined-playlist-btn'))).toBe(true);

            expect(byId(doc, 'combined-mode-shortcuts-label').hidden).toBe(false);

            const dailyBtn = byId(doc, 'combined-more-btn');
            const campaignBtn = byId(doc, 'combined-menu-btn');
            expect(dailyBtn.hidden).toBe(false);
            expect(dailyBtn.textContent.trim()).toBe('THE DAILY');
            expect(campaignBtn.textContent.trim()).toBe('CAMPAIGN');

            dailyBtn.onclick();
            expect(daily).not.toHaveBeenCalled();
            const panel = doc.querySelector('.result-share-panel');
            expect(panel.textContent).toContain('This will leave the head to head.');

            const [confirmBtn, cancelBtn] = panel.querySelectorAll('.result-share-panel__button');
            expect(confirmBtn.textContent).toBe('OK');
            expect(cancelBtn.textContent).toBe('Cancel');

            cancelBtn.onclick();
            expect(daily).not.toHaveBeenCalled();
            expect(doc.querySelector('.result-share-panel')).toBe(null);
            expect(dailyBtn.disabled).toBe(false);

            dailyBtn.onclick();
            doc.querySelector('.result-share-panel__button--primary').onclick();
            expect(daily).toHaveBeenCalledTimes(1);
            expect(doc.querySelector('.result-share-panel')).toBe(null);

            campaignBtn.onclick();
            expect(campaign).not.toHaveBeenCalled();
            doc.querySelector('.result-share-panel__button--primary').onclick();
            expect(campaign).toHaveBeenCalledTimes(1);
            expect(shell.resetMenuKeyboardNav).toHaveBeenCalled();
        });
    });

    it('hands Home back when the server takes the win away', () => {
        withWinSheet((shell, doc) => {
            const secondaryAction = vi.fn();
            shell.showCombinedResults(
                { lapTime: 7.5, bestTime: 8, trackKey: 'number-zero', challengeFinish: true },
                { restartAction: vi.fn(), secondaryAction },
            );
            shell.setChallengeWinActions({
                dailyAction: vi.fn(),
                campaignAction: vi.fn(),
            });

            shell.clearChallengeWinActions({ restartAction: vi.fn() });

            const menu = byId(doc, 'combined-menu-btn');
            expect(menu.textContent.trim()).toBe('HOME');
            expect(byId(doc, 'combined-mode-shortcuts-label').hidden).toBe(true);
            expect(byId(doc, 'combined-more-btn').hidden).toBe(true);
            menu.onclick();
            expect(secondaryAction).toHaveBeenCalledTimes(1);
        });
    });

    it('does not leak a won duel\'s shortcuts into the next finish sheet', () => {
        withWinSheet((shell, doc) => {
            shell.showCombinedResults(
                { lapTime: 7.5, bestTime: 8, trackKey: 'number-zero', challengeFinish: true },
                { restartAction: vi.fn() },
            );
            shell.setChallengeWinActions({
                dailyAction: vi.fn(),
                campaignAction: vi.fn(),
            });

            shell.showCombinedResults(
                { lapTime: 12.345, bestTime: 12.345, trackKey: 'number-zero' },
                { restartAction: vi.fn() },
            );

            expect(byId(doc, 'combined-more-btn').hidden).toBe(true);
            expect(byId(doc, 'combined-mode-shortcuts-label').hidden).toBe(true);
            expect(byId(doc, 'combined-menu-btn').textContent.trim()).toBe('HOME');
            expect(byId(doc, 'combined-restart-btn').hidden).toBe(false);
            expect(isAccented(byId(doc, 'combined-restart-btn'))).toBe(true);
            expect(isAccented(byId(doc, 'combined-playlist-btn'))).toBe(false);
        });
    });

    it('refuses to rewrite the actions when the finish sheet is not on screen', () => {
        withWinSheet((shell) => {
            expect(shell.setChallengeWinActions({ dailyAction: vi.fn() })).toBe(false);
        });
    });
});
