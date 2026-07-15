import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildModalRunsPayload,
    buildModalRunsViewOptions,
    buildModalDeltaDisplay,
    buildModalStatsPlan,
    buildScoreboardRankDisplay,
    formatCombinedRankOutOf,
    getCombinedRankNumber,
    buildLapRecord,
    isNewBestResult,
    pushRecentLap,
    scheduleModalScoreboardRefresh
} from '../game/race/result-flow.js';

describe('result-flow helpers', () => {
    afterEach(() => {
        vi.restoreAllMocks();
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

    it('formats modal delta display states for result summaries', () => {
        expect(buildModalDeltaDisplay()).toEqual({
            text: '--',
            valueClass: ''
        });

        expect(buildModalDeltaDisplay({ deltaToBest: 0.004 })).toEqual({
            text: '0.00s',
            valueClass: ''
        });

        expect(buildModalDeltaDisplay({ deltaToBest: 1.25 })).toEqual({
            text: '+1.25s',
            valueClass: 'modal-stat-value--delta-positive'
        });

        expect(buildModalDeltaDisplay({ deltaToBest: -0.62 })).toEqual({
            text: '-0.62s',
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

    it('extracts numeric combined rank for medal labels', () => {
        expect(getCombinedRankNumber(null)).toBe(null);
        expect(getCombinedRankNumber({ isLoading: true, playerRank: 2 })).toBe(null);
        expect(getCombinedRankNumber({
            isLoading: false,
            playerRank: 3,
            totalCount: 120
        })).toBe(3);
        expect(getCombinedRankNumber({
            isLoading: false,
            currentPlayerRow: { rank: 5 }
        })).toBe(5);
        expect(getCombinedRankNumber({
            isLoading: false,
            playerRankLabel: '#12'
        })).toBe(12);
    });

    it('formats combined rank as "x out of y" when snapshot has rank and total', () => {
        expect(formatCombinedRankOutOf(null)).toBe('--');
        expect(formatCombinedRankOutOf({ isLoading: true, playerRank: 2, totalCount: 10 })).toBe('--');
        expect(formatCombinedRankOutOf({
            isLoading: false,
            playerRank: 3,
            totalCount: 120
        })).toBe('3 out of 120');
        expect(formatCombinedRankOutOf({
            isLoading: false,
            currentPlayerRow: { rank: 5 },
            totalCount: 99
        })).toBe('5 out of 99');
        expect(formatCombinedRankOutOf({
            isLoading: false,
            playerRank: 2,
            totalCount: 0,
            playerRankLabel: '#2'
        })).toBe('#2');
    });

    it('builds modal stats plans for pause, crash, and win summaries', () => {
        expect(buildModalStatsPlan({
            variant: 'daily-pause',
            lapTime: 50.1,
            bestTime: 48.35,
            deltaToBest: 1.75,
            primaryStatLabel: 'Race Time'
        })).toEqual({
            kind: 'hide',
            display: 'none',
            hasRuns: null,
            args: [],
            rankSnapshot: null
        });

        expect(buildModalStatsPlan({
            isCrash: true,
            impact: 188
        })).toEqual({
            kind: 'crash',
            display: 'flex',
            hasRuns: '',
            args: ['Impact', '188 KPH', 'modal-stat-value--crash']
        });

        expect(buildModalStatsPlan({
            lapTime: 48.35,
            bestTime: null,
            isNewBest: true,
            primaryStatLabel: 'Race Time',
            scoreboardSnapshot: { isLoading: true },
            lapTimesArray: [48.35]
        })).toEqual({
            kind: 'win',
            display: 'grid',
            hasRuns: 'true',
            args: [48.35, null, 'Race Time'],
            rankSnapshot: { isLoading: true },
            showDelta: false,
            lapMedal: null
        });

        expect(buildModalStatsPlan({
            lapTime: 50.2,
            bestTime: 48.35,
            lapTimesArray: []
        })).toEqual({
            kind: 'win',
            display: 'grid',
            hasRuns: '',
            args: [50.2, 1.8500000000000014, 'Lap Time'],
            rankSnapshot: null,
            showDelta: true,
            lapMedal: null
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

    it('waits for pending work before refreshing modal scoreboard data', async () => {
        const order = [];
        let resolvePending;
        const pendingPromise = new Promise((resolve) => {
            resolvePending = () => {
                order.push('pending');
                resolve();
            };
        });
        const applySnapshot = vi.fn((snapshot) => {
            order.push(snapshot.label);
        });

        const refreshPromise = scheduleModalScoreboardRefresh({
            pendingPromise,
            loadSnapshot: async () => {
                order.push('load');
                return { label: 'snapshot' };
            },
            isStillCurrent: () => true,
            applySnapshot,
            logError: 'refresh failed'
        });

        resolvePending();
        await refreshPromise;

        expect(order).toEqual(['pending', 'load', 'snapshot']);
        expect(applySnapshot).toHaveBeenCalledWith({ label: 'snapshot' });
    });

    it('returns snapshots without applying when refresh is stale or has no applier', async () => {
        const applySnapshot = vi.fn();

        await expect(scheduleModalScoreboardRefresh({
            loadSnapshot: async () => ({ label: 'default-current' }),
            applySnapshot
        })).resolves.toEqual({ label: 'default-current' });

        expect(applySnapshot).toHaveBeenCalledWith({ label: 'default-current' });
        applySnapshot.mockClear();

        await expect(scheduleModalScoreboardRefresh({
            loadSnapshot: async () => ({ label: 'stale' }),
            isStillCurrent: () => false,
            applySnapshot
        })).resolves.toEqual({ label: 'stale' });

        expect(applySnapshot).not.toHaveBeenCalled();

        await expect(scheduleModalScoreboardRefresh({
            loadSnapshot: async () => ({ label: 'no-applier' })
        })).resolves.toEqual({ label: 'no-applier' });
    });

    it('returns null when no loader is configured and logs refresh errors', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(scheduleModalScoreboardRefresh()).resolves.toBe(null);
        expect(consoleError).not.toHaveBeenCalled();

        const error = new Error('network failed');
        await expect(scheduleModalScoreboardRefresh({
            loadSnapshot: async () => {
                throw error;
            },
            logError: 'custom refresh failure'
        })).resolves.toBe(null);

        expect(consoleError).toHaveBeenCalledWith('custom refresh failure', error);

        const defaultError = new Error('default failure');
        await expect(scheduleModalScoreboardRefresh({
            loadSnapshot: async () => {
                throw defaultError;
            }
        })).resolves.toBe(null);

        expect(consoleError).toHaveBeenCalledWith('Error refreshing modal scoreboard data', defaultError);
    });
});
