import {
  getDailyChallengeData,
  restoreDailyChallengeBestAfterFailedSubmission,
  saveDailyChallengeBestTime,
  setDailyChallengeBestTime,
} from "./storage.js";
import { normalizeCheckpointTimesSec } from "../shared/checkpoint-times.js";
import { isVerificationQueueSubmissionBlocked } from "../scoreboard/verification-queue.js";
import { normalizePbGhostRecord } from "../ghost/pb-ghost.js";
import { createPersonalBestPaceBaseline, getLapPaceDeltaSec } from "../ghost/pb-pace.js";
import {
  buildLapRecord,
  createModalActions,
  isNewBestResult,
  pushRecentLap,
} from "../race/result-flow.js";
import {
  formatDailyChallengeResultLabel,
  getDailyChallengeCopyLabels,
  getDailyChallengeObjectiveLabel,
  getDailyChallengeRequiredLaps,
} from "./labels.js";
import {
  getActiveDailyChallenge,
  cacheDailyChallengePlaylist,
  DAILY_PLAYLIST_DAYS,
  getCachedDailyChallengePlaylist,
  getDailyChallengeSnapshotIdsToFetch,
  getCachedDailyChallengeSnapshot,
  getDailyChallengePlaylist,
  getDailyChallengeSnapshot,
  getDailyChallengeTrackName,
  isDailyChallengeStoredResultForChallenge,
  prefetchDailyChallengeSnapshots,
} from "./service.js";
import { buildDailyCarouselCards } from "./carousel-model.js";
import { createVerificationSnapshot, getDailyChallengeVerificationEntry, getVerificationSnapshotFromQueueEntry } from "../scoreboard/verification-queue.js";
import { runAfterPlayerIdentityReady } from "../player/identity-recovery.js";
import { getMedalForRaceTime } from "../medals/medal-timing.js";
import {
  readTrackLastLapMedal,
  writeTrackLastLapMedal,
} from "../medals/last-lap-medal-storage.js";
import { getTrackCanvasAsset } from "../track/assets.js";
import { DEFAULT_TRACK_KEY } from "../track/catalog.js";
import { getLoadedClientTrack, loadClientTrack } from "../track/client-registry.js";
import {
  createDailyChallengePresentationEvent,
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "../track/presentation.js";
import { isLobbyPaintEligible } from "../lobby/deferred-work.js";
import {
  bumpPbGhostPrepareGeneration,
  claimPbGhostSelection,
  getPbGhostSelectionChallengeId,
  getPendingPbGhostCandidates,
  getTrackPersonalBestForChallenge,
  normalizeTrackPersonalBest,
} from "../challenge-run/engine-methods.js";

function isDailyChallengeStillPlayable(challenge) {
  if (!challenge || typeof challenge !== "object") return false;
  const availableUntilMs = Date.parse(challenge.availableUntil || "");
  if (!Number.isFinite(availableUntilMs)) return true;
  return Date.now() < availableUntilMs;
}

function isValidCanonicalTrackPersonalBest(record, trackKey) {
  if (!record || typeof record !== "object") return false;
  if (record.trackKey !== trackKey) return false;
  if (!Number.isFinite(Number(record.bestTimeMs)) || Number(record.bestTimeMs) <= 0) {
    return false;
  }
  if (record.checkpointTimesSec !== null && !Array.isArray(record.checkpointTimesSec)) {
    return false;
  }
  if (
    record.lapCompletionTimesSec !== undefined
    && record.lapCompletionTimesSec !== null
    && !Array.isArray(record.lapCompletionTimesSec)
  ) {
    return false;
  }
  if (typeof record.updatedAt !== "string" || !record.updatedAt) return false;
  return record.ghost === null || normalizePbGhostRecord(record) !== null;
}

function resolveJourneyStartReason({ replacesCurrentRun = false } = {}) {
  if (replacesCurrentRun) return "track_switch";
  return "initial_start";
}

function isCurrentPbGhostPreparation(
  engine,
  challengeId,
  prepareGeneration,
  selectionGeneration,
) {
  return (
    engine.pbGhostPrepareGenerationByChallengeId?.[challengeId] === prepareGeneration
    && getPbGhostSelectionChallengeId(engine) === challengeId
    && (engine.pbGhostSelectionGeneration || 0) === selectionGeneration
  );
}

function applyTrackPersonalBest(engine, challenge, record, { prepareGhost = false } = {}) {
  if (!challenge?.trackKey) return null;
  const personalBest = normalizeTrackPersonalBest(record, challenge.trackKey, challenge.id);
  if (!engine.trackPersonalBestByTrackKey) {
    engine.trackPersonalBestByTrackKey = Object.create(null);
  }
  if (personalBest) {
    engine.trackPersonalBestByTrackKey[challenge.id] = personalBest;
  } else {
    delete engine.trackPersonalBestByTrackKey[challenge.id];
  }
  if (!engine.personalBestPaceBaselineByRaceId) {
    engine.personalBestPaceBaselineByRaceId = Object.create(null);
  }
  const paceBaseline = personalBest
    ? createPersonalBestPaceBaseline({
        ...record,
        bestTimeMs: Math.round(personalBest.bestTime * 1000),
        checkpointTimesSec: personalBest.checkpointTimesSec,
        lapCompletionTimesSec: personalBest.lapCompletionTimesSec,
      }, getLoadedClientTrack(challenge.trackKey), getDailyChallengeRequiredLaps(challenge))
    : null;
  if (paceBaseline) {
    engine.personalBestPaceBaselineByRaceId[challenge.id] = paceBaseline;
  } else {
    delete engine.personalBestPaceBaselineByRaceId[challenge.id];
  }

  const selectedChallengeId = engine.activeDailyChallenge?.id
    || engine.currentDailyChallenge?.id
    || null;
  if (selectedChallengeId === challenge.id) {
    engine.trackPersonalBestResult = personalBest;
    engine.bestLapTime = personalBest?.bestTime ?? null;
    if (challenge.trackKey && Number.isFinite(personalBest?.bestTime)) {
      if (!engine.sessionBestLapSecByTrackKey) {
        engine.sessionBestLapSecByTrackKey = Object.create(null);
      }
      engine.sessionBestLapSecByTrackKey[challenge.id] = personalBest.bestTime;
      if (Array.isArray(personalBest.checkpointTimesSec)) {
        if (!engine.sessionBestCheckpointTimesByTrackKey) {
          engine.sessionBestCheckpointTimesByTrackKey = Object.create(null);
        }
        engine.sessionBestCheckpointTimesByTrackKey[challenge.id] =
          personalBest.checkpointTimesSec.slice();
      }
    }
  }

  if (prepareGhost && !engine.raceComparisonTarget) {
    if (personalBest?.ghostAvailable) engine.pbGhost?.prepare?.(record);
    else engine.pbGhost?.clearTrack?.();
  }
  return personalBest;
}

function decorateChallengesWithTrackPersonalBests(engine, challenges = []) {
  return (Array.isArray(challenges) ? challenges : []).map((challenge) => ({
    ...challenge,
    trackPersonalBest: getTrackPersonalBestForChallenge(engine, challenge),
  }));
}

function getInvalidDailyChallengeWinReason(engine, winData) {
  if (!winData || typeof winData !== "object") return "Finish data missing.";
  if (engine.status !== "won") return "Run did not end in a winning state.";
  if (winData.trackKey !== engine.currentTrackKey) return "Finish track did not match the active track.";
  if (
    engine.activeDailyChallenge?.trackKey &&
    winData.trackKey !== engine.activeDailyChallenge.trackKey
  ) {
    return "Finish track did not match the active challenge.";
  }
  if (
    engine.currentChallengeRun?.challengeId &&
    engine.activeDailyChallenge?.id &&
    engine.currentChallengeRun.challengeId !== engine.activeDailyChallenge.id
  ) {
    return "Challenge context changed before the finish was confirmed.";
  }
  if (
    engine.currentChallengeRun?.trackKey &&
    winData.trackKey !== engine.currentChallengeRun.trackKey
  ) {
    return "Run track context changed before the finish was confirmed.";
  }
  if (winData.runId !== engine.activeRunId) return "Run confirmation arrived for the wrong attempt.";

  const checkpointCount = engine.currentTrack?.checkpoints?.length || 0;
  if (winData.checkpointCount !== checkpointCount) return "Checkpoint count did not match the loaded track.";
  if (winData.completedCheckpointCount < checkpointCount) {
    return "The lap finished before every checkpoint was confirmed.";
  }
  if (!Number.isFinite(winData.lapTime) || winData.lapTime < 2.0) {
    return "Lap time was too short to rank.";
  }
  const requiredLaps = getDailyChallengeRequiredLaps(engine.activeDailyChallenge);
  if (Math.trunc(Number(winData.completedLaps)) !== requiredLaps) {
    return "The race ended before every required lap was confirmed.";
  }

  return null;
}

export const dailyChallengeEngineMethods = {
  async refreshTrackPersonalBestSummaries(challenges = []) {
    const playableChallenges = Array.isArray(challenges)
      ? challenges.filter((challenge) => challenge?.id && challenge?.trackKey)
      : [];
    if (!playableChallenges.length) return {};

    const summaries = await this.pbGhostService.getSummaries(
      playableChallenges.map((challenge) => challenge.id),
    );
    for (const challenge of playableChallenges) {
      applyTrackPersonalBest(this, challenge, summaries?.[challenge.id] ?? null);
    }
    return summaries;
  },

  async prepareTrackPersonalBestGhost(challenge, { forceRefresh = false } = {}) {
    if (!challenge?.id || !challenge?.trackKey) {
      this.pbGhost?.clearTrack?.();
      this.preparedPbGhostChallengeId = null;
      return null;
    }
    const selectionGeneration = this.pbGhostSelectionChallengeId == null
      && getPbGhostSelectionChallengeId(this) === challenge.id
      ? claimPbGhostSelection(this, challenge.id)
      : (this.pbGhostSelectionGeneration || 0);
    const prepareGeneration = bumpPbGhostPrepareGeneration(this, challenge.id);
    const record = await this.pbGhostService.getForChallenge(challenge.id, {
      forceRefresh,
    });
    if (
      !isCurrentPbGhostPreparation(
        this,
        challenge.id,
        prepareGeneration,
        selectionGeneration,
      )
    ) {
      return null;
    }
    const personalBest = applyTrackPersonalBest(this, challenge, record, { prepareGhost: true });
    if (!this.raceComparisonTarget) {
      this.preparedPbGhostChallengeId = challenge.id;
    }
    return personalBest;
  },

  markTrackPersonalBestGhostPending(challenge) {
    if (!challenge?.id) return false;
    getPendingPbGhostCandidates(this).add(challenge.id);
    bumpPbGhostPrepareGeneration(this, challenge.id);
    this.pbGhostService?.invalidate?.(challenge.id);
    if (!this.previousPreparedPbGhostByChallengeId) {
      this.previousPreparedPbGhostByChallengeId = Object.create(null);
    }
    this.previousPreparedPbGhostByChallengeId[challenge.id] =
      this.pbGhost?.preparedRecord ?? null;
    return true;
  },

  resolveTrackPersonalBestGhostPending(challengeId) {
    if (!challengeId) return false;
    return getPendingPbGhostCandidates(this).delete(challengeId);
  },

  markTrackPersonalBestGhostUnavailable(challenge) {
    if (!challenge?.id) return false;
    bumpPbGhostPrepareGeneration(this, challenge.id);
    this.pbGhostService?.invalidate?.(challenge.id);
    this.resolveTrackPersonalBestGhostPending(challenge.id);
    if (!this.unavailablePbGhostChallengeIds) {
      this.unavailablePbGhostChallengeIds = new Set();
    }
    this.unavailablePbGhostChallengeIds.add(challenge.id);
    if (this.previousPreparedPbGhostByChallengeId) {
      delete this.previousPreparedPbGhostByChallengeId[challenge.id];
    }
    if (getPbGhostSelectionChallengeId(this) === challenge.id) {
      this.pbGhost?.clearPrepared?.();
      this.preparedPbGhostChallengeId = null;
    }
    return true;
  },

  restorePreviousTrackPersonalBestGhost(challenge) {
    if (!challenge?.id) return false;
    const previous = this.previousPreparedPbGhostByChallengeId?.[challenge.id] ?? null;
    this.resolveTrackPersonalBestGhostPending(challenge.id);
    if (this.previousPreparedPbGhostByChallengeId) {
      delete this.previousPreparedPbGhostByChallengeId[challenge.id];
    }
    this.unavailablePbGhostChallengeIds?.delete(challenge.id);
    if (getPbGhostSelectionChallengeId(this) !== challenge.id) return false;
    if (previous && this.pbGhost?.prepare?.(previous)) {
      this.preparedPbGhostChallengeId = challenge.id;
      return true;
    }
    this.pbGhost?.clearPrepared?.();
    this.preparedPbGhostChallengeId = null;
    return false;
  },

  installCanonicalTrackPersonalBestGhost(challenge, record) {
    if (!challenge?.id || !challenge?.trackKey || !record) return null;
    const ownsSelection = getPbGhostSelectionChallengeId(this) === challenge.id;
    if (!isValidCanonicalTrackPersonalBest(record, challenge.trackKey)) {
      bumpPbGhostPrepareGeneration(this, challenge.id);
      this.resolveTrackPersonalBestGhostPending(challenge.id);
      if (this.previousPreparedPbGhostByChallengeId) {
        delete this.previousPreparedPbGhostByChallengeId[challenge.id];
      }
      if (!this.unavailablePbGhostChallengeIds) {
        this.unavailablePbGhostChallengeIds = new Set();
      }
      this.unavailablePbGhostChallengeIds.add(challenge.id);
      if (ownsSelection) {
        this.pbGhost?.clearPrepared?.();
        this.preparedPbGhostChallengeId = null;
      }
      return null;
    }
    this.pbGhostService?.installForChallenge?.(challenge.id, record);
    this.unavailablePbGhostChallengeIds?.delete(challenge.id);
    bumpPbGhostPrepareGeneration(this, challenge.id);
    this.resolveTrackPersonalBestGhostPending(challenge.id);
    if (this.previousPreparedPbGhostByChallengeId) {
      delete this.previousPreparedPbGhostByChallengeId[challenge.id];
    }
    const personalBest = applyTrackPersonalBest(this, challenge, record, {
      prepareGhost: ownsSelection,
    });
    if (ownsSelection && !this.raceComparisonTarget) {
      this.preparedPbGhostChallengeId = challenge.id;
    }
    return personalBest;
  },

  beginPersonalBestGhostRunAtGo() {
    const challenge = this.activeDailyChallenge;
    const ghostActive = this.pbGhost?.beginRun?.() === true;
    this.activePersonalBestPaceBaseline = this.raceComparisonTarget
      ? null
      : (this.personalBestPaceBaselineByRaceId?.[challenge?.id] ?? null);
    const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    const ghostExpected = this.pbGhost?.enabled === true
      && Number.isFinite(trackPersonalBest?.bestTime);
    const noticeNeeded = ghostExpected
      && !ghostActive
      && typeof this.hud?.showGhostUnavailableNotice === 'function';
    return { ghostActive, ghostExpected, noticeNeeded };
  },

  async loadInitialPersonalBestGhostAsset() {
    const [, challenge] = await Promise.all([
      this.playerHistoryPromise,
      this.dailyChallengePromise,
    ]);
    if (!challenge) return null;

    try {
      return await this.prepareTrackPersonalBestGhost(challenge);
    } catch (error) {
      console.error("Error loading initial personal best ghost:", error);
      return null;
    }
  },

  applyVerifiedTrackPersonalBest(challenge, record) {
    const personalBest = applyTrackPersonalBest(this, challenge, record);
    if (
      personalBest
      && (this.activeDailyChallenge?.id || this.currentDailyChallenge?.id) === challenge?.id
    ) {
      this.syncTrackMedalFromChallengeBest(challenge, personalBest.bestTime);
      this.hud?.setBestTime?.(personalBest.bestTime, {
        persistToTrackCard: false,
      });
    }
    return personalBest;
  },

  waitForTrackPrewarmIdle() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(resolve, { timeout: 500 });
        return;
      }
      setTimeout(resolve, 32);
    });
  },

  scheduleDailyPlaylistPrewarm(challenges = []) {
    const modal = this.dailyChallengeUi?.dailyChallengePlaylistModal;
    if (!modal) {
      this.prewarmDailyPlaylistTracks(challenges);
      return;
    }

    let finished = false;
    const startPrewarm = () => {
      if (finished) return;
      finished = true;
      modal.removeEventListener("transitionend", onTransitionEnd);
      this.prewarmDailyPlaylistTracks(challenges);
    };
    const onTransitionEnd = (event) => {
      if (event.target !== modal || event.propertyName !== "opacity") return;
      startPrewarm();
    };

    modal.addEventListener("transitionend", onTransitionEnd);
    setTimeout(startPrewarm, 200);
  },

  prewarmDailyPlaylistTracks(challenges = [], { requireModal = true } = {}) {
    const prewarmId = (this._dailyPlaylistTrackPrewarmId || 0) + 1;
    this._dailyPlaylistTrackPrewarmId = prewarmId;
    const queue = (Array.isArray(challenges) ? challenges : [])
      .filter((challenge) => challenge?.trackKey);
    const isSurfaceOpen = () => (
      !requireModal || this.dailyChallengeUi.isPlaylistModalOpen?.()
    );

    const prewarmNext = async () => {
      if (this._dailyPlaylistTrackPrewarmId !== prewarmId) return;
      if (!isSurfaceOpen()) return;
      if (this.status === "playing" || this.status === "starting") return;
      const challenge = queue.shift();
      if (!challenge) return;

      await this.waitForTrackPrewarmIdle();
      if (this._dailyPlaylistTrackPrewarmId !== prewarmId) return;
      if (!isSurfaceOpen()) return;
      if (this.status === "playing" || this.status === "starting") return;

      const track = await loadClientTrack(challenge.trackKey);
      if (!track) return;
      const presentation = resolveTrackPresentation(challenge.trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.RACE,
        event: createDailyChallengePresentationEvent(challenge),
      });
      getTrackCanvasAsset(challenge.trackKey, track, {
        qualityLevel: this.qualityLevel,
        frameSkip: this.frameSkip,
        presentation,
      });
      void prewarmNext();
    };

    void prewarmNext();
  },

  syncTrackMedalFromChallengeBest(challenge, bestTime) {
    if (
      !challenge?.trackKey ||
      !Number.isFinite(bestTime)
    ) {
      return null;
    }

    const medal = getMedalForRaceTime(
      challenge.trackKey,
      Number(bestTime),
      getDailyChallengeRequiredLaps(challenge),
    );
    writeTrackLastLapMedal(challenge.trackKey, medal);
    return medal;
  },

  async syncReadyBackgroundTrack(challenge = this.activeDailyChallenge) {
    const targetTrackKey =
      typeof challenge?.trackKey === "string" && challenge.trackKey
        ? challenge.trackKey
        : DEFAULT_TRACK_KEY;

    if (
      this.status !== "ready"
      || this.activeRaceMode === "challenge"
      || !targetTrackKey
    ) {
      return;
    }

    if (this.currentTrackKey === targetTrackKey && this.trackCanvas) {
      await this.refreshTrackPresentation();
      return;
    }

    await this.loadTrack(targetTrackKey, { loadPlayerProgress: false });
  },

  syncChallengeHudPrimaryStats() {
    const copyLabels = getDailyChallengeCopyLabels(this.activeDailyChallenge);
    this.hud.setHudPrimaryMetric({
      label: copyLabels.hudPrimaryLabel,
      useTimer: true,
      visible: true,
    });
    const comparisonTarget = this.raceComparisonTarget;
    if (comparisonTarget) {
      this.hud.setComparisonTarget?.(comparisonTarget);
    } else {
      this.hud.setBestTime(this.bestLapTime, { persistToTrackCard: false });
    }
  },

  getDailyChallengeProgressText() {
    if (!this.currentChallengeRun) return "";

    const requiredLaps = this.currentChallengeRun.requiredLaps || 1;
    if (requiredLaps > 1) {
      return `${Math.min(this.currentChallengeRun.completedLaps + 1, requiredLaps)} / ${requiredLaps}`;
    }
    return "1 / 1";
  },

  updateDailyChallengeHud() {
    if (!this.currentChallengeRun) {
      this.dailyChallengeUi.setDailyChallengeHud(null);
      return;
    }

    this.syncChallengeHudPrimaryStats();
    this.dailyChallengeUi.setDailyChallengeHud({
      visible: true,
      progressText: this.getDailyChallengeProgressText(),
    });
  },

  setDailyChallengeLobbySummary(challenge) {
    if (!challenge) {
      this.dailyChallengeUi.setDailyChallengeSummary(null);
      return;
    }

    const storedLocalData = getDailyChallengeData(challenge.id);
    const localData = isDailyChallengeStoredResultForChallenge(challenge, storedLocalData)
      ? storedLocalData
      : null;
    this.dailyChallengeBestResult = localData ? { ...localData } : null;
    const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    this.trackPersonalBestResult = trackPersonalBest;
    this.bestLapTime = Number.isFinite(trackPersonalBest?.bestTime)
      ? trackPersonalBest.bestTime
      : null;
    this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);

    this.dailyChallengeUi.setDailyChallengeSummary({
      available: true,
      challengeId: challenge.id,
      title: getDailyChallengeTrackName(challenge),
      trackKey: challenge.trackKey,
      skin: challenge.skin,
      trackName: getDailyChallengeTrackName(challenge),
      bestTime: this.bestLapTime,
      bestLabel: formatDailyChallengeResultLabel(trackPersonalBest),
      rankLabel: "--",
      scoreboardSnapshot: null,
      usesTrackPersonalBest: true,
      objectiveType: challenge.objectiveType,
      startsAt: challenge.startsAt,
      challengeDate: challenge.challengeDate,
      endsAt: challenge.endsAt,
    });
  },

  async loadDailyChallengeCritical({
    prepareTrack = true,
    loadPersonalBest = true,
    throwOnError = false,
  } = {}) {
    try {
      const pending = this.initialDailyChallengeRequestPromise ?? getActiveDailyChallenge();
      this.initialDailyChallengeRequestPromise = pending;
      let challenge;
      try {
        challenge = await pending;
      } finally {
        if (this.initialDailyChallengeRequestPromise === pending) {
          this.initialDailyChallengeRequestPromise = null;
        }
      }
      this.currentDailyChallenge = challenge || null;
      this.activeDailyChallenge = null;
      this.setDailyChallengeLobbySummary(challenge);
      if (challenge && loadPersonalBest) {
        try {
          await this.refreshTrackPersonalBestSummaries([challenge]);
          this.setDailyChallengeLobbySummary(challenge);
        } catch (error) {
          console.error("Error loading track personal best:", error);
        }
      }
      if (prepareTrack) await this.syncReadyBackgroundTrack(challenge);
      return challenge;
    } catch (error) {
      console.error("Error loading daily challenge:", error);
      this.currentDailyChallenge = null;
      this.activeDailyChallenge = null;
      if (prepareTrack) await this.syncReadyBackgroundTrack(null);
      this.dailyChallengeUi.setDailyChallengeSummary(null);
      if (throwOnError) throw error;
      return null;
    }
  },

  async refreshDailyChallengeSummary({ forceRefresh = false } = {}) {
    const challenge = this.currentDailyChallenge || this.activeDailyChallenge;
    if (!challenge) {
      this.dailyChallengeUi.setDailyChallengeSummary(null);
      return null;
    }

    const storedLocalData = getDailyChallengeData(challenge.id);
    let localData = isDailyChallengeStoredResultForChallenge(challenge, storedLocalData)
      ? storedLocalData
      : null;
    this.dailyChallengeBestResult = localData ? { ...localData } : null;
    let trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    this.trackPersonalBestResult = trackPersonalBest;
    this.bestLapTime = trackPersonalBest?.bestTime ?? null;
    let snapshot = null;
    const [snapshotResult, trackPbResult] = await Promise.allSettled([
      getDailyChallengeSnapshot({
        challengeId: challenge.id,
        forceRefresh,
      }),
      this.refreshTrackPersonalBestSummaries([challenge]),
    ]);
    if (snapshotResult.status === "fulfilled") {
      snapshot = snapshotResult.value;
    } else {
      console.error("Error loading daily challenge snapshot:", snapshotResult.reason);
    }
    if (trackPbResult.status === "fulfilled") {
      trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    } else {
      console.error("Error loading track personal best:", trackPbResult.reason);
    }

    if (
      snapshot?.currentPlayerRow &&
      Number.isFinite(snapshot.currentPlayerRow.bestTime)
    ) {
      localData = setDailyChallengeBestTime(
        challenge,
        snapshot.currentPlayerRow.bestTime,
        Number.isFinite(snapshot.currentPlayerRow.completedLaps)
          ? snapshot.currentPlayerRow.completedLaps
          : null,
        snapshot.currentPlayerRow.checkpointTimesSec,
      ) || localData;
      this.dailyChallengeBestResult = localData ? { ...localData } : null;
    }

    this.trackPersonalBestResult = trackPersonalBest;
    this.bestLapTime = Number.isFinite(trackPersonalBest?.bestTime)
      ? trackPersonalBest.bestTime
      : null;
    this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);
    const bestTime = this.bestLapTime;
    const rankLabel = snapshot?.playerRankLabel || "--";
    this.dailyChallengeUi.setDailyChallengeSummary({
      available: true,
      challengeId: challenge.id,
      title: getDailyChallengeTrackName(challenge),
      trackKey: challenge.trackKey,
      skin: challenge.skin,
      trackName: getDailyChallengeTrackName(challenge),
      bestTime,
      bestLabel: formatDailyChallengeResultLabel(trackPersonalBest),
      rankLabel,
      scoreboardSnapshot: snapshot,
      usesTrackPersonalBest: true,
      objectiveType: challenge.objectiveType,
      endsAt: challenge.endsAt,
    });
    return snapshot;
  },

  createDailyChallengeRun(challenge) {
    return {
      challengeId: challenge.id,
      trackKey: challenge.trackKey,
      objectiveType: challenge.objectiveType,
      rulesRevision: Number.isInteger(challenge.rulesRevision) ? challenge.rulesRevision : 0,
      requiredLaps: getDailyChallengeRequiredLaps(challenge),
      completedLaps: 0,
      lastLapAt: 0,
      bestLap: null,
      bestLapSecBeforeLastLap: null,
      recentLaps: [],
    };
  },

  applyDailyChallenge(challenge) {
    this.activeDailyChallenge = challenge;
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.currentChallengeRun = this.createDailyChallengeRun(challenge);
    this.syncCurrentRunPolicy();
    this.setRuntimeConfig(null);

    const storedDailyRaw = getDailyChallengeData(challenge.id);
    const storedDaily = isDailyChallengeStoredResultForChallenge(challenge, storedDailyRaw)
      ? storedDailyRaw
      : null;
    this.dailyChallengeBestResult = storedDaily ? { ...storedDaily } : null;
    const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    this.trackPersonalBestResult = trackPersonalBest;
    this.bestLapTime = Number.isFinite(trackPersonalBest?.bestTime)
      ? trackPersonalBest.bestTime
      : null;
    this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);
    const tk = challenge.id;
    if (tk && Number.isFinite(trackPersonalBest?.bestTime)) {
      const storedSec = Number(trackPersonalBest.bestTime);
      const cur = this.sessionBestLapSecByTrackKey?.[tk];
      if (!Number.isFinite(cur) || storedSec < cur) {
        this.sessionBestLapSecByTrackKey[tk] = storedSec;
      }
      const storedCheckpoints = normalizeCheckpointTimesSec(
        storedSec,
        trackPersonalBest.checkpointTimesSec,
      );
      if (storedCheckpoints) {
        if (!this.sessionBestCheckpointTimesByTrackKey) {
          this.sessionBestCheckpointTimesByTrackKey = Object.create(null);
        }
        this.sessionBestCheckpointTimesByTrackKey[tk] = storedCheckpoints.slice();
      }
    }
    this.hud.setPauseVisible(false);
    this.syncChallengeHudPrimaryStats();
    this.updateDailyChallengeHud();
  },

  clearDailyChallengeRun() {
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.currentChallengeRun = null;
    this.activeDailyChallenge = null;
    this.dailyChallengeBestResult = null;
    this.trackPersonalBestResult = null;
    this.activePersonalBestPaceBaseline = null;
    this.pbGhost?.clearTrack?.();
    this.preparedPbGhostChallengeId = null;
    claimPbGhostSelection(this, null);
    this.syncCurrentRunPolicy();
    this.setRuntimeConfig(null);
    this.hud.setHudPrimaryMetric({
      label: "LAP",
      useTimer: true,
      visible: true,
    });
    this.hud.setHudBestMetric({ visible: false });
    this.updateDailyChallengeHud();
    const lobbyChallenge = isDailyChallengeStillPlayable(this.lastPlayedDailyChallenge)
      ? this.lastPlayedDailyChallenge
      : this.currentDailyChallenge;
    if (lobbyChallenge && typeof this.setDailyChallengeLobbySummary === "function") {
      this.setDailyChallengeLobbySummary(lobbyChallenge);
    }
  },

  async handleStartDailyChallenge(challengeOverride = null, options = {}) {
    if (isVerificationQueueSubmissionBlocked()) {
        this.reportRaceBlockedByTransfer?.('daily');
        return null;
    }
    this.lobbyUi?.clearRaceStartError?.("daily");
    if (!options.preserveRaceComparisonTarget) {
      this.clearRaceComparisonTarget?.();
    }
    const sessionChallenge = isDailyChallengeStillPlayable(this.lastPlayedDailyChallenge)
      ? this.lastPlayedDailyChallenge
      : null;
    const challenge = challengeOverride
      || sessionChallenge
      || this.currentDailyChallenge
      || this.activeDailyChallenge;
    const replacesCurrentRun = Boolean(challengeOverride) && this.status !== "ready";
    if (
      (this.status !== "ready" && !replacesCurrentRun) ||
      this.startButtonPending ||
      !challenge
    ) {
      return;
    }

    const availableUntilMs = Date.parse(challenge.availableUntil || "");
    if (Number.isFinite(availableUntilMs) && Date.now() >= availableUntilMs) {
      const refreshed = await this.loadDailyChallengeCritical();
      const refreshedUntil = Date.parse(refreshed?.availableUntil || "");
      const refreshedPlayable = refreshed
        && (!Number.isFinite(refreshedUntil) || Date.now() < refreshedUntil);
      if (refreshedPlayable && refreshed.id !== challenge.id) {
        return this.handleStartDailyChallenge(refreshed, options);
      }
      return;
    }

    const raceStartTransition = this.startOverlay?.beginRaceStartTransition?.();
    if (!raceStartTransition) this.startOverlay?.hideStartOverlay?.();
    claimPbGhostSelection(this, challenge.id);
    this.startButtonPending = true;
    const replaceActiveJourney = replacesCurrentRun
      && challenge.trackKey !== this.currentTrackKey;
    try {
      if (replacesCurrentRun && challenge.trackKey === this.currentTrackKey) {
        this.reset(false, {
          ...(options.preserveRaceComparisonTarget === true
            ? { preserveRaceComparisonTarget: true }
            : {}),
          showStartOverlay: false,
        });
      }
      this.lastPlayedDailyChallenge = challenge;
      this.selectedDailyChallengeId = challenge.id;
      this.activeDailyChallenge = challenge;
      if (
        challenge.trackKey
        && (challenge.trackKey !== this.currentTrackKey || !this.trackCanvas)
      ) {
        await this.loadTrack(challenge.trackKey, {
          loadPlayerProgress: false,
          preserveDailyChallengeContext: true,
          preserveRaceComparisonTarget: options.preserveRaceComparisonTarget === true,
          showStartOverlayOnReset: false,
        });
      }

      if (!this.raceComparisonTarget) {
        const hasPreparedGhostAsset =
          this.preparedPbGhostChallengeId === challenge.id;
        const hasPendingGhostCandidate =
          getPendingPbGhostCandidates(this).has(challenge.id);
        const hasUnavailableGhost =
          this.unavailablePbGhostChallengeIds?.has(challenge.id) === true;
        if (
          !hasPreparedGhostAsset
          && !hasPendingGhostCandidate
          && !hasUnavailableGhost
          && typeof this.prepareTrackPersonalBestGhost === "function"
        ) {
          this.pbGhost?.clearTrack?.();
          this.preparedPbGhostChallengeId = null;
          void this.prepareTrackPersonalBestGhost(challenge).catch((error) => {
            console.error("Error loading personal best ghost:", error);
          });
        } else if (hasPendingGhostCandidate || hasUnavailableGhost) {
          this.pbGhost?.clearPrepared?.();
          this.preparedPbGhostChallengeId = null;
        }
      }
      this.activeRaceMode = "daily";
      this.activeCampaignStage = null;
      this.activeHeadToHead = null;
      this.applyDailyChallenge(challenge);
      void this.journeys?.startAttempt?.({
        mode: "daily",
        reason: resolveJourneyStartReason({ replacesCurrentRun }),
        replaceActive: replaceActiveJourney,
      });
      await raceStartTransition;
      this.startSequence();
    } catch (error) {
      console.error("Could not start Daily race:", error);
      this.activeDailyChallenge = null;
      this.showDailyLobby?.({ selectChallengeId: challenge.id });
      this.lobbyUi?.setRaceStartError?.(
        "daily",
        "Track failed to load. Tap Retry Start.",
      );
    } finally {
      this.startButtonPending = false;
    }
  },

  async openDailyChallengePlaylist() {
    let loadedChallenges = [];
    let playlistRequestNeeded = false;
    const playlistActions = {
      onPlay: (challenge) => {
        void this.handleStartDailyChallenge(challenge);
      },
    };

    if (this.currentDailyChallenge) {
      loadedChallenges = cacheDailyChallengePlaylist([this.currentDailyChallenge]);
    } else {
      loadedChallenges = getCachedDailyChallengePlaylist();
    }
    loadedChallenges = decorateChallengesWithTrackPersonalBests(this, loadedChallenges);
    playlistRequestNeeded = loadedChallenges.length < 7;
    this.dailyChallengeUi.openPlaylistModal(
      loadedChallenges.length ? loadedChallenges : null,
      playlistActions,
    );
    if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
    this.scheduleDailyPlaylistPrewarm(loadedChallenges);

    if (playlistRequestNeeded) {
      try {
        loadedChallenges = await getDailyChallengePlaylist();
        if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
        loadedChallenges = decorateChallengesWithTrackPersonalBests(this, loadedChallenges);
        this.dailyChallengeUi.renderPlaylist(loadedChallenges, playlistActions);
        this.scheduleDailyPlaylistPrewarm(loadedChallenges);
      } catch (error) {
        console.error("Error loading daily challenge playlist:", error);
        if (!loadedChallenges.length && this.dailyChallengeUi.isPlaylistModalOpen?.()) {
          this.dailyChallengeUi.openPlaylistModal([], null);
        }
        return;
      }
    }

    try {
      await this.refreshTrackPersonalBestSummaries(loadedChallenges);
      loadedChallenges = decorateChallengesWithTrackPersonalBests(this, loadedChallenges);
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      this.dailyChallengeUi.renderPlaylist(loadedChallenges, playlistActions);
    } catch (error) {
      console.error("Error loading playlist personal bests:", error);
    }

    const snapshotIdsToFetch = getDailyChallengeSnapshotIdsToFetch(
      loadedChallenges.map((challenge) => challenge?.id).filter(Boolean),
    );
    for (const challengeId of snapshotIdsToFetch) {
      try {
        await getDailyChallengeSnapshot({ challengeId });
      } catch (error) {
        console.error("Error loading daily challenge snapshot:", error);
      }
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      this.dailyChallengeUi.renderPlaylist(loadedChallenges, playlistActions);
    }
  },

  async refreshDailyCarousel({ selectChallengeId = null } = {}) {
    const carousel = this.dailyCarousel;
    if (!carousel) return;

    const token = (this._dailyCarouselRenderToken || 0) + 1;
    this._dailyCarouselRenderToken = token;
    const isStale = () => this._dailyCarouselRenderToken !== token;
    const preferredId = selectChallengeId
      || this.selectedDailyChallengeId
      || this.currentDailyChallenge?.id
      || null;

    let challenges = this.dailyCarouselChallenges();
    this.paintDailyCarousel(challenges, {
      selectedChallengeId: preferredId,
      loading: true,
    });

    if (challenges.length < DAILY_PLAYLIST_DAYS) {
      try {
        const fetched = await getDailyChallengePlaylist();
        if (isStale()) return;
        if (fetched.length) {
          challenges = getCachedDailyChallengePlaylist();
          this.paintDailyCarousel(challenges, { selectedChallengeId: preferredId });
        }
      } catch (error) {
        console.error("Error loading daily challenge playlist:", error);
      }
      if (isStale()) return;
    }

    try {
      await this.refreshTrackPersonalBestSummaries(challenges);
      if (isStale()) return;
      this.paintDailyCarousel(challenges);
    } catch (error) {
      console.error("Error loading playlist personal bests:", error);
    }

    if (isStale()) return;
    await this.ensureDailyCarouselRank(
      carousel.getSelectedChallengeId?.() || preferredId,
    );
  },

  dailyCarouselChallenges() {
    return this.currentDailyChallenge
      ? cacheDailyChallengePlaylist([this.currentDailyChallenge])
      : getCachedDailyChallengePlaylist();
  },

  repaintDailyCarouselFromCache() {
    if (!this.dailyCarousel) return;
    this.paintDailyCarousel(this.dailyCarouselChallenges());
  },

  async ensureDailyCarouselRank(challengeId) {
    if (!challengeId) return null;
    try {
      return await getDailyChallengeSnapshot({ challengeId });
    } catch (error) {
      console.error("Error loading daily challenge snapshot:", error);
      return null;
    }
  },

  paintDailyCarousel(challenges = [], {
    selectedChallengeId = this.selectedDailyChallengeId,
    loading = false,
  } = {}) {
    if (!this.dailyCarousel || !isLobbyPaintEligible(this, "daily")) return;
    const cards = buildDailyCarouselCards(
      decorateChallengesWithTrackPersonalBests(this, challenges),
      { getSnapshot: (challengeId) => getCachedDailyChallengeSnapshot(challengeId) },
    );
    this.dailyCarousel.render(cards, { selectedChallengeId, loading });
  },

  handleDailyCarouselSelect(challenge, card = null) {
    if (!challenge?.id) {
      this.selectedDailyChallengeId = null;
      this.lobbyUi?.setDailySelectedChallenge?.(null, null);
      this.setDailyChallengeLobbySummary(null);
      return;
    }
    this.selectedDailyChallengeId = challenge.id;
    this.lobbyUi?.setDailySelectedChallenge?.(challenge, card);
    this.setDailyChallengeLobbySummary(challenge);
  },

  handleDailyCarouselSettled(card) {
    const challenge = card?.challenge;
    if (!challenge?.trackKey) return;
    if (this.status === "playing" || this.status === "starting") return;
    if (!this.startOverlay?.isStartOverlayVisible?.()) return;
    this.prewarmDailyPlaylistTracks([challenge], { requireModal: false });
    void this.ensureDailyCarouselRank(challenge.id);
  },

  openDailyCarouselStandings(challenge) {
    if (!challenge?.id) return;
    void this.leaderboards?.openDailyChallengeLeaderboardForChallenge?.(
      challenge,
      "close",
      {
        onClose: () => {
          const viewedId = this.leaderboards?.getLastViewedDailyChallengeId?.()
            || challenge.id;
          this.selectDailyCarouselChallenge(viewedId);
        },
      },
    );
  },

  selectDailyCarouselChallenge(challengeId) {
    if (!challengeId) return false;
    return Boolean(this.dailyCarousel?.selectChallenge?.(challengeId));
  },

  prefetchDailyChallengePlaylist() {
    getDailyChallengePlaylist()
      .then((challenges) => prefetchDailyChallengeSnapshots(
        challenges.map((challenge) => challenge?.id).filter(Boolean),
      ))
      .catch((error) => {
        console.error("Error preloading daily challenge playlist:", error);
      });
  },

  handleDailyChallengeLapCompleted(lapTime, {
    elapsedTimeSec = null,
    completedLaps = null,
    requiredLaps = null,
    isFinalLap = false,
  } = {}) {
    if (!this.currentChallengeRun || !Number.isFinite(lapTime)) {
      this.updateDailyChallengeHud();
      this.requestRender();
      return;
    }

    const lapNumber = Number.isInteger(completedLaps)
      ? completedLaps
      : this.currentChallengeRun.completedLaps || 0;
    const raceElapsedTime = Number.isFinite(elapsedTimeSec)
      ? elapsedTimeSec
      : this.currentTime;
    const requiredLapCount = Number.isInteger(requiredLaps)
      ? requiredLaps
      : this.currentChallengeRun.requiredLaps;
    const paceBaseline = this.getActiveRacePaceBaseline?.()
      ?? this.raceComparisonTarget
      ?? this.activePersonalBestPaceBaseline
      ?? null;
    const lapRecord = buildLapRecord(lapNumber, lapTime, null);
    lapRecord.deltaVsBest = getLapPaceDeltaSec({
      elapsedTimeSec: raceElapsedTime,
      lapNumber,
      requiredLaps: requiredLapCount,
      isFinalLap,
      paceBaseline,
    });

    pushRecentLap(this.currentChallengeRun.recentLaps, lapRecord);

    this.currentChallengeRun.bestLapSecBeforeLastLap =
      this.currentChallengeRun.bestLap?.time ?? null;

    if (
      !this.currentChallengeRun.bestLap ||
      lapTime < this.currentChallengeRun.bestLap.time
    ) {
      this.currentChallengeRun.bestLap = {
        lapNumber,
        time: lapTime,
      };
    }

    if (!isFinalLap) {
      this.hud.showLapFlash({
        lapNumber,
        lapTime,
        deltaVsBest: lapRecord.deltaVsBest,
        isBest: false,
        isNewBest: false,
        completedLaps: lapNumber,
        requiredLaps: requiredLapCount,
        elapsedTimeSec: raceElapsedTime,
      });
      this._resetLapTrailAfterIntermediateLap();
    }
    this.updateDailyChallengeHud();
    this.requestRender();
  },

  getInvalidWinDataReason(winData) {
    return getInvalidDailyChallengeWinReason(this, winData);
  },

  handleInvalidDailyChallengeWin(reason = "Finish could not be verified.") {
    console.warn("Daily challenge win validation failed:", reason);
    this.status = "ready";
    void this.journeys?.endAttempt?.({ complete: false });
    this.hud.setPauseVisible(false);

    const existingScoreboardSnapshot = getCachedDailyChallengeSnapshot(
      this.activeDailyChallenge?.id,
    );

    this.modal.showModal(
      "RUN REJECTED",
      null,
      {
        bestTime: this.bestLapTime,
        lapTime: this.currentTime,
        deltaToBest: null,
        primaryStatLabel: this.activeDailyChallenge
          ? getDailyChallengeCopyLabels(this.activeDailyChallenge).primaryStatLabel
          : "Lap Time",
        scoreboardSnapshot: existingScoreboardSnapshot,
      },
      {
        ...createModalActions({
          modalKind: "rejected",
          primaryActionLabel: "Retry",
          primaryAction: () => this.restartDailyChallenge({ reason: "retry" }),
          secondaryActionLabel: "Done",
          secondaryAction: () => this.reset(false),
        }),
        playlistAction: () => {
          void this.openDailyChallengePlaylist();
        },
      },
    );
    if (this.modal.modalMsg) {
      this.modal.modalMsg.style.display = "";
      this.modal.modalMsg.textContent = reason;
    }
  },

  handleDailyChallengeWin(winData) {
    if (!this.currentChallengeRun || !this.activeDailyChallenge) {
      return;
    }

    const invalidReason = (
      typeof this.isValidatedWinData === "function"
      && this.isValidatedWinData !== dailyChallengeEngineMethods.isValidatedWinData
    )
      ? (this.isValidatedWinData(winData) ? null : "Finish could not be verified.")
      : getInvalidDailyChallengeWinReason(this, winData);
    if (invalidReason) {
      this.handleInvalidDailyChallengeWin(invalidReason);
      return;
    }

    this.status = "won";
    void this.journeys?.endAttempt?.({ complete: true });
    const finalTime = winData.lapTime;
    const challenge = this.activeDailyChallenge;
    const completedLaps = Math.max(0, Math.trunc(winData.completedLaps || 0));
    const previousDailyBest = this.dailyChallengeBestResult;
    const previousTrackBest = this.trackPersonalBestResult;
    const requiredLaps = getDailyChallengeRequiredLaps(challenge);
    const finishMedal = getMedalForRaceTime(challenge.trackKey, finalTime, requiredLaps);
    const previousTrackMedal = readTrackLastLapMedal(challenge.trackKey);
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.trackMedalBeforeLastLapWrite = null;
    writeTrackLastLapMedal(challenge.trackKey, finishMedal);
    const lapMedal = readTrackLastLapMedal(challenge.trackKey);
    const isDailyBest = isNewBestResult(
      this.currentRunPolicy,
      { bestTime: finalTime, completedLaps },
      previousDailyBest,
    );
    const isNewBest = !Number.isFinite(previousTrackBest?.bestTime)
      || finalTime < previousTrackBest.bestTime;
    const runBestBeforeLastLap = this.currentChallengeRun.bestLapSecBeforeLastLap;
    const raceCacheKey = challenge.id;
    const lastRunLap = this.currentChallengeRun.recentLaps?.length
      ? this.currentChallengeRun.recentLaps[this.currentChallengeRun.recentLaps.length - 1]
      : null;
    const sessionPrevSec =
      raceCacheKey && Number.isFinite(this.sessionBestLapSecByTrackKey?.[raceCacheKey])
        ? this.sessionBestLapSecByTrackKey[raceCacheKey]
        : null;
    const frozenPaceBaseline = this.raceComparisonTarget
      ? null
      : (this.activePersonalBestPaceBaseline ?? null);
    const storedTrackBestSec =
      Number.isFinite(frozenPaceBaseline?.finishTimeSec)
        ? frozenPaceBaseline.finishTimeSec
        : previousTrackBest != null && Number.isFinite(Number(previousTrackBest.bestTime))
        ? Number(previousTrackBest.bestTime)
        : null;
    const previousPersonalBestSec = storedTrackBestSec != null
        ? storedTrackBestSec
        : challenge.objectiveType === "multi_lap_total"
          ? (Number.isFinite(sessionPrevSec) ? sessionPrevSec : undefined)
          : Number.isFinite(runBestBeforeLastLap)
            ? runBestBeforeLastLap
            : sessionPrevSec != null
              ? sessionPrevSec
              : Number.isFinite(this.bestLapTime)
                ? this.bestLapTime
                : null;
    const deltaToPersonalBest =
      previousPersonalBestSec === undefined
        ? undefined
        : Number.isFinite(previousPersonalBestSec)
          ? finalTime - previousPersonalBestSec
          : Number.isFinite(lastRunLap?.deltaVsBest)
            ? lastRunLap.deltaVsBest
            : null;
    this.hud.syncHud({ time: finalTime, speed: this.cachedSpeed, force: true });
    this.hud.setBestTime(this.bestLapTime, {
      persistToTrackCard: false,
    });

    const lapCheckpointTimes = this.getLapCheckpointTimesSec?.() ?? [];
    const storedPbCheckpointTimes = normalizeCheckpointTimesSec(
      storedTrackBestSec ?? finalTime,
      frozenPaceBaseline?.checkpointTimesSec ?? previousTrackBest?.checkpointTimesSec,
    );
    const priorPbCheckpointTimes =
      storedPbCheckpointTimes
      ?? (raceCacheKey && this.sessionBestCheckpointTimesByTrackKey
        ? this.sessionBestCheckpointTimesByTrackKey[raceCacheKey] ?? null
        : null);
    const priorPbFinishSec =
      Number.isFinite(frozenPaceBaseline?.finishTimeSec)
        ? frozenPaceBaseline.finishTimeSec
        : raceCacheKey && this.sessionBestLapSecByTrackKey
        ? this.sessionBestLapSecByTrackKey[raceCacheKey] ?? null
        : null;
    const runSubmissionBlockedReason = this.rankedSubmissionBlockedReason || null;
    const replayPayload = this.scoreboardReplay.getPayload(requiredLaps);
    let submissionError = runSubmissionBlockedReason;
    const previousBestSnapshot = isDailyBest && Number.isFinite(previousDailyBest?.bestTime)
      ? {
          bestTime: Number(previousDailyBest.bestTime),
          completedLaps: Number.isFinite(previousDailyBest.completedLaps)
            ? previousDailyBest.completedLaps
            : null,
          checkpointTimesSec: Array.isArray(previousDailyBest.checkpointTimesSec)
            ? previousDailyBest.checkpointTimesSec
            : null,
        }
      : null;

    if (isDailyBest) {
      const saved = saveDailyChallengeBestTime(
        challenge,
        finalTime,
        completedLaps,
        lapCheckpointTimes,
      );
      if (saved) this.dailyChallengeBestResult = { ...saved };

      submissionError = submissionError
        || (replayPayload
          ? null
          : this.scoreboardReplay.overflowed
            ? "Run too long to rank."
            : "Submission replay was unavailable for this run.");
    }

    const presentDailyFinish = (didEnqueue) => {
      if (isDailyBest && (submissionError || !didEnqueue)) {
        const restored = restoreDailyChallengeBestAfterFailedSubmission(
          challenge,
          previousBestSnapshot,
        );
        this.dailyChallengeBestResult = restored ? { ...restored } : null;
      }

      const optimisticVerificationSnapshot = submissionError || !didEnqueue
        ? {
            ...createVerificationSnapshot({
              verificationState: "error",
              isLoading: false,
              submissionStage: "error",
              statusText: submissionError || "Couldn't rank this run. Try again.",
            }),
            currentPlayerRow: {
              isCurrentPlayer: true,
              bestTime: finalTime,
              rank: null,
              displayName: "You",
            },
          }
        : {
            ...createVerificationSnapshot({
              verificationState: "pending",
              isLoading: true,
              submissionStage: "submitting",
            }),
            currentPlayerRow: {
              isCurrentPlayer: true,
              bestTime: finalTime,
              rank: null,
              displayName: "You",
            },
          };

      const comparison = this.getRaceComparisonResult?.(finalTime) ?? null;
      const comparisonCheckpointTimes = comparison?.target.checkpointTimesSec
        ?? priorPbCheckpointTimes;
      const comparisonFinishSec = comparison?.target.finishTimeSec
        ?? priorPbFinishSec;
      const existingScoreboardSnapshot = getCachedDailyChallengeSnapshot(challenge.id);
      this.modal.showModal(
        "Daily challenge complete",
        null,
        {
          lapTime: finalTime,
          bestTime: this.bestLapTime,
          deltaToPersonalBest,
          completedLaps,
          requiredLaps,
          isNewBest,
          primaryStatLabel:
            getDailyChallengeCopyLabels(challenge).primaryStatLabel,
          scoreboardSnapshot: isDailyBest
            ? optimisticVerificationSnapshot
            : existingScoreboardSnapshot,
          scoreboardChallengeId: challenge.id,
          scoreboardTrackKey: challenge.trackKey,
          showGlobalLeaderboard: false,
          allowLeaderboardOpen: true,
          lapMedal,
          previousTrackMedal,
          previousPersonalBestSec,
          trackKey: challenge.trackKey,
          lapCheckpointTimes,
          pbCheckpointTimes: comparisonCheckpointTimes,
          pbFinishSec: comparisonFinishSec,
          raceComparisonTarget: comparison?.target ?? null,
          comparisonOutcome: comparison?.outcome ?? null,
          deltaToComparison: comparison?.deltaSec ?? null,
        },
        {
          ...createModalActions({
            modalKind: "win",
            primaryActionLabel: "Retry",
            secondaryActionLabel: "Done",
            secondaryAction: () => this.returnToActiveLobby(),
          }),
          restartAction: comparison?.outcome === "won"
            ? () => this.handleStartDailyChallenge(challenge)
            : () => this.restartDailyChallenge({
              reason: comparison?.target ? "opponent-retry" : "improve",
            }),
          settingsAction: () => this.settings.openSettings(),
          shareRequest: {
            source: "finish",
            challengeId: challenge.id,
            replay: replayPayload ? { ...replayPayload } : null,
          },
        },
      );
      if (this.modal.modalMsg) {
        this.modal.modalMsg.style.display = "";
        this.modal.modalMsg.textContent = `${getDailyChallengeTrackName(challenge)} • ${getDailyChallengeObjectiveLabel(challenge)}`;
      }

      this.configureLeaderboardOpponentFinish?.({
        mode: "daily",
        race: challenge,
        finalTime,
        comparison,
        waitForVerification: Boolean(isDailyBest && didEnqueue && !submissionError),
      });

      if (isDailyBest && didEnqueue && !submissionError) {
        const verificationEntry = getDailyChallengeVerificationEntry(challenge.id);
        if (verificationEntry) {
          this.modal.updateModalScoreboardSnapshot?.(
            {
              ...getVerificationSnapshotFromQueueEntry(verificationEntry),
              currentPlayerRow: {
                isCurrentPlayer: true,
                bestTime: finalTime,
                rank: null,
                displayName: "You",
              },
            },
          );
        }
      }
    };

    const enqueueDailyBest = () => {
      const didEnqueue = submissionError
        ? false
        : this.enqueueDailyChallengeVerificationSubmission({
            challenge,
            bestTime: finalTime,
            completedLaps,
            checkpointTimesSec: lapCheckpointTimes,
            replay: { ...replayPayload },
            previousBest: previousBestSnapshot,
            isTrackPbCandidate: isNewBest,
          });
      presentDailyFinish(didEnqueue);
    };

    if (isDailyBest && !submissionError) {
      runAfterPlayerIdentityReady(this, enqueueDailyBest);
      return;
    }
    presentDailyFinish(false);

  },

  isValidatedWinData(winData) {
    return getInvalidDailyChallengeWinReason(this, winData) === null;
  },

  restartDailyChallenge({ reason = "restart" } = {}) {
    if (!this.activeDailyChallenge) return;

    void this.journeys?.endAttempt?.({ complete: false });
    void this.journeys?.startAttempt?.({ mode: "daily", reason });
    this.reset(true, {
      preserveDailyChallenge: true,
      preserveRaceComparisonTarget: reason !== "improve",
    });
  },

  async startDailyChallengeAgainstOpponent(challenge, target) {
    if (!challenge || !target) return false;
    const track = await loadClientTrack(challenge.trackKey);
    this.clearRaceComparisonTarget?.();
    if (!this.installRaceComparisonTarget?.(
      { ...target, mode: "daily" },
      {
        track,
        lapCount: getDailyChallengeRequiredLaps(challenge),
      },
    )) {
      return false;
    }
    await this.handleStartDailyChallenge(challenge, {
      preserveRaceComparisonTarget: true,
    });
    if (this.activeDailyChallenge?.id !== challenge.id) {
      this.clearRaceComparisonTarget?.();
      return false;
    }
    return this.raceComparisonTarget !== null;
  },
};
