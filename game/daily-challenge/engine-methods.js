import {
  getDailyChallengeData,
  restoreDailyChallengeBestAfterFailedSubmission,
  saveDailyChallengeBestTime,
  setDailyChallengeBestTime,
} from "./storage.js";
import { normalizeCheckpointTimesSec } from "../shared/checkpoint-times.js";
import { normalizePbGhostRecord } from "../ghost/pb-ghost.js";
import {
  buildLapRecord,
  createModalActions,
  isNewBestResult,
  pushRecentLap,
} from "../race/result-flow.js";
import {
  formatDailyChallengeResultLabel,
  getActiveDailyChallenge,
  getDailyChallengeCopyLabels,
  getDailyChallengeModifierBadges,
  getDailyChallengeModifierLabel,
  getDailyChallengeObjectiveLabel,
  getDailyChallengeRequiredLaps,
  cacheDailyChallengePlaylist,
  getCachedDailyChallengePlaylist,
  getMissingDailyChallengeSnapshotIds,
  getCachedDailyChallengeSnapshot,
  getDailyChallengePlaylist,
  getDailyChallengeSnapshot,
  getDailyChallengeTrackName,
  isDailyChallengeStoredResultForChallenge,
  prefetchDailyChallengeSnapshots,
} from "./service.js";
import { createVerificationSnapshot } from "../scoreboard/verification-queue.js";
import { getMedalForLapTime } from "../medals/medals.js";
import {
  readTrackLastLapMedal,
  writeTrackLastLapMedal,
} from "../medals/last-lap-medal-storage.js";
import { getTrackCanvasAsset } from "../track/assets.js";
import { DEFAULT_TRACK_KEY } from "../track/catalog.js";
import { TRACKS } from "../track/tracks.js";
import {
  createDailyChallengePresentationEvent,
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "../track/presentation.js";

function normalizeTrackPersonalBest(record, trackKey = null) {
  if (!record || typeof record !== "object") return null;
  if (trackKey && record.trackKey && record.trackKey !== trackKey) return null;
  const bestTimeMs = Number(record.bestTimeMs);
  if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 0) return null;
  return {
    trackKey: record.trackKey || trackKey || null,
    bestTime: bestTimeMs / 1000,
    checkpointTimesSec: Array.isArray(record.checkpointTimesSec)
      ? record.checkpointTimesSec.slice()
      : null,
    ghostAvailable: Boolean(record.ghostAvailable || record.ghost),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
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
  if (typeof record.updatedAt !== "string" || !record.updatedAt) return false;
  return record.ghost === null || normalizePbGhostRecord(record) !== null;
}

function getTrackPersonalBestForChallenge(engine, challenge) {
  if (!challenge?.trackKey) return null;
  if (
    engine.trackPersonalBestResult?.trackKey === challenge.trackKey
    && Number.isFinite(engine.trackPersonalBestResult.bestTime)
  ) {
    return engine.trackPersonalBestResult;
  }
  return engine.trackPersonalBestByTrackKey?.[challenge.trackKey] || null;
}

function getPbGhostSelectionChallengeId(engine) {
  return engine.pbGhostSelectionChallengeId
    || engine.activeDailyChallenge?.id
    || engine.currentDailyChallenge?.id
    || null;
}

function claimPbGhostSelection(engine, challengeId) {
  const normalizedId = challengeId || null;
  if (engine.pbGhostSelectionChallengeId === normalizedId) {
    return engine.pbGhostSelectionGeneration || 0;
  }
  if (normalizedId && engine.unavailablePbGhostChallengeIds?.has(normalizedId)) {
    engine.unavailablePbGhostChallengeIds.delete(normalizedId);
  }
  if (
    normalizedId
    && engine.pbGhostSelectionChallengeId == null
    && engine.preparedPbGhostChallengeId === normalizedId
  ) {
    engine.pbGhostSelectionChallengeId = normalizedId;
    engine.pbGhostSelectionGeneration = engine.pbGhostSelectionGeneration || 1;
    return engine.pbGhostSelectionGeneration;
  }
  engine.pbGhostSelectionChallengeId = normalizedId;
  engine.pbGhostSelectionGeneration = (engine.pbGhostSelectionGeneration || 0) + 1;
  engine.preparedPbGhostChallengeId = null;
  return engine.pbGhostSelectionGeneration;
}

function bumpPbGhostPrepareGeneration(engine, challengeId) {
  if (!engine.pbGhostPrepareGenerationByChallengeId) {
    engine.pbGhostPrepareGenerationByChallengeId = Object.create(null);
  }
  const nextGeneration =
    (engine.pbGhostPrepareGenerationByChallengeId[challengeId] || 0) + 1;
  engine.pbGhostPrepareGenerationByChallengeId[challengeId] = nextGeneration;
  return nextGeneration;
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

function getPendingPbGhostCandidates(engine) {
  if (!engine.pendingPbGhostCandidateChallengeIds) {
    engine.pendingPbGhostCandidateChallengeIds = new Set();
  }
  return engine.pendingPbGhostCandidateChallengeIds;
}

function applyTrackPersonalBest(engine, challenge, record, { prepareGhost = false } = {}) {
  if (!challenge?.trackKey) return null;
  const personalBest = normalizeTrackPersonalBest(record, challenge.trackKey);
  if (!engine.trackPersonalBestByTrackKey) {
    engine.trackPersonalBestByTrackKey = Object.create(null);
  }
  if (personalBest) {
    engine.trackPersonalBestByTrackKey[challenge.trackKey] = personalBest;
  } else {
    delete engine.trackPersonalBestByTrackKey[challenge.trackKey];
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
      engine.sessionBestLapSecByTrackKey[challenge.trackKey] = personalBest.bestTime;
      if (Array.isArray(personalBest.checkpointTimesSec)) {
        if (!engine.sessionBestCheckpointTimesByTrackKey) {
          engine.sessionBestCheckpointTimesByTrackKey = Object.create(null);
        }
        engine.sessionBestCheckpointTimesByTrackKey[challenge.trackKey] =
          personalBest.checkpointTimesSec.slice();
      }
    }
  }

  if (prepareGhost) {
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
    this.preparedPbGhostChallengeId = challenge.id;
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
    if (ownsSelection) {
      this.preparedPbGhostChallengeId = challenge.id;
    }
    return personalBest;
  },

  beginPersonalBestGhostRunAtGo() {
    const challenge = this.activeDailyChallenge;
    const ghostActive = this.pbGhost?.beginRun?.() === true;
    const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
    const ghostExpected = this.pbGhost?.enabled === true
      && Number.isFinite(trackPersonalBest?.bestTime);
    const noticeShown = ghostExpected
      && !ghostActive
      && this.hud?.showGhostUnavailableNotice?.() === true;
    return { ghostActive, ghostExpected, noticeShown };
  },

  async loadInitialPersonalBestGhostAsset() {
    const [, challenge] = await Promise.all([
      this.playerHistoryPromise,
      this.dailyChallengePromise,
    ]);
    if (!challenge) return null;

    this.setLoadingStatus(80, "Loading Ghost...");
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

  waitForPlaylistModalPaint() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame !== "function") {
        setTimeout(resolve, 0);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
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

  prewarmDailyPlaylistTracks(challenges = []) {
    const prewarmId = (this._dailyPlaylistTrackPrewarmId || 0) + 1;
    this._dailyPlaylistTrackPrewarmId = prewarmId;
    const queue = (Array.isArray(challenges) ? challenges : [])
      .filter((challenge) => challenge?.trackKey && TRACKS[challenge.trackKey]);

    const prewarmNext = async () => {
      if (this._dailyPlaylistTrackPrewarmId !== prewarmId) return;
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      if (this.status === "playing" || this.status === "starting") return;
      const challenge = queue.shift();
      if (!challenge) return;

      await this.waitForTrackPrewarmIdle();
      if (this._dailyPlaylistTrackPrewarmId !== prewarmId) return;
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      if (this.status === "playing" || this.status === "starting") return;

      const track = TRACKS[challenge.trackKey];
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

    const medal = getMedalForLapTime(challenge.trackKey, Number(bestTime));
    writeTrackLastLapMedal(challenge.trackKey, medal);
    return medal;
  },

  async syncReadyBackgroundTrack(challenge = this.activeDailyChallenge) {
    const targetTrackKey =
      typeof challenge?.trackKey === "string" && challenge.trackKey
        ? challenge.trackKey
        : DEFAULT_TRACK_KEY;

    if (this.status !== "ready" || !targetTrackKey) {
      return;
    }

    if (this.currentTrackKey === targetTrackKey && this.trackCanvas) {
      await this.refreshTrackPresentation();
      return;
    }

    await this.loadTrack(targetTrackKey, {
      loadPlayerProgress: false,
    });
  },

  getChallengeRunTitle() {
    return this.activeDailyChallenge
      ? getDailyChallengeTrackName(this.activeDailyChallenge)
      : "Daily";
  },

  syncChallengeHudPrimaryStats() {
    const copyLabels = getDailyChallengeCopyLabels(this.activeDailyChallenge);
    this.hud.setHudPrimaryMetric({
      label: copyLabels.hudPrimaryLabel,
      useTimer: true,
      visible: true,
    });
    this.hud.setBestTime(this.bestLapTime, { persistToTrackCard: false });
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
      typeText: getDailyChallengeObjectiveLabel(this.activeDailyChallenge),
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
    const objectiveLabel = getDailyChallengeObjectiveLabel(challenge);

    this.dailyChallengeUi.setDailyChallengeSummary({
      available: true,
      challengeId: challenge.id,
      title: getDailyChallengeTrackName(challenge),
      trackKey: challenge.trackKey,
      skin: challenge.skin,
      trackName: getDailyChallengeTrackName(challenge),
      objectiveLabel,
      modifierBadges: getDailyChallengeModifierBadges(challenge),
      modifierLabel: getDailyChallengeModifierLabel(challenge),
      bestTime: this.bestLapTime,
      bestLabel: formatDailyChallengeResultLabel(challenge, trackPersonalBest),
      rankLabel: "--",
      scoreboardSnapshot: null,
      usesTrackPersonalBest: true,
      objectiveType: challenge.objectiveType,
      startsAt: challenge.startsAt,
      challengeDate: challenge.challengeDate,
      endsAt: challenge.endsAt,
    });
  },

  async loadDailyChallengeCritical() {
    try {
      this.setLoadingStatus(40, "Checking Challenge...");
      const challenge = await getActiveDailyChallenge();
      this.currentDailyChallenge = challenge || null;
      this.activeDailyChallenge = null;
      this.setDailyChallengeLobbySummary(challenge);
      if (challenge) {
        try {
          await this.refreshTrackPersonalBestSummaries([challenge]);
          this.setDailyChallengeLobbySummary(challenge);
        } catch (error) {
          console.error("Error loading track personal best:", error);
        }
      }
      await this.syncReadyBackgroundTrack(challenge);
      return challenge;
    } catch (error) {
      console.error("Error loading daily challenge:", error);
      this.currentDailyChallenge = null;
      this.activeDailyChallenge = null;
      await this.syncReadyBackgroundTrack(null);
      this.dailyChallengeUi.setDailyChallengeSummary(null);
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
    const objectiveLabel = getDailyChallengeObjectiveLabel(challenge);
    this.dailyChallengeUi.setDailyChallengeSummary({
      available: true,
      challengeId: challenge.id,
      title: getDailyChallengeTrackName(challenge),
      trackKey: challenge.trackKey,
      skin: challenge.skin,
      trackName: getDailyChallengeTrackName(challenge),
      objectiveLabel,
      modifierBadges: getDailyChallengeModifierBadges(challenge),
      modifierLabel: getDailyChallengeModifierLabel(challenge),
      bestTime,
      bestLabel: formatDailyChallengeResultLabel(challenge, trackPersonalBest),
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
    const tk = challenge.trackKey;
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
    this.hud.setHudPersonalBestsOpenAllowed(false);
    this.syncChallengeHudPrimaryStats();
    this.updateDailyChallengeHud();
  },

  clearDailyChallengeRun() {
    const hadChallengeRun = Boolean(this.currentChallengeRun);
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.currentChallengeRun = null;
    this.activeDailyChallenge = null;
    this.dailyChallengeBestResult = null;
    this.trackPersonalBestResult = null;
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
  },

  async handleStartDailyChallenge(challengeOverride = null, options = {}) {
    const challenge = challengeOverride || this.currentDailyChallenge || this.activeDailyChallenge;
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

    this.resetCanvasPresentation();
    this.startOverlay?.hideStartOverlay?.();
    claimPbGhostSelection(this, challenge.id);
    this.startButtonPending = true;
    try {
      if (replacesCurrentRun && challenge.trackKey === this.currentTrackKey) {
        this.reset(false, {
          showStartOverlay: false,
        });
      }
      this.activeDailyChallenge = challenge;
      if (challenge.trackKey && challenge.trackKey !== this.currentTrackKey) {
        await this.loadTrack(challenge.trackKey, {
          loadPlayerProgress: false,
          preserveDailyChallengeContext: true,
          showStartOverlayOnReset: false,
        });
      }

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
      this.applyDailyChallenge(challenge);
      this.startSequence();
    } finally {
      this.startButtonPending = false;
    }
  },

  async openDailyChallengePlaylist() {
    let loadedChallenges = [];
    let playlistRequestNeeded = false;
    const playlistActions = {
      onPlay: (challenge) => {
        void this.handleStartDailyChallenge(challenge, {
          startSource: "track_modal",
        });
      },
      onLeaderboard: (challenge) => {
        void this.leaderboards?.openDailyChallengeLeaderboardForChallenge?.(
          challenge,
          "close",
          {
            onClose: () => this.dailyChallengeUi.openPlaylistModal(loadedChallenges, playlistActions),
          },
        );
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

    const missingSnapshotIds = getMissingDailyChallengeSnapshotIds(
      loadedChallenges.map((challenge) => challenge?.id).filter(Boolean),
    );
    for (const challengeId of missingSnapshotIds) {
      try {
        await getDailyChallengeSnapshot({ challengeId });
      } catch (error) {
        console.error("Error loading daily challenge snapshot:", error);
      }
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      this.dailyChallengeUi.renderPlaylist(loadedChallenges, playlistActions);
    }
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

  handleDailyChallengeLapCompleted(lapTime) {
    if (!this.currentChallengeRun || !Number.isFinite(lapTime)) {
      this.updateDailyChallengeHud();
      this.requestRender();
      return;
    }

    const lapNumber = this.currentChallengeRun.completedLaps || 0;
    const lapRecord = buildLapRecord(
      lapNumber,
      lapTime,
      this.currentChallengeRun.bestLap?.time ?? null,
    );

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

    const tk =
      typeof this.activeDailyChallenge?.trackKey === "string"
        ? this.activeDailyChallenge.trackKey
        : this.currentTrackKey;
    if (tk) {
      this.trackMedalBeforeLastLapWrite = readTrackLastLapMedal(tk);
      this.hasTrackMedalBeforeLastLapWrite = true;
      writeTrackLastLapMedal(tk, getMedalForLapTime(tk, lapTime));
    }

    this.hud.showLapFlash({
      lapNumber,
      lapTime,
      deltaVsBest: lapRecord.deltaVsBest,
      isBest: false,
      isNewBest: false,
    });
    this._resetLapTrailAfterIntermediateLap();
    this.updateDailyChallengeHud();
    this.requestRender();
  },

  getInvalidWinDataReason(winData) {
    return getInvalidDailyChallengeWinReason(this, winData);
  },

  handleInvalidDailyChallengeWin(reason = "Finish could not be verified.") {
    console.warn("Daily challenge win validation failed:", reason);
    this.status = "ready";
    this.hud.setPauseVisible(false);
    this.hud.setHudPersonalBestsOpenAllowed(true);

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
          primaryAction: () => this.restartDailyChallenge(),
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
    const finalTime = winData.lapTime;
    const challenge = this.activeDailyChallenge;
    const completedLaps = Math.max(0, Math.trunc(winData.completedLaps || 0));
    const previousDailyBest = this.dailyChallengeBestResult;
    const previousTrackBest = this.trackPersonalBestResult;
    const finishMedal = getMedalForLapTime(challenge.trackKey, finalTime);
    const previousTrackMedal = this.hasTrackMedalBeforeLastLapWrite
      ? this.trackMedalBeforeLastLapWrite
      : readTrackLastLapMedal(challenge.trackKey);
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
    const trackKey = challenge.trackKey;
    const lastRunLap = this.currentChallengeRun.recentLaps?.length
      ? this.currentChallengeRun.recentLaps[this.currentChallengeRun.recentLaps.length - 1]
      : null;
    const sessionPrevSec =
      trackKey && Number.isFinite(this.sessionBestLapSecByTrackKey?.[trackKey])
        ? this.sessionBestLapSecByTrackKey[trackKey]
        : null;
    const storedTrackBestSec =
      previousTrackBest != null && Number.isFinite(Number(previousTrackBest.bestTime))
        ? Number(previousTrackBest.bestTime)
        : null;
    const previousPersonalBestSec = storedTrackBestSec != null
        ? storedTrackBestSec
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
    this.hud.setHudPersonalBestsOpenAllowed(false);

    const lapCheckpointTimes = this.getLapCheckpointTimesSec?.() ?? [];
    const storedPbCheckpointTimes = normalizeCheckpointTimesSec(
      storedTrackBestSec ?? finalTime,
      previousTrackBest?.checkpointTimesSec,
    );
    const priorPbCheckpointTimes =
      storedPbCheckpointTimes
      ?? (trackKey && this.sessionBestCheckpointTimesByTrackKey
        ? this.sessionBestCheckpointTimesByTrackKey[trackKey] ?? null
        : null);
    const priorPbFinishSec =
      trackKey && this.sessionBestLapSecByTrackKey
        ? this.sessionBestLapSecByTrackKey[trackKey] ?? null
        : null;
    const runSubmissionBlockedReason = this.rankedSubmissionBlockedReason || null;
    const replayPayload = this.scoreboardReplay.getPayload(1);
    let submissionError = runSubmissionBlockedReason;
    let didEnqueue = true;
    if (isDailyBest) {
      const previousBestSnapshot = Number.isFinite(previousDailyBest?.bestTime)
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
            ? "Replay was too long to submit. Finish a cleaner run to rank it."
            : "Submission replay was unavailable for this run.");
      didEnqueue = submissionError
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
      if (submissionError || !didEnqueue) {
        const restored = restoreDailyChallengeBestAfterFailedSubmission(
          challenge,
          previousBestSnapshot,
        );
        this.dailyChallengeBestResult = restored ? { ...restored } : null;
      }
    }

    const optimisticVerificationSnapshot = submissionError || !didEnqueue
      ? {
          ...createVerificationSnapshot({
            verificationState: "error",
            isLoading: false,
            submissionStage: "error",
            statusText: submissionError || "Leaderboard submission could not be queued.",
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

    const existingScoreboardSnapshot = getCachedDailyChallengeSnapshot(challenge.id);
    this.modal.showModal(
      "Daily challenge complete",
      null,
      {
        lapTime: finalTime,
        bestTime: this.bestLapTime,
        deltaToPersonalBest,
        completedLaps,
        isNewBest,
        primaryStatLabel:
          getDailyChallengeCopyLabels(challenge).primaryStatLabel,
        variant: null,
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
        pbCheckpointTimes: priorPbCheckpointTimes,
        pbFinishSec: priorPbFinishSec,
      },
      {
        ...createModalActions({
          modalKind: "win",
          primaryActionLabel: "Retry",
          primaryAction: () => this.restartDailyChallenge(),
          secondaryActionLabel: "Done",
          secondaryAction: () => this.reset(false),
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

  },

  isValidatedWinData(winData) {
    return getInvalidDailyChallengeWinReason(this, winData) === null;
  },

  restartDailyChallenge() {
    if (!this.activeDailyChallenge) return;

    this.reset(true, { preserveDailyChallenge: true });
  },
};
