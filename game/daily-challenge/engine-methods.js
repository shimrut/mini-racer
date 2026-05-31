import {
  getDailyChallengeData,
  saveDailyChallengeBestTime,
  setDailyChallengeBestTime,
} from "./storage.js?v=1.91";
import { normalizeCheckpointTimesSec } from "./checkpoint-times.js?v=1.92";
import {
  buildLapRecord,
  createModalActions,
  isNewBestResult,
  pushRecentLap,
} from "../race/result-flow.js?v=1.91";
import {
  formatDailyChallengeResultLabel,
  getActiveDailyChallenge,
  getDailyChallengeCopyLabels,
  getDailyChallengeModifierBadges,
  getDailyChallengeModifierLabel,
  getDailyChallengeObjectiveLabel,
  getDailyChallengeRequiredLaps,
  getCachedDailyChallengePlaylist,
  getDailyChallengePlaylist,
  getDailyChallengeSnapshot,
  getDailyChallengeTrackName,
  invalidateDailyChallengeSnapshot,
  isDailyChallengeStoredResultForChallenge,
  prefetchDailyChallengeSnapshots,
} from "./service.js?v=1.94";
import { createVerificationSnapshot } from "../scoreboard/verification-queue.js";
import { getMedalForLapTime } from "../medals/medals.js?v=2.04";
import {
  readTrackLastLapMedal,
  writeTrackLastLapMedal,
} from "../medals/last-lap-medal-storage.js?v=1.92";

export const dailyChallengeEngineMethods = {
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
      this.activeDailyChallenge = challenge || null;
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

  async refreshDailyChallengeSummary() {
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
    let snapshot = null;
    try {
      snapshot = await getDailyChallengeSnapshot({ challengeId: challenge.id });
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
    this.activeDailyChallenge = this.currentDailyChallenge || this.activeDailyChallenge;
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

  async handleStartDailyChallenge(challengeOverride = null) {
    const challenge = challengeOverride || this.currentDailyChallenge || this.activeDailyChallenge;
    const replacesCurrentRun = Boolean(challengeOverride) && this.status !== "ready";
    if (
      (this.status !== "ready" && !replacesCurrentRun) ||
      this.startButtonPending ||
      !challenge
    ) {
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
      this.trackModeStart({
        trackKey: challenge.trackKey,
      });
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
    const playlistActions = {
      onPlay: (challenge) => {
        void this.handleStartDailyChallenge(challenge);
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
    loadedChallenges = getCachedDailyChallengePlaylist();
    this.dailyChallengeUi.openPlaylistModal(
      loadedChallenges.length ? loadedChallenges : null,
      playlistActions,
    );

    try {
      const challenges = await getDailyChallengePlaylist();
      loadedChallenges = challenges;
      await prefetchDailyChallengeSnapshots(
        challenges.map((challenge) => challenge?.id).filter(Boolean),
      );
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      this.dailyChallengeUi.openPlaylistModal(challenges, playlistActions);
    } catch (error) {
      console.error("Error loading daily challenge playlist:", error);
      if (!this.dailyChallengeUi.isPlaylistModalOpen?.()) return;
      this.dailyChallengeUi.openPlaylistModal([], null);
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

    const existingScoreboardSnapshot = this.dailyChallengeUi.getDailyChallengeScoreboardSnapshot();

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

  handleDailyChallengeWin(winData) {
    if (
      !this.isValidatedWinData(winData) ||
      !this.currentChallengeRun ||
      !this.activeDailyChallenge
    ) {
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

    const existingScoreboardSnapshot =
      this.dailyChallengeUi.getDailyChallengeScoreboardSnapshot();
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
          ? {
              ...(existingScoreboardSnapshot || {}),
              ...createVerificationSnapshot({
                statusText: "Submitting...",
                verificationState: "pending",
                isLoading: true,
              }),
              currentPlayerRow: {
                isCurrentPlayer: true,
                bestTime: finalTime,
                rank: null,
                displayName: "You",
              },
            }
          : existingScoreboardSnapshot,
        scoreboardChallengeId: challenge.id,
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
      this.enqueueDailyChallengeVerificationSubmission({
        challenge,
        bestTime: finalTime,
        completedLaps,
        checkpointTimesSec: lapCheckpointTimes,
        replay: replayPayload ? { ...replayPayload } : null,
      });
    }
  },

  isValidatedWinData(winData) {
    if (!winData || typeof winData !== "object") return false;
    if (this.status !== "won") return false;
    if (winData.trackKey !== this.currentTrackKey) return false;
    if (
      this.activeDailyChallenge?.trackKey &&
      winData.trackKey !== this.activeDailyChallenge.trackKey
    ) {
      return false;
    }
    if (
      this.currentChallengeRun?.challengeId &&
      this.activeDailyChallenge?.id &&
      this.currentChallengeRun.challengeId !== this.activeDailyChallenge.id
    ) {
      return false;
    }
    if (
      this.currentChallengeRun?.trackKey &&
      winData.trackKey !== this.currentChallengeRun.trackKey
    ) {
      return false;
    }
    if (winData.runId !== this.activeRunId) return false;

    const checkpointCount = this.currentTrack.checkpoints?.length || 0;
    if (winData.checkpointCount !== checkpointCount) return false;
    if (winData.completedCheckpointCount < checkpointCount) {
      return false;
    }
    if (!Number.isFinite(winData.lapTime) || winData.lapTime < 2.0) {
      return false;
    }

    return true;
  },

  restartDailyChallenge() {
    if (!this.activeDailyChallenge) return;

    this.trackModeStart({
      trackKey: this.activeDailyChallenge.trackKey,
    });
    this.bumpDailyGpRaceStart();
    this.reset(true, { preserveDailyChallenge: true });
  },
};
