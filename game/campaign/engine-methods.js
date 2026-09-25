import { getMedalForRaceTime, isStandardMedalTier } from '../medals/medal-timing.js';
import { runAfterPlayerIdentityReady } from '../player/identity-recovery.js';
import { normalizeCampaignLobbyState } from '../lobby/service.js';
import { normalizeScoreboardSnapshot } from '../scoreboard/snapshot.js';
import { mergeLeaderboardPages } from '../scoreboard/ui.js';
import { getTrackName } from '../track/catalog.js';
import { getLoadedClientTrack, loadClientTrack } from '../track/client-registry.js';
import { createPersonalBestPaceBaseline } from '../ghost/pb-pace.js';
import { createModalActions, isNewBestResult } from '../race/result-flow.js';
import { objectiveTypeForLapCount } from '../race/race-spec.js';
import {
    deriveCampaignProgress,
    getCampaignBootstrap,
    getCampaignPbGhost,
    getCampaignSnapshot,
    startServerCampaignRace,
    submitCampaignRun,
    readSelectedCampaignSeriesId,
    writeSelectedCampaignSeriesId,
} from './service.js';
import {
    CAMPAIGN_ID,
    CAMPAIGN_SERIES,
    countCampaignMedals,
    getCampaignSeriesStages,
    getCampaignStage,
    isCampaignSeriesFinished,
    isCampaignSeriesId,
} from './manifest.js';
import { buildCampaignCarouselCards } from './carousel-model.js';
import { isVerificationQueueSubmissionBlocked } from '../scoreboard/verification-queue.js';
import {
    deferLobbyWorkUntilAfterPaint,
    isLobbyPaintEligible,
} from '../lobby/deferred-work.js';
import {
    clearCampaignVerification,
    createVerificationSnapshot,
    enqueueCampaignVerification,
    getCampaignVerificationEntry,
    getCampaignVerificationEntries,
    getVerificationRetryDelayMs,
    isRetryableVerificationFailure,
    markCampaignTrackPbRetry,
    markCampaignVerificationError,
    markCampaignVerificationPending,
} from '../scoreboard/verification-queue.js';

const CAMPAIGN_UNLOCK_CONFIRMATION_TIMEOUT_MS = 5_000;
const CAMPAIGN_UNLOCK_CONFIRMATION_POLL_MS = 50;

function campaignTracksListPayload(engine) {
    const stages = engine.campaignLobbyState?.stages;
    const hasStages = Array.isArray(stages) && stages.length > 0;
    if (hasStages) return stages;
    return engine._campaignBootstrapReady ? [] : null;
}

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

function getCampaignNextStageTarget(engine, stage) {
    // Next goes to the next stage of the same series.
    const seriesStages = getCampaignSeriesStages(getCampaignStage(stage?.raceId)?.seriesId);
    const stageIndex = seriesStages.findIndex(
        (candidate) => candidate.raceId === stage?.raceId,
    );
    const nextStage = stageIndex < 0 ? null : seriesStages[stageIndex + 1] ?? null;
    if (!nextStage) return null;

    const verifiedUnlockIds = engine.campaignVerifiedBootstrap?.progress?.unlockedRaceIds
        || engine.campaignBootstrap?.verifiedProgress?.unlockedRaceIds
        || [];
    const lobbyStage = engine.campaignLobbyState?.stages?.find(
        (candidate) => candidate?.id === nextStage.raceId,
    ) ?? null;
    return {
        stage: nextStage,
        unlocked: verifiedUnlockIds.includes(nextStage.raceId),
        trackName: getTrackName(nextStage.trackKey, nextStage.trackKey),
        requirementLabel: lobbyStage?.unlockRequirementLabel || null,
    };
}

function getDefaultCampaignLobbyStage(lobbyState) {
    const unlockedStages = Array.isArray(lobbyState?.stages)
        ? lobbyState.stages.filter((stage) => stage.unlocked)
        : [];
    return lobbyState?.nextStage || unlockedStages.at(-1) || null;
}

// The series line of each live series. Without a server summary (no connection,
// or an older server), the stage list gives it, with the medals of the series
// on screen only.
function campaignSeriesSummaries(bootstrap) {
    if (Array.isArray(bootstrap?.series) && bootstrap.series.length) return bootstrap.series;
    const seriesId = bootstrap?.campaignId ?? CAMPAIGN_ID;
    const results = bootstrap?.progress?.resultsByRaceId ?? {};
    return CAMPAIGN_SERIES.map((series) => ({
        id: series.id,
        name: series.name,
        ground: series.ground,
        stageCount: series.stages.length,
        medalCount: series.id === seriesId ? countCampaignMedals(results, series.id) : 0,
        finished: series.id === seriesId && isCampaignSeriesFinished(series.id, results),
    }));
}

function decorateCampaignState(bootstrap) {
    const progress = bootstrap?.progress || {};
    const verifiedProgress = bootstrap?.verifiedProgress || progress;
    const results = progress.resultsByRaceId || {};
    const unlocked = new Set(verifiedProgress.unlockedRaceIds || []);
    const standings = bootstrap?.standingsByRaceId || {};
    const verificationErrors = bootstrap?.verificationErrors || {};
    const standingsResolved = Boolean(bootstrap?.standingsByRaceId);
    return {
        ranked: bootstrap?.ranked === true,
        signedIn: bootstrap?.signedIn === true,
        seriesId: bootstrap?.campaignId ?? CAMPAIGN_ID,
        series: campaignSeriesSummaries(bootstrap),
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
                verificationError: typeof verificationErrors[stage.raceId] === 'string'
                    ? verificationErrors[stage.raceId]
                    : null,
            };
        }),
    };
}

function isSupersededCampaignVerificationEntry(entry) {
    const current = entry?.raceId ? getCampaignVerificationEntry(entry.raceId) : null;
    if (!current) return false;
    return current.updatedAt !== entry.updatedAt || current.bestTime !== entry.bestTime;
}

function campaignResultFromVerificationEntry(stage, entry) {
    const bestTimeMs = Math.round(Number(entry?.bestTime) * 1000);
    if (!Number.isSafeInteger(bestTimeMs) || bestTimeMs <= 0) return null;
    return {
        raceId: stage.raceId,
        trackKey: stage.trackKey,
        lapCount: stage.lapCount,
        rulesRevision: stage.rulesRevision,
        bestTimeMs,
        medal: getMedalForRaceTime(stage.trackKey, bestTimeMs / 1000, stage.lapCount),
        checkpointTimesSec: null,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
}

function buildDisplayedCampaignBootstrap(bootstrap) {
    const seriesId = bootstrap?.campaignId ?? CAMPAIGN_ID;
    const verifiedProgress = bootstrap?.progress || deriveCampaignProgress({}, null, seriesId);
    const verifiedDerived = deriveCampaignProgress(
        verifiedProgress.resultsByRaceId || {},
        verifiedProgress.startedAt ?? null,
        seriesId,
    );
    const resultsByRaceId = { ...(verifiedProgress.resultsByRaceId || {}) };
    const verificationErrors = Object.create(null);
    const entries = getCampaignVerificationEntries();
    for (const stage of getCampaignSeriesStages(seriesId)) {
        const entry = entries[stage.raceId];
        if (!entry) continue;
        if (entry.progressConfirmed) continue;
        if (entry.verificationState === 'pending') {
            const provisional = campaignResultFromVerificationEntry(stage, entry);
            const verified = resultsByRaceId[stage.raceId];
            if (provisional && (!verified || provisional.bestTimeMs < Number(verified.bestTimeMs))) {
                resultsByRaceId[stage.raceId] = provisional;
            }
            continue;
        }
        if (entry.verificationState === 'error' && typeof entry.statusText === 'string') {
            verificationErrors[stage.raceId] = entry.statusText;
        }
    }
    const displayDerived = deriveCampaignProgress(
        resultsByRaceId,
        verifiedProgress.startedAt ?? null,
        seriesId,
    );
    return {
        ...bootstrap,
        verifiedProgress: {
            ...verifiedProgress,
            unlockedRaceIds: verifiedDerived.unlockedRaceIds,
            complete: verifiedDerived.complete,
        },
        progress: {
            ...displayDerived,
            unlockedRaceIds: verifiedDerived.unlockedRaceIds,
            complete: verifiedDerived.complete,
        },
        verificationErrors,
    };
}

function buildProvisionalCampaignBootstrap(previous = null) {
    const seriesId = previous?.campaignId ?? CAMPAIGN_ID;
    return {
        availability: 'loading',
        authoritative: false,
        campaignId: seriesId,
        ranked: previous?.ranked === true,
        signedIn: previous?.signedIn === true,
        series: Array.isArray(previous?.series) ? previous.series : [],
        stages: getCampaignSeriesStages(seriesId),
        progress: previous?.progress || deriveCampaignProgress({}, null, seriesId),
    };
}

export function normalizeCampaignLeaderboardSnapshot(body) {
    return body ? normalizeScoreboardSnapshot(body) : null;
}

export function buildCampaignLeaderboardOptions(campaignState) {
    const stages = Array.isArray(campaignState?.stages) ? campaignState.stages : [];
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

function responseConfirmsCampaignResult(response, entry) {
    const confirmedBestTimeMs = Number(
        response?.body?.progress?.resultsByRaceId?.[entry?.raceId]?.bestTimeMs,
    );
    const submittedBestTimeMs = Math.round(Number(entry?.bestTime) * 1000);
    return Number.isSafeInteger(confirmedBestTimeMs)
        && confirmedBestTimeMs > 0
        && Number.isSafeInteger(submittedBestTimeMs)
        && submittedBestTimeMs > 0
        && confirmedBestTimeMs <= submittedBestTimeMs;
}

// The series on the Campaign screen: the last one this device showed, or Numbers.
function selectedCampaignSeriesId(engine) {
    if (!isCampaignSeriesId(engine.campaignSeriesId)) {
        engine.campaignSeriesId = readSelectedCampaignSeriesId();
    }
    return engine.campaignSeriesId;
}

export const campaignEngineMethods = {
    // Shows another series on the Campaign screen. Its stages paint at once from
    // the stage list, and its progress arrives with the next bootstrap.
    selectCampaignSeries(seriesId) {
        if (!isCampaignSeriesId(seriesId) || seriesId === selectedCampaignSeriesId(this)) return;
        this.campaignSeriesId = seriesId;
        writeSelectedCampaignSeriesId(seriesId);
        this.selectedCampaignStageId = null;
        this.lobbyUi?.setCampaignSelectedStage?.(null);
        this._campaignBootstrapRequestId = (this._campaignBootstrapRequestId || 0) + 1;
        this._campaignBootstrapPromise = null;
        this._campaignBootstrapReady = false;
        this.campaignBootstrap = buildProvisionalCampaignBootstrap({
            ...this.campaignBootstrap,
            campaignId: seriesId,
            progress: null,
        });
        this.campaignVerifiedBootstrap = null;
        this.showCampaignLobby({ refresh: true, view: 'stages' });
    },

    applyCampaignLobbyBootstrap(bootstrap, { paint = false } = {}) {
        this.campaignVerifiedBootstrap = bootstrap;
        const displayedBootstrap = buildDisplayedCampaignBootstrap(bootstrap);
        const bootstrapReady = Boolean(
            displayedBootstrap
            && displayedBootstrap.authoritative !== false
            && displayedBootstrap.availability !== 'unavailable'
        );
        this.applyCarUnlockSnapshot?.(displayedBootstrap?.carUnlocks, {
            authoritative: bootstrapReady,
        });
        this.campaignBootstrap = displayedBootstrap;
        this._campaignBootstrapReady = bootstrapReady;
        this.campaignLobbyState = normalizeCampaignLobbyState({
            ...decorateCampaignState(displayedBootstrap),
            view: this.campaignLobbyView ?? 'stages',
        });
        if (
            paint
            && this.activeRaceMode === 'campaign'
            && this.lobbyUi?.getMode?.() === 'campaign'
        ) {
            this.lobbyUi.showCampaign(this.campaignLobbyState);
            if (this._campaignCarouselPaintReady !== false) {
                this.paintCampaignCarousel();
            }
            if (!this.startButtonPending) {
                this.lobbyUi.setCampaignPrimaryLoading?.(!bootstrapReady);
            }
            this.syncOpenCampaignTracks?.();
        }
        return this.campaignLobbyState;
    },

    refreshCampaignVerificationOverlay({ paint = true } = {}) {
        const verifiedBootstrap = this.campaignVerifiedBootstrap;
        if (!verifiedBootstrap) return this.campaignBootstrap || null;
        this.applyCampaignLobbyBootstrap(verifiedBootstrap, { paint });
        return this.campaignBootstrap;
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
            view: this.campaignLobbyView ?? 'stages',
            resolved: Boolean(bootstrapReady),
        });
        this._campaignBootstrapReady = Boolean(bootstrapReady);
        this.lobbyUi.showCampaign(this.campaignLobbyState);
        if (paintCarousel) this.paintCampaignCarousel();
        this.lobbyUi.setCampaignPrimaryLoading?.(!bootstrapReady);
        this.syncOpenCampaignTracks?.();
    },

    async ensureCampaignBootstrap({ forceRefresh = false } = {}) {
        const hasUsableBootstrap = Boolean(
            this._campaignBootstrapReady
            && this.campaignBootstrap
            && this.campaignBootstrap.authoritative !== false
            && this.campaignBootstrap.availability !== 'unavailable'
        );
        if (!forceRefresh && hasUsableBootstrap) {
            return this.campaignBootstrap;
        }
        if (this._campaignBootstrapPromise) {
            return this._campaignBootstrapPromise;
        }

        const requestId = (this._campaignBootstrapRequestId || 0) + 1;
        this._campaignBootstrapRequestId = requestId;
        const promise = getCampaignBootstrap({ seriesId: selectedCampaignSeriesId(this) })
            .then((bootstrap) => {
                if (requestId !== this._campaignBootstrapRequestId) {
                    return this.campaignBootstrap;
                }
                const hasAuthoritativeBootstrap = Boolean(
                    this._campaignBootstrapReady
                    && this.campaignBootstrap
                    && this.campaignBootstrap.authoritative !== false
                    && this.campaignBootstrap.availability !== 'unavailable'
                );
                if (bootstrap?.authoritative === false && hasAuthoritativeBootstrap) {
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

    async prepareInitialCampaignLaunch({
        prepareTrack = true,
        loadPersonalBest = true,
    } = {}) {
        const bootstrap = await this.ensureCampaignBootstrap({ forceRefresh: true });
        if (bootstrap?.authoritative === false || bootstrap?.availability === 'unavailable') {
            throw new Error('Campaign progress is not authoritative.');
        }
        const lobbyState = normalizeCampaignLobbyState(decorateCampaignState(bootstrap));
        const stage = getCampaignStage(getDefaultCampaignLobbyStage(lobbyState)?.id);
        if (!stage?.trackKey || !stage?.raceId) return null;

        this.activeRaceMode = 'campaign';
        this.activeCampaignStage = stage;
        this.selectedCampaignStageId = stage.raceId;
        if (prepareTrack) {
            await this.loadTrack(stage.trackKey, {
                loadPlayerProgress: false,
                preserveDailyChallengeContext: true,
                showStartOverlayOnReset: false,
            });
        }

        const personalBest = loadPersonalBest
            ? await this.loadInitialCampaignPersonalBest(stage)
            : null;
        return { stage, personalBest };
    },

    async loadInitialCampaignPersonalBest(stage = this.activeCampaignStage) {
        if (!stage?.raceId) return null;
        this.campaignPbGhostByRaceId ??= Object.create(null);
        let response = null;
        try {
            response = await getCampaignPbGhost(stage.raceId);
        } catch (error) {
            console.warn('Campaign PB ghost was unavailable during startup:', error);
        }
        const personalBest = response?.ok ? response.body?.personalBest : null;
        this.campaignPbGhostByRaceId[stage.raceId] = personalBest || null;
        if (personalBest) this.applyCampaignPersonalBest(stage, personalBest);
        return personalBest;
    },

    async loadCampaignLobby({ show = true } = {}) {
        if (show) {
            this.showCampaignLobby({ refresh: false });
            await this.ensureCampaignBootstrap({ forceRefresh: true });
            return this.campaignLobbyState;
        }
        await this.ensureCampaignBootstrap({ forceRefresh: true });
        return this.campaignLobbyState;
    },

    // `view` is 'series' (the list of series) or 'stages' (the stages of one series).
    // Entering the Campaign shows the series; a return from a race shows the stages.
    showCampaignLobby({ refresh = true, view = 'stages' } = {}) {
        this.campaignLobbyView = view === 'series' ? 'series' : 'stages';
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
        // A hidden carousel measures zero, so the stages paint only when they show.
        if (this.campaignLobbyView === 'stages') {
            deferLobbyWorkUntilAfterPaint(this, 'campaign', () => {
                this._campaignCarouselPaintReady = true;
                this.paintCampaignCarousel();
            });
        }
        if (refresh) {
            void this.ensureCampaignBootstrap({ forceRefresh: true });
        }
    },

    // A series row on the series screen: show the stages of that series.
    openCampaignSeries(seriesId) {
        if (!isCampaignSeriesId(seriesId)) return;
        if (seriesId !== selectedCampaignSeriesId(this)) {
            this.campaignLobbyView = 'stages';
            this.selectCampaignSeries(seriesId);
            return;
        }
        this.showCampaignLobby({ view: 'stages', refresh: !this._campaignBootstrapReady });
    },

    backToCampaignSeries() {
        this.showCampaignLobby({ view: 'series', refresh: false });
    },

    paintCampaignCarousel() {
        if (!this.campaignCarousel || !isLobbyPaintEligible(this, 'campaign')) return;
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

    syncOpenCampaignTracks() {
        if (!this.dailyChallengeUi?.isCampaignTracksModalOpen?.()) return;
        this.dailyChallengeUi.renderCampaignPlaylist(
            campaignTracksListPayload(this),
            null,
            { selectedStageId: this.selectedCampaignStageId },
        );
    },

    openCampaignTracks() {
        this.dailyChallengeUi?.openCampaignTracksModal?.(
            campaignTracksListPayload(this),
            {
                onChoose: (stage) => this.handleCampaignTracksChoose(stage),
            },
            { selectedStageId: this.selectedCampaignStageId },
        );
    },

    handleCampaignTracksChoose(stage) {
        if (!stage?.id) return;
        if (!stage.unlocked) {
            this.selectedCampaignStageId = stage.id;
            this.campaignCarousel?.selectChallenge?.(stage.id);
            this.lobbyUi?.setCampaignSelectedStage?.(stage);
            return;
        }
        this.activeRaceMode = 'campaign';
        void this.startCampaignStage(stage);
    },

    handleCampaignCarouselSettled(card) {
        const stage = card?.challenge;
        if (!stage?.trackKey || card?.locked) return;
        if (this.status === 'playing' || this.status === 'starting') return;
        if (!this.startOverlay?.isStartOverlayVisible?.()) return;
        this.prewarmDailyPlaylistTracks?.([{ trackKey: stage.trackKey }], {
            requireModal: false,
        });
    },

    async awaitCampaignVerificationSettled(raceId, {
        timeoutMs = CAMPAIGN_UNLOCK_CONFIRMATION_TIMEOUT_MS,
        pollMs = CAMPAIGN_UNLOCK_CONFIRMATION_POLL_MS,
    } = {}) {
        if (!raceId) return true;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const entry = getCampaignVerificationEntry(raceId);
            if (!entry || entry.progressConfirmed) return true;
            if (entry.verificationState !== 'pending') return false;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => { setTimeout(resolve, pollMs); });
        }
    },

    async startCampaignStage(stageLike = null, {
        preserveRaceComparisonTarget = false,
        confirmUnlockFor = null,
    } = {}) {
        if (isVerificationQueueSubmissionBlocked()) {
            this.reportRaceBlockedByTransfer?.('campaign');
            return null;
        }
        if (this.startButtonPending) return;
        this.lobbyUi?.clearRaceStartError?.('campaign');
        if (!preserveRaceComparisonTarget) this.clearRaceComparisonTarget?.();
        this.startButtonPending = true;
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

            if (confirmUnlockFor) {
                const verificationSettled = await this.awaitCampaignVerificationSettled(
                    confirmUnlockFor,
                );
                if (!verificationSettled) {
                    this.lobbyUi?.setRaceStartError?.(
                        'campaign',
                        'Your last run is still being verified. Wait a moment, then try Next again.',
                    );
                    return;
                }
            }

            const raceStartTransition = this.startOverlay?.beginRaceStartTransition?.();
            if (!raceStartTransition) this.startOverlay?.hideStartOverlay?.();

            const startRequest = startServerCampaignRace(stage.raceId).catch((error) => {
                console.warn('Could not stamp the Campaign race start:', error);
                return null;
            });
            this.campaignPbGhostByRaceId ??= Object.create(null);
            const cachedPersonalBest = this.campaignPbGhostByRaceId[stage.raceId];
            const ghostRequest = cachedPersonalBest
                ? null
                : getCampaignPbGhost(stage.raceId).catch((error) => {
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
            if (stage.trackKey !== this.currentTrackKey || !this.trackCanvas) {
                await this.loadTrack(stage.trackKey, {
                    loadPlayerProgress: false,
                    preserveDailyChallengeContext: true,
                    preserveRaceComparisonTarget,
                    showStartOverlayOnReset: false,
                });
            }
            this.applyDailyChallenge(toRaceChallenge(stage));
            this.activeRaceMode = 'campaign';
            if (cachedPersonalBest) this.applyCampaignPersonalBest(stage, cachedPersonalBest);
            void this.journeys?.startAttempt?.({ mode: 'campaign', reason: 'initial_start' });
            await raceStartTransition;
            this.startSequence();

            if (startRequest) void this.confirmCampaignRaceStart(stage, startRequest);
            if (ghostRequest) {
                void ghostRequest.then((response) => {
                    if (!response) return;
                    this.campaignPbGhostByRaceId[stage.raceId] = response.ok
                        ? response.body?.personalBest || null
                        : null;
                    this.applyCampaignPersonalBest(
                        stage,
                        response.ok ? response.body?.personalBest : null,
                    );
                });
            }
        } catch (error) {
            console.error('Could not start Campaign race:', error);
            await this.loadCampaignLobby({ show: true });
            this.lobbyUi?.setRaceStartError?.(
                'campaign',
                'Track failed to load. Tap Retry Start.',
            );
        } finally {
            this.lobbyUi?.setCampaignPrimaryLoading?.(false);
            this.startButtonPending = false;
        }
    },

    async startCampaignStageAgainstOpponent(stage, target) {
        if (!stage || !target) return false;
        const track = await loadClientTrack(stage.trackKey);
        this.clearRaceComparisonTarget?.();
        if (!this.installRaceComparisonTarget?.(
            { ...target, mode: 'campaign' },
            {
                track,
                lapCount: stage.lapCount,
            },
        )) {
            return false;
        }
        await this.startCampaignStage(stage, { preserveRaceComparisonTarget: true });
        if (this.activeCampaignStage?.raceId !== stage.raceId) {
            this.clearRaceComparisonTarget?.();
            return false;
        }
        return this.raceComparisonTarget !== null;
    },

    async confirmCampaignRaceStart(stage, startRequest) {
        const started = await startRequest;
        if (!started) return;
        if (started.ok) {
            if (this.campaignVerifiedBootstrap && started.body?.progress) {
                const startedAt = started.body.progress.startedAt;
                if (
                    typeof startedAt === 'string'
                    && !this.campaignVerifiedBootstrap.progress?.startedAt
                ) {
                    this.campaignVerifiedBootstrap = {
                        ...this.campaignVerifiedBootstrap,
                        progress: {
                            ...(this.campaignVerifiedBootstrap.progress || deriveCampaignProgress(
                                {},
                                null,
                                this.campaignVerifiedBootstrap.campaignId,
                            )),
                            startedAt,
                        },
                    };
                    this.refreshCampaignVerificationOverlay?.({ paint: false });
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
            getLoadedClientTrack(stage.trackKey),
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
        let previousPersonalBestSec = null;
        if (comparison) {
            const cached = Number(this.trackPersonalBestByTrackKey?.[stage.raceId]?.bestTime);
            const storedMs = Number(
                this.campaignBootstrap?.progress?.resultsByRaceId?.[stage.raceId]?.bestTimeMs,
            );
            const prepared = Number(
                this.personalBestPaceBaselineByRaceId?.[stage.raceId]?.finishTimeSec,
            );
            if (cached > 0) previousPersonalBestSec = cached;
            else if (storedMs > 0) previousPersonalBestSec = storedMs / 1000;
            else if (prepared > 0) previousPersonalBestSec = prepared;
        } else if (Number.isFinite(paceBaseline?.finishTimeSec)) {
            previousPersonalBestSec = paceBaseline.finishTimeSec;
        }
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
                previousTrackMedal: previousMedal,
                trackKey: stage.trackKey,
                scoreboardSnapshot,
                scoreboardChallengeId: stage.raceId,
                scoreboardTrackKey: stage.trackKey,
                showGlobalLeaderboard: false,
                allowLeaderboardOpen: true,
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
                restartAction: comparison?.outcome === 'won'
                    ? () => void this.startCampaignStage(stage)
                    : () => this.restartActiveRace(),
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

    async startCampaignNextStage(stage) {
        if (!stage || this.startButtonPending) return;
        const confirmUnlockFor = this.activeCampaignStage?.raceId ?? null;
        this.selectedCampaignStageId = stage.raceId;
        this.reset(false, { showStartOverlay: false });
        this.activeRaceMode = 'campaign';
        await this.startCampaignStage(stage, { confirmUnlockFor });
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
        const previousMedal = getStoredCampaignStageMedal(this.campaignBootstrap, stage.raceId);
        const previousVerifiedBestSec = getCampaignVerificationBestTimeSec(this, stage);
        const isCampaignBest = isNewBestResult(
            this.currentRunPolicy || { bestResultComparator: 'time' },
            { bestTime: finalTime, completedLaps: stage.lapCount },
            Number.isFinite(previousVerifiedBestSec)
                ? { bestTime: previousVerifiedBestSec, completedLaps: stage.lapCount }
                : null,
        );

        const replay = this.scoreboardReplay.getPayload(stage.lapCount);
        const shareRequest = { kind: 'head-to-head', source: 'campaign', raceId: stage.raceId, replay };

        if (!isCampaignBest) {
            this.showCampaignFinish(stage, {
                finalTime,
                medal,
                previousMedal,
                shareRequest,
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

        const blockedReason = this.rankedSubmissionBlockedReason
            || (replay
                ? null
                : this.scoreboardReplay.overflowed
                    ? 'Run too long to rank.'
                    : 'Submission replay was unavailable for this run.');

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

        runAfterPlayerIdentityReady(this, () => {
            const { enqueued } = enqueueCampaignVerification({
                raceId: stage.raceId,
                trackKey: stage.trackKey,
                bestTime: finalTime,
                lapCount: stage.lapCount,
                rulesRevision: stage.rulesRevision,
                replay,
            });

            if (enqueued) this.refreshCampaignVerificationOverlay?.();

            this.showCampaignFinish(stage, {
                finalTime,
                medal,
                previousMedal,
                shareRequest,
                scoreboardSnapshot: enqueued
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
        });
    },

    updateCampaignFinishSnapshot(raceId, snapshot) {
        if (this.modal.matchesModalScoreboardContext?.({ challengeId: raceId })) {
            this.modal.updateModalScoreboardSnapshot?.(snapshot);
        }
    },

    settleCampaignGhostPersistence(raceId, response) {
        const trackPbStatus = response.body?.trackPbPersistenceStatus;
        if (trackPbStatus === 'unavailable') {
            const { exhausted } = markCampaignTrackPbRetry(
                raceId,
                Date.now() + getVerificationRetryDelayMs(),
            );
            return { ghost: exhausted ? 'fetch' : 'skip' };
        }

        clearCampaignVerification(raceId);
        const personalBest = response.body?.trackPersonalBest;
        return (trackPbStatus === 'stored' || trackPbStatus === 'unchanged')
            && personalBest
            && typeof personalBest === 'object'
            ? { ghost: 'install', personalBest }
            : { ghost: 'fetch' };
    },

    retryCampaignGhostRecoveryLater(raceId) {
        return !markCampaignTrackPbRetry(
            raceId,
            Date.now() + getVerificationRetryDelayMs(),
        ).exhausted;
    },

    retryCampaignVerificationLater(entry, statusText = null) {
        markCampaignVerificationPending(
            entry.raceId,
            Date.now() + getVerificationRetryDelayMs(),
            { submissionStage: 'retrying', statusText, preserveUpdatedAt: true },
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
            this.refreshCampaignVerificationOverlay?.();
            this.updateCampaignFinishSnapshot(
                raceId,
                campaignErrorSnapshot(entry.bestTime, error),
            );
            return;
        }

        const inFlight = markCampaignVerificationPending(raceId, Date.now(), {
            submissionStage: 'verifying',
            statusText: entry.progressConfirmed ? entry.statusText : null,
            preserveUpdatedAt: true,
        }) || entry;
        if (!entry.progressConfirmed) {
            this.updateCampaignFinishSnapshot(
                raceId,
                campaignPendingSnapshot(entry.bestTime, 'verifying'),
            );
        }

        let response = null;
        try {
            response = await submitCampaignRun({
                raceId,
                trackKey: stage.trackKey,
                replay: entry.replay,
                submissionOwnerId: entry.ownerPlayerId ?? null,
            });
        } catch (submitError) {
            console.error('Could not confirm Campaign race result:', submitError);
            if (isSupersededCampaignVerificationEntry(inFlight)) return;
            if (entry.progressConfirmed) {
                this.retryCampaignGhostRecoveryLater(raceId);
                return;
            }
            this.retryCampaignVerificationLater(inFlight);
            return;
        }

        if (isSupersededCampaignVerificationEntry(inFlight)) return;

        if (response.status === 409 && response.body?.reason === 'submission_identity_changed') {
            markCampaignVerificationPending(
                raceId,
                Date.now() + getVerificationRetryDelayMs(),
                {
                    submissionStage: entry.progressConfirmed ? 'verifying' : 'pending',
                    statusText: entry.progressConfirmed ? entry.statusText : null,
                    preserveUpdatedAt: true,
                },
            );
            return;
        }

        if (response.ok && response.body?.accepted === true) {
            if (!responseConfirmsCampaignResult(response, entry)) {
                if (entry.progressConfirmed) {
                    this.retryCampaignGhostRecoveryLater(raceId);
                    return;
                }
                this.retryCampaignVerificationLater(
                    inFlight,
                    'Saving Campaign progress...',
                );
                return;
            }
            this.applyCarUnlockSnapshot?.(response.body.carUnlocks);
            const ghostRecovery = this.settleCampaignGhostPersistence(raceId, response);
            // A run in another series than the one on screen does not change this screen.
            const sameSeries = (response.body.progress?.campaignId ?? CAMPAIGN_ID)
                === (this.campaignVerifiedBootstrap?.campaignId ?? CAMPAIGN_ID);
            if (this.campaignVerifiedBootstrap && response.body.progress && sameSeries) {
                this.applyCampaignLobbyBootstrap({
                    ...this.campaignVerifiedBootstrap,
                    progress: response.body.progress,
                    carUnlocks: response.body.carUnlocks ?? this.campaignVerifiedBootstrap.carUnlocks,
                }, { paint: true });
            } else {
                this.refreshCampaignVerificationOverlay?.();
            }
            if (this.modal.matchesModalScoreboardContext?.({ challengeId: raceId })) {
                this.modal.setCombinedNextRaceEnabled?.(
                    getCampaignNextStageTarget(this, stage)?.unlocked === true,
                );
            }
            await this.refreshCampaignAfterAcceptedRun(stage, ghostRecovery);
            void this.resolveLeaderboardOpponentAdvanceAfterVerification?.({
                mode: 'campaign',
                competitionId: raceId,
                benchmarkTimeMs: Math.round(entry.bestTime * 1000),
            });
            return;
        }

        if (entry.progressConfirmed) {
            this.retryCampaignGhostRecoveryLater(raceId);
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
        this.refreshCampaignVerificationOverlay?.();
        if (this.modal.matchesModalScoreboardContext?.({ challengeId: raceId })) {
            this.modal.setCombinedWinMedal?.(null);
            this.modal.setCombinedNextRaceEnabled?.(
                getCampaignNextStageTarget(this, stage)?.unlocked === true,
            );
        }
        this.updateCampaignFinishSnapshot(
            raceId,
            campaignErrorSnapshot(entry.bestTime, error),
        );
    },

    async refreshCampaignAfterAcceptedRun(stage, { ghost = 'fetch', personalBest = null } = {}) {
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

        if (ghost === 'install') {
            this.campaignPbGhostByRaceId ??= Object.create(null);
            this.campaignPbGhostByRaceId[stage.raceId] = personalBest;
            this.applyCampaignPersonalBest(stage, personalBest);
        } else if (ghost !== 'skip') {
            try {
                const ghostResponse = await getCampaignPbGhost(stage.raceId);
                this.applyCampaignPersonalBest(
                    stage,
                    ghostResponse.ok ? ghostResponse.body?.personalBest : null,
                );
            } catch (ghostError) {
                console.warn('Campaign result was saved, but PB ghost refresh failed:', ghostError);
            }
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
