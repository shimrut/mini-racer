import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';
import { LeaderboardsUi, mergeLeaderboardPages } from '../game/scoreboard/ui.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ui leaderboard helpers', () => {
    it('merges sequential rank pages without duplicating rows', () => {
        expect(mergeLeaderboardPages({
            topRows: [{ rank: 1, displayName: 'One' }, { rank: 2, displayName: 'Old Two' }],
            currentPlayerRow: { rank: 154, displayName: 'You' },
            playerRank: 154,
            hasMore: true,
            nextOffset: 2,
        }, {
            topRows: [{ rank: 2, displayName: 'Two' }, { rank: 3, displayName: 'Three' }],
            hasMore: false,
            nextOffset: null,
        })).toMatchObject({
            topRows: [
                { rank: 1, displayName: 'One' },
                { rank: 2, displayName: 'Two' },
                { rank: 3, displayName: 'Three' },
            ],
            currentPlayerRow: { rank: 154, displayName: 'You' },
            playerRank: 154,
            hasMore: false,
            nextOffset: null,
        });
    });

    it('opens the runs modal with leaderboard-only payload state', () => {
        const showRunsModal = vi.fn();
        const instance = new LeaderboardsUi({ showRunsModal });

        instance.showLeaderboardModalState('back', {
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardChallengeId: 'daily-1',
            scoreboardSubhead: 'Leaderboard · Daily Challenge'
        });

        expect(showRunsModal).toHaveBeenCalledWith(null, null, null, 'back', {
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardChallengeId: 'daily-1',
            scoreboardSubhead: 'Leaderboard · Daily Challenge'
        });
    });

    it('shows the daily leaderboard immediately, then refreshes it with the fetched snapshot', async () => {
        const today = new Date(Date.now()).toISOString().slice(0, 10);
        const scoreboardSnapshot = { playerRankLabel: '#5' };
        const showRunsModal = vi.fn();
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({
                challengeId: 'daily-1',
                trackKey: 'circuit',
                challengeDate: today,
                scoreboardSnapshot: { playerRankLabel: '#9' }
            }))
        };
        const instance = new LeaderboardsUi({ showRunsModal, dailyChallengeUi });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockImplementation(async () => scoreboardSnapshot);

        await instance.openDailyChallengeLeaderboard('back');

        expect(instance.requestDailyChallengeLeaderboardSnapshot).toHaveBeenCalledWith(
            'daily-1',
            { forceRefresh: true, limit: 50, offset: 0 }
        );
        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardTitle: 'Today',
            scoreboardSubhead: 'Classic Circuit',
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot: { isLoading: true },
            onLoadMoreLeaderboard: expect.any(Function),
            leaderboardDayOptions: [{
                challengeId: 'daily-1',
                dayLabel: 'Today',
                dateLabel: new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC'
                }).format(new Date(`${today}T00:00:00.000Z`))
            }],
            selectedLeaderboardDayId: 'daily-1'
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardTitle: 'Today',
            scoreboardSubhead: 'Classic Circuit',
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            leaderboardDayOptions: [{
                challengeId: 'daily-1',
                dayLabel: 'Today',
                dateLabel: new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC'
                }).format(new Date(`${today}T00:00:00.000Z`))
            }],
            selectedLeaderboardDayId: 'daily-1'
        });
    });

    it('shows an older post-bound challenge date instead of calling it Today', async () => {
        const originalDateNow = Date.now;
        Date.now = () => Date.parse('2026-07-12T12:00:00.000Z');
        try {
            const showRunsModal = vi.fn();
            const dailyChallengeUi = {
                getSummary: vi.fn(() => ({ challengeId: 'daily-friday' }))
            };
            const instance = new LeaderboardsUi({ showRunsModal, dailyChallengeUi });
            vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockResolvedValue(null);

            await instance.openDailyChallengeLeaderboardForChallenge({
                id: 'daily-friday',
                trackKey: 'circuit',
                challengeDate: '2026-07-10'
            });

            expect(showRunsModal).toHaveBeenCalledWith(null, null, null, 'close', expect.objectContaining({
                scoreboardTitle: 'Fri Jul 10',
                selectedLeaderboardDayId: 'daily-friday',
                leaderboardDayOptions: [{
                    challengeId: 'daily-friday',
                    dayLabel: 'Fri',
                    dateLabel: 'Jul 10'
                }]
            }));
        } finally {
            Date.now = originalDateNow;
        }
    });

    it('shows the cached track snapshot immediately, then refreshes it', async () => {
        const cachedSnapshot = { playerRankLabel: '#2' };
        const freshSnapshot = { playerRankLabel: '#3' };
        const showRunsModal = vi.fn();
        const loadScoreboardSnapshot = vi.fn(async () => freshSnapshot);
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot: vi.fn(() => cachedSnapshot),
            getScoreboardSnapshot: loadScoreboardSnapshot
        });

        await instance.showTrackLeaderboardModal('circuit', 'close');

        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'close', {
            scoreboardSnapshot: cachedSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
        expect(loadScoreboardSnapshot).toHaveBeenCalledWith({
            trackKey: 'circuit',
            limit: 50,
            offset: 0,
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'close', {
            scoreboardSnapshot: freshSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
    });

    it('loads and appends the next standings page from the continuation offset', async () => {
        const firstPage = {
            topRows: [{ rank: 1, displayName: 'One' }],
            currentPlayerRow: { rank: 154, displayName: 'You', bestTime: 42.3 },
            playerRank: 154,
            playerRankLabel: '#154',
            hasMore: true,
            nextOffset: 50,
        };
        const secondPage = {
            topRows: [{ rank: 51, displayName: 'Fifty One' }],
            hasMore: true,
            nextOffset: 100,
        };
        const showRunsModal = vi.fn();
        const updateModalScoreboardSnapshot = vi.fn();
        const loadScoreboardSnapshot = vi.fn()
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(secondPage);
        const instance = new LeaderboardsUi({
            showRunsModal,
            getScoreboardSnapshot: loadScoreboardSnapshot,
            updateModalScoreboardSnapshot,
        });

        await instance.showTrackLeaderboardModal('circuit');
        const payload = showRunsModal.mock.calls.at(-1)[4];
        await payload.onLoadMoreLeaderboard();

        expect(loadScoreboardSnapshot).toHaveBeenNthCalledWith(2, {
            trackKey: 'circuit',
            limit: 50,
            offset: 50,
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            topRows: [
                { rank: 1, displayName: 'One' },
                { rank: 51, displayName: 'Fifty One' },
            ],
            currentPlayerRow: expect.objectContaining({ rank: 154 }),
            playerRank: 154,
            nextOffset: 100,
        }));
    });

    it('shows a provided track snapshot immediately, then refreshes it', async () => {
        const providedSnapshot = { playerRankLabel: '#4', topRows: [{ playerId: 'p1', bestTime: 18.2 }] };
        const freshSnapshot = { playerRankLabel: '#5', topRows: [{ playerId: 'p2', bestTime: 17.9 }] };
        const showRunsModal = vi.fn();
        const loadScoreboardSnapshot = vi.fn(async () => freshSnapshot);
        const getCachedTrackCardScoreboardSnapshot = vi.fn();
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot,
            getScoreboardSnapshot: loadScoreboardSnapshot
        });

        await instance.showTrackLeaderboardModal('circuit', 'back', {
            scoreboardSnapshot: providedSnapshot
        });

        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', {
            scoreboardSnapshot: providedSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
        expect(getCachedTrackCardScoreboardSnapshot).not.toHaveBeenCalled();
        expect(loadScoreboardSnapshot).toHaveBeenCalledWith({
            trackKey: 'circuit',
            limit: 50,
            offset: 0,
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', {
            scoreboardSnapshot: freshSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
    });

    it('shows a provided daily snapshot immediately, then force-refreshes it', async () => {
        const playedSnapshot = { playerRankLabel: '#3' };
        const freshSnapshot = { playerRankLabel: '#4' };
        const showRunsModal = vi.fn();
        const dailyChallengeUi = { getSummary: vi.fn(() => null) };
        const instance = new LeaderboardsUi({ showRunsModal, dailyChallengeUi });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValue(freshSnapshot);

        await instance.openDailyChallengeLeaderboardForChallenge({
            id: 'daily-2',
            trackKey: 'harborParkLoop',
            scoreboardSnapshot: playedSnapshot
        }, 'back');

        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', {
            scoreboardSnapshot: playedSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'harborParkLoop',
            scoreboardTitle: 'Leaderboard',
            scoreboardSubhead: 'Harbor Park',
            scoreboardChallengeId: 'daily-2',
            leaderboardDayOptions: [{
                challengeId: 'daily-2',
                dayLabel: 'Day',
                dateLabel: '--'
            }],
            selectedLeaderboardDayId: 'daily-2'
        });
        expect(requestSnapshot).toHaveBeenCalledWith('daily-2', {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', {
            scoreboardSnapshot: freshSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'harborParkLoop',
            scoreboardTitle: 'Leaderboard',
            scoreboardSubhead: 'Harbor Park',
            scoreboardChallengeId: 'daily-2',
            leaderboardDayOptions: [{
                challengeId: 'daily-2',
                dayLabel: 'Day',
                dateLabel: '--'
            }],
            selectedLeaderboardDayId: 'daily-2'
        });
    });

    it('keeps a cached track snapshot visible when its refresh fails', async () => {
        const cachedSnapshot = { playerRankLabel: '#2' };
        const showRunsModal = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot: vi.fn(() => cachedSnapshot),
            getScoreboardSnapshot: vi.fn(() => Promise.reject(new Error('boom')))
        });

        await instance.showTrackLeaderboardModal('circuit', 'close');

        expect(showRunsModal).toHaveBeenCalledTimes(1);
        expect(showRunsModal).toHaveBeenCalledWith(null, null, null, 'close', {
            scoreboardSnapshot: cachedSnapshot,
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });

        consoleError.mockRestore();
    });

    it('falls back to an empty track leaderboard state when the fetch fails', async () => {
        const showRunsModal = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot: vi.fn(() => null),
            getScoreboardSnapshot: vi.fn(() => Promise.reject(new Error('boom')))
        });

        await instance.showTrackLeaderboardModal('circuit', 'close');

        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'close', {
            scoreboardSnapshot: { isLoading: true },
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'close', {
            scoreboardSnapshot: null,
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });

        consoleError.mockRestore();
    });
});
