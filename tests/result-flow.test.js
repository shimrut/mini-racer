import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyCombinedRankValue,
    buildChallengeRankSnapshot,
    buildModalRunsPayload,
    buildModalRunsViewOptions,
    buildModalDeltaDisplay,
    buildScoreboardRankDisplay,
    createModalActions,
    buildLapRecord,
    isNewBestResult,
    pushRecentLap,
} from '../game/race/result-flow.js';

describe('result-flow helpers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('applies combined RANK status text, errors, and real ranks', () => {
        const rightGroupEl = {
            hidden: true,
            removeAttribute: vi.fn(function removeAttribute(name) {
                if (name === 'hidden') this.hidden = false;
            }),
            setAttribute: vi.fn(function setAttribute(name) {
                if (name === 'hidden') this.hidden = true;
            }),
        };
        const rankValueEl = {
            textContent: '',
            innerHTML: '',
            classList: {
                toggle: vi.fn(),
            },
        };
        const rankTotalEl = {
            textContent: 'of 9',
            hidden: false,
            removeAttribute: vi.fn(),
            setAttribute: vi.fn(function setAttribute(name) {
                if (name === 'hidden') this.hidden = true;
            }),
        };

        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot: {
                isLoading: true,
                statusText: 'Submitting...',
                submissionStage: 'submitting',
            },
        });
        expect(rankValueEl.textContent).toBe('Submitting...');
        expect(rightGroupEl.hidden).toBe(false);
        expect(rankTotalEl.hidden).toBe(true);
        expect(rankValueEl.classList.toggle).toHaveBeenCalledWith(
            'combined-rank-value--status',
            true,
        );

        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot: {
                isLoading: false,
                verificationState: 'error',
                submissionStage: 'error',
                statusText: 'Run too long to rank.',
            },
        });
        expect(rankValueEl.textContent).toBe(
            'Run too long to rank.',
        );
        expect(rightGroupEl.hidden).toBe(false);

        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot: {
                isLoading: false,
                playerRankLabel: '#7',
                totalCount: 120,
            },
        });
        expect(rankValueEl.innerHTML).toContain('rank-num');
        expect(rankValueEl.innerHTML).toContain('7');
        expect(rankTotalEl.textContent).toBe('of 120');
        expect(rankTotalEl.hidden).toBe(false);
        expect(rightGroupEl.hidden).toBe(false);

        applyCombinedRankValue({
            rankValueEl,
            rankTotalEl,
            rightGroupEl,
            scoreboardSnapshot: {
                isLoading: false,
                statusText: null,
                playerRankLabel: null,
            },
        });
        expect(rightGroupEl.hidden).toBe(true);
        expect(rankValueEl.textContent).toBe('');
    });

    it('keeps a challenge rank row visible and only replaces the number on a personal best', () => {
        expect(buildChallengeRankSnapshot(null, { rank: 12 })).toEqual({
            playerRankLabel: '#12',
        });
        expect(buildChallengeRankSnapshot({ rank: 3 }, { rank: 12 })).toEqual({
            playerRankLabel: '#3',
        });
        expect(buildChallengeRankSnapshot(null, null)).toEqual({
            playerRankLabel: '—',
        });
        expect(buildChallengeRankSnapshot({ rank: 1 }, { trackLocked: true })).toEqual({
            playerRankLabel: 'TRACK LOCKED',
            statusText: 'TRACK LOCKED',
            trackLocked: true,
        });
    });

    it('builds lap records and trims recent laps', () => {
        const lapRecord = buildLapRecord(3, 22.5, 21);
        expect(lapRecord).toEqual({
            lapNumber: 3,
            time: 22.5,
            deltaVsBest: 1.5
        });
        expect(buildLapRecord(4, 24, null)).toEqual({
            lapNumber: 4,
            time: 24,
            deltaVsBest: null
        });
        expect(buildLapRecord(5, 24, Number.NaN)).toEqual({
            lapNumber: 5,
            time: 24,
            deltaVsBest: null
        });

        const recent = [];
        for (let index = 0; index < 12; index += 1) {
            pushRecentLap(recent, { lapNumber: index + 1 }, 10);
        }
        expect(recent).toHaveLength(10);
        expect(recent[0].lapNumber).toBe(3);

        const exact = [{ lapNumber: 1 }];
        expect(pushRecentLap(exact, { lapNumber: 2 }, 2)).toEqual([
            { lapNumber: 1 },
            { lapNumber: 2 }
        ]);

        expect(pushRecentLap(exact, { lapNumber: 3 }, 2)).toEqual([
            { lapNumber: 2 },
            { lapNumber: 3 }
        ]);
    });

    it('evaluates time-only best results', () => {
        expect(isNewBestResult(null, { bestTime: 19.8 }, null)).toBe(false);
        expect(isNewBestResult({ bestResultComparator: 'time' }, null, null)).toBe(false);
        expect(isNewBestResult(
            { bestResultComparator: 'time' },
            { bestTime: Number.NaN },
            null
        )).toBe(false);

        expect(isNewBestResult(
            { bestResultComparator: 'time' },
            { bestTime: 19.8 },
            { bestTime: 20.1 }
        )).toBe(true);
        expect(isNewBestResult(
            { bestResultComparator: 'time' },
            { bestTime: 20.1 },
            { bestTime: 20.1 }
        )).toBe(false);
        expect(isNewBestResult(
            { bestResultComparator: 'time' },
            { bestTime: 20.2 },
            { bestTime: 20.1 }
        )).toBe(false);
        expect(isNewBestResult(
            { bestResultComparator: 'time' },
            { bestTime: 20.2 },
            null
        )).toBe(true);

    });

    it('applies explicit modal run updates including null snapshots', () => {
        const base = {
            lapTimesArray: [20],
            bestTime: 20,
            currentTime: 21,
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: 'daily'
        };

        expect(buildModalRunsPayload(base, {
            updates: {
                bestTime: 19.5,
                currentTime: 19.5,
                lapTimesArray: [19.5, 20],
                scoreboardSnapshot: { playerRank: 2 }
            }
        })).toMatchObject({
            bestTime: 19.5,
            currentTime: 19.5,
            lapTimesArray: [19.5, 20],
            scoreboardSnapshot: { playerRank: 2 }
        });

        expect(buildModalRunsPayload(base, {
            updates: {
                bestTime: undefined,
                scoreboardSnapshot: null
            }
        })).toMatchObject({
            bestTime: 20,
            scoreboardSnapshot: null
        });

        expect(buildModalRunsPayload(base, { updates: null })).toMatchObject({
            bestTime: 20,
            scoreboardSnapshot: { isLoading: true }
        });
        expect(buildModalRunsPayload(base, { updates: 'bad' })).toMatchObject({
            bestTime: 20
        });
    });

    it('builds modal runs view options from payload fields', () => {
        expect(buildModalRunsViewOptions(null)).toEqual({});
        expect(buildModalRunsViewOptions('bad')).toEqual({});

        const onSelect = () => {};
        const onLoadMore = () => {};
        const onOpenStandings = () => {};
        const primaryAction = () => {};
        expect(buildModalRunsViewOptions({
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot: { isLoading: false },
            scoreboardMode: 'global',
            scoreboardTrackKey: 'circuit',
            scoreboardTitle: 'Title',
            scoreboardSubhead: 'Sub',
            leaderboardDayOptions: [{ id: 'a' }],
            selectedLeaderboardDayId: 'a',
            onSelectLeaderboardDay: onSelect,
            onLoadMoreLeaderboard: onLoadMore,
            onOpenStandings,
            primaryActionLabel: 'Go',
            primaryAction,
            showGlobalLeaderboard: false,
            allowLeaderboardOpen: false
        })).toEqual({
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot: { isLoading: false },
            scoreboardMode: 'global',
            scoreboardTrackKey: 'circuit',
            scoreboardTitle: 'Title',
            scoreboardSubhead: 'Sub',
            leaderboardDayOptions: [{ id: 'a' }],
            selectedLeaderboardDayId: 'a',
            onSelectLeaderboardDay: onSelect,
            onLoadMoreLeaderboard: onLoadMore,
            onOpenStandings,
            primaryActionLabel: 'Go',
            primaryAction,
            showGlobalLeaderboard: false,
            allowLeaderboardOpen: false
        });

        expect(buildModalRunsViewOptions({
            leaderboardDayOptions: 'nope',
            onSelectLeaderboardDay: 'nope',
            onLoadMoreLeaderboard: 7,
            onOpenStandings: 'nope',
            primaryAction: 7,
            showGlobalLeaderboard: undefined,
            allowLeaderboardOpen: undefined
        })).toMatchObject({
            scoreboardMode: 'daily',
            leaderboardDayOptions: null,
            onSelectLeaderboardDay: null,
            onLoadMoreLeaderboard: null,
            onOpenStandings: null,
            primaryAction: null,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: true
        });
    });

    it('covers remaining scoreboard rank label branches', () => {
        expect(buildScoreboardRankDisplay({
            submissionStage: 'verifying'
        }).labelText).toBe('Verifying rank');
        expect(buildScoreboardRankDisplay({
            submissionStage: 'submitting'
        }).labelText).toBe('Submitting rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'Queued for retry'
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'Retrying soon'
        }).labelText).toBe('Retrying rank');
        expect(buildScoreboardRankDisplay({
            statusText: 'Pending verification'
        }).labelText).toBe('Rank pending');
        expect(buildScoreboardRankDisplay({
            verificationState: 'rejected'
        }).labelText).toBe('Rank rejected');
        expect(buildScoreboardRankDisplay({
            isLoading: true
        }).labelText).toBe('Loading rank');
    });

    it('formats modal delta display states for result summaries', () => {
        expect(buildModalDeltaDisplay()).toEqual({
            text: '--',
            valueClass: ''
        });

        expect(buildModalDeltaDisplay({ deltaToBest: 0.0004 })).toEqual({
            text: '0.000s',
            valueClass: ''
        });

        expect(buildModalDeltaDisplay({ deltaToBest: 1.25 })).toEqual({
            text: '+1.250s',
            valueClass: 'modal-stat-value--delta-positive'
        });

        expect(buildModalDeltaDisplay({ deltaToBest: -0.62 })).toEqual({
            text: '-0.620s',
            valueClass: 'modal-stat-value--delta-negative'
        });

        expect(buildModalDeltaDisplay({
            deltaToBest: null,
            emptyText: 'New PB',
            emptyValueClass: 'modal-stat-value--delta-negative'
        })).toEqual({
            text: 'New PB',
            valueClass: 'modal-stat-value--delta-negative'
        });
    });

    it('normalizes scoreboard rank display state for loading and fallback cases', () => {
        expect(buildScoreboardRankDisplay()).toEqual({
            labelText: 'Rank',
            text: 'N/A',
            isLoading: false,
            statusText: null
        });

        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#7',
            isLoading: true,
            statusText: '  Pending verification  '
        })).toEqual({
            labelText: 'Rank pending',
            text: '#7',
            isLoading: true,
            statusText: 'Pending verification'
        });

        expect(buildScoreboardRankDisplay({
            isLoading: true,
            statusText: 'Verifying...'
        }).labelText).toBe('Verifying rank');

        expect(buildScoreboardRankDisplay({
            isLoading: true,
            statusText: 'Submitting...'
        }).labelText).toBe('Submitting rank');

        expect(buildScoreboardRankDisplay({
            isLoading: true,
            submissionStage: 'retrying',
            statusText: 'Retrying...'
        }).labelText).toBe('Retrying rank');

        expect(buildScoreboardRankDisplay({
            isLoading: false,
            verificationState: 'error',
            submissionStage: 'error',
            statusText: 'Daily challenge submit failed'
        }).labelText).toBe('Rank error');

        expect(buildScoreboardRankDisplay({
            playerRankLabel: null,
            isLoading: true,
            statusText: 'Rejected'
        }, { fallbackText: '#12' })).toEqual({
            labelText: 'Rank rejected',
            text: '',
            isLoading: true,
            statusText: 'Rejected'
        });

        expect(buildScoreboardRankDisplay({
            playerRankLabel: null,
            isLoading: false,
            statusText: '   '
        }, { fallbackText: '#12' })).toEqual({
            labelText: 'Rank',
            text: '#12',
            isLoading: false,
            statusText: null
        });
    });

    it('normalizes modal runs payloads from lap data and explicit runs data', () => {
        expect(buildModalRunsPayload(null, { currentTrackKey: 'circuit' })).toBe(null);

        expect(buildModalRunsPayload({
            listData: [48.35, 49.1],
            bestTime: null,
            lapTime: 48.35,
            scoreboardChallengeId: 'daily-1',
            scoreboardTrackKey: null,
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: 'daily',
            scoreboardSubhead: 'Daily leaderboard',
            showGlobalLeaderboard: false,
            allowLeaderboardOpen: false
        }, { currentTrackKey: 'circuit' })).toEqual({
            lapTimesArray: [48.35, 49.1],
            bestTime: 48.35,
            currentTime: 48.35,
            scoreboardChallengeId: 'daily-1',
            scoreboardTrackKey: 'circuit',
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: 'daily',
            scoreboardTitle: null,
            scoreboardSubhead: 'Daily leaderboard',
            leaderboardDayOptions: null,
            selectedLeaderboardDayId: null,
            onSelectLeaderboardDay: null,
            onLoadMoreLeaderboard: null,
            onOpenStandings: null,
            primaryActionLabel: null,
            primaryAction: null,
            showGlobalLeaderboard: false,
            allowLeaderboardOpen: false
        });

        expect(buildModalRunsPayload({
            lapTimesArray: [22.18, 22.4],
            bestTime: 22.18,
            currentTime: 22.18,
            scoreboardTrackKey: 'harborParkLoop'
        }, { currentTrackKey: 'circuit' })).toEqual({
            lapTimesArray: [22.18, 22.4],
            bestTime: 22.18,
            currentTime: 22.18,
            scoreboardChallengeId: null,
            scoreboardTrackKey: 'harborParkLoop',
            scoreboardSnapshot: null,
            scoreboardMode: 'daily',
            scoreboardTitle: null,
            scoreboardSubhead: null,
            leaderboardDayOptions: null,
            selectedLeaderboardDayId: null,
            onSelectLeaderboardDay: null,
            onLoadMoreLeaderboard: null,
            onOpenStandings: null,
            primaryActionLabel: null,
            primaryAction: null,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: true
        });

        expect(buildModalRunsPayload({
            lapTime: 44.12,
            bestTime: 44.12,
            trackKey: 'harborParkLoop',
            scoreboardChallengeId: 'daily-2'
        }, { currentTrackKey: 'circuit' })).toEqual({
            lapTimesArray: null,
            bestTime: 44.12,
            currentTime: 44.12,
            scoreboardChallengeId: 'daily-2',
            scoreboardTrackKey: 'harborParkLoop',
            scoreboardSnapshot: null,
            scoreboardMode: 'daily',
            scoreboardTitle: null,
            scoreboardSubhead: null,
            leaderboardDayOptions: null,
            selectedLeaderboardDayId: null,
            onSelectLeaderboardDay: null,
            onLoadMoreLeaderboard: null,
            onOpenStandings: null,
            primaryActionLabel: null,
            primaryAction: null,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: true
        });
    });

    it('builds runs-view options and applies partial payload updates', () => {
        const basePayload = {
            lapTimesArray: [22.4, 22.9],
            bestTime: 22.4,
            currentTime: 22.4,
            scoreboardChallengeId: null,
            scoreboardTrackKey: 'circuit',
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: 'daily',
            scoreboardTitle: null,
            scoreboardSubhead: null,
            leaderboardDayOptions: null,
            selectedLeaderboardDayId: null,
            onSelectLeaderboardDay: null,
            onLoadMoreLeaderboard: null,
            onOpenStandings: null,
            primaryActionLabel: null,
            primaryAction: null,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: true
        };

        expect(buildModalRunsPayload(basePayload, {
            updates: {
                bestTime: 22.18,
                currentTime: 22.18,
                lapTimesArray: [22.18, 22.4]
            }
        })).toEqual({
            ...basePayload,
            bestTime: 22.18,
            currentTime: 22.18,
            lapTimesArray: [22.18, 22.4]
        });

        expect(buildModalRunsPayload(basePayload, {
            updates: {
                bestTime: undefined,
                currentTime: 22.18
            }
        })).toEqual({
            ...basePayload,
            currentTime: 22.18
        });
    });

    it('builds modal action bundles and exact delta thresholds', () => {
        const restart = () => {};
        const primary = () => {};
        const secondary = () => {};
        expect(createModalActions({
            modalKind: 'finish',
            primaryActionLabel: 'Improve',
            primaryAction: primary,
            restartAction: restart,
            secondaryActionLabel: 'Share',
            secondaryAction: secondary
        })).toEqual({
            modalKind: 'finish',
            primaryActionLabel: 'Improve',
            primaryAction: primary,
            restartAction: restart,
            secondaryActionLabel: 'Share',
            secondaryAction: secondary
        });

        expect(buildModalDeltaDisplay({ deltaToBest: 0.0005 })).toEqual({
            text: '0.000s',
            valueClass: ''
        });
        expect(buildModalDeltaDisplay({ deltaToBest: 0.0006 })).toEqual({
            text: '+0.001s',
            valueClass: 'modal-stat-value--delta-positive'
        });
        expect(buildModalDeltaDisplay({ deltaToBest: -0.0005 })).toEqual({
            text: '0.000s',
            valueClass: ''
        });
        expect(buildModalDeltaDisplay({ deltaToBest: -0.0006 })).toEqual({
            text: '-0.001s',
            valueClass: 'modal-stat-value--delta-negative'
        });
    });

    it('covers remaining rank-display branches', () => {
        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#4',
            verificationState: 'pending',
            submissionStage: 'pending'
        })).toMatchObject({
            labelText: 'Rank pending',
            text: '#4'
        });

        expect(buildScoreboardRankDisplay({
            submissionStage: 'rejected',
            statusText: 'Rejected.'
        })).toMatchObject({
            labelText: 'Rank rejected',
            text: 'N/A'
        });

        expect(buildScoreboardRankDisplay({
            statusText: '  Verifying...  '
        }).labelText).toBe('Verifying rank');
    });

    it('preserves leaderboard callbacks and day selectors in modal payloads', () => {
        const onSelect = () => {};
        const onLoadMore = () => {};
        const primaryAction = () => {};
        expect(buildModalRunsPayload({
            listData: [20],
            bestTime: 20,
            lapTime: 20,
            scoreboardTitle: 'Daily',
            scoreboardSubhead: 'Today',
            leaderboardDayOptions: [{ id: 'day-1' }],
            selectedLeaderboardDayId: 'day-1',
            onSelectLeaderboardDay: onSelect,
            onLoadMoreLeaderboard: onLoadMore,
            primaryActionLabel: 'Play',
            primaryAction
        })).toMatchObject({
            scoreboardTitle: 'Daily',
            scoreboardSubhead: 'Today',
            leaderboardDayOptions: [{ id: 'day-1' }],
            selectedLeaderboardDayId: 'day-1',
            onSelectLeaderboardDay: onSelect,
            onLoadMoreLeaderboard: onLoadMore,
            primaryActionLabel: 'Play',
            primaryAction
        });
    });

    it('treats zero as a finite previous best and keeps laps at the max-length boundary', () => {
        expect(buildLapRecord(2, 1.5, 0)).toEqual({
            lapNumber: 2,
            time: 1.5,
            deltaVsBest: 1.5,
        });

        const exact = [{ lapNumber: 1 }, { lapNumber: 2 }];
        expect(pushRecentLap(exact, { lapNumber: 3 }, 3)).toEqual([
            { lapNumber: 1 },
            { lapNumber: 2 },
            { lapNumber: 3 },
        ]);
    });

    it('only applies explicit payload updates when an own property is present', () => {
        const base = {
            lapTimesArray: [20],
            bestTime: 20,
            currentTime: 20,
            scoreboardSnapshot: { isLoading: true },
        };

        expect(buildModalRunsPayload(base, {
            updates: Object.defineProperty({}, 'bestTime', {
                value: undefined,
                enumerable: true,
            }),
        })).toMatchObject({
            bestTime: 20,
            currentTime: 20,
        });

        expect(buildModalRunsPayload(base, {
            updates: { bestTime: 19.5 },
        })).toMatchObject({ bestTime: 19.5 });
    });

    it('normalizes mixed-case verification stages and strips trailing status dots', () => {
        expect(buildScoreboardRankDisplay({
            playerRankLabel: '#2',
            verificationState: ' ERROR ',
            submissionStage: ' error ',
        })).toMatchObject({
            labelText: 'Rank error',
            text: '#2',
        });

        expect(buildScoreboardRankDisplay({
            statusText: 'Rejected...',
        })).toMatchObject({
            labelText: 'Rank rejected',
        });

        expect(buildScoreboardRankDisplay({
            submissionStage: ' VERIFYING ',
            statusText: 'Verifying...',
        }).labelText).toBe('Verifying rank');
    });

    it('treats hasOwnValue as false for null update sources', () => {
        expect(buildModalRunsPayload({ bestTime: 20 }, { updates: null })).toMatchObject({ bestTime: 20 });
        expect(buildModalRunsPayload({ bestTime: 20 }, { updates: undefined })).toMatchObject({ bestTime: 20 });
    });
});
