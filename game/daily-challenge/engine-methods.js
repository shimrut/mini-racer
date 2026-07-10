import {
  getDailyChallengeData,
  saveDailyChallengeBestTime,
  setDailyChallengeBestTime,
} from "./storage.js";
import { normalizeCheckpointTimesSec } from "../shared/checkpoint-times.js";
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
  invalidateDailyChallengeSnapshot,
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
import { TRACKS } from "../track/tracks.js";
import {
  createDailyChallengePresentationEvent,
  resolveTrackPresentation,
  TRACK_PRESENTATION_SURFACES,
} from "../track/presentation.js";

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
    const fallbackTrackKey = "circuit";
    const targetTrackKey =
      typeof challenge?.trackKey === "string" && challenge.trackKey
        ? challenge.trackKey
        : fallbackTrackKey;

    if (this.status !== "ready" || !targetTrackKey) {
      return;
    }

    if (this.currentTrackKey === targetTrackKey && this.trackCanvas) {
      await this.refreshTrackPresentation();
      return;
    }

    await this.loadTrack(targetTrackKey, {
      trackPageview: false,
      countMapSelection: false,
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
    this.bestLapTime = Number.isFinite(localData?.bestTime)
      ? localData.bestTime
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
      bestLabel: formatDailyChallengeResultLabel(challenge, localData),
      rankLabel: "--",
      scoreboardSnapshot: null,
      objectiveType: challenge.objectiveType,
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
    this.bestLapTime = Number.isFinite(localData?.bestTime)
      ? localData.bestTime
      : null;
    if (forceRefresh) {
      invalidateDailyChallengeSnapshot(challenge.id);
    }
    let snapshot = null;
    try {
      snapshot = await getDailyChallengeSnapshot({
        challengeId: challenge.id,
        forceRefresh,
      });
    } catch (error) {
      console.error("Error loading daily challenge snapshot:", error);
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
      this.bestLapTime = Number.isFinite(localData?.bestTime)
        ? localData.bestTime
        : this.bestLapTime;
      this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);
    }

    const bestTime = Number.isFinite(localData?.bestTime)
      ? localData.bestTime
      : null;
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
      bestLabel: formatDailyChallengeResultLabel(challenge, localData),
      rankLabel,
      scoreboardSnapshot: snapshot,
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
    this.bestLapTime = Number.isFinite(storedDaily?.bestTime)
      ? storedDaily.bestTime
      : null;
    this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);
    const tk = challenge.trackKey;
    if (tk && Number.isFinite(storedDaily?.bestTime)) {
      const storedSec = Number(storedDaily.bestTime);
      const cur = this.sessionBestLapSecByTrackKey?.[tk];
      if (!Number.isFinite(cur) || storedSec < cur) {
        this.sessionBestLapSecByTrackKey[tk] = storedSec;
      }
      const storedCheckpoints = normalizeCheckpointTimesSec(
        storedSec,
        storedDaily.checkpointTimesSec,
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
    this.startButtonPending = true;
    const playerTypeAlreadySent = this.sessionFlags.get("playerTypeSent");
    try {
      if (replacesCurrentRun && challenge.trackKey === this.currentTrackKey) {
        this.reset(false);
      }
      this.activeDailyChallenge = challenge;
      if (challenge.trackKey && challenge.trackKey !== this.currentTrackKey) {
        await this.loadTrack(challenge.trackKey, {
          trackPageview: false,
          countMapSelection: true,
          loadPlayerProgress: false,
          preserveDailyChallengeContext: true,
        });
      }

      if (this.currentTrackPageviewPending) {
        this.analytics.trackPageview(
          `/track/${this.currentTrackKey}`,
          `${this.currentTrackKey} Daily`,
        );
        this.currentTrackPageviewPending = false;
      }

      if (!this.playerTypeSent && !playerTypeAlreadySent) {
        this.playerTypeSent = true;
        this.sessionFlags.set("playerTypeSent", "1");
        this.playerHistoryPromise
          .then(({ isReturningPlayer }) => {
            this.analytics.trackPlayerType(isReturningPlayer);
          })
          .catch(() => {
            this.analytics.trackPlayerType(false);
          });
      }

      this.applyDailyChallenge(challenge);
      const modeStartPayload = {
        trackKey: challenge.trackKey,
      };
      if (options.startSource) {
        modeStartPayload.challengeId = challenge.id;
        modeStartPayload.source = options.startSource;
      }
      this.trackModeStart(modeStartPayload);
      if (this.currentTrackMapSelectionPending) {
        this.bumpMapSelectionForCurrentTrack();
        this.currentTrackMapSelectionPending = false;
      }
      this.bumpDailyGpRaceStart();
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

  restartDailyChallengeAfterCrash() {
    if (!this.currentChallengeRun) return;

    this.resetRunToTrackStart({
      currentTime: this.currentTime,
      relaunchDelay: this.crashRestartDelaySec,
    });
    this.hud.syncHud({ time: this.currentTime, speed: 0, force: true });
    this.updateDailyChallengeHud();
    this.requestRender();
  },

  handleDailyChallengeFailure(reason, crashImpact = null) {
    if (!this.currentChallengeRun) return;

    this.hud.setPauseVisible(false);
    this.hud.setHudPersonalBestsOpenAllowed(true);

    const existingScoreboardSnapshot = getCachedDailyChallengeSnapshot(
      this.activeDailyChallenge?.id,
    );

    this.modal.showModal(
      "CRASHED",
      null,
      {
        isCrash: true,
        impact: crashImpact,
        currentTime: this.currentTime,
        scoreboardSnapshot: existingScoreboardSnapshot,
      },
      {
        ...createModalActions({
          modalKind: "crash",
          primaryActionLabel: "Retry",
          primaryAction: () => this.restartDailyChallenge(),
          primaryActionIcon: "retry",
          secondaryActionLabel: "Done",
          secondaryActionIcon: "done",
          secondaryAction: () => this.reset(false),
        }),
        settingsAction: () => this.settings.openSettings(),
        playlistAction: () => {
          void this.openDailyChallengePlaylist();
        },
      },
    );
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
          primaryActionIcon: "retry",
          secondaryActionLabel: "Done",
          secondaryAction: () => this.reset(false),
          secondaryActionIcon: "done",
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
    this.dailyGpRaceStats.win++;
    const finalTime = winData.lapTime;
    const challenge = this.activeDailyChallenge;
    const completedLaps = Math.max(0, Math.trunc(winData.completedLaps || 0));
    const previousBest = this.dailyChallengeBestResult;
    const finishMedal = getMedalForLapTime(challenge.trackKey, finalTime);
    const previousTrackMedal = this.hasTrackMedalBeforeLastLapWrite
      ? this.trackMedalBeforeLastLapWrite
      : readTrackLastLapMedal(challenge.trackKey);
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.trackMedalBeforeLastLapWrite = null;
    writeTrackLastLapMedal(challenge.trackKey, finishMedal);
    const lapMedal = readTrackLastLapMedal(challenge.trackKey);
    const isNewBest = isNewBestResult(
      this.currentRunPolicy,
      { bestTime: finalTime, completedLaps },
      previousBest,
    );
    const runBestBeforeLastLap = this.currentChallengeRun.bestLapSecBeforeLastLap;
    const trackKey = challenge.trackKey;
    const lastRunLap = this.currentChallengeRun.recentLaps?.length
      ? this.currentChallengeRun.recentLaps[this.currentChallengeRun.recentLaps.length - 1]
      : null;
    const sessionPrevSec =
      trackKey && Number.isFinite(this.sessionBestLapSecByTrackKey?.[trackKey])
        ? this.sessionBestLapSecByTrackKey[trackKey]
        : null;
    const storedChallengeBestSec =
      previousBest != null && Number.isFinite(Number(previousBest.bestTime))
        ? Number(previousBest.bestTime)
        : null;
    const previousPersonalBestSec = storedChallengeBestSec != null
        ? storedChallengeBestSec
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
    this.analytics?.trackRaceEnded?.({
      cause: "finish",
      trackKey: challenge.trackKey,
      challengeId: challenge.id,
      runTimeSec: finalTime,
    });
    this.hud.setBestTime(this.bestLapTime, {
      persistToTrackCard: false,
    });
    this.hud.setHudPersonalBestsOpenAllowed(false);

    const lapCheckpointTimes = this.getLapCheckpointTimesSec?.() ?? [];
    const storedPbCheckpointTimes = normalizeCheckpointTimesSec(
      storedChallengeBestSec ?? finalTime,
      previousBest?.checkpointTimesSec,
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
    const optimisticVerificationSnapshot = runSubmissionBlockedReason
      ? {
          ...createVerificationSnapshot({
            verificationState: "error",
            isLoading: false,
            submissionStage: "error",
            statusText: runSubmissionBlockedReason,
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
        scoreboardSnapshot: isNewBest
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
          primaryActionIcon: "retry",
          secondaryActionLabel: "Done",
          secondaryActionIcon: "done",
          secondaryAction: () => this.reset(false),
        }),
        settingsAction: () => this.settings.openSettings(),
        playlistAction: () => {
          void this.openDailyChallengePlaylist();
        },
      },
    );
    if (this.modal.modalMsg) {
      this.modal.modalMsg.style.display = "";
      this.modal.modalMsg.textContent = `${getDailyChallengeTrackName(challenge)} • ${getDailyChallengeObjectiveLabel(challenge)}`;
    }

    if (trackKey && Number.isFinite(finalTime)) {
      if (!this.sessionBestLapSecByTrackKey) {
        this.sessionBestLapSecByTrackKey = Object.create(null);
      }
      const curSession = this.sessionBestLapSecByTrackKey[trackKey];
      if (!Number.isFinite(curSession) || finalTime < curSession) {
        this.sessionBestLapSecByTrackKey[trackKey] = finalTime;
        if (!this.sessionBestCheckpointTimesByTrackKey) {
          this.sessionBestCheckpointTimesByTrackKey = Object.create(null);
        }
        this.sessionBestCheckpointTimesByTrackKey[trackKey] = lapCheckpointTimes.slice();
      }
    }

    if (isNewBest) {
      invalidateDailyChallengeSnapshot(challenge.id);
      const saved = saveDailyChallengeBestTime(
        challenge,
        finalTime,
        completedLaps,
        lapCheckpointTimes,
      );
      if (saved) {
        this.dailyChallengeBestResult = { ...saved };
        this.bestLapTime = Number.isFinite(saved.bestTime)
          ? saved.bestTime
          : this.bestLapTime;
      }

      const replayPayload = this.scoreboardReplay.getPayload(1);
      const submissionError = runSubmissionBlockedReason
        || (replayPayload
          ? null
          : this.scoreboardReplay.overflowed
            ? "Replay was too long to submit. Finish a cleaner run to rank it."
            : "Submission replay was unavailable for this run.");
      const didEnqueue = submissionError
        ? false
        : this.enqueueDailyChallengeVerificationSubmission({
            challenge,
            bestTime: finalTime,
            completedLaps,
            checkpointTimesSec: lapCheckpointTimes,
            replay: replayPayload ? { ...replayPayload } : null,
          });

      if (submissionError || !didEnqueue) {
        this.modal.updateModalScoreboardSnapshot?.(
          {
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
          },
        );
      }
    }
  },

  isValidatedWinData(winData) {
    return getInvalidDailyChallengeWinReason(this, winData) === null;
  },

  restartDailyChallenge() {
    if (!this.activeDailyChallenge) return;

    if (this.status === "crashed") {
      this.analytics?.trackRaceRestarted?.({
        source: "manual_restart_after_crash",
        trackKey: this.activeDailyChallenge.trackKey,
        challengeId: this.activeDailyChallenge.id,
      });
    } else if (this.status === "won") {
      this.analytics?.trackRaceRestarted?.({
        source: "improve_restart_after_win",
        trackKey: this.activeDailyChallenge.trackKey,
        challengeId: this.activeDailyChallenge.id,
      });
    }

    this.trackModeStart({
      trackKey: this.activeDailyChallenge.trackKey,
    });
    this.bumpDailyGpRaceStart();
    this.reset(true, { preserveDailyChallenge: true });
  },
};
