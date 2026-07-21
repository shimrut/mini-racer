import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACK_MODE_DAILY_GP } from '../game/config.js';
import { DAILY_PLAYLIST_DAYS } from '../game/daily-challenge/service.js';
import {
    LeaderboardsUi,
    mergeLeaderboardPages,
    buildLeaderboardDayOptionsForWindow,
} from '../game/scoreboard/ui.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function buildExpectedDayOptions(challenge, playlistChallenges = []) {
    return buildLeaderboardDayOptionsForWindow({
        anchorChallenge: challenge,
        playlistChallenges,
    });
}

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
        const updateModalLeaderboardDayOptions = vi.fn();
        const fallbackChallenge = {
            id: 'daily-1',
            trackKey: 'circuit',
            challengeDate: today,
        };
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({
                challengeId: 'daily-1',
                trackKey: 'circuit',
                challengeDate: today,
                scoreboardSnapshot: { playerRankLabel: '#9' }
            }))
        };
        const instance = new LeaderboardsUi({
            showRunsModal,
            dailyChallengeUi,
            updateModalLeaderboardDayOptions,
        });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockImplementation(async () => scoreboardSnapshot);
        const service = await import('../game/daily-challenge/service.js');
        vi.spyOn(service, 'getCachedDailyChallengePlaylist').mockReturnValue([]);
        const playlistDeferred = createDeferred();
        vi.spyOn(service, 'getDailyChallengePlaylist').mockReturnValue(playlistDeferred.promise);

        const openPromise = instance.openDailyChallengeLeaderboard('back');
        const expectedDayOptions = buildExpectedDayOptions(fallbackChallenge);
        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', expect.objectContaining({
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit',
            scoreboardTitle: 'Classic Circuit',
            scoreboardSubhead: 'Classic Circuit',
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot: { isLoading: true },
            selectedLeaderboardDayId: 'daily-1',
            leaderboardDayOptions: expectedDayOptions,
        }));
        expect(expectedDayOptions).toHaveLength(DAILY_PLAYLIST_DAYS);

        playlistDeferred.resolve([]);
        await openPromise;

        expect(instance.requestDailyChallengeLeaderboardSnapshot).toHaveBeenCalledWith(
            'daily-1',
            { forceRefresh: false, limit: 50, offset: 0 }
        );
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', expect.objectContaining({
            scoreboardChallengeId: 'daily-1',
            scoreboardSnapshot,
            leaderboardDayOptions: expectedDayOptions,
        }));
    });

    it('shows the track name in the standings header instead of the challenge date', async () => {
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
                scoreboardTitle: 'Classic Circuit',
                selectedLeaderboardDayId: 'daily-friday',
                leaderboardDayOptions: expect.arrayContaining([
                    expect.objectContaining({
                        challengeId: 'daily-friday',
                        dayLabel: 'Fri',
                        dateLabel: 'Jul 10',
                    }),
                ]),
            }));
            expect(showRunsModal.mock.calls[0][4].leaderboardDayOptions).toHaveLength(DAILY_PLAYLIST_DAYS);
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
            scoreboardSnapshot: { ...cachedSnapshot, isRefreshing: true },
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
            scoreboardSnapshot: { ...providedSnapshot, isRefreshing: true },
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

    it('shows a provided daily snapshot immediately, then refreshes it', async () => {
        const playedSnapshot = { playerRankLabel: '#3' };
        const freshSnapshot = { playerRankLabel: '#2' };
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

        expect(showRunsModal).toHaveBeenNthCalledWith(1, null, null, null, 'back', expect.objectContaining({
            scoreboardSnapshot: { ...playedSnapshot, isRefreshing: true },
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'harborParkLoop',
            scoreboardTitle: 'Harbor Park',
            scoreboardSubhead: 'Harbor Park',
            scoreboardChallengeId: 'daily-2',
            selectedLeaderboardDayId: 'daily-2',
            leaderboardDayOptions: expect.any(Array),
        }));
        expect(showRunsModal.mock.calls[0][4].leaderboardDayOptions).toHaveLength(DAILY_PLAYLIST_DAYS);
        expect(requestSnapshot).toHaveBeenCalledWith('daily-2', {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(showRunsModal).toHaveBeenNthCalledWith(2, null, null, null, 'back', expect.objectContaining({
            scoreboardChallengeId: 'daily-2',
            scoreboardSnapshot: freshSnapshot,
        }));
    });

    it('uses the initially loaded day snapshots without refreshing on day changes', async () => {
        const challengeA = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: { playerRankLabel: '#8' }
        };
        const challengeB = {
            id: 'daily-b',
            trackKey: 'harborParkLoop',
            scoreboardSnapshot: { playerRankLabel: '#9' }
        };
        const freshA = { playerRankLabel: '#2', topRows: [{ rank: 1, displayName: 'A' }] };
        const freshB = { playerRankLabel: '#3', topRows: [{ rank: 1, displayName: 'B' }] };
        const showRunsModal = vi.fn();
        const instance = new LeaderboardsUi({
            showRunsModal,
            dailyChallengeUi: { getSummary: vi.fn(() => null) }
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockImplementation(async (challengeId) => (
                challengeId === challengeA.id ? freshA : freshB
            ));
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = {
            playlistChallenges: [challengeA, challengeB],
            refreshSession
        };

        await instance.primeDailyLeaderboardRefreshSession(
            [challengeA, challengeB],
            refreshSession,
        );
        expect(requestSnapshot).toHaveBeenCalledTimes(2);

        await instance.openDailyChallengeLeaderboardForChallenge(challengeA, 'close', options);
        showRunsModal.mock.calls.at(-1)[4].onSelectLeaderboardDay(challengeB.id);
        await vi.waitFor(() => {
            expect(showRunsModal.mock.calls.at(-1)[4].scoreboardChallengeId)
                .toBe(challengeB.id);
            expect(showRunsModal.mock.calls.at(-1)[4].scoreboardSnapshot).toBe(freshB);
        });
        const callsBeforeReturningToA = showRunsModal.mock.calls.length;
        showRunsModal.mock.calls.at(-1)[4].onSelectLeaderboardDay(challengeA.id);
        await vi.waitFor(() => {
            expect(showRunsModal).toHaveBeenCalledTimes(callsBeforeReturningToA + 1);
        });

        expect(requestSnapshot.mock.calls.map(([challengeId]) => challengeId)).toEqual([
            challengeA.id,
            challengeB.id
        ]);
        expect(showRunsModal.mock.calls.at(-1)[4]).toEqual(expect.objectContaining({
            scoreboardChallengeId: challengeA.id,
            scoreboardSnapshot: freshA
        }));
        expect(showRunsModal.mock.calls.at(-1)[4].scoreboardSnapshot.isRefreshing)
            .toBeUndefined();
    });

    it('reuses initial day loads that are still running while the player switches days', async () => {
        const challengeA = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: { playerRankLabel: '#8' }
        };
        const challengeB = {
            id: 'daily-b',
            trackKey: 'harborParkLoop',
            scoreboardSnapshot: { playerRankLabel: '#9' }
        };
        const deferredA = createDeferred();
        const deferredB = createDeferred();
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) }
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockImplementation((challengeId) => (
                challengeId === challengeA.id ? deferredA.promise : deferredB.promise
            ));
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = {
            playlistChallenges: [challengeA, challengeB],
            refreshSession
        };

        const initialLoads = instance.primeDailyLeaderboardRefreshSession(
            [challengeA, challengeB],
            refreshSession,
        );
        const firstA = instance.openDailyChallengeLeaderboardForChallenge(challengeA, 'close', options);
        const firstB = instance.openDailyChallengeLeaderboardForChallenge(challengeB, 'close', options);
        const secondA = instance.openDailyChallengeLeaderboardForChallenge(challengeA, 'close', options);

        expect(requestSnapshot.mock.calls.map(([challengeId]) => challengeId)).toEqual([
            challengeA.id,
            challengeB.id
        ]);

        deferredA.resolve({ playerRankLabel: '#2' });
        deferredB.resolve({ playerRankLabel: '#3' });
        await Promise.all([initialLoads, firstA, firstB, secondA]);
    });

    it('retries a day in the same session after its refresh fails', async () => {
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: { playerRankLabel: '#8' }
        };
        const freshSnapshot = { playerRankLabel: '#2' };
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            updateModalScoreboardSnapshot: vi.fn()
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(freshSnapshot);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = { refreshSession };
        instance._pendingDailyLeaderboardRefreshChallengeIds.add(challenge.id);

        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);
        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);

        expect(requestSnapshot).toHaveBeenCalledTimes(2);
        expect(refreshSession.refreshedChallengeIds.has(challenge.id)).toBe(true);
    });

    it('refreshes a cached day again after the leaderboard is closed and reopened', async () => {
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: { playerRankLabel: '#8' }
        };
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) }
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValue({ playerRankLabel: '#2' });

        await instance.openDailyChallengeLeaderboardForChallenge(challenge);
        instance.cancelPendingRequests();
        await instance.openDailyChallengeLeaderboardForChallenge(challenge);

        expect(requestSnapshot).toHaveBeenCalledTimes(2);
        expect(requestSnapshot).toHaveBeenNthCalledWith(1, challenge.id, {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(requestSnapshot).toHaveBeenNthCalledWith(2, challenge.id, {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
    });

    it('forces one newer refresh after an accepted time and keeps that result fresh', async () => {
        const beforeAccepted = { playerRankLabel: '#4', currentPlayerRow: { bestTime: 14.2 } };
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: beforeAccepted
        };
        const beforeSubmission = { playerRankLabel: '#3', currentPlayerRow: { bestTime: 14.2 } };
        const afterAccepted = { playerRankLabel: '#2', currentPlayerRow: { bestTime: 13.8 } };
        const updateModalScoreboardSnapshot = vi.fn();
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            updateModalScoreboardSnapshot
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValueOnce(beforeSubmission)
            .mockResolvedValueOnce(afterAccepted);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = { refreshSession };

        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);
        await instance.refreshDailyChallengeAfterAcceptedSubmission(challenge.id);
        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);

        expect(requestSnapshot).toHaveBeenCalledTimes(2);
        expect(requestSnapshot).toHaveBeenNthCalledWith(1, challenge.id, {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(requestSnapshot).toHaveBeenNthCalledWith(2, challenge.id, {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith({
            ...beforeSubmission,
            isRefreshing: true
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith(afterAccepted);
    });

    it('marks retained WebView standings stale so the next open refreshes them', async () => {
        const cachedSnapshot = {
            playerRankLabel: '#4',
            leaderboardEntryCount: 6,
            topRows: [{ rank: 1, displayName: 'Cached' }]
        };
        const freshSnapshot = {
            playerRankLabel: '#4',
            leaderboardEntryCount: 7,
            topRows: [{ rank: 1, displayName: 'Fresh' }]
        };
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: cachedSnapshot
        };
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            isRunsViewActive: () => false
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValue(freshSnapshot);

        await instance.refreshDailyChallengeAfterResume(challenge.id);
        expect(requestSnapshot).not.toHaveBeenCalled();

        await instance.openDailyChallengeLeaderboardForChallenge(challenge);

        expect(requestSnapshot).toHaveBeenCalledTimes(1);
        expect(requestSnapshot).toHaveBeenCalledWith(challenge.id, {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
    });

    it('refreshes visible retained WebView standings immediately on resume', async () => {
        const cachedSnapshot = {
            playerRankLabel: '#4',
            leaderboardEntryCount: 6,
            topRows: [{ rank: 1, displayName: 'Cached' }]
        };
        const freshSnapshot = {
            playerRankLabel: '#4',
            leaderboardEntryCount: 7,
            topRows: [{ rank: 1, displayName: 'Fresh' }]
        };
        const updateModalScoreboardSnapshot = vi.fn();
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            isRunsViewActive: () => true,
            updateModalScoreboardSnapshot
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValue(freshSnapshot);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        refreshSession.selectedChallengeId = 'daily-a';
        refreshSession.snapshotByChallengeId.set('daily-a', cachedSnapshot);

        await instance.refreshDailyChallengeAfterResume('daily-a');

        expect(requestSnapshot).toHaveBeenCalledTimes(1);
        expect(requestSnapshot).toHaveBeenCalledWith('daily-a', {
            forceRefresh: true,
            limit: 50,
            offset: 0,
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenNthCalledWith(1, {
            ...cachedSnapshot,
            isRefreshing: true,
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenNthCalledWith(2, freshSnapshot);
    });

    it('refreshes only the submitted day after an accepted better time', async () => {
        const beforeAccepted = { playerRankLabel: '#4', currentPlayerRow: { bestTime: 14.2 } };
        const afterAccepted = { playerRankLabel: '#2', currentPlayerRow: { bestTime: 13.8 } };
        const otherDaySnapshot = { playerRankLabel: '#7', currentPlayerRow: { bestTime: 18.4 } };
        const submittedChallenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: beforeAccepted
        };
        const otherChallenge = {
            id: 'daily-b',
            trackKey: 'harborParkLoop',
            scoreboardSnapshot: otherDaySnapshot
        };
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            updateModalScoreboardSnapshot: vi.fn()
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValue(afterAccepted);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = { refreshSession };

        await instance.openDailyChallengeLeaderboardForChallenge(
            submittedChallenge,
            'close',
            options,
        );
        await instance.openDailyChallengeLeaderboardForChallenge(
            otherChallenge,
            'close',
            options,
        );
        await instance.refreshDailyChallengeAfterAcceptedSubmission(submittedChallenge.id);
        submittedChallenge.scoreboardSnapshot = afterAccepted;
        await instance.openDailyChallengeLeaderboardForChallenge(
            otherChallenge,
            'close',
            options,
        );
        await instance.openDailyChallengeLeaderboardForChallenge(
            submittedChallenge,
            'close',
            options,
        );

        expect(requestSnapshot.mock.calls).toEqual([
            [submittedChallenge.id, { forceRefresh: true, limit: 50, offset: 0 }],
            [otherChallenge.id, { forceRefresh: true, limit: 50, offset: 0 }],
            [submittedChallenge.id, { forceRefresh: true, limit: 50, offset: 0 }],
        ]);
    });

    it('runs the accepted-time refresh after any older request for that day', async () => {
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: { playerRankLabel: '#8' }
        };
        const olderRequest = createDeferred();
        const acceptedRequest = createDeferred();
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            updateModalScoreboardSnapshot: vi.fn()
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockReturnValueOnce(olderRequest.promise)
            .mockReturnValueOnce(acceptedRequest.promise);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        instance._pendingDailyLeaderboardRefreshChallengeIds.add(challenge.id);

        const initialOpen = instance.openDailyChallengeLeaderboardForChallenge(
            challenge,
            'close',
            { refreshSession }
        );
        const acceptedRefresh = instance.refreshDailyChallengeAfterAcceptedSubmission(challenge.id);

        expect(requestSnapshot).toHaveBeenCalledTimes(1);
        olderRequest.resolve({ playerRankLabel: '#4' });
        await vi.waitFor(() => {
            expect(requestSnapshot).toHaveBeenCalledTimes(2);
        });

        acceptedRequest.resolve({ playerRankLabel: '#2' });
        await Promise.all([initialOpen, acceptedRefresh]);
    });

    it('leaves an accepted-time refresh eligible for retry when it fails', async () => {
        const beforeAccepted = { playerRankLabel: '#4' };
        const challenge = {
            id: 'daily-a',
            trackKey: 'circuit',
            scoreboardSnapshot: beforeAccepted
        };
        const afterRetry = { playerRankLabel: '#2' };
        const instance = new LeaderboardsUi({
            showRunsModal: vi.fn(),
            dailyChallengeUi: { getSummary: vi.fn(() => null) },
            updateModalScoreboardSnapshot: vi.fn()
        });
        const requestSnapshot = vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot')
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(afterRetry);
        const refreshSession = instance.startDailyLeaderboardRefreshSession();
        const options = { refreshSession };

        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);
        await instance.refreshDailyChallengeAfterAcceptedSubmission(challenge.id);
        await instance.openDailyChallengeLeaderboardForChallenge(challenge, 'close', options);

        expect(requestSnapshot).toHaveBeenCalledTimes(2);
        expect(refreshSession.snapshotByChallengeId.get(challenge.id)).toBe(afterRetry);
    });

    it('clears the daily refresh spinner without replacing cached standings on failure', async () => {
        const cachedSnapshot = { playerRankLabel: '#3' };
        const showRunsModal = vi.fn();
        const updateModalScoreboardSnapshot = vi.fn();
        const dailyChallengeUi = { getSummary: vi.fn(() => null) };
        const instance = new LeaderboardsUi({
            showRunsModal,
            dailyChallengeUi,
            updateModalScoreboardSnapshot
        });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockResolvedValue(null);
        instance._pendingDailyLeaderboardRefreshChallengeIds.add('daily-2');

        await instance.openDailyChallengeLeaderboardForChallenge({
            id: 'daily-2',
            trackKey: 'harborParkLoop',
            scoreboardSnapshot: cachedSnapshot
        }, 'back');

        expect(showRunsModal).toHaveBeenCalledTimes(1);
        expect(showRunsModal).toHaveBeenCalledWith(
            null,
            null,
            null,
            'back',
            expect.objectContaining({
                scoreboardSnapshot: { ...cachedSnapshot, isRefreshing: true }
            })
        );
        expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith(cachedSnapshot);
    });

    it('keeps a cached track snapshot visible when its refresh fails', async () => {
        const cachedSnapshot = { playerRankLabel: '#2' };
        const showRunsModal = vi.fn();
        const updateModalScoreboardSnapshot = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const instance = new LeaderboardsUi({
            showRunsModal,
            getCachedTrackCardScoreboardSnapshot: vi.fn(() => cachedSnapshot),
            getScoreboardSnapshot: vi.fn(() => Promise.reject(new Error('boom'))),
            updateModalScoreboardSnapshot
        });

        await instance.showTrackLeaderboardModal('circuit', 'close');

        expect(showRunsModal).toHaveBeenCalledTimes(1);
        expect(showRunsModal).toHaveBeenCalledWith(null, null, null, 'close', {
            scoreboardSnapshot: { ...cachedSnapshot, isRefreshing: true },
            onLoadMoreLeaderboard: expect.any(Function),
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: 'circuit'
        });
        expect(updateModalScoreboardSnapshot).toHaveBeenCalledWith(cachedSnapshot);

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

    it('builds seven day options from the anchor challenge even when the playlist cache is empty', () => {
        const today = '2026-07-21';
        const options = buildLeaderboardDayOptionsForWindow({
            anchorChallenge: {
                id: 'daily-today',
                trackKey: 'circuit',
                challengeDate: today,
            },
            playlistChallenges: [],
            nowMs: Date.parse(`${today}T12:00:00.000Z`),
        });

        expect(options).toHaveLength(DAILY_PLAYLIST_DAYS);
        expect(options[0]).toMatchObject({
            challengeId: 'daily-today',
            dayLabel: 'Today',
            challengeDate: today,
        });
        expect(options.slice(1).every((option) => option.challengeId === null)).toBe(true);
    });

    it('updates the day rail when the playlist resolves while standings stay open', async () => {
        const today = new Date(Date.now()).toISOString().slice(0, 10);
        const showRunsModal = vi.fn();
        const updateModalLeaderboardDayOptions = vi.fn();
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({
                challengeId: 'daily-1',
                trackKey: 'circuit',
                challengeDate: today,
            })),
        };
        const instance = new LeaderboardsUi({
            showRunsModal,
            dailyChallengeUi,
            updateModalLeaderboardDayOptions,
        });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockResolvedValue({
            playerRankLabel: '#3',
        });
        const service = await import('../game/daily-challenge/service.js');
        vi.spyOn(service, 'getCachedDailyChallengePlaylist').mockReturnValue([]);
        const playlistDeferred = createDeferred();
        vi.spyOn(service, 'getDailyChallengePlaylist').mockReturnValue(playlistDeferred.promise);

        const openPromise = instance.openDailyChallengeLeaderboard('close');
        playlistDeferred.resolve([
            {
                id: 'daily-1',
                trackKey: 'circuit',
                challengeDate: today,
            },
            {
                id: 'daily-0',
                trackKey: 'harborParkLoop',
                challengeDate: new Date(Date.parse(`${today}T00:00:00.000Z`) - 86400000)
                    .toISOString()
                    .slice(0, 10),
            },
        ]);
        await openPromise;

        expect(updateModalLeaderboardDayOptions).toHaveBeenCalledWith(expect.objectContaining({
            leaderboardDayOptions: expect.arrayContaining([
                expect.objectContaining({ challengeId: 'daily-1' }),
                expect.objectContaining({ challengeId: 'daily-0' }),
            ]),
        }));
    });

    it('clears loading when the refresh returns null without a cached snapshot', async () => {
        const today = new Date(Date.now()).toISOString().slice(0, 10);
        const showRunsModal = vi.fn();
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({
                challengeId: 'daily-1',
                trackKey: 'circuit',
                challengeDate: today,
            })),
        };
        const instance = new LeaderboardsUi({ showRunsModal, dailyChallengeUi });
        vi.spyOn(instance, 'requestDailyChallengeLeaderboardSnapshot').mockResolvedValue(null);
        const service = await import('../game/daily-challenge/service.js');
        vi.spyOn(service, 'getCachedDailyChallengePlaylist').mockReturnValue([]);
        vi.spyOn(service, 'getDailyChallengePlaylist').mockResolvedValue([]);

        await instance.openDailyChallengeLeaderboard('close');

        expect(showRunsModal).toHaveBeenLastCalledWith(
            null,
            null,
            null,
            'close',
            expect.objectContaining({
                scoreboardChallengeId: 'daily-1',
                scoreboardSnapshot: null,
            }),
        );
    });
});
