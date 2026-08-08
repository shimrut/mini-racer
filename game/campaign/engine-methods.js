import { getMedalForRaceTime, isStandardMedalTier } from '../medals/medal-timing.js';
import { normalizeCampaignLobbyState } from '../lobby/service.js';
import { normalizeScoreboardSnapshot } from '../scoreboard/snapshot.js';
import { mergeLeaderboardPages } from '../scoreboard/ui.js';
import { getTrackName } from '../track/catalog.js';
import { TRACKS } from '../track/tracks.js';
import { createPersonalBestPaceBaseline } from '../ghost/pb-pace.js';
import { createModalActions, isNewBestResult } from '../race/result-flow.js';
import { objectiveTypeForLapCount } from '../race/race-spec.js';
import {
    clearPendingCampaignResult,
    deriveCampaignProgress,
    mergePendingCampaignResults,
    recordPendingCampaignResult,
    getCampaignBootstrap,
    getCampaignPbGhost,
    getCampaignSnapshot,
    startServerCampaignRace,
    submitCampaignRun,
} from './service.js';
import { CAMPAIGN_ID, CAMPAIGN_STAGES, getCampaignStage } from './manifest.js';
import { buildCampaignCarouselCards } from './carousel-model.js';
import { deferLobbyWorkUntilAfterPaint } from '../lobby/deferred-work.js';
import {
    clearCampaignVerification,
    createVerificationSnapshot,
    enqueueCampaignVerification,
    getVerificationRetryDelayMs,
    isRetryableVerificationFailure,
    markCampaignVerificationError,
    markCampaignVerificationPending,
} from '../scoreboard/verification-queue.js';

function toRaceChallenge(stage) {
    return {
        id: stage.raceId,
        challengeDate: stage.challengeDate || 'Campaign',
        trackKey: stage.trackKey,
        startsAt: '1970-01-01T00:00:00.000Z',
        endsAt: '9999-12-31T23:59:59.999Z',
        availableUntil: '9999-12-31T23:59:59.999Z',
        status: 'active',
        rulesRevision: stage.rulesRevision,
        objectiveType: objectiveTypeForLapCount(stage.lapCount),
        objectiveParams: { lapCount: stage.lapCount },
        skin: 'default',
        mode: 'campaign',
    };
}

/**
 * Best medal already banked for this stage. Campaign medals scale with lap
 * count and belong to a stage rather than a track, so they live in Campaign
 * progress by raceId, not the per-track store the Daily finish reads.
 * @returns {'author'|'gold'|'silver'|'bronze'|null}
 */
function getStoredCampaignStageMedal(bootstrap, raceId) {
    const medal = bootstrap?.progress?.resultsByRaceId?.[raceId]?.medal ?? null;
    return isStandardMedalTier(medal) ? medal : null;
}

function getCampaignVerificationBestTimeSec(engine, stage) {
    const storedBestTimeMs = Number(
        engine.campaignBootstrap?.progress?.resultsByRaceId?.[stage.raceId]?.bestTimeMs,
    );
    const cachedTrackBestSec = Number(
        engine.trackPersonalBestByTrackKey?.[stage.raceId]?.bestTime,
    );
    const preparedBaselineSec = Number(
        engine.personalBestPaceBaselineByRaceId?.[stage.raceId]?.finishTimeSec,
    );
    const activeBaselineSec = Number(engine.activePersonalBestPaceBaseline?.finishTimeSec);
    const candidates = [
        storedBestTimeMs > 0 ? storedBestTimeMs / 1000 : null,
        cachedTrackBestSec > 0 ? cachedTrackBestSec : null,
        preparedBaselineSec > 0 ? preparedBaselineSec : null,
        activeBaselineSec > 0 ? activeBaselineSec : null,
    ].filter(Number.isFinite);
    return candidates.length ? Math.min(...candidates) : null;
}

function getExistingCampaignScoreboardSnapshot(engine, stage) {
    const raceId = stage?.raceId;
    if (!raceId) return null;

    const standing = engine.campaignBootstrap?.standingsByRaceId?.[raceId] ?? null;
    const lobbyStage = engine.campaignLobbyState?.stages?.find((candidate) => (
        candidate?.id === raceId || candidate?.raceId === raceId
    )) ?? null;
    const result = engine.campaignBootstrap?.progress?.resultsByRaceId?.[raceId] ?? null;
    const rankValue = Number(standing?.rank ?? lobbyStage?.playerRank);
    const playerRank = Number.isInteger(rankValue) && rankValue > 0 ? rankValue : null;
    const countValue = Number(
        standing?.totalCount ?? lobbyStage?.leaderboardEntryCount,
    );
    const totalCount = Number.isInteger(countValue) && countValue > 0 ? countValue : 0;
    const bestTimeMs = Number(result?.bestTimeMs ?? lobbyStage?.bestTimeMs);
    const bestTime = bestTimeMs > 0 ? bestTimeMs / 1000 : null;

    if (playerRank === null && bestTime === null && totalCount === 0) return null;

    return normalizeScoreboardSnapshot({
        currentPlayerRow: bestTime === null
            ? null
            : {
                isCurrentPlayer: true,
                displayName: 'You',
                rank: playerRank,
                bestTime,
            },
        totalCount,
        leaderboardEntryCount: totalCount,
        playerRank,
        playerRankLabel: playerRank === null ? null : `#${playerRank}`,
    });
}

function createCampaignLeaderboardRefreshSession(previousSession = null) {
    return {
        refreshedRaceIds: new Set(),
        inFlightByRaceId: new Map(),
        snapshotByRaceId: new Map(previousSession?.snapshotByRaceId || []),
        selectedRaceId: null,
    };
}

function requestCampaignLeaderboardSessionRefresh(raceId, refreshSession) {
    if (refreshSession.refreshedRaceIds.has(raceId)) {
        return Promise.resolve(refreshSession.snapshotByRaceId.get(raceId) || null);
    }

    const existingRequest = refreshSession.inFlightByRaceId.get(raceId);
    if (existingRequest) return existingRequest;

    let requestPromise = null;
    requestPromise = getCampaignSnapshot(raceId, {
        limit: 50,
        offset: 0,
    }).then((response) => {
        const snapshot = response.ok
            ? normalizeCampaignLeaderboardSnapshot(response.body)
            : null;
        if (
            snapshot
            && refreshSession.inFlightByRaceId.get(raceId) === requestPromise
        ) {
            refreshSession.refreshedRaceIds.add(raceId);
            refreshSession.snapshotByRaceId.set(raceId, snapshot);
        }
        return snapshot;
    }).finally(() => {
        if (refreshSession.inFlightByRaceId.get(raceId) === requestPromise) {
            refreshSession.inFlightByRaceId.delete(raceId);
        }
    });
    refreshSession.inFlightByRaceId.set(raceId, requestPromise);
    return requestPromise;
}

/** Next stage and whether it's open, read off the same gate the lobby uses (progress has already absorbed this finish by the time the sheet builds). */
function getCampaignNextStageTarget(engine, stage) {
    const stageIndex = CAMPAIGN_STAGES.findIndex(
        (candidate) => candidate.raceId === stage?.raceId,
    );
    const nextStage = stageIndex < 0 ? null : CAMPAIGN_STAGES[stageIndex + 1] ?? null;
    if (!nextStage) return null;

    const lobbyStage = engine.campaignLobbyState?.stages?.find(
        (candidate) => candidate?.id === nextStage.raceId,
    ) ?? null;
    return {
        stage: nextStage,
        unlocked: (engine.campaignBootstrap?.progress?.unlockedRaceIds || [])
            .includes(nextStage.raceId),
        trackName: getTrackName(nextStage.trackKey, nextStage.trackKey),
        requirementLabel: lobbyStage?.unlockRequirementLabel || null,
    };
}

/** Default landing stage when none is picked: the last stage reached, not Stage 00. */
function getDefaultCampaignLobbyStage(lobbyState) {
    const unlockedStages = Array.isArray(lobbyState?.stages)
        ? lobbyState.stages.filter((stage) => stage.unlocked)
        : [];
    return lobbyState?.nextStage || unlockedStages.at(-1) || null;
}

function decorateCampaignState(bootstrap) {
    const progress = bootstrap?.progress || {};
    const results = progress.resultsByRaceId || {};
    const unlocked = new Set(progress.unlockedRaceIds || []);
    const standings = bootstrap?.standingsByRaceId || {};
    // A provisional paint has no standings yet, and "no rank" reads very
    // differently from "not loaded" on a card.
    const standingsResolved = Boolean(bootstrap?.standingsByRaceId);
    return {
        ranked: bootstrap?.ranked === true,
        signedIn: bootstrap?.signedIn === true,
        startedAt: progress.startedAt || null,
        complete: progress.complete === true,
        standingsResolved,
        stages: (bootstrap?.stages || []).map((stage) => {
            const result = results[stage.raceId] || null;
            const standing = standings[stage.raceId] || null;
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
                playerRank: standing?.rank ?? null,
                leaderboardEntryCount: standing?.totalCount ?? 0,
                standingsResolved,
                standingsAvailable: true,
            };
        }),
    };
}

/** Opens the next stage optimistically off the client-computed medal, before the server confirms — verified progress replaces this once it lands, and a refused run has it revoked. */
function applyPendingCampaignResult(engine, stage, finalTime, medal) {
    if (!engine.campaignBootstrap) return;
    const bestTimeMs = Math.round(Number(finalTime) * 1000);
    if (!Number.isSafeInteger(bestTimeMs) || bestTimeMs <= 0) return;
    const merged = mergePendingCampaignResults(
        engine.campaignBootstrap.progress?.resultsByRaceId,
        recordPendingCampaignResult(stage.raceId, { bestTimeMs, medal }),
    );
    engine.campaignBootstrap.progress = deriveCampaignProgress(
        merged,
        engine.campaignBootstrap.progress?.startedAt ?? null,
    );
    engine.applyCampaignLobbyBootstrap?.(engine.campaignBootstrap);
}

/** Takes back an unlock the server refused; a verified result for the same stage outranks it and stays. */
function revokePendingCampaignResult(engine, raceId, bestTime) {
    clearPendingCampaignResult(raceId);
    const progress = engine.campaignBootstrap?.progress;
    if (!progress?.resultsByRaceId) return;
    const existing = progress.resultsByRaceId[raceId];
    const bestTimeMs = Math.round(Number(bestTime) * 1000);
    if (!existing || Number(existing.bestTimeMs) !== bestTimeMs) return;
    const { [raceId]: _refused, ...rest } = progress.resultsByRaceId;
    engine.campaignBootstrap.progress = deriveCampaignProgress(
        rest,
        progress.startedAt ?? null,
    );
    engine.applyCampaignLobbyBootstrap?.(engine.campaignBootstrap);
}

function buildProvisionalCampaignBootstrap(previous = null) {
    return {
        campaignId: CAMPAIGN_ID,
        ranked: previous?.ranked === true,
        signedIn: previous?.signedIn === true,
        stages: CAMPAIGN_STAGES,
        progress: previous?.progress || deriveCampaignProgress(),
    };
}

/** Campaign standings already match the shared snapshot shape; this is just the null guard call sites rely on. */
export function normalizeCampaignLeaderboardSnapshot(body) {
    return body ? normalizeScoreboardSnapshot(body) : null;
}

export function buildCampaignLeaderboardOptions(campaignState) {
    const stages = Array.isArray(campaignState?.stages) ? campaignState.stages : [];
    // The standings rail is an index of Campaign stages, not an unlock gate.
    // A stage can have a public leaderboard before this player has a rank on it.
    return stages.map((stage) => ({
        challengeId: stage.id,
        monthLabel: 'Stage',
        dayNumberLabel: stage.numberLabel,
        dateLabel: stage.trackName,
        ariaLabel: `View ${stage.trackName} campaign standings`,
    }));
}

function campaignPlayerRow(bestTime) {
    return {
        isCurrentPlayer: true,
        bestTime,
        rank: null,
        displayName: 'You',
    };
}

function campaignPendingSnapshot(bestTime, submissionStage = 'submitting') {
    return {
        ...createVerificationSnapshot({
            verificationState: 'pending',
            isLoading: true,
            submissionStage,
        }),
        currentPlayerRow: campaignPlayerRow(bestTime),
    };
}

function campaignErrorSnapshot(bestTime, statusText) {
    return {
        ...createVerificationSnapshot({
            verificationState: 'error',
            isLoading: false,
            submissionStage: 'error',
            statusText: statusText || 'Couldn\'t rank this run. Try again.',
        }),
        currentPlayerRow: campaignPlayerRow(bestTime),
    };
}

export const campaignEngineMethods = {
    applyCampaignLobbyBootstrap(bootstrap, { paint = false } = {}) {
        this.applyCarUnlockSnapshot?.(bootstrap?.carUnlocks);
        this.campaignBootstrap = bootstrap;
        this._campaignBootstrapReady = true;
        this.campaignLobbyState = normalizeCampaignLobbyState(decorateCampaignState(bootstrap));
        if (
            paint
            && this.activeRaceMode === 'campaign'
            && this.lobbyUi?.getMode?.() === 'campaign'
        ) {
            this.lobbyUi.showCampaign(this.campaignLobbyState);
            if (this._campaignCarouselPaintReady !== false) {
                this.paintCampaignCarousel();
            }
            // A press owns the spinner until its own start finishes.
            if (!this.startButtonPending) {
                this.lobbyUi.setCampaignPrimaryLoading?.(false);
            }
        }
        return this.campaignLobbyState;
    },

    paintCampaignLobby(state, {
        bootstrapReady = false,
        paintCarousel = true,
    } = {}) {
        if (this.status !== 'ready' || this.currentChallengeRun) {
            this.reset(false, { showStartOverlay: false });
        }
        this.activeRaceMode = 'campaign';
        this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
        this.campaignLobbyState = normalizeCampaignLobbyState({
            ...state,
            resolved: Boolean(bootstrapReady),
        });
        this._campaignBootstrapReady = Boolean(bootstrapReady);
        this.lobbyUi.showCampaign(this.campaignLobbyState);
        if (paintCarousel) this.paintCampaignCarousel();
        // Until the server answers, the primary action is unknown rather than
        // "Start": showing it as pending is what keeps the label from flipping.
        this.lobbyUi.setCampaignPrimaryLoading?.(!bootstrapReady);
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

    showCampaignLobby({ refresh = true } = {}) {
        this._campaignCarouselPaintReady = false;
        this.activeCampaignStage = null;
        this.activeHeadToHead = null;
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
            {
                bootstrapReady: hadReadyBootstrap,
                paintCarousel: false,
            },
        );
        if (this.campaignCarousel?.isEmpty?.()) {
            this.campaignCarousel.renderStatus?.({ loading: true });
        }
        deferLobbyWorkUntilAfterPaint(this, 'campaign', () => {
            this._campaignCarouselPaintReady = true;
            this.paintCampaignCarousel();
        });
        if (refresh || !hadReadyBootstrap) {
            void this.ensureCampaignBootstrap({ forceRefresh: true });
        }
    },

    /** Every stage gets a card, locked ones included, so the shape of the campaign is visible from the lobby. */
    paintCampaignCarousel() {
        if (!this.campaignCarousel) return;
        const cards = buildCampaignCarouselCards(this.campaignLobbyState);
        this.campaignCarousel.render(cards, {
            selectedChallengeId: this.selectedCampaignStageId
                || getDefaultCampaignLobbyStage(this.campaignLobbyState)?.id
                || null,
            loading: !this._campaignBootstrapReady,
        });
    },

    handleCampaignCarouselSelect(stage) {
        if (!stage?.id) return;
        this.selectedCampaignStageId = stage.id;
        this.lobbyUi?.setCampaignSelectedStage?.(stage);
    },

    /** Warm the centred track so the primary action does not pay for the build. */
    handleCampaignCarouselSettled(card) {
        const stage = card?.challenge;
        if (!stage?.trackKey || card?.locked) return;
        if (this.status === 'playing' || this.status === 'starting') return;
        if (!this.startOverlay?.isStartOverlayVisible?.()) return;
        this.prewarmDailyPlaylistTracks?.([{ trackKey: stage.trackKey }], {
            requireModal: false,
        });
    },

    async startCampaignStage(stageLike = null, {
        preserveRaceComparisonTarget = false,
    } = {}) {
        if (this.startButtonPending) return;
        if (!preserveRaceComparisonTarget) this.clearRaceComparisonTarget?.();
        this.startButtonPending = true;
        // The whole start is a wait, not just the bootstrap leg: without this the
        // button sits dead through a track load and reads as a freeze.
        this.lobbyUi?.setCampaignPrimaryLoading?.(true);
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
                || getDefaultCampaignLobbyStage(this.campaignLobbyState)?.id
                || requestedId,
            );
            if (!stage) return;
            const replacesCurrentRun = this.status !== 'ready';
            const raceStartTransition = this.startOverlay?.beginRaceStartTransition?.();
            if (!raceStartTransition) this.startOverlay?.hideStartOverlay?.();

            // Same as Daily: start/ghost requests fire now and fold in once the
            // lights are running, so nothing on the wire gates the countdown.
            // Both swallow their own failures rather than being skipped.
            const startRequest = startServerCampaignRace(stage.raceId).catch((error) => {
                console.warn('Could not stamp the Campaign race start:', error);
                return null;
            });
            const ghostRequest = getCampaignPbGhost(stage.raceId).catch((error) => {
                console.warn('Campaign PB ghost was unavailable for this run:', error);
                return null;
            });

            this.activeRaceMode = 'campaign';
            this.activeCampaignStage = stage;
            this.activeHeadToHead = null;
            if (replacesCurrentRun && stage.trackKey === this.currentTrackKey) {
                this.reset(false, {
                    preserveRaceComparisonTarget,
                    showStartOverlay: false,
                });
            }
            if (!preserveRaceComparisonTarget) this.pbGhost.clearTrack();
            if (stage.trackKey !== this.currentTrackKey) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    preserveRaceComparisonTarget,
                    showStartOverlayOnReset: false,
                });
            }
            this.applyDailyChallenge(toRaceChallenge(stage));
            this.activeRaceMode = 'campaign';
            void this.journeys?.startAttempt?.({ reason: 'initial_start' });
            await raceStartTransition;
            this.startSequence();

            if (startRequest) void this.confirmCampaignRaceStart(stage, startRequest);
            if (ghostRequest) {
                void ghostRequest.then((response) => {
                    // A dropped request leaves whatever was already cached alone;
                    // only an answer from the server rewrites the personal best.
                    if (!response) return;
                    this.applyCampaignPersonalBest(
                        stage,
                        response.ok ? response.body?.personalBest : null,
                    );
                });
            }
        } catch (error) {
            console.error('Could not start Campaign race:', error);
            await this.loadCampaignLobby({ show: true });
        } finally {
            this.lobbyUi?.setCampaignPrimaryLoading?.(false);
            this.startButtonPending = false;
        }
    },

    async startCampaignStageAgainstOpponent(stage, target) {
        if (!stage || !target) return false;
        this.clearRaceComparisonTarget?.();
        if (!this.installRaceComparisonTarget?.(
            { ...target, mode: 'campaign' },
            {
                track: TRACKS[stage.trackKey],
                lapCount: stage.lapCount,
            },
        )) {
            return false;
        }
        await this.startCampaignStage(stage, { preserveRaceComparisonTarget: true });
        // Same rule as Daily: a start that never reached this stage cannot
        // leave its opponent installed for the next race.
        if (this.activeCampaignStage?.raceId !== stage.raceId) {
            this.clearRaceComparisonTarget?.();
            return false;
        }
        return this.raceComparisonTarget !== null;
    },

    /** Folds the start-stamp response into a race already running. Only an outright refusal (locked/missing stage) pulls the player out; any other failure (network, server error) leaves the countdown alone. */
    async confirmCampaignRaceStart(stage, startRequest) {
        const started = await startRequest;
        if (!started) return;
        if (started.ok) {
            if (this.campaignBootstrap && started.body?.progress) {
                const startedAt = started.body.progress.startedAt;
                // The start stamp was read before the race. Its result map can
                // therefore be older than a medal earned while this request was
                // in flight. Only fold in the one field this request owns.
                if (
                    typeof startedAt === 'string'
                    && !this.campaignBootstrap.progress?.startedAt
                ) {
                    this.campaignBootstrap.progress = {
                        ...(this.campaignBootstrap.progress || deriveCampaignProgress()),
                        startedAt,
                    };
                }
            }
            return;
        }
        console.warn(
            'Campaign race start was not stamped:',
            started.body?.error || 'Could not stamp this Campaign race start.',
        );
        const refusesThisStage = started.status === 403 || started.status === 404;
        if (!refusesThisStage) return;
        if (this.activeCampaignStage?.raceId !== stage.raceId) return;
        await this.loadCampaignLobby({ show: true });
    },

    /** Folds a personal-best ghost into the run already counting down; a slow response just means this attempt runs without one. */
    applyCampaignPersonalBest(stage, personalBest) {
        if (this.activeCampaignStage?.raceId !== stage.raceId) return;
        this.trackPersonalBestByTrackKey ??= Object.create(null);
        this.personalBestPaceBaselineByRaceId ??= Object.create(null);
        this.sessionBestLapSecByTrackKey ??= Object.create(null);
        this.sessionBestCheckpointTimesByTrackKey ??= Object.create(null);
        const bestTimeMs = Number(personalBest?.bestTimeMs);
        if (!(bestTimeMs > 0)) {
            delete this.trackPersonalBestByTrackKey[stage.raceId];
            delete this.personalBestPaceBaselineByRaceId[stage.raceId];
            delete this.sessionBestLapSecByTrackKey[stage.raceId];
            delete this.sessionBestCheckpointTimesByTrackKey[stage.raceId];
            if (this.activeDailyChallenge?.id !== stage.raceId) return;
            this.trackPersonalBestResult = null;
            this.bestLapTime = null;
            this.syncChallengeHudPrimaryStats?.();
            return;
        }
        if (personalBest?.ghost) this.pbGhost.prepare(personalBest);
        const bestTime = bestTimeMs / 1000;
        const trackPersonalBest = {
            challengeId: stage.raceId,
            trackKey: stage.trackKey,
            bestTime,
            checkpointTimesSec: personalBest?.checkpointTimesSec ?? null,
            lapCompletionTimesSec: personalBest?.lapCompletionTimesSec ?? null,
            ghostAvailable: Boolean(personalBest?.ghost),
            updatedAt: personalBest?.updatedAt ?? null,
        };
        this.trackPersonalBestByTrackKey[stage.raceId] = trackPersonalBest;
        const paceBaseline = createPersonalBestPaceBaseline(
            personalBest,
            TRACKS[stage.trackKey],
            stage.lapCount,
        );
        if (paceBaseline) {
            this.personalBestPaceBaselineByRaceId[stage.raceId] = paceBaseline;
            this.sessionBestLapSecByTrackKey[stage.raceId] = paceBaseline.finishTimeSec;
            if (paceBaseline.checkpointTimesSec.length) {
                this.sessionBestCheckpointTimesByTrackKey[stage.raceId] =
                    paceBaseline.checkpointTimesSec.slice();
            } else {
                delete this.sessionBestCheckpointTimesByTrackKey[stage.raceId];
            }
        } else {
            delete this.personalBestPaceBaselineByRaceId[stage.raceId];
        }
        // applyDailyChallenge already ran off whatever was cached, so the HUD and
        // medal baseline have to be re-derived from the fresh best.
        if (this.activeDailyChallenge?.id !== stage.raceId) return;
        this.trackPersonalBestResult = trackPersonalBest;
        this.bestLapTime = bestTime;
        this.syncTrackMedalFromChallengeBest?.(this.activeDailyChallenge, bestTime);
        this.syncChallengeHudPrimaryStats?.();
    },

    handleInvalidCampaignWin(reason = 'Finish could not be verified.') {
        console.warn('Campaign win validation failed:', reason);
        const stage = this.activeCampaignStage;
        this.status = 'ready';
        void this.journeys?.endAttempt?.({ complete: false });
        this.hud.setPauseVisible(false);
        this.hud.setHudPersonalBestsOpenAllowed(true);
        this.modal.showModal(
            'RUN REJECTED',
            null,
            {
                lapTime: this.currentTime,
                bestTime: this.bestLapTime,
                primaryStatLabel: 'Race Time',
                trackKey: stage?.trackKey ?? this.currentTrackKey,
                showGlobalLeaderboard: false,
            },
            {
                ...createModalActions({
                    modalKind: 'rejected',
                    primaryActionLabel: 'Retry',
                    secondaryActionLabel: 'Campaign',
                    secondaryAction: () => this.showCampaignLobby(),
                }),
                restartAction: () => this.restartActiveRace(),
                settingsAction: () => this.settings.openSettings(),
            },
        );
        if (this.modal.modalMsg) {
            this.modal.modalMsg.style.display = '';
            this.modal.modalMsg.textContent = reason;
        }
    },

    showCampaignFinish(stage, {
        finalTime,
        medal,
        previousMedal = null,
        message = null,
        shareRequest = null,
        scoreboardSnapshot = null,
    }) {
        const comparison = this.getRaceComparisonResult?.(finalTime) ?? null;
        const paceBaseline = this.getActiveRacePaceBaseline?.()
            ?? this.activePersonalBestPaceBaseline
            ?? null;
        const previousPersonalBestSec = comparison
            ? null
            : (Number.isFinite(paceBaseline?.finishTimeSec)
                ? paceBaseline.finishTimeSec
                : null);
        const trackLine = `${getTrackName(stage.trackKey, stage.trackKey)} · ${stage.lapCount} ${stage.lapCount === 1 ? 'lap' : 'laps'}`;
        const nextTarget = getCampaignNextStageTarget(this, stage);
        this.modal.showModal(
            'Campaign race complete',
            null,
            {
                lapTime: finalTime,
                bestTime: previousPersonalBestSec,
                previousPersonalBestSec,
                deltaToPersonalBest: Number.isFinite(previousPersonalBestSec)
                    ? finalTime - previousPersonalBestSec
                    : null,
                completedLaps: stage.lapCount,
                requiredLaps: stage.lapCount,
                primaryStatLabel: 'Race Time',
                lapMedal: medal,
                // Without the stage's banked medal the sheet reads every tier as
                // a first unlock and replays the whole fanfare on every retry.
                previousTrackMedal: previousMedal,
                trackKey: stage.trackKey,
                scoreboardSnapshot,
                scoreboardChallengeId: stage.raceId,
                scoreboardTrackKey: stage.trackKey,
                showGlobalLeaderboard: false,
                allowLeaderboardOpen: true,
                // Campaign stages rank against their own board, so the rank tap
                // must not fall through to the Daily standings.
                onOpenStandings: () => void this.openCampaignStandings(stage.raceId, {
                    returnMode: 'back',
                }),
                raceComparisonTarget: comparison?.target ?? null,
                comparisonOutcome: comparison?.outcome ?? null,
                deltaToComparison: comparison?.deltaSec ?? null,
                lapCheckpointTimes: this.getLapCheckpointTimesSec?.() ?? [],
                pbCheckpointTimes: comparison?.target.checkpointTimesSec
                    ?? paceBaseline?.checkpointTimesSec
                    ?? null,
                pbFinishSec: comparison?.target.finishTimeSec
                    ?? paceBaseline?.finishTimeSec
                    ?? null,
            },
            {
                ...createModalActions({
                    modalKind: 'win',
                    primaryActionLabel: 'Retry',
                    secondaryActionLabel: 'Campaign',
                    secondaryAction: () => this.showCampaignLobby(),
                }),
                restartAction: () => this.restartActiveRace(),
                settingsAction: () => this.settings.openSettings(),
                shareRequest,
                nextRace: nextTarget
                    ? {
                        label: 'Next',
                        ariaLabel: nextTarget.unlocked
                            ? `Race ${nextTarget.trackName}`
                            : nextTarget.requirementLabel
                                || `${nextTarget.trackName} is still locked`,
                        enabled: nextTarget.unlocked,
                        action: () => void this.startCampaignNextStage(nextTarget.stage),
                    }
                    : null,
            },
        );
        if (this.modal.modalMsg) {
            this.modal.modalMsg.style.display = '';
            this.modal.modalMsg.textContent = message || trackLine;
        }
    },

    /** Starts the stage the finish sheet just unlocked without detouring through the lobby. */
    async startCampaignNextStage(stage) {
        if (!stage || this.startButtonPending) return;
        this.selectedCampaignStageId = stage.raceId;
        this.reset(false, { showStartOverlay: false });
        this.activeRaceMode = 'campaign';
        await this.startCampaignStage(stage);
    },

    handleCampaignWin(winData) {
        const stage = this.activeCampaignStage;
        if (!stage || !this.currentChallengeRun) return;

        const invalidReason = this.getInvalidWinDataReason?.(winData) ?? null;
        if (invalidReason) {
            this.handleInvalidCampaignWin(invalidReason);
            return;
        }

        this.status = 'won';
        void this.journeys?.endAttempt?.({ complete: true });
        const finalTime = Number(winData?.lapTime);
        const medal = getMedalForRaceTime(stage.trackKey, finalTime, stage.lapCount);
        // Read before verification writes this finish into progress, or the run
        // would look like it had already earned its own medal.
        const previousMedal = getStoredCampaignStageMedal(this.campaignBootstrap, stage.raceId);
        const previousVerifiedBestSec = getCampaignVerificationBestTimeSec(this, stage);
        const isCampaignBest = isNewBestResult(
            this.currentRunPolicy || { bestResultComparator: 'time' },
            { bestTime: finalTime, completedLaps: stage.lapCount },
            Number.isFinite(previousVerifiedBestSec)
                ? { bestTime: previousVerifiedBestSec, completedLaps: stage.lapCount }
                : null,
        );

        // Match Daily's submission boundary: a valid finish still gets its
        // result sheet, opponent outcome, and retry controls, but only a strict
        // improvement enters verification. Equal and slower runs never enqueue.
        if (!isCampaignBest) {
            this.showCampaignFinish(stage, {
                finalTime,
                medal,
                previousMedal,
                shareRequest: {
                    kind: 'head-to-head',
                    source: 'campaign',
                    raceId: stage.raceId,
                },
                scoreboardSnapshot: getExistingCampaignScoreboardSnapshot(this, stage),
            });
            this.configureLeaderboardOpponentFinish?.({
                mode: 'campaign',
                race: stage,
                finalTime,
                comparison: this.getRaceComparisonResult?.(finalTime) ?? null,
                waitForVerification: false,
            });
            return;
        }

        const replay = this.scoreboardReplay.getPayload(stage.lapCount);
        const blockedReason = this.rankedSubmissionBlockedReason
            || (replay
                ? null
                : this.scoreboardReplay.overflowed
                    ? 'Run too long to rank.'
                    : 'Submission replay was unavailable for this run.');

        // A run the client cannot rank must not advance progression: an unlock
        // only ever follows a medal the server itself derived.
        if (blockedReason) {
            this.showCampaignFinish(stage, {
                finalTime,
                medal,
                previousMedal,
                message: blockedReason,
                scoreboardSnapshot: campaignErrorSnapshot(finalTime, blockedReason),
            });
            return;
        }

        // Medal is already known client-side, so its stage unlocks now rather
        // than after a round trip.
        applyPendingCampaignResult(this, stage, finalTime, medal);

        // Same as Daily: finish sheet opens immediately, durable queue
        // confirms in the background so a dropped connection retries.

        const { enqueued, entry } = enqueueCampaignVerification({
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            bestTime: finalTime,
            lapCount: stage.lapCount,
            rulesRevision: stage.rulesRevision,
            replay,
        });

        this.showCampaignFinish(stage, {
            finalTime,
            medal,
            previousMedal,
            shareRequest: {
                kind: 'head-to-head',
                source: 'campaign',
                raceId: stage.raceId,
            },
            scoreboardSnapshot: entry
                ? campaignPendingSnapshot(finalTime)
                : campaignErrorSnapshot(finalTime, null),
        });
        this.configureLeaderboardOpponentFinish?.({
            mode: 'campaign',
            race: stage,
            finalTime,
            comparison: this.getRaceComparisonResult?.(finalTime) ?? null,
            waitForVerification: Boolean(enqueued),
        });

        if (!enqueued) return;
        const processing = this.processVerificationQueue?.();
        if (processing && typeof processing.catch === 'function') {
            void processing.catch((error) => {
                console.error('Error processing Campaign verification queue:', error);
                this.scheduleVerificationQueueProcessing?.(getVerificationRetryDelayMs());
            });
        } else {
            this.scheduleVerificationQueueProcessing?.(0);
        }
    },

    updateCampaignFinishSnapshot(raceId, snapshot) {
        if (this.modal.matchesModalScoreboardContext?.({ challengeId: raceId })) {
            this.modal.updateModalScoreboardSnapshot?.(snapshot);
        }
    },

    retryCampaignVerificationLater(entry, statusText = null) {
        markCampaignVerificationPending(
            entry.raceId,
            Date.now() + getVerificationRetryDelayMs(),
            { submissionStage: 'retrying', statusText },
        );
        this.updateCampaignFinishSnapshot(
            entry.raceId,
            campaignPendingSnapshot(entry.bestTime, 'retrying'),
        );
    },

    async processCampaignVerificationEntry(entry) {
        const raceId = entry?.raceId;
        const stage = getCampaignStage(raceId);
        if (!raceId || !stage || !Number.isFinite(entry?.bestTime)) {
            if (raceId) clearCampaignVerification(raceId);
            return;
        }

        if (!entry.replay) {
            const error = 'Submission replay is missing. Race again to rank it.';
            markCampaignVerificationError(raceId, error);
            this.updateCampaignFinishSnapshot(
                raceId,
                campaignErrorSnapshot(entry.bestTime, error),
            );
            return;
        }

        markCampaignVerificationPending(raceId, Date.now(), {
            submissionStage: 'verifying',
        });
        this.updateCampaignFinishSnapshot(
            raceId,
            campaignPendingSnapshot(entry.bestTime, 'verifying'),
        );

        let response = null;
        try {
            response = await submitCampaignRun({
                raceId,
                trackKey: stage.trackKey,
                replay: entry.replay,
            });
        } catch (submitError) {
            console.error('Could not confirm Campaign race result:', submitError);
            this.retryCampaignVerificationLater(entry);
            return;
        }

        if (response.ok && response.body?.accepted === true) {
            this.applyCarUnlockSnapshot?.(response.body.carUnlocks);
            clearCampaignVerification(raceId);
            // Verified progress supersedes what this run opened optimistically.
            clearPendingCampaignResult(raceId);
            if (this.campaignBootstrap && response.body.progress) {
                this.campaignBootstrap.progress = response.body.progress;
            }
            await this.refreshCampaignAfterAcceptedRun(stage);
            void this.resolveLeaderboardOpponentAdvanceAfterVerification?.({
                mode: 'campaign',
                competitionId: raceId,
                benchmarkTimeMs: Math.round(entry.bestTime * 1000),
            });
            return;
        }

        if (isRetryableVerificationFailure(response)) {
            this.retryCampaignVerificationLater(
                entry,
                typeof response.body?.error === 'string' ? response.body.error : null,
            );
            return;
        }

        const error = response.body?.error || 'This run could not be verified.';
        markCampaignVerificationError(raceId, error);
        // Campaign medals are the unlock gate, and the server refused this run,
        // so the stage it opened closes again and the sheet stops advertising a
        // medal it did not earn.
        revokePendingCampaignResult(this, raceId, entry.bestTime);
        if (this.modal.matchesModalScoreboardContext?.({ challengeId: raceId })) {
            this.modal.setCombinedWinMedal?.(null);
            // Medals from other stages may still hold the gate open, so the
            // button follows the re-derived progress rather than simply closing.
            this.modal.setCombinedNextRaceEnabled?.(
                getCampaignNextStageTarget(this, stage)?.unlocked === true,
            );
        }
        this.updateCampaignFinishSnapshot(
            raceId,
            campaignErrorSnapshot(entry.bestTime, error),
        );
    },

    async refreshCampaignAfterAcceptedRun(stage) {
        const activeStandingsSession = this._activeCampaignStandingsRefreshSession;
        const olderRequest = activeStandingsSession?.inFlightByRaceId.get(stage.raceId);
        if (olderRequest) {
            await olderRequest.catch(() => null);
        }
        activeStandingsSession?.refreshedRaceIds.delete(stage.raceId);

        try {
            const snapshotResponse = await getCampaignSnapshot(stage.raceId, {
                limit: 50,
                offset: 0,
            });
            if (snapshotResponse.ok) {
                const snapshot = normalizeCampaignLeaderboardSnapshot(snapshotResponse.body);
                if (snapshot) {
                    this.updateCampaignFinishSnapshot(stage.raceId, snapshot);
                    const refreshSessions = new Set([
                        activeStandingsSession,
                        this._lastCampaignStandingsRefreshSession,
                    ]);
                    for (const refreshSession of refreshSessions) {
                        refreshSession?.snapshotByRaceId.set(stage.raceId, snapshot);
                        refreshSession?.refreshedRaceIds.add(stage.raceId);
                    }
                }
            }
        } catch (snapshotError) {
            console.warn('Campaign finish opened without a live rank snapshot:', snapshotError);
        }

        try {
            const ghost = await getCampaignPbGhost(stage.raceId);
            const personalBest = ghost.ok ? ghost.body?.personalBest : null;
            this.applyCampaignPersonalBest(stage, personalBest);
        } catch (ghostError) {
            console.warn('Campaign result was saved, but PB ghost refresh failed:', ghostError);
        }

        try {
            await this.loadCampaignLobby({ show: false });
        } catch (refreshError) {
            console.warn('Campaign result screen opened without refreshed progress:', refreshError);
        }
    },
    async openCampaignStandings(stageLike = null, {
        returnMode = 'close',
        refreshSession: providedRefreshSession = null,
    } = {}) {
        await this.ensureCampaignBootstrap();
        if (this.activeRaceMode !== 'campaign') return;

        const lobbyState = this.campaignLobbyState;
        const campaignStages = Array.isArray(lobbyState?.stages)
            ? lobbyState.stages
            : [];
        const defaultStage = getDefaultCampaignLobbyStage(lobbyState);
        const requestedStageId = typeof stageLike === 'string'
            ? stageLike
            : (stageLike?.raceId || stageLike?.id || defaultStage?.id);
        const selectedLobbyStage = campaignStages.find((stage) => stage.id === requestedStageId);
        const stage = getCampaignStage(selectedLobbyStage?.id);
        if (!stage) return;

        const refreshSession = providedRefreshSession
            || createCampaignLeaderboardRefreshSession(
                this._lastCampaignStandingsRefreshSession,
            );
        this._activeCampaignStandingsRefreshSession = refreshSession;
        this._lastCampaignStandingsRefreshSession = refreshSession;
        refreshSession.selectedRaceId = stage.raceId;
        const requestId = (this._campaignStandingsRequestId || 0) + 1;
        this._campaignStandingsRequestId = requestId;
        const leaderboardOptions = buildCampaignLeaderboardOptions(lobbyState);
        const existingSnapshot = refreshSession.snapshotByRaceId.get(stage.raceId)
            || getExistingCampaignScoreboardSnapshot(this, stage);
        if (existingSnapshot && !refreshSession.snapshotByRaceId.has(stage.raceId)) {
            refreshSession.snapshotByRaceId.set(stage.raceId, existingSnapshot);
        }
        const shouldRefresh = refreshSession.inFlightByRaceId.has(stage.raceId)
            || !refreshSession.refreshedRaceIds.has(stage.raceId);
        let currentSnapshot = existingSnapshot;
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
                    || this._activeCampaignStandingsRefreshSession !== refreshSession
                    || refreshSession.selectedRaceId !== stage.raceId
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
            scoreboardSnapshot: shouldRefresh
                ? (existingSnapshot
                    ? { ...existingSnapshot, isRefreshing: true }
                    : { isLoading: true })
                : existingSnapshot,
            scoreboardMode: 'campaign',
            scoreboardChallengeId: stage.raceId,
            scoreboardTrackKey: stage.trackKey,
            scoreboardTitle: getTrackName(stage.trackKey, stage.trackKey),
            scoreboardSubhead: `Campaign · ${stage.lapCount} ${stage.lapCount === 1 ? 'lap' : 'laps'}`,
            leaderboardDayOptions: leaderboardOptions,
            leaderboardRailLabel: 'Campaign stages',
            selectedLeaderboardDayId: stage.raceId,
            onSelectLeaderboardDay: (raceId) => void this.openCampaignStandings(raceId, {
                returnMode,
                refreshSession,
            }),
            onRaceOpponent: (entry) => this.prepareAndStartLeaderboardOpponent?.({
                mode: 'campaign',
                competitionId: stage.raceId,
                entry,
            }),
            onLoadMoreLeaderboard,
            showGlobalLeaderboard: true,
            allowLeaderboardOpen: false,
            onClose: () => {
                this._campaignStandingsRequestId = (this._campaignStandingsRequestId || 0) + 1;
                if (
                    this._activeCampaignStandingsRefreshSession === refreshSession
                    && refreshSession.selectedRaceId === stage.raceId
                ) {
                    refreshSession.selectedRaceId = null;
                    this._activeCampaignStandingsRefreshSession = null;
                }
                // Browsing the stage rail inside the standings moves the lobby
                // with it, so closing lands on the stage last looked at.
                this.campaignCarousel?.selectChallenge?.(stage.raceId);
            },
        };
        this.modal.showRunsModal(null, null, null, returnMode, modalOptions);

        if (!shouldRefresh) return;

        try {
            const snapshot = await requestCampaignLeaderboardSessionRefresh(
                stage.raceId,
                refreshSession,
            );
            if (
                requestId !== this._campaignStandingsRequestId
                || this._activeCampaignStandingsRefreshSession !== refreshSession
                || refreshSession.selectedRaceId !== stage.raceId
                || !this.modal.isRunsViewActive?.()
            ) {
                return;
            }
            currentSnapshot = snapshot || existingSnapshot;
            this.modal.updateModalScoreboardSnapshot(currentSnapshot);
        } catch (error) {
            console.error('Could not load Campaign standings:', error);
            if (
                requestId === this._campaignStandingsRequestId
                && this._activeCampaignStandingsRefreshSession === refreshSession
                && refreshSession.selectedRaceId === stage.raceId
                && this.modal.isRunsViewActive?.()
            ) {
                currentSnapshot = existingSnapshot;
                this.modal.updateModalScoreboardSnapshot(currentSnapshot);
            }
        }
    },
};
