import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';

const {
    applyRankModalStatContent,
    getModalScoreboardStatusText,
    matchesModalScoreboardContext,
    showRunsModal,
    showModalLeaderboardPayload,
    updateModalRunSummary
} = ModalShell.prototype;

function createClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        values: () => Array.from(classes)
    };
}

describe('ui modal runs helpers', () => {
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
            'modal--pause',
            'modal--crash'
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
            hideCombinedInlineTune: vi.fn(),
            _hidePauseTrackPreview: vi.fn(),
            getCurrentTrackKey: vi.fn(() => 'circuit'),
            isModalActive: vi.fn(() => true),
            activateModalFocusTrap: vi.fn()
        };

        try {
            showRunsModal.call(context, null, null, null, 'close', {
                scoreboardSnapshot: { isLoading: true },
                scoreboardTrackKey: 'circuit'
            });

            expect(modalClassList.values()).not.toContain('modal--win');
            expect(modalClassList.values()).not.toContain('modal--pause');
            expect(modalClassList.values()).not.toContain('modal--crash');
            expect(combinedClassList.contains('active-view')).toBe(false);
            expect(context.hideCombinedInlineTune).toHaveBeenCalled();
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
        const showTrackLeaderboardModal = vi.fn();

        showModalLeaderboardPayload.call({
            _modalRunsPayload: {
                scoreboardChallengeId: 'daily-1',
                scoreboardTrackKey: 'circuit',
                scoreboardMode: TRACK_MODE_DAILY_GP
            },
            getLeaderboards: () => ({
                openDailyChallengeLeaderboard,
                showTrackLeaderboardModal
            })
        });

        expect(openDailyChallengeLeaderboard).toHaveBeenCalledWith('back');
        expect(showTrackLeaderboardModal).not.toHaveBeenCalled();

        showModalLeaderboardPayload.call({
            _modalRunsPayload: {
                scoreboardChallengeId: null,
                scoreboardTrackKey: 'circuit',
                scoreboardMode: TRACK_MODE_DAILY_GP
            },
            getLeaderboards: () => ({
                openDailyChallengeLeaderboard,
                showTrackLeaderboardModal
            })
        });

        expect(showTrackLeaderboardModal).toHaveBeenCalledWith('circuit', 'back');
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

        expect(valueNode.textContent).toBe('');
        expect(valueNode.toggleAttribute).toHaveBeenCalledWith('aria-busy', true);
        expect(spinnerNodes).toHaveLength(1);
        expect(labelNode.textContent).toBe('Rank pending');
        expect(statusNode).toBe(null);

        global.document = originalDocument;
    });
});
