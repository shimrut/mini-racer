import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';

const {
    applyRankModalStatContent,
    getModalScoreboardStatusText,
    matchesModalScoreboardContext,
    showRunsModal,
    showModalLeaderboardPayload,
    renderLeaderboardStandaloneIntro,
    configureRunsModalHeader,
    updateModalRunSummary,
    bindLeaderboardPagination,
    bindLeaderboardDaySwipe,
    _wireLeaderboardRowShare,
    _leaderboardShareBestOption,
} = ModalShell.prototype;

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
    return {
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
        }),
        getAttribute: vi.fn((name) => attributes[name] ?? null),
        removeAttribute: vi.fn(),
        toggleAttribute: vi.fn(),
        addEventListener: vi.fn(),
        append(...nodes) {
            this.children.push(...nodes);
        },
        appendChild(node) {
            this.children.push(node);
            return node;
        },
        prepend(...nodes) {
            this.children.unshift(...nodes);
        },
        querySelector: vi.fn(() => null)
    };
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
            renderLeaderboardStandaloneIntro.call({
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
            });

            const rail = modalLapTimes.children.find((child) => (
                child.className === 'leaderboard-day-rail'
            ));
            expect(rail).toBeTruthy();
            expect(rail.children).toHaveLength(3);
            expect(rail.children[0].disabled).toBe(false);
            expect(rail.children[0].getAttribute('aria-disabled')).toBe('true');
            expect(rail.children.map((button) => {
                if (button.children.length === 1) {
                    return button.children[0].textContent;
                }
                return [
                    button.children[0].textContent,
                    button.children[1].textContent
                ];
            })).toEqual([
                'Today',
                ['Jul', '14'],
                ['Jul', '13']
            ]);
            expect(rail.children[0].className).toContain('leaderboard-day-chip--today');
            expect(rail.children[0].children[0].className).toBe('leaderboard-day-chip__day');
            expect(rail.children[1].children[0].className).toBe('leaderboard-day-chip__month');
            expect(rail.children[1].children[1].className).toBe('leaderboard-day-chip__day');
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
            renderLeaderboardStandaloneIntro.call({
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
            });

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
            renderLeaderboardStandaloneIntro.call({
                modalLapTimes,
                modalRunsView,
                _modalRunsPayload: {
                    showGlobalLeaderboard: true,
                    scoreboardChallengeId: 'daily-1',
                    scoreboardTrackKey: 'circuit',
                    scoreboardSnapshot: { isLoading: true }
                }
            });

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
            renderLeaderboardStandaloneIntro.call({
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
            });

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
                scoreboardChallengeId: 'daily-1',
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };

        expect(_leaderboardShareBestOption.call(ctx)).toEqual({
            challengeId: 'daily-1',
            bestTime: 42.317
        });

        const noChallenge = {
            _modalRunsPayload: {
                scoreboardChallengeId: null,
                scoreboardSnapshot: { currentPlayerRow: { bestTime: 42.317 } }
            }
        };
        expect(_leaderboardShareBestOption.call(noChallenge)).toBeNull();

        const noTime = {
            _modalRunsPayload: {
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
        expect(primaryValue.textContent).toBe('22.18s');
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

    it('binds the pause modal garage button', () => {
        const bindCombinedGarageBtn = vi.fn();
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
        const context = {
            modal: { classList: createClassList() },
            modalPauseView: { classList: createClassList() },
            modalMainView: { classList: createClassList() },
            modalRunsView: { classList: createClassList() },
            modalCombinedView: { classList: createClassList() },
            pauseGarageBtn: { id: 'pause-garage-btn' },
            modalMenuBtn: null,
            pauseSettingsBtn: null,
            pausePlaylistBtn: null,
            modalRestartBtn: null,
            modalResumeBtn: null,
            cancelPendingModalClose: vi.fn(),
            _bindClickAction: vi.fn(),
            _bindCombinedGarageBtn: bindCombinedGarageBtn,
            _syncGarageButtonToPanelState: vi.fn(),
            _setActiveView: setActiveView,
            activateModalFocusTrap: vi.fn(),
            _syncPauseTrackPreview: vi.fn(),
        };

        try {
            ModalShell.prototype.showPauseResults.call(context, {}, {});

            expect(bindCombinedGarageBtn).toHaveBeenCalledWith(context.pauseGarageBtn);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });
});
