import { TRACKS } from '../track/tracks.js';
import { TRACK_MODE_DAILY_GP } from '../config.js';
import {
    getCachedDailyChallengePlaylist,
    getCachedDailyChallengeSnapshot,
    getDailyChallengeTrackName,
    getDailyChallengePlaylist,
    prefetchDailyChallengeSnapshots,
    getDailyChallengeSnapshot
} from '../daily-challenge/service.js';
import { getScoreboardSnapshot } from './service.js';

const FULL_STANDINGS_PAGE_SIZE = 50;

export function mergeLeaderboardPages(currentSnapshot, nextPage) {
    if (!currentSnapshot || typeof currentSnapshot !== 'object') return nextPage || null;
    if (!nextPage || typeof nextPage !== 'object') return currentSnapshot;

    const rowsByRank = new Map();
    for (const row of [
        ...(Array.isArray(currentSnapshot.topRows) ? currentSnapshot.topRows : []),
        ...(Array.isArray(nextPage.topRows) ? nextPage.topRows : []),
    ]) {
        const rank = Number(row?.rank);
        if (!Number.isFinite(rank) || rank < 1) continue;
        rowsByRank.set(rank, row);
    }

    return {
        ...currentSnapshot,
        ...nextPage,
        topRows: [...rowsByRank.values()].sort((a, b) => a.rank - b.rank),
        nearbyRows: Array.isArray(currentSnapshot.nearbyRows)
            ? currentSnapshot.nearbyRows
            : [],
        currentPlayerRow: nextPage.currentPlayerRow || currentSnapshot.currentPlayerRow || null,
        playerRank: nextPage.playerRank ?? currentSnapshot.playerRank ?? null,
        playerRankLabel: nextPage.playerRankLabel ?? currentSnapshot.playerRankLabel ?? null,
    };
}

function isValidDailyChallenge(challenge) {
    return Boolean(challenge?.id && challenge.trackKey && TRACKS[challenge.trackKey]);
}

function getDailyChallengeDateSource(challenge) {
    if (typeof challenge?.startsAt === 'string' && challenge.startsAt) {
        return challenge.startsAt;
    }
    if (typeof challenge?.challengeDate === 'string' && challenge.challengeDate) {
        return `${challenge.challengeDate}T00:00:00.000Z`;
    }
    return '';
}

function isDailyChallengeToday(challenge, nowMs = Date.now()) {
    const challengeTimeMs = Date.parse(getDailyChallengeDateSource(challenge));
    if (!Number.isFinite(challengeTimeMs) || !Number.isFinite(nowMs)) return false;

    return new Date(challengeTimeMs).toISOString().slice(0, 10)
        === new Date(nowMs).toISOString().slice(0, 10);
}

function getDailyChallengeLeaderboardTitle(challenge) {
    if (isDailyChallengeToday(challenge)) {
        return 'Today';
    }

    const source = getDailyChallengeDateSource(challenge);
    const timeMs = Date.parse(source);
    if (!Number.isFinite(timeMs)) {
        return 'Leaderboard';
    }

    const date = new Date(timeMs);
    const weekday = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        timeZone: 'UTC'
    }).format(date);
    const dateLabel = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC'
    }).format(date);
    return `${weekday} ${dateLabel}`;
}

function buildDailyChallengeLeaderboardDayOption(challenge) {
    if (!isValidDailyChallenge(challenge)) return null;

    const source = getDailyChallengeDateSource(challenge);
    const timeMs = Date.parse(source);
    if (!Number.isFinite(timeMs)) {
        return {
            challengeId: challenge.id,
            dayLabel: 'Day',
            dateLabel: '--'
        };
    }

    const date = new Date(timeMs);
    return {
        challengeId: challenge.id,
        dayLabel: isDailyChallengeToday(challenge)
            ? 'Today'
            : new Intl.DateTimeFormat('en-US', {
                weekday: 'short',
                timeZone: 'UTC'
            }).format(date),
        dateLabel: new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC'
        }).format(date)
    };
}

function mergeDailyChallengeHistory(challenges = [], fallbackChallenge = null) {
    const merged = [];
    const seen = new Set();
    const pushChallenge = (challenge) => {
        if (!isValidDailyChallenge(challenge) || seen.has(challenge.id)) return;
        seen.add(challenge.id);
        merged.push(challenge);
    };

    for (const challenge of Array.isArray(challenges) ? challenges : []) {
        pushChallenge(challenge);
    }
    if (isValidDailyChallenge(fallbackChallenge)) {
        pushChallenge(fallbackChallenge);
    }
    return merged;
}

export class LeaderboardsUi {
    constructor({
        showRunsModal,
        dailyChallengeUi,
        onStartDailyChallenge = null,
        getCachedTrackCardScoreboardSnapshot = () => null,
        getScoreboardSnapshot: loadScoreboardSnapshot = getScoreboardSnapshot,
        isRunsViewActive = () => true,
        updateModalScoreboardSnapshot = () => {},
    } = {}) {
        this.showRunsModal = showRunsModal;
        this.dailyChallengeUi = dailyChallengeUi;
        this.onStartDailyChallenge = onStartDailyChallenge;
        this.getCachedTrackCardScoreboardSnapshot = getCachedTrackCardScoreboardSnapshot;
        this.loadScoreboardSnapshot = loadScoreboardSnapshot;
        this.isRunsViewActive = isRunsViewActive;
        this.updateModalScoreboardSnapshot = updateModalScoreboardSnapshot;
        this._requestVersion = 0;
    }

    showLeaderboardModalState(returnMode = 'close', {
        scoreboardSnapshot = null,
        scoreboardChallengeId = null,
        scoreboardTrackKey = null,
        scoreboardTitle = null,
        scoreboardSubhead = null,
        leaderboardDayOptions = null,
        selectedLeaderboardDayId = null,
        onSelectLeaderboardDay = null,
        primaryActionLabel = null,
        primaryAction = null,
        onLoadMoreLeaderboard = null,
        onClose = null
    } = {}) {
        const payload = {
            scoreboardSnapshot,
            scoreboardMode: TRACK_MODE_DAILY_GP
        };
        if (scoreboardTrackKey !== null) {
            payload.scoreboardTrackKey = scoreboardTrackKey;
        }
        if (scoreboardChallengeId !== null) {
            payload.scoreboardChallengeId = scoreboardChallengeId;
        }
        if (scoreboardTitle !== null) {
            payload.scoreboardTitle = scoreboardTitle;
        }
        if (scoreboardSubhead !== null) {
            payload.scoreboardSubhead = scoreboardSubhead;
        }
        if (Array.isArray(leaderboardDayOptions) && leaderboardDayOptions.length) {
            payload.leaderboardDayOptions = leaderboardDayOptions;
        }
        if (selectedLeaderboardDayId !== null) {
            payload.selectedLeaderboardDayId = selectedLeaderboardDayId;
        }
        if (typeof onSelectLeaderboardDay === 'function') {
            payload.onSelectLeaderboardDay = onSelectLeaderboardDay;
        }
        if (primaryActionLabel !== null) {
            payload.primaryActionLabel = primaryActionLabel;
        }
        if (typeof primaryAction === 'function') {
            payload.primaryAction = primaryAction;
        }
        if (typeof onLoadMoreLeaderboard === 'function') {
            payload.onLoadMoreLeaderboard = onLoadMoreLeaderboard;
        }
        if (typeof onClose === 'function') {
            payload.onClose = onClose;
        }
        this.showRunsModal(null, null, null, returnMode, payload);
    }

    cancelPendingRequests() {
        this._requestVersion += 1;
    }

    resolveInitialDailyChallengeSnapshot(challenge) {
        const providedSnapshot = challenge?.scoreboardSnapshot;
        if (
            providedSnapshot
            && typeof providedSnapshot === 'object'
            && !providedSnapshot.isLoading
        ) {
            return providedSnapshot;
        }

        return getCachedDailyChallengeSnapshot(challenge?.id);
    }

    syncDailyChallengeSummarySnapshot(challengeId, scoreboardSnapshot) {
        const summary = this.dailyChallengeUi.getSummary();
        if (summary?.challengeId !== challengeId) return;

        this.dailyChallengeUi.setDailyChallengeSummary({
            ...summary,
            rankLabel: scoreboardSnapshot?.playerRankLabel || '--',
            scoreboardSnapshot: scoreboardSnapshot || null
        });
    }

    async requestDailyChallengeLeaderboardSnapshot(challengeId, {
        forceRefresh = false,
        limit = FULL_STANDINGS_PAGE_SIZE,
        offset = 0,
    } = {}) {
        if (!challengeId) return null;

        try {
            const scoreboardSnapshot = await getDailyChallengeSnapshot({
                challengeId,
                limit,
                offset,
                forceRefresh
            });
            this.syncDailyChallengeSummarySnapshot(challengeId, scoreboardSnapshot);
            return scoreboardSnapshot || null;
        } catch (error) {
            console.error('Error loading daily challenge leaderboard:', error);
            return null;
        }
    }

    async openDailyChallengeLeaderboard(returnMode = 'close', options = {}) {
        const summary = this.dailyChallengeUi.getSummary();
        if (!summary?.challengeId || !summary.trackKey) return;

        const fallbackChallenge = {
            id: summary.challengeId,
            trackKey: summary.trackKey,
            startsAt: summary.startsAt || null,
            challengeDate: summary.challengeDate || null
        };
        const playlistChallenges = mergeDailyChallengeHistory(
            getCachedDailyChallengePlaylist(),
            fallbackChallenge
        );
        const currentChallenge = playlistChallenges.find(
            (challenge) => challenge.id === summary.challengeId
        ) || fallbackChallenge;

        await this.openDailyChallengeLeaderboardForChallenge(
            currentChallenge,
            returnMode,
            {
                ...options,
                playlistChallenges
            }
        );
    }

    buildDailyChallengeLeaderboardRows(challenges = []) {
        return (Array.isArray(challenges) ? challenges : [])
            .filter((challenge) => challenge?.id && challenge.trackKey && TRACKS[challenge.trackKey])
            .map((challenge) => ({
                challenge,
                trackKey: challenge.trackKey,
                scoreboardSnapshot: this.resolveInitialDailyChallengeSnapshot(challenge) || { isLoading: true }
            }));
    }

    openDailyChallengeLeaderboardOverviewModal(challenges, actions) {
        const rows = this.buildDailyChallengeLeaderboardRows(challenges);
        this.dailyChallengeUi.openLeaderboardTracksModal(rows.length ? rows : null, actions);
        return rows;
    }

    async openDailyChallengeLeaderboardOverview() {
        const requestId = ++this._requestVersion;
        let loadedChallenges = getCachedDailyChallengePlaylist();
        let currentRows = [];
        const actions = {
            onTrack: (challenge) => {
                void this.openDailyChallengeLeaderboardForChallenge(challenge, 'close', {
                    onClose: () => {
                        if (loadedChallenges.length) {
                            currentRows = this.buildDailyChallengeLeaderboardRows(loadedChallenges);
                        }
                        this.dailyChallengeUi.openLeaderboardTracksModal(currentRows, actions);
                    }
                });
            }
        };

        currentRows = this.openDailyChallengeLeaderboardOverviewModal(
            loadedChallenges.length ? loadedChallenges : null,
            actions
        );

        try {
            loadedChallenges = await getDailyChallengePlaylist();
            await prefetchDailyChallengeSnapshots(
                loadedChallenges.map((challenge) => challenge?.id).filter(Boolean)
            );
            currentRows = this.buildDailyChallengeLeaderboardRows(loadedChallenges);
        } catch (error) {
            console.error('Error loading leaderboard tracks:', error);
            currentRows = [];
        }

        if (
            requestId === this._requestVersion
            && this.dailyChallengeUi.isLeaderboardTracksModalOpen?.()
        ) {
            this.dailyChallengeUi.renderLeaderboardTracks?.(currentRows, actions);
        }
    }

    async openDailyChallengeLeaderboardForChallenge(challenge, returnMode = 'close', {
        onClose = null,
        playlistChallenges = null
    } = {}) {
        if (!challenge?.id || !challenge.trackKey || !TRACKS[challenge.trackKey]) return;

        const requestId = ++this._requestVersion;
        const historyChallenges = mergeDailyChallengeHistory(
            playlistChallenges ?? getCachedDailyChallengePlaylist(),
            challenge
        );
        const leaderboardDayOptions = historyChallenges
            .map((entry) => buildDailyChallengeLeaderboardDayOption(entry))
            .filter(Boolean);
        const sharedOptions = {
            scoreboardMode: TRACK_MODE_DAILY_GP,
            scoreboardTrackKey: challenge.trackKey,
            scoreboardTitle: getDailyChallengeLeaderboardTitle(challenge),
            scoreboardSubhead: getDailyChallengeTrackName(challenge),
            leaderboardDayOptions,
            selectedLeaderboardDayId: challenge.id,
            onSelectLeaderboardDay: leaderboardDayOptions.length > 1
                ? (selectedChallengeId) => {
                    if (!selectedChallengeId || selectedChallengeId === challenge.id) return;
                    const nextChallenge = historyChallenges.find(
                        (entry) => entry.id === selectedChallengeId
                    );
                    if (!nextChallenge) return;
                    void this.openDailyChallengeLeaderboardForChallenge(
                        nextChallenge,
                        returnMode,
                        {
                            onClose,
                            playlistChallenges: historyChallenges
                        }
                    );
                }
                : null
        };
        const initialSnapshot = this.resolveInitialDailyChallengeSnapshot(challenge);
        let currentSnapshot = initialSnapshot;
        let pageRequest = null;
        const loadMoreLeaderboard = async () => {
            if (pageRequest) return pageRequest;
            const nextOffset = Number(currentSnapshot?.nextOffset);
            if (!currentSnapshot?.hasMore || !Number.isFinite(nextOffset)) {
                return currentSnapshot;
            }

            pageRequest = this.requestDailyChallengeLeaderboardSnapshot(challenge.id, {
                limit: FULL_STANDINGS_PAGE_SIZE,
                offset: nextOffset,
            }).then((page) => {
                if (!page || requestId !== this._requestVersion) return currentSnapshot;
                currentSnapshot = mergeLeaderboardPages(currentSnapshot, page);
                this.updateModalScoreboardSnapshot(currentSnapshot);
                return currentSnapshot;
            }).finally(() => {
                pageRequest = null;
            });
            return pageRequest;
        };
        sharedOptions.onLoadMoreLeaderboard = loadMoreLeaderboard;

        this.showLeaderboardModalState(returnMode, {
            ...sharedOptions,
            scoreboardChallengeId: challenge.id,
            scoreboardSnapshot: initialSnapshot || { isLoading: true },
            onClose
        });

        const scoreboardSnapshot = await this.requestDailyChallengeLeaderboardSnapshot(
            challenge.id,
            {
                forceRefresh: true,
                limit: FULL_STANDINGS_PAGE_SIZE,
                offset: 0,
            }
        );
        if (requestId !== this._requestVersion) return;
        if (!scoreboardSnapshot && initialSnapshot) return;
        currentSnapshot = scoreboardSnapshot;

        if (this.isRunsViewActive()) {
            this.showLeaderboardModalState(returnMode, {
                ...sharedOptions,
                scoreboardChallengeId: challenge.id,
                scoreboardSnapshot,
                onClose
            });
        } else {
            this.updateModalScoreboardSnapshot(scoreboardSnapshot);
        }
    }

    async showTrackLeaderboardModal(trackKey, returnMode = 'close', {
        scoreboardSnapshot = null
    } = {}) {
        if (!trackKey || !TRACKS[trackKey]) return;

        const providedSnapshot =
            scoreboardSnapshot
            && typeof scoreboardSnapshot === 'object'
            && !scoreboardSnapshot.isLoading
                ? scoreboardSnapshot
                : null;
        const cachedSnapshot = providedSnapshot
            || this.getCachedTrackCardScoreboardSnapshot(trackKey, TRACK_MODE_DAILY_GP);
        const requestId = ++this._requestVersion;
        let currentSnapshot = cachedSnapshot;
        let pageRequest = null;
        const loadMoreLeaderboard = async () => {
            if (pageRequest) return pageRequest;
            const nextOffset = Number(currentSnapshot?.nextOffset);
            if (!currentSnapshot?.hasMore || !Number.isFinite(nextOffset)) {
                return currentSnapshot;
            }
            pageRequest = this.loadScoreboardSnapshot({
                trackKey,
                limit: FULL_STANDINGS_PAGE_SIZE,
                offset: nextOffset,
            }).then((page) => {
                if (!page || requestId !== this._requestVersion) return currentSnapshot;
                currentSnapshot = mergeLeaderboardPages(currentSnapshot, page);
                this.updateModalScoreboardSnapshot(currentSnapshot);
                return currentSnapshot;
            }).finally(() => {
                pageRequest = null;
            });
            return pageRequest;
        };
        this.showLeaderboardModalState(returnMode, {
            scoreboardSnapshot: cachedSnapshot || { isLoading: true },
            scoreboardTrackKey: trackKey,
            onLoadMoreLeaderboard: loadMoreLeaderboard,
        });

        try {
            const freshSnapshot = await this.loadScoreboardSnapshot({
                trackKey,
                limit: FULL_STANDINGS_PAGE_SIZE,
                offset: 0,
            });
            if (requestId !== this._requestVersion) return;
            currentSnapshot = freshSnapshot;

            if (this.isRunsViewActive()) {
                this.showLeaderboardModalState(returnMode, {
                    scoreboardSnapshot: freshSnapshot,
                    scoreboardTrackKey: trackKey,
                    onLoadMoreLeaderboard: loadMoreLeaderboard,
                });
            } else {
                this.updateModalScoreboardSnapshot(freshSnapshot);
            }
        } catch (error) {
            console.error('Error loading track leaderboard:', error);
            if (requestId !== this._requestVersion) return;
            if (cachedSnapshot) return;

            if (this.isRunsViewActive()) {
                this.showLeaderboardModalState(returnMode, {
                    scoreboardSnapshot: null,
                    scoreboardTrackKey: trackKey
                });
            } else {
                this.updateModalScoreboardSnapshot(null);
            }
        }
    }
}
