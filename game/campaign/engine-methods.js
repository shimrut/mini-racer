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
    previewCampaignChallengeBrag,
    confirmCampaignChallengeBrag,
    readLocalCampaignProgress,
    saveLocalCampaignFinish,
    startLocalCampaign,
    startServerCampaignRace,
    submitCampaignChallengeRun,
    submitCampaignRun,
} from './service.js';
import { CAMPAIGN_ID, CAMPAIGN_STAGES, getCampaignStage } from './manifest.js';
import { createVerificationSnapshot } from '../scoreboard/verification-queue.js';

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

function buildProvisionalCampaignBootstrap(previous = null) {
    return {
        campaignId: CAMPAIGN_ID,
        signedIn: previous?.signedIn === true,
        stages: CAMPAIGN_STAGES,
        progress: previous?.progress || readLocalCampaignProgress(),
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
    applyCampaignLobbyBootstrap(bootstrap, { paint = false } = {}) {
        this.campaignBootstrap = bootstrap;
        this._campaignBootstrapReady = true;
        this.campaignLobbyState = normalizeCampaignLobbyState(decorateCampaignState(bootstrap));
        if (
            paint
            && this.activeRaceMode === 'campaign'
            && this.lobbyUi?.getMode?.() === 'campaign'
        ) {
            this.lobbyUi.showCampaign(this.campaignLobbyState);
        }
        return this.campaignLobbyState;
    },

    paintCampaignLobby(state, { bootstrapReady = false } = {}) {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'campaign';
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.campaignLobbyState = normalizeCampaignLobbyState(state);
        this.lobbyUi.showCampaign(this.campaignLobbyState);
        this.lobbyUi.setCampaignPrimaryLoading?.(false);
        this._campaignBootstrapReady = Boolean(bootstrapReady);
    },

    async ensureCampaignBootstrap({ forceRefresh = false } = {}) {
        if (!forceRefresh && this._campaignBootstrapReady && this.campaignBootstrap) {
            return this.campaignBootstrap;
        }
        if (!forceRefresh && this._campaignBootstrapPromise) {
            return this._campaignBootstrapPromise;
        }

        const requestId = (this._campaignBootstrapRequestId || 0) + 1;
        this._campaignBootstrapRequestId = requestId;
        const promise = getCampaignBootstrap()
            .then((bootstrap) => {
                if (requestId !== this._campaignBootstrapRequestId) {
                    return this.campaignBootstrap;
                }
                this.applyCampaignLobbyBootstrap(bootstrap, { paint: true });
                return bootstrap;
            })
            .finally(() => {
                if (this._campaignBootstrapPromise === promise) {
                    this._campaignBootstrapPromise = null;
                }
            });
        this._campaignBootstrapPromise = promise;
        return promise;
    },

    async loadCampaignLobby({ show = true } = {}) {
        if (show) {
            this.showCampaignLobby();
            await this.ensureCampaignBootstrap({ forceRefresh: true });
            return this.campaignLobbyState;
        }
        await this.ensureCampaignBootstrap({ forceRefresh: true });
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

    showCampaignLobby() {
        this.activeCampaignStage = null;
        this.activeCampaignChallenge = null;
        const hadReadyBootstrap = Boolean(
            this._campaignBootstrapReady && this.campaignBootstrap
        );
        const bootstrapForPaint = hadReadyBootstrap
            ? this.campaignBootstrap
            : buildProvisionalCampaignBootstrap(this.campaignBootstrap);
        if (!hadReadyBootstrap) {
            this.campaignBootstrap = bootstrapForPaint;
            this._campaignBootstrapReady = false;
        }
        this.paintCampaignLobby(
            decorateCampaignState(bootstrapForPaint),
            { bootstrapReady: hadReadyBootstrap },
        );
        void this.ensureCampaignBootstrap({ forceRefresh: true });
    },

    async openCampaignTracks() {
        await this.ensureCampaignBootstrap();
        if (this.activeRaceMode !== 'campaign' || !this.campaignLobbyState) return;
        this.dailyChallengeUi.openCampaignProgressModal(this.campaignLobbyState, {
            onPlay: (stage) => void this.startCampaignStage(stage),
        });
    },

    async startCampaignStage(stageLike = null) {
        if (this.startButtonPending) return;
        this.startButtonPending = true;
        const needsBootstrapWait = !this._campaignBootstrapReady;
        if (needsBootstrapWait) {
            this.lobbyUi?.setCampaignPrimaryLoading?.(true);
        }
        try {
            await this.ensureCampaignBootstrap();
            if (this.activeRaceMode !== 'campaign') return;

            const requestedId = stageLike?.raceId || stageLike?.id || null;
            const unlockedStages = Array.isArray(this.campaignLobbyState?.stages)
                ? this.campaignLobbyState.stages.filter((stage) => stage.unlocked)
                : [];
            const selectedLobbyStage = requestedId
                ? unlockedStages.find((stage) => stage.id === requestedId)
                : null;
            const stage = getCampaignStage(
                selectedLobbyStage?.id
                || this.campaignLobbyState?.nextStage?.id
                || requestedId,
            );
            if (!stage) return;

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
            if (needsBootstrapWait) {
                this.lobbyUi?.setCampaignPrimaryLoading?.(false);
            }
            this.startButtonPending = false;
        }
    },

    async loadChallengeLobby(challengeId = null) {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        const response = await getCampaignChallenge(challengeId);
        if (response.body?.status === 'own_challenge') {
            this.activeCampaignChallenge = null;
            await this.showCampaignLobby();
            return;
        }
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
        const signedIn = this.campaignBootstrap?.signedIn === true;
        const trackLine = `${getTrackName(stage.trackKey, stage.trackKey)} · ${stage.lapCount} ${stage.lapCount === 1 ? 'lap' : 'laps'}`;

        const buildCampaignPlayerRow = () => ({
            isCurrentPlayer: true,
            bestTime: finalTime,
            rank: null,
            displayName: 'You',
        });

        const buildSubmittingSnapshot = () => ({
            ...createVerificationSnapshot({
                verificationState: 'pending',
                isLoading: true,
                submissionStage: 'submitting',
            }),
            currentPlayerRow: buildCampaignPlayerRow(),
        });

        const buildErrorSnapshot = (statusText) => ({
            ...createVerificationSnapshot({
                verificationState: 'error',
                isLoading: false,
                submissionStage: 'error',
                statusText: statusText || 'Couldn\'t rank this run. Try again.',
            }),
            currentPlayerRow: buildCampaignPlayerRow(),
        });

        const showCampaignResult = ({
            accepted,
            confirmationFailed = false,
            error = null,
            shareRequest = null,
            scoreboardSnapshot = null,
        }) => {
            this.modal.showModal(
                accepted
                    ? 'Campaign race complete'
                    : confirmationFailed
                        ? 'Result not confirmed'
                        : 'Run rejected',
                null,
                {
                    lapTime: finalTime,
                    bestTime: null,
                    completedLaps: stage.lapCount,
                    requiredLaps: stage.lapCount,
                    primaryStatLabel: 'Race Time',
                    lapMedal: medal,
                    trackKey: stage.trackKey,
                    scoreboardSnapshot,
                    scoreboardChallengeId: stage.raceId,
                    scoreboardTrackKey: stage.trackKey,
                    showGlobalLeaderboard: false,
                    allowLeaderboardOpen: true,
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
                    shareRequest,
                },
            );
            if (this.modal.modalMsg) {
                this.modal.modalMsg.style.display = '';
                this.modal.modalMsg.textContent = error || trackLine;
            }
        };

        if (!signedIn) {
            const local = saveLocalCampaignFinish(stage.raceId, finalTime);
            this.campaignBootstrap.progress = local;
            showCampaignResult({ accepted: true });
            return;
        }

        if (!replay) {
            const error = 'This run could not be verified.';
            showCampaignResult({
                accepted: false,
                error,
                scoreboardSnapshot: buildErrorSnapshot(error),
            });
            return;
        }

        // Same pattern as Daily: open the finish sheet immediately, confirm in the background.
        showCampaignResult({
            accepted: true,
            shareRequest: {
                kind: 'campaign-challenge',
                source: 'campaign',
                raceId: stage.raceId,
            },
            scoreboardSnapshot: buildSubmittingSnapshot(),
        });

        void (async () => {
            let accepted = false;
            let confirmationFailed = false;
            let error = null;
            try {
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
            } catch (submitError) {
                confirmationFailed = true;
                error = 'Race finished, but the result could not be confirmed. Check Campaign progress before retrying.';
                console.error('Could not confirm Campaign race result:', submitError);
            }

            if (
                this.status !== 'won'
                || this.activeCampaignStage?.raceId !== stage.raceId
            ) {
                return;
            }

            if (!accepted) {
                showCampaignResult({
                    accepted: false,
                    confirmationFailed,
                    error,
                    scoreboardSnapshot: buildErrorSnapshot(error),
                });
                return;
            }

            try {
                const snapshotResponse = await getCampaignSnapshot(stage.raceId, {
                    limit: 50,
                    offset: 0,
                });
                if (
                    this.status === 'won'
                    && this.activeCampaignStage?.raceId === stage.raceId
                    && snapshotResponse.ok
                ) {
                    const snapshot = normalizeCampaignLeaderboardSnapshot(snapshotResponse.body);
                    if (snapshot) {
                        this.modal.updateModalScoreboardSnapshot?.(snapshot);
                    }
                }
            } catch (snapshotError) {
                console.warn('Campaign finish opened without a live rank snapshot:', snapshotError);
            }

            try {
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
            } catch (ghostError) {
                console.warn('Campaign result was saved, but PB ghost refresh failed:', ghostError);
            }

            try {
                await this.loadCampaignLobby({ show: false });
            } catch (refreshError) {
                console.warn('Campaign result screen opened without refreshed progress:', refreshError);
            }
        })();
    },

    async handleCampaignChallengeWin(winData) {
        const challenge = this.activeCampaignChallenge;
        if (!challenge) return;
        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const replay = this.scoreboardReplay.getPayload(challenge.lapCount);

        const showChallengeResult = ({
            accepted,
            confirmationFailed = false,
            title = null,
            error = null,
            outcome = null,
            differenceMs = null,
        }) => {
            const won = accepted && outcome === 'won';
            const shareRequest = won
                ? { kind: 'challenge-brag', challengeId: challenge.challengeId }
                : null;
            this.modal.showModal(
                accepted
                    ? (title || 'Challenge complete')
                    : confirmationFailed
                        ? 'Result not confirmed'
                        : 'Run rejected',
                null,
                {
                    lapTime: finalTime,
                    bestTime: challenge.targetTimeMs / 1000,
                    completedLaps: challenge.lapCount,
                    requiredLaps: challenge.lapCount,
                    primaryStatLabel: 'Race Time',
                    lapMedal: null,
                    trackKey: challenge.trackKey,
                    showGlobalLeaderboard: false,
                },
                {
                    ...createModalActions({
                        modalKind: accepted ? 'win' : 'rejected',
                        primaryActionLabel: 'Retry',
                        secondaryActionLabel: 'Home',
                        secondaryAction: () => this.loadChallengeLobby(challenge.challengeId),
                    }),
                    restartAction: won ? null : () => this.restartActiveRace(),
                    settingsAction: () => this.settings.openSettings(),
                    shareRequest,
                },
            );
            if (this.modal.modalMsg) {
                this.modal.modalMsg.style.display = '';
                this.modal.modalMsg.textContent = accepted
                    ? `${Math.abs(Number(differenceMs) || 0) / 1000}s from the challenge time`
                    : (error || 'This run could not be verified.');
            }
        };

        if (!replay) {
            showChallengeResult({
                accepted: false,
                error: 'This run could not be verified.',
            });
            return;
        }

        showChallengeResult({
            accepted: true,
            title: 'Challenge complete',
            outcome: null,
            differenceMs: null,
        });
        if (this.modal.modalMsg) {
            this.modal.modalMsg.textContent = 'Confirming your finished race…';
        }

        void (async () => {
            let confirmationFailed = false;
            let response = { ok: false, body: { error: 'This run could not be verified.' } };
            try {
                response = await submitCampaignChallengeRun({
                    challengeId: challenge.challengeId,
                    replay,
                });
            } catch (submitError) {
                confirmationFailed = true;
                response = {
                    ok: false,
                    body: {
                        error: 'Race finished, but the challenge result could not be confirmed.',
                    },
                };
                console.error('Could not confirm Campaign challenge result:', submitError);
            }

            if (
                this.status !== 'won'
                || this.activeCampaignChallenge?.challengeId !== challenge.challengeId
            ) {
                return;
            }

            const accepted = response.ok && response.body?.accepted === true;
            showChallengeResult({
                accepted,
                confirmationFailed,
                title: accepted ? response.body.resultLabel : null,
                error: response.body?.error || null,
                outcome: accepted ? response.body?.outcome : null,
                differenceMs: accepted ? response.body?.differenceMs : null,
            });
        })();
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
        await this.ensureCampaignBootstrap();
        if (this.activeRaceMode !== 'campaign') return;

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

    previewCampaignChallengeBrag(request) {
        return previewCampaignChallengeBrag(request);
    },

    confirmCampaignChallengeBrag(token) {
        return confirmCampaignChallengeBrag(token);
    },
};
