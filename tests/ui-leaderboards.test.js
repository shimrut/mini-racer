import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';
import { LeaderboardsUi } from '../game/scoreboard/ui.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ui leaderboard helpers', () => {
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
        const scoreboardSnapshot = { playerRankLabel: '#5' };
        const showRunsModal = vi.fn();
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({
                challengeId: 'daily-1',
                trackKey: 'circuit',
                scoreboardSnapshot: { playerRankLabel: '#9' }
            }))
        };
        const instance = new LeaderboardsUi({ showRunsModal, dailyChallengeUi });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockImplementation(async () => scoreboardSnapshot);

        await instance.openDailyChallengeLeaderboard('back');

        expect(instance.requestDailyChallengeLeaderboardSnapshot).toHaveBeenCalledWith('daily-1');
        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardSubhead: 'Leaderboard · Daily Challenge',
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot: { playerRankLabel: '#9' }
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardSubhead: 'Leaderboard · Daily Challenge',
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot
        });
    });

    it('uses the cached track snapshot without refetching', async () => {
        const cachedSnapshot = { playerRankLabel: '#2' };
        const showRunsModal = vi.fn();
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot: vi.fn(() => cachedSnapshot)
        });

        await instance.showTrackLeaderboardModal('circuit', 'close');

        expect(showRunsModal).toHaveBeenCalledWith(null, null, null, 'close', {
            scoreboardSnapshot: cachedSnapshot,
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
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
