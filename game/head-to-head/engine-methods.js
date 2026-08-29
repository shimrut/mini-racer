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
import { getDailyChallengeBestResult } from '../daily-challenge/service.js';
import {
    cancelDeferredLobbyWork,
} from '../lobby/deferred-work.js';
import { createModalActions } from '../race/result-flow.js';
import { objectiveTypeForLapCount } from '../race/race-spec.js';

function finitePositiveMs(value) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/**
 * Same origin best Daily and Campaign finishes already use: the challenge GET, then Campaign
 * progress / Daily storage. Head to Head start wipes the in-race PB cache so the HUD stays
 * opponent-only; this must not empty VS. YOUR PB.
 */
export function resolveHeadToHeadHeldBest(engine, challenge) {
    const viewer = challenge?.viewerBest && typeof challenge.viewerBest === 'object'
        ? challenge.viewerBest
        : null;
    if (viewer?.trackLocked) return viewer;

    const origin = challenge?.origin;
    const times = [];
    const viewerMs = finitePositiveMs(viewer?.bestTimeMs);
    if (viewerMs) times.push(viewerMs);

    const raceId = origin?.mode === 'campaign'
        ? origin.raceId
        : (origin?.mode === 'daily' ? null : challenge?.raceId);
    if (raceId) {
        const progressMs = finitePositiveMs(
            engine?.campaignBootstrap?.progress?.resultsByRaceId?.[raceId]?.bestTimeMs,
        );
        if (progressMs) times.push(progressMs);
        const cachedSec = Number(engine?.trackPersonalBestByTrackKey?.[raceId]?.bestTime);
        if (Number.isFinite(cachedSec) && cachedSec > 0) {
            times.push(Math.round(cachedSec * 1000));
        }
    }
    if (origin?.mode === 'daily') {
        const daily = getDailyChallengeBestResult({
            id: origin.challengeId,
            trackKey: challenge.trackKey,
        });
        const dailySec = Number(daily?.bestTime);
        if (Number.isFinite(dailySec) && dailySec > 0) {
            times.push(Math.round(dailySec * 1000));
        }
    }

    const bestTimeMs = times.length ? Math.min(...times) : null;
    if (!bestTimeMs) return viewer;
    const standingRank = Number(
        engine?.campaignBootstrap?.standingsByRaceId?.[raceId]?.rank,
    );
    return {
        ...(viewer || {}),
        bestTimeMs,
        rank: Number.isInteger(Number(viewer?.rank)) && Number(viewer.rank) > 0
            ? Number(viewer.rank)
            : (Number.isInteger(standingRank) && standingRank > 0 ? standingRank : (viewer?.rank ?? null)),
    };
}

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

        // Same origin best Daily and Campaign finishes already use. The GET can miss it; local
        // Campaign progress and Daily storage still know.
        const heldBest = resolveHeadToHeadHeldBest(this, challenge);
        const viewerBestMs = finitePositiveMs(heldBest?.bestTimeMs);
        const hasViewerBest = viewerBestMs !== null;
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
                    challengeConfirmStatus: null,
                    challengeConfirmError: error,
                    challengeViewerAvatarUrl: challenge.viewerAvatarUrl ?? null,
                    challengeVerdict: buildVerdict(localDifferenceMs),
                    previousPersonalBestSec,
                    challengeViewerBest: heldBest ?? null,
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
        // Clock already faster than the target: show Daily/Campaign now. Brag stays locked
        // until the server signs the beat. A miss or failed confirm puts Improve/Home back.
        const optimisticWin = localDifferenceMs !== null && localDifferenceMs < 0;
        const revertOptimisticWin = () => {
            if (!optimisticWin) return;
            this.modal.clearChallengeWinActions?.({
                restartAction: () => this.restartActiveRace(),
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
        const paintBestUpdate = (response) => {
            const bestUpdate = response?.body?.bestUpdate;
            if (!bestUpdate || !stillOnThisFinish()) return;
            this.modal.updateChallengeFinishHero?.({ bestUpdate });
        };
        const claimSettledBest = async () => {
            try {
                // Same submit as a claimed win: origin personal best and place come back on this
                // body so the finish sheet can replace RANK.
                const response = await submitHeadToHeadRun({
                    challengeId: challenge.challengeId,
                    replay,
                    bestTimeMs: finalTimeMs,
                });
                paintBestUpdate(response);
            } catch (submitError) {
                console.error('Could not rank a settled Head to Head run:', submitError);
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

        openPendingFinish({ phase: 'pending' });
        if (optimisticWin) applyWinActions();

        void (async () => {
            if (!stillOnThisFinish()) return;

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

            if (!accepted) {
                const serverDifferenceMs = Number(response.body?.differenceMs);
                if (
                    response.body?.status === 'target_not_beaten'
                    && Number.isFinite(serverDifferenceMs)
                ) {
                    this.modal.updateChallengeFinishHero?.({
                        phase: serverDifferenceMs === 0 ? 'tie' : 'lost',
                        verdict: buildVerdict(serverDifferenceMs),
                        ...(response.body?.bestUpdate
                            ? { bestUpdate: response.body.bestUpdate }
                            : {}),
                    });
                    revertOptimisticWin();
                    return;
                }
                this.modal.updateChallengeFinishHero?.({
                    phase: 'error',
                    error: confirmationFailed
                        ? (response.body?.error || 'Race finished, but the challenge result could not be confirmed.')
                        : (response.body?.error || 'This run could not be verified.'),
                });
                revertOptimisticWin();
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

            const bestUpdate = response.body?.bestUpdate
                ? { bestUpdate: response.body.bestUpdate }
                : {};
            if (outcome === 'won') {
                this.modal.updateChallengeFinishHero?.({
                    phase: 'won',
                    verdict,
                    ...bestUpdate,
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
                ...bestUpdate,
            });
            revertOptimisticWin();
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
