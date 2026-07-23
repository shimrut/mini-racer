import { getMedalForRaceTime } from '../medals/medal-timing.js';
import { normalizeCampaignLobbyState } from '../lobby/service.js';
import { normalizeScoreboardSnapshot } from '../scoreboard/snapshot.js';
import { mergeLeaderboardPages } from '../scoreboard/ui.js';
import { getTrackName } from '../track/catalog.js';
import { createModalActions } from '../race/result-flow.js';
import {
    createCampaignChallenge,
    getCampaignBootstrap,
    getCampaignChallenge,
    getCampaignPbGhost,
    getCampaignSnapshot,
    previewCampaignChallenge,
    saveLocalCampaignFinish,
    startLocalCampaign,
    startServerCampaignRace,
    submitCampaignChallengeRun,
    submitCampaignRun,
} from './service.js';
import { getCampaignStage } from './manifest.js';

function toRaceChallenge(stage, mode = 'campaign') {
    return {
        id: stage.raceId,
        challengeDate: 'Campaign',
        trackKey: stage.trackKey,
        startsAt: '1970-01-01T00:00:00.000Z',
        endsAt: '9999-12-31T23:59:59.999Z',
        availableUntil: '9999-12-31T23:59:59.999Z',
        status: 'active',
        rulesRevision: stage.rulesRevision,
        objectiveType: stage.lapCount === 1 ? 'single_lap_fastest' : 'multi_lap_total',
        objectiveParams: { lapCount: stage.lapCount },
        skin: 'default',
        mode,
    };
}

function decorateCampaignState(bootstrap) {
    const progress = bootstrap?.progress || {};
    const results = progress.resultsByRaceId || {};
    const unlocked = new Set(progress.unlockedRaceIds || []);
    return {
        signedIn: bootstrap?.signedIn === true,
        startedAt: progress.startedAt || null,
        complete: progress.complete === true,
        stages: (bootstrap?.stages || []).map((stage) => {
            const result = results[stage.raceId] || null;
            return {
                ...stage,
                id: stage.raceId,
                index: stage.stageIndex,
                numberLabel: stage.stageNumber,
                laps: stage.lapCount,
                trackName: getTrackName(stage.trackKey, stage.trackKey),
                unlocked: unlocked.has(stage.raceId),
                bestTimeMs: result?.bestTimeMs ?? null,
                medal: result?.medal ?? null,
                standingsAvailable: true,
            };
        }),
    };
}

export function normalizeCampaignLeaderboardSnapshot(body) {
    if (!body) return null;
    const normalizeRow = (row) => row ? {
        ...row,
        bestTime: Number(row.bestTimeMs) / 1000,
    } : null;
    const currentPlayerRow = normalizeRow(body.currentPlayerRow);
    const playerRank = Number.isFinite(Number(currentPlayerRow?.rank))
        ? Number(currentPlayerRow.rank)
        : null;
    return normalizeScoreboardSnapshot({
        ...body,
        topRows: Array.isArray(body.rows) ? body.rows.map(normalizeRow) : [],
        currentPlayerRow,
        leaderboardEntryCount: body.totalCount,
        playerRank,
        playerRankLabel: playerRank ? `#${playerRank}` : null,
    });
}

export function buildCampaignLeaderboardOptions(campaignState) {
    const stages = Array.isArray(campaignState?.stages) ? campaignState.stages : [];
    return stages
        .filter((stage) => stage.unlocked)
        .map((stage) => ({
            challengeId: stage.id,
            monthLabel: 'Stage',
            dayNumberLabel: stage.numberLabel,
            dateLabel: stage.trackName,
            ariaLabel: `View ${stage.trackName} campaign standings`,
        }));
}

export const campaignEngineMethods = {
    async loadCampaignLobby({ show = true } = {}) {
        const bootstrap = await getCampaignBootstrap();
        this.campaignBootstrap = bootstrap;
        this.campaignLobbyState = normalizeCampaignLobbyState(decorateCampaignState(bootstrap));
        if (show) {
            if (this.status !== 'ready' || this.currentChallengeRun) {
                this.reset(false, { showStartOverlay: false });
            }
            this.activeRaceMode = 'campaign';
            this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
            this.lobbyUi.showCampaign(this.campaignLobbyState);
        }
        return this.campaignLobbyState;
    },

    showHomeLobby() {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'home';
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        this.clearDailyChallengeRun();
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showHome();
        this.resetCanvasPresentation();
    },

    showDailyLobby() {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'daily';
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showDaily();
    },

    async showCampaignLobby() {
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        await this.loadCampaignLobby({ show: true });
    },

    openCampaignTracks() {
        if (!this.campaignLobbyState) return;
        this.dailyChallengeUi.openCampaignProgressModal(this.campaignLobbyState, {
            onPlay: (stage) => void this.startCampaignStage(stage),
        });
    },

    async startCampaignStage(stageLike) {
        const stage = getCampaignStage(stageLike?.raceId || stageLike?.id);
        if (!stage || this.startButtonPending) return;
        this.startButtonPending = true;
        try {
            if (this.campaignBootstrap?.signedIn) {
                const started = await startServerCampaignRace(stage.raceId);
                if (!started.ok) throw new Error(started.body?.error || 'Could not start this Campaign race.');
                if (started.body?.progress) {
                    this.campaignBootstrap.progress = started.body.progress;
                }
            } else {
                startLocalCampaign();
            }
            this.activeRaceMode = 'campaign';
            this.activeCampaignStage = stage;
            this.activeCampaignChallenge = null;
            this.pbGhost.clearTrack();
            if (stage.trackKey !== this.currentTrackKey) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    showStartOverlayOnReset: false,
                });
            }
            if (this.campaignBootstrap?.signedIn) {
                const ghost = await getCampaignPbGhost(stage.raceId);
                const personalBest = ghost.ok ? ghost.body?.personalBest : null;
                if (personalBest?.ghost) this.pbGhost.prepare(personalBest);
                this.bestLapTime = Number(personalBest?.bestTimeMs) > 0
                    ? Number(personalBest.bestTimeMs) / 1000
                    : null;
                if (this.bestLapTime) {
                    this.trackPersonalBestByTrackKey[stage.raceId] = {
                        challengeId: stage.raceId,
                        trackKey: stage.trackKey,
                        bestTime: this.bestLapTime,
                        checkpointTimesSec: personalBest?.checkpointTimesSec ?? null,
                        ghostAvailable: Boolean(personalBest?.ghost),
                        updatedAt: personalBest?.updatedAt ?? null,
                    };
                } else {
                    delete this.trackPersonalBestByTrackKey[stage.raceId];
                }
            }
            this.applyDailyChallenge(toRaceChallenge(stage));
            this.activeRaceMode = 'campaign';
            void this.journeys?.startAttempt?.({ reason: 'initial_start' });
            this.startSequence();
        } catch (error) {
            console.error('Could not start Campaign race:', error);
            await this.loadCampaignLobby({ show: true });
        } finally {
            this.startButtonPending = false;
        }
    },

    async loadChallengeLobby(challengeId = null) {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        const response = await getCampaignChallenge(challengeId);
        const contextual = globalThis.devvit?.context?.postData;
        const challenge = response.body?.challenge
            || (contextual?.postType === 'campaign-challenge' ? contextual : null);
        this.activeRaceMode = 'challenge';
        this.activeCampaignChallenge = response.ok ? {
            ...challenge,
            frozenGhost: response.body?.opponentGhost ?? null,
        } : null;
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showChallenge({
            signedIn: response.ok,
            available: response.ok && Boolean(challenge),
            challengerName: challenge?.challengerUsername,
            trackName: getTrackName(challenge?.trackKey, challenge?.trackKey || ''),
            laps: challenge?.lapCount,
            targetTimeMs: challenge?.targetTimeMs,
            medal: challenge?.medal,
            statusMessage: response.body?.error || '',
        });
    },

    async startCampaignChallenge() {
        const challenge = this.activeCampaignChallenge;
        if (!challenge || this.startButtonPending) return;
        this.startButtonPending = true;
        try {
            const stage = {
                raceId: challenge.raceId,
                trackKey: challenge.trackKey,
                lapCount: challenge.lapCount,
                rulesRevision: challenge.rulesRevision,
            };
            this.activeRaceMode = 'challenge';
            this.pbGhost.clearTrack();
            if (stage.trackKey !== this.currentTrackKey) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    showStartOverlayOnReset: false,
                });
            }
            if (challenge.frozenGhost) {
                this.pbGhost.prepare({
                    bestTimeMs: challenge.targetTimeMs,
                    ghost: challenge.frozenGhost,
                });
            }
            delete this.trackPersonalBestByTrackKey[stage.raceId];
            this.bestLapTime = null;
            this.applyDailyChallenge(toRaceChallenge(stage, 'challenge'));
            this.activeRaceMode = 'challenge';
            void this.journeys?.startAttempt?.({ reason: 'initial_start' });
            this.startSequence();
        } finally {
            this.startButtonPending = false;
        }
    },

    handleActiveRaceLapCompleted(lapTime, details) {
        this.handleDailyChallengeLapCompleted(lapTime, details);
    },

    handleActiveRaceWin(winData) {
        if (this.activeRaceMode === 'campaign') {
            void this.handleCampaignWin(winData);
            return;
        }
        if (this.activeRaceMode === 'challenge') {
            void this.handleCampaignChallengeWin(winData);
            return;
        }
        this.handleDailyChallengeWin(winData);
    },

    async handleCampaignWin(winData) {
        const stage = this.activeCampaignStage;
        if (!stage || !this.currentChallengeRun) return;
        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const replay = this.scoreboardReplay.getPayload(stage.lapCount);
        const medal = getMedalForRaceTime(stage.trackKey, finalTime, stage.lapCount);
        let accepted = !this.campaignBootstrap?.signedIn;
        let error = null;
        if (this.campaignBootstrap?.signedIn) {
            if (!replay) {
                error = 'This run could not be verified.';
            } else {
                const response = await submitCampaignRun({
                    raceId: stage.raceId,
                    trackKey: stage.trackKey,
                    replay,
                });
                accepted = response.ok && response.body?.accepted === true;
                error = accepted ? null : response.body?.error || 'This run could not be verified.';
                if (accepted && response.body?.progress) {
                    this.campaignBootstrap.progress = response.body.progress;
                }
                if (accepted) {
                    const ghost = await getCampaignPbGhost(stage.raceId);
                    const personalBest = ghost.ok ? ghost.body?.personalBest : null;
                    if (personalBest?.ghost) this.pbGhost.prepare(personalBest);
                    if (Number(personalBest?.bestTimeMs) > 0) {
                        this.trackPersonalBestByTrackKey[stage.raceId] = {
                            challengeId: stage.raceId,
                            trackKey: stage.trackKey,
                            bestTime: Number(personalBest.bestTimeMs) / 1000,
                            checkpointTimesSec: personalBest.checkpointTimesSec ?? null,
                            ghostAvailable: Boolean(personalBest.ghost),
                            updatedAt: personalBest.updatedAt ?? null,
                        };
                    }
                }
            }
        } else {
            const local = saveLocalCampaignFinish(stage.raceId, finalTime);
            this.campaignBootstrap.progress = local;
        }
        await this.loadCampaignLobby({ show: false });
        this.modal.showModal(
            accepted ? 'Campaign race complete' : 'Run rejected',
            null,
            {
                lapTime: finalTime,
                bestTime: null,
                completedLaps: stage.lapCount,
                requiredLaps: stage.lapCount,
                primaryStatLabel: 'Race Time',
                lapMedal: medal,
                trackKey: stage.trackKey,
                showGlobalLeaderboard: false,
            },
            {
                ...createModalActions({
                    modalKind: accepted ? 'win' : 'rejected',
                    primaryActionLabel: 'Retry',
                    secondaryActionLabel: 'Campaign',
                    secondaryAction: () => this.showCampaignLobby(),
                }),
                restartAction: () => this.restartActiveRace(),
                settingsAction: () => this.settings.openSettings(),
                shareRequest: accepted && this.campaignBootstrap?.signedIn
                    ? { kind: 'campaign-challenge', source: 'campaign', raceId: stage.raceId }
                    : null,
            },
        );
        if (this.modal.modalMsg) {
            this.modal.modalMsg.style.display = '';
            this.modal.modalMsg.textContent = error
                || `${getTrackName(stage.trackKey, stage.trackKey)} · ${stage.lapCount} ${stage.lapCount === 1 ? 'lap' : 'laps'}`;
        }
    },

    async handleCampaignChallengeWin(winData) {
        const challenge = this.activeCampaignChallenge;
        if (!challenge) return;
        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const replay = this.scoreboardReplay.getPayload(challenge.lapCount);
        const response = replay
            ? await submitCampaignChallengeRun({ challengeId: challenge.challengeId, replay })
            : { ok: false, body: { error: 'This run could not be verified.' } };
        const accepted = response.ok && response.body?.accepted === true;
        this.modal.showModal(
            accepted ? response.body.resultLabel : 'Run rejected',
            null,
            {
                lapTime: finalTime,
                bestTime: challenge.targetTimeMs / 1000,
                completedLaps: challenge.lapCount,
                requiredLaps: challenge.lapCount,
                primaryStatLabel: 'Race Time',
                lapMedal: getMedalForRaceTime(challenge.trackKey, finalTime, challenge.lapCount),
                trackKey: challenge.trackKey,
                showGlobalLeaderboard: false,
            },
            {
                ...createModalActions({
                    modalKind: accepted ? 'win' : 'rejected',
                    primaryActionLabel: 'Retry',
                    secondaryActionLabel: 'Challenge',
                    secondaryAction: () => this.loadChallengeLobby(challenge.challengeId),
                }),
                restartAction: () => this.restartActiveRace(),
                settingsAction: () => this.settings.openSettings(),
                shareRequest: accepted
                    ? { kind: 'campaign-challenge', source: 'duel', challengeId: challenge.challengeId }
                    : null,
            },
        );
        if (this.modal.modalMsg) {
            this.modal.modalMsg.style.display = '';
            this.modal.modalMsg.textContent = accepted
                ? `${Math.abs(Number(response.body?.differenceMs) || 0) / 1000}s from the challenge time`
                : response.body?.error || 'This run could not be verified.';
        }
    },

    restartActiveRace() {
        if (this.activeRaceMode === 'daily') {
            this.restartDailyChallenge({ reason: 'restart' });
            return;
        }
        if (!this.currentChallengeRun) return;
        void this.journeys?.endAttempt?.({ complete: false });
        void this.journeys?.startAttempt?.({ reason: 'restart' });
        this.reset(true, { preserveDailyChallenge: true, showStartOverlay: false });
    },

    returnToActiveLobby() {
        if (this.activeRaceMode === 'campaign') return this.showCampaignLobby();
        if (this.activeRaceMode === 'challenge') {
            return this.loadChallengeLobby(this.activeCampaignChallenge?.challengeId);
        }
        return this.showDailyLobby();
    },

    async openCampaignStandings(stageLike = null) {
        const lobbyState = this.campaignLobbyState;
        const unlockedStages = Array.isArray(lobbyState?.stages)
            ? lobbyState.stages.filter((stage) => stage.unlocked)
            : [];
        const defaultStage = lobbyState?.complete
            ? unlockedStages.at(-1)
            : (lobbyState?.nextStage || unlockedStages[0]);
        const requestedStageId = typeof stageLike === 'string'
            ? stageLike
            : (stageLike?.raceId || stageLike?.id || defaultStage?.id);
        const selectedLobbyStage = unlockedStages.find((stage) => stage.id === requestedStageId);
        const stage = getCampaignStage(selectedLobbyStage?.id);
        if (!stage) return;

        const requestId = (this._campaignStandingsRequestId || 0) + 1;
        this._campaignStandingsRequestId = requestId;
        const leaderboardOptions = buildCampaignLeaderboardOptions(lobbyState);
        let currentSnapshot = null;
        let pageRequest = null;

        const onLoadMoreLeaderboard = async () => {
            if (pageRequest) return pageRequest;
            const nextOffset = Number(currentSnapshot?.nextOffset);
            if (!currentSnapshot?.hasMore || !Number.isFinite(nextOffset)) {
                return currentSnapshot;
            }
            pageRequest = getCampaignSnapshot(stage.raceId, {
                limit: 50,
                offset: nextOffset,
            }).then((response) => {
                if (
                    !response.ok
                    || requestId !== this._campaignStandingsRequestId
                    || !this.modal.isRunsViewActive?.()
                ) {
                    return currentSnapshot;
                }
                const nextPage = normalizeCampaignLeaderboardSnapshot(response.body);
                currentSnapshot = mergeLeaderboardPages(currentSnapshot, nextPage);
                this.modal.updateModalScoreboardSnapshot(currentSnapshot);
                return currentSnapshot;
            }).catch((error) => {
                console.error('Could not load more Campaign standings:', error);
                return currentSnapshot;
            }).finally(() => {
                pageRequest = null;
            });
            return pageRequest;
        };

        const modalOptions = {
            scoreboardSnapshot: { isLoading: true },
            scoreboardMode: 'campaign',
            scoreboardChallengeId: stage.raceId,
            scoreboardTrackKey: stage.trackKey,
            scoreboardTitle: getTrackName(stage.trackKey, stage.trackKey),
            scoreboardSubhead: `Campaign · ${stage.lapCount} ${stage.lapCount === 1 ? 'lap' : 'laps'}`,
            leaderboardDayOptions: leaderboardOptions,
            leaderboardRailLabel: 'Campaign stages',
            selectedLeaderboardDayId: stage.raceId,
            onSelectLeaderboardDay: (raceId) => void this.openCampaignStandings(raceId),
            onLoadMoreLeaderboard,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: false,
            onClose: () => {
                this._campaignStandingsRequestId = (this._campaignStandingsRequestId || 0) + 1;
            },
        };
        this.modal.showRunsModal(null, null, null, 'close', modalOptions);

        try {
            const response = await getCampaignSnapshot(stage.raceId, { limit: 50, offset: 0 });
            if (
                requestId !== this._campaignStandingsRequestId
                || !this.modal.isRunsViewActive?.()
            ) {
                return;
            }
            currentSnapshot = response.ok
                ? normalizeCampaignLeaderboardSnapshot(response.body)
                : normalizeScoreboardSnapshot(null);
            this.modal.updateModalScoreboardSnapshot(currentSnapshot);
        } catch (error) {
            console.error('Could not load Campaign standings:', error);
            if (
                requestId === this._campaignStandingsRequestId
                && this.modal.isRunsViewActive?.()
            ) {
                currentSnapshot = normalizeScoreboardSnapshot(null);
                this.modal.updateModalScoreboardSnapshot(currentSnapshot);
            }
        }
    },

    previewCampaignChallenge(request) {
        return previewCampaignChallenge(request);
    },

    confirmCampaignChallenge(token) {
        return createCampaignChallenge(token);
    },
};
