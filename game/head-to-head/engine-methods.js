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
    // The challenge record keeps no per-viewer result, so the finish sheet hands its own
    // verdict over. Reopening the post falls back to the stored win until it expires.
    async loadChallengeLobby(challengeId = null, { outcome = null, bestTimeMs = null } = {}) {
        this.headToHeadChallengeId = challengeId;
        cancelDeferredLobbyWork(this);
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        let response;
        try {
            response = await getHeadToHead(challengeId);
        } catch (error) {
            // A challenge post can outlive a slow WebView connection. Keep the
            // failure inside the lobby flow so startup can always hand control
            // to the player instead of leaving the global loader up forever.
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
            // The finish sheet crowns the viewer with their own face, so the duel
            // carries the avatar the lobby already fetched.
            viewerAvatarUrl: response.body?.viewerAvatarUrl ?? null,
        } : null;
        const challengeReady = response.ok
            && response.body?.status === 'ready'
            && Boolean(challenge);
        const retryable = !response.ok
            && (response.status === 0 || response.status >= 500);
        const remembered = outcome
            ? null
            : readHeadToHeadWin(challenge?.challengeId || challengeId);
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.lobbyUi.showChallenge({
            signedIn: response.body?.viewerType === 'reddit',
            canRace: challengeReady,
            // Contextual post data is presentation-only until the server has
            // returned the authoritative frozen challenge and ghost. It is
            // still useful while a transient request is waiting for Retry.
            available: challengeReady || Boolean(challenge),
            canRetry: retryable,
            challengerName: challenge?.challengerUsername,
            challengerAvatarUrl: challenge?.challengerAvatarUrl,
            viewerAvatarUrl: response.body?.viewerAvatarUrl,
            trackKey: challenge?.trackKey,
            trackName: getTrackName(challenge?.trackKey, challenge?.trackKey || ''),
            laps: challenge?.lapCount,
            targetTimeMs: challenge?.targetTimeMs,
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
            if (stage.trackKey !== this.currentTrackKey) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    showStartOverlayOnReset: false,
                });
            }
            if (challenge.frozenGhost) {
                const prepareGhost = this.pbGhost.prepareOpponent || this.pbGhost.prepare;
                prepareGhost?.call(this.pbGhost, {
                    bestTimeMs: challenge.targetTimeMs,
                    ghost: challenge.frozenGhost,
                });
            }
            delete this.trackPersonalBestByTrackKey[stage.raceId];
            this.bestLapTime = null;
            this.applyDailyChallenge(toRaceChallenge(stage));
            this.activeRaceMode = 'challenge';
            void this.journeys?.startAttempt?.({ reason: 'initial_start' });
            this.startSequence();
        } finally {
            this.startButtonPending = false;
        }
    },

    async handleHeadToHeadWin(winData) {
        const challenge = this.activeHeadToHead;
        if (!challenge) return;
        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const replay = this.scoreboardReplay.getPayload(challenge.lapCount);
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

        // The target time is on the client, so the whole verdict — who won and by
        // how much — is known the moment the race ends. Opening on it spares the
        // winner a "Submitting..." sheet that flips a beat later; the server still
        // gets the last word and can take it back.
        const finalTimeMs = Number.isFinite(finalTime) ? Math.round(finalTime * 1000) : null;
        const targetTimeMs = Number.isFinite(challenge.targetTimeMs)
            ? Math.round(challenge.targetTimeMs)
            : null;
        // Won or lost, the margin is what the racer came for. The hero words the
        // verdict; the duel only has to say who was raced and by how much.
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
        const beatsTarget = localDifferenceMs !== null && localDifferenceMs < 0;

        const openPendingFinish = () => {
            this.modal.showModal(
                'Challenge complete',
                null,
                {
                    lapTime: finalTime,
                    bestTime: challenge.targetTimeMs / 1000,
                    completedLaps: challenge.lapCount,
                    requiredLaps: challenge.lapCount,
                    primaryStatLabel: 'Race Time',
                    lapMedal: beatsTarget ? 'challenge' : null,
                    challengeFinish: true,
                    challengeConfirmPhase: beatsTarget ? 'won' : 'pending',
                    challengeConfirmStatus: beatsTarget ? null : submittingStatus,
                    challengeViewerAvatarUrl: challenge.viewerAvatarUrl ?? null,
                    challengeVerdict: buildVerdict(localDifferenceMs),
                    trackKey: challenge.trackKey,
                    showGlobalLeaderboard: false,
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

        // The verdict is the whole sheet, buttons included: a win retires Improve
        // for Brag and the two modes waiting outside this duel. Opening on it
        // keeps the winner from watching a loser's action row for the length of
        // a round trip.
        const applyWinActions = () => {
            this.modal.setChallengeWinActions?.({
                // The duel is over, so both exits end it — each asks first.
                dailyAction: () => this.showDailyLobby(),
                campaignAction: () => this.showCampaignLobby(),
            });
        };
        const revokeWinActions = () => {
            if (!beatsTarget) return;
            this.modal.clearChallengeWinActions?.({
                restartAction: () => this.restartActiveRace(),
            });
        };

        const stillOnThisFinish = () => (
            this.status === 'won'
            && this.activeHeadToHead?.challengeId === challenge.challengeId
        );

        if (!replay) {
            openPendingFinish();
            this.modal.updateChallengeFinishHero?.({
                phase: 'error',
                error: 'This run could not be verified.',
            });
            return;
        }

        openPendingFinish();
        if (beatsTarget) applyWinActions();

        void (async () => {
            if (!stillOnThisFinish()) return;
            if (!beatsTarget) {
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
                revokeWinActions();
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

            // Thread the acceptToken into the finish modal's shareRequest so the brag
            // comment quotes the run just finished, not a re-derived best.
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
                });
                rememberHeadToHeadWin(
                    challenge.challengeId,
                    response.body?.bestTimeMs ?? null,
                );
                applyWinActions();
                return;
            }
            revokeWinActions();
            this.modal.updateChallengeFinishHero?.({
                phase: outcome === 'tie' ? 'tie' : 'lost',
                verdict,
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
