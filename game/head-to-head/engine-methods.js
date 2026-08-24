import { getTrackName } from '../track/catalog.js';
import {
    createHeadToHead,
    getHeadToHead,
    previewHeadToHead,
    previewHeadToHeadBrag,
    confirmHeadToHeadBrag,
    readHeadToHeadWin,
    rememberHeadToHeadWin,
    submitHeadToHeadRun,
} from './service.js';
import {
    cancelDeferredLobbyWork,
} from '../lobby/deferred-work.js';
import {
    createVerificationSnapshot,
} from '../scoreboard/verification-queue.js';
import { createModalActions } from '../race/result-flow.js';
import { objectiveTypeForLapCount } from '../race/race-spec.js';

function toRaceChallenge(stage) {
    return {
        id: stage.raceId,
        challengeDate: stage.challengeDate || 'Head to Head',
        trackKey: stage.trackKey,
        startsAt: '1970-01-01T00:00:00.000Z',
        endsAt: '9999-12-31T23:59:59.999Z',
        availableUntil: '9999-12-31T23:59:59.999Z',
        status: 'active',
        rulesRevision: stage.rulesRevision,
        objectiveType: objectiveTypeForLapCount(stage.lapCount),
        objectiveParams: { lapCount: stage.lapCount },
        skin: 'default',
        mode: 'challenge',
    };
}

export const headToHeadEngineMethods = {
    async loadChallengeLobby(challengeId = null, {
        outcome = null,
        bestTimeMs = null,
        onTrackPhase = null,
        onGhostPhase = null,
    } = {}) {
        this.headToHeadChallengeId = challengeId;
        cancelDeferredLobbyWork(this);
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        let response;
        try {
            const pending = this.initialHeadToHeadRequestPromise ?? getHeadToHead(challengeId);
            this.initialHeadToHeadRequestPromise = pending;
            try {
                response = await pending;
            } finally {
                if (this.initialHeadToHeadRequestPromise === pending) {
                    this.initialHeadToHeadRequestPromise = null;
                }
            }
        } catch (error) {
            console.error('Failed to load Head to Head challenge:', error);
            response = {
                ok: false,
                status: 0,
                body: {
                    status: 'challenge_failed',
                    error: 'Could not load this challenge. Check your connection and try again.',
                },
            };
        }
        const contextual = globalThis.devvit?.context?.postData;
        if (response.body?.status === 'own_challenge') {
            this.activeHeadToHead = null;
            this.showHomeLobby?.();
            return;
        }
        const challenge = response.body?.challenge
            || (contextual?.postType === 'head-to-head' ? contextual : null);
        this.activeRaceMode = 'challenge';
        this.activeHeadToHead = response.ok && challenge ? {
            ...challenge,
            frozenGhost: response.body?.opponentGhost ?? null,
            viewerAvatarUrl: response.body?.viewerAvatarUrl ?? null,
            viewerBest: response.body?.viewerBest ?? null,
        } : null;
        let challengeReady = response.ok
            && response.body?.status === 'ready'
            && Boolean(challenge);
        if (challengeReady && typeof this.loadTrack === 'function') {
            try {
                onTrackPhase?.();
                await this.loadTrack(challenge.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    showStartOverlayOnReset: false,
                });
                if (this.activeHeadToHead?.frozenGhost) {
                    onGhostPhase?.();
                    const prepareGhost = this.pbGhost.prepareOpponent || this.pbGhost.prepare;
                    prepareGhost?.call(this.pbGhost, {
                        bestTimeMs: challenge.targetTimeMs,
                        ghost: this.activeHeadToHead.frozenGhost,
                    });
                    this.activeHeadToHead = {
                        ...this.activeHeadToHead,
                        frozenGhostPrepared: true,
                    };
                }
            } catch (error) {
                console.error('Failed to prepare the Head to Head track:', error);
                challengeReady = false;
                this.activeHeadToHead = null;
                response = {
                    ok: false,
                    status: 0,
                    body: {
                        ...response.body,
                        error: 'Could not prepare this track. Try again.',
                    },
                };
            }
        }
        const retryable = !response.ok
            && (response.status === 0 || response.status >= 500);
        const remembered = outcome
            ? null
            : readHeadToHeadWin(challenge?.challengeId || challengeId);
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showChallenge({
            signedIn: response.body?.viewerType === 'reddit',
            canRace: challengeReady,
            available: challengeReady || Boolean(challenge),
            canRetry: retryable,
            challengerName: challenge?.challengerUsername,
            challengerAvatarUrl: challenge?.challengerAvatarUrl,
            viewerAvatarUrl: response.body?.viewerAvatarUrl,
            trackKey: challenge?.trackKey,
            trackName: getTrackName(challenge?.trackKey, challenge?.trackKey || ''),
            laps: challenge?.lapCount,
            targetTimeMs: challenge?.targetTimeMs,
            viewerBestTimeMs: response.body?.viewerBest?.bestTimeMs ?? null,
            medal: challenge?.medal,
            outcome: outcome || remembered?.outcome || null,
            bestTimeMs: outcome ? bestTimeMs : (remembered?.bestTimeMs ?? null),
            statusMessage: response.body?.error || (retryable
                ? 'Could not load this challenge. Try again.'
                : ''),
        });
    },

    async retryHeadToHead() {
        const challengeId = this.headToHeadChallengeId
            || this.launchTarget?.challengeId
            || null;
        if (!challengeId || this.headToHeadLoadPending) return;
        this.headToHeadLoadPending = true;
        const currentState = this.lobbyUi?.challengeState || {};
        this.lobbyUi?.showChallenge({
            ...currentState,
            canRetry: true,
            challengeLoading: true,
            statusMessage: 'Retrying challenge…',
        });
        try {
            await this.loadChallengeLobby(challengeId);
        } finally {
            this.headToHeadLoadPending = false;
        }
    },

    async startHeadToHead() {
        const challenge = this.activeHeadToHead;
        if (!challenge || this.startButtonPending) return;
        this.startButtonPending = true;
        try {
            const origin = challenge.origin?.mode === 'daily'
                ? challenge.origin
                : null;
            const stage = {
                raceId: origin?.challengeId || challenge.raceId,
                challengeDate: origin?.challengeId || 'Campaign',
                trackKey: challenge.trackKey,
                lapCount: challenge.lapCount,
                rulesRevision: challenge.rulesRevision,
            };
            this.activeRaceMode = 'challenge';
            this.clearRaceComparisonTarget?.();
            this.pbGhost.clearTrack();
            if (stage.trackKey !== this.currentTrackKey || !this.trackCanvas) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    showStartOverlayOnReset: false,
                });
            }
            if (challenge.frozenGhost) {
                const challengerName = typeof challenge.challengerUsername === 'string'
                    ? challenge.challengerUsername.trim()
                    : '';
                const installed = this.installRaceComparisonTarget?.({
                    displayName: challengerName || 'Challenger',
                    bestTimeMs: challenge.targetTimeMs,
                    ghost: challenge.frozenGhost,
                }, {
                    lapCount: challenge.lapCount,
                });
                if (!installed) {
                    const prepareGhost = this.pbGhost.prepareOpponent || this.pbGhost.prepare;
                    prepareGhost?.call(this.pbGhost, {
                        bestTimeMs: challenge.targetTimeMs,
                        ghost: challenge.frozenGhost,
                    });
                }
            }
            delete this.trackPersonalBestByTrackKey[stage.raceId];
            this.bestLapTime = null;
            this.applyDailyChallenge(toRaceChallenge(stage));
            this.activeRaceMode = 'challenge';
            void this.journeys?.startAttempt?.({ mode: 'challenge', reason: 'initial_start' });
            this.startSequence();
        } catch (error) {
            console.error('Could not start Head to Head race:', error);
            this.startOverlay?.showStartOverlay?.(this.hasAnyData, this.isReturningPlayer);
            this.lobbyUi?.showChallenge?.({
                ...(this.lobbyUi?.challengeState || {}),
                canRace: true,
                canRetry: false,
                challengeLoading: false,
                startError: true,
                statusMessage: 'Could not prepare this track. Tap Retry Start.',
            });
        } finally {
            this.startButtonPending = false;
        }
    },

    async handleHeadToHeadWin(winData) {
        const challenge = this.activeHeadToHead;
        if (!challenge) return;
        this._headToHeadFinishAttempt = (this._headToHeadFinishAttempt ?? 0) + 1;
        const finishAttempt = this._headToHeadFinishAttempt;
        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const replay = this.scoreboardReplay.getPayload(challenge.lapCount);
        const submissionBlockedReason = this.rankedSubmissionBlockedReason
            || (replay ? null : 'This run could not be verified.');
        const submittingStatus = createVerificationSnapshot({
            verificationState: 'pending',
            isLoading: true,
            submissionStage: 'submitting',
        }).statusText || 'Submitting...';
        const verifyingStatus = createVerificationSnapshot({
            verificationState: 'pending',
            isLoading: true,
            submissionStage: 'verifying',
        }).statusText || 'Verifying...';

        const finalTimeMs = Number.isFinite(finalTime) ? Math.round(finalTime * 1000) : null;
        const targetTimeMs = Number.isFinite(challenge.targetTimeMs)
            ? Math.round(challenge.targetTimeMs)
            : null;
        const buildVerdict = (differenceMs) => (
            Number.isFinite(differenceMs)
                ? {
                    opponentName: challenge.challengerUsername || null,
                    deltaSec: differenceMs / 1000,
                }
                : null
        );
        const localDifferenceMs = finalTimeMs !== null && targetTimeMs !== null
            ? finalTimeMs - targetTimeMs
            : null;
        const settlesLocally = localDifferenceMs !== null && localDifferenceMs >= 0;

        // The best the player already holds on the stage or Daily behind this challenge. The finish
        // sheet measures the run against it the way an ordinary finish does.
        const viewerBestMs = Number(challenge.viewerBest?.bestTimeMs);
        const hasViewerBest = Number.isFinite(viewerBestMs) && viewerBestMs > 0;
        const previousPersonalBestSec = hasViewerBest ? viewerBestMs / 1000 : null;

        const openPendingFinish = ({
            phase = 'pending',
            error = null,
        } = {}) => {
            this.modal.showModal(
                'Challenge complete',
                null,
                {
                    lapTime: finalTime,
                    bestTime: challenge.targetTimeMs / 1000,
                    completedLaps: challenge.lapCount,
                    requiredLaps: challenge.lapCount,
                    primaryStatLabel: 'Race Time',
                    lapMedal: phase === 'won' ? 'challenge' : null,
                    challengeFinish: true,
                    challengeConfirmPhase: phase,
                    challengeConfirmStatus: phase === 'pending' ? submittingStatus : null,
                    challengeConfirmError: error,
                    challengeViewerAvatarUrl: challenge.viewerAvatarUrl ?? null,
                    challengeVerdict: buildVerdict(localDifferenceMs),
                    previousPersonalBestSec,
                    challengeViewerBest: challenge.viewerBest ?? null,
                    trackKey: challenge.trackKey,
                    showGlobalLeaderboard: false,
                    // Rank is already on this row; a personal best may replace the number, but the
                    // Head to Head finish still has no board sheet behind it.
                    allowLeaderboardOpen: false,
                },
                {
                    ...createModalActions({
                        modalKind: 'win',
                        primaryActionLabel: 'Retry',
                        secondaryActionLabel: 'Home',
                        secondaryAction: () => this.loadChallengeLobby(challenge.challengeId),
                    }),
                    restartAction: () => this.restartActiveRace(),
                    settingsAction: () => this.settings.openSettings(),
                    shareRequest: { kind: 'challenge-brag', acceptToken: null },
                    shareEnabled: false,
                },
            );
        };

        const applyWinActions = () => {
            this.modal.setChallengeWinActions?.({
                dailyAction: () => this.showDailyLobby(),
                campaignAction: () => this.showCampaignLobby(),
            });
        };
        const stillOnThisFinish = () => (
            this._headToHeadFinishAttempt === finishAttempt
            && this.status === 'won'
            && this.activeHeadToHead?.challengeId === challenge.challengeId
        );

        // A settled loss keeps its instant verdict, but the run is still a real run on the stage or
        // Daily behind the challenge. Send it when it beats what the player already holds there, so the
        // personal best it earned is not thrown away. A slower run would be refused anyway, so it stays home.
        const beatsViewerBest = finalTimeMs !== null
            && (!hasViewerBest || finalTimeMs < viewerBestMs);
        const claimSettledBest = async () => {
            let settledResponse = null;
            try {
                settledResponse = await submitHeadToHeadRun({
                    challengeId: challenge.challengeId,
                    replay,
                    bestTimeMs: finalTimeMs,
                });
            } catch (submitError) {
                console.error('Could not rank a settled Head to Head run:', submitError);
                return;
            }
            if (!stillOnThisFinish()) return;
            const settledBestUpdate = settledResponse?.body?.bestUpdate ?? null;
            if (settledBestUpdate) {
                this.modal.updateChallengeFinishHero?.({ bestUpdate: settledBestUpdate });
            }
        };

        if (settlesLocally) {
            openPendingFinish({ phase: localDifferenceMs === 0 ? 'tie' : 'lost' });
            if (!submissionBlockedReason && beatsViewerBest) void claimSettledBest();
            return;
        }

        if (submissionBlockedReason) {
            openPendingFinish({
                phase: 'error',
                error: submissionBlockedReason,
            });
            return;
        }

        const localWin = localDifferenceMs !== null && localDifferenceMs < 0;
        openPendingFinish({ phase: localWin ? 'won' : 'pending' });

        void (async () => {
            if (!stillOnThisFinish()) return;
            if (!localWin) {
                this.modal.updateChallengeFinishHero?.({
                    phase: 'pending',
                    statusText: verifyingStatus,
                });
            }

            let confirmationFailed = false;
            let response = { ok: false, body: { error: 'This run could not be verified.' } };
            try {
                response = await submitHeadToHeadRun({
                    challengeId: challenge.challengeId,
                    replay,
                    bestTimeMs: finalTimeMs,
                });
            } catch (submitError) {
                confirmationFailed = true;
                response = {
                    ok: false,
                    body: {
                        error: 'Race finished, but the challenge result could not be confirmed.',
                    },
                };
                console.error('Could not confirm Head to Head result:', submitError);
            }

            if (!stillOnThisFinish()) return;

            const accepted = response.ok && response.body?.accepted === true;
            const outcome = accepted ? response.body?.outcome : null;
            // A challenge run is a real run on the stage or Daily behind it, so a lost challenge
            // can still carry a personal best home. Report it on both endings.
            const bestUpdate = response.body?.bestUpdate ?? null;

            if (!accepted) {
                const serverDifferenceMs = Number(response.body?.differenceMs);
                if (
                    response.body?.status === 'target_not_beaten'
                    && Number.isFinite(serverDifferenceMs)
                ) {
                    this.modal.updateChallengeFinishHero?.({
                        phase: serverDifferenceMs === 0 ? 'tie' : 'lost',
                        verdict: buildVerdict(serverDifferenceMs),
                        bestUpdate,
                    });
                    return;
                }
                this.modal.updateChallengeFinishHero?.({
                    phase: 'error',
                    error: confirmationFailed
                        ? (response.body?.error || 'Race finished, but the challenge result could not be confirmed.')
                        : (response.body?.error || 'This run could not be verified.'),
                });
                return;
            }
            const verdict = buildVerdict(Number(response.body?.differenceMs));
            this.applyCarUnlockSnapshot?.(response.body.carUnlocks);

            const acceptToken = response.body?.acceptToken || null;
            if (acceptToken) {
                this.modal.updateChallengeFinishHero?.({
                    shareRequest: { kind: 'challenge-brag', acceptToken },
                });
            }

            if (outcome === 'won') {
                this.modal.updateChallengeFinishHero?.({
                    phase: 'won',
                    verdict,
                    bestUpdate,
                });
                rememberHeadToHeadWin(
                    challenge.challengeId,
                    response.body?.bestTimeMs ?? null,
                );
                applyWinActions();
                return;
            }
            this.modal.updateChallengeFinishHero?.({
                phase: outcome === 'tie' ? 'tie' : 'lost',
                verdict,
                bestUpdate,
            });
        })();
    },

    previewHeadToHead(request) {
        return previewHeadToHead(request);
    },

    async confirmHeadToHead(token, request = null) {
        const response = await createHeadToHead(token, request?.source === 'daily'
            ? { replay: request.replay }
            : {});
        if (response?.ok) this.applyCarUnlockSnapshot?.(response.body?.carUnlocks);
        return response;
    },

    previewHeadToHeadBrag(request) {
        return previewHeadToHeadBrag(request);
    },

    confirmHeadToHeadBrag(token) {
        return confirmHeadToHeadBrag(token);
    },
};
