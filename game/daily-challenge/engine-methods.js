import {
  getDailyChallengeData,
  setDailyChallengeBestTime,
} from "./storage.js?v=1.91";
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
  getDailyChallengeMaxCrashes,
  getDailyChallengeModifierBadges,
  getDailyChallengeModifierLabel,
  getDailyChallengeObjectiveLabel,
  getDailyChallengeRequiredLaps,
  getDailyChallengeSnapshot,
  getDailyChallengeTrackName,
  isCrashBudgetDailyChallenge,
} from "./service.js?v=1.91";
import { createVerificationSnapshot } from "../scoreboard/verification-queue.js";
import { applySkillPointAllocation } from "../car/skill-points.js";
import { getMedalForLapTime } from "../medals/medals.js?v=2.04";
import {
  readTrackLastLapMedal,
  writeTrackLastLapMedal,
} from "../medals/last-lap-medal-storage.js?v=1.92";

export const dailyChallengeEngineMethods = {
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
    });
  },

  getChallengeRunTitle() {
    return this.activeDailyChallenge
      ? getDailyChallengeTrackName(this.activeDailyChallenge)
      : "Daily";
  },

  isCrashBudgetDailyChallenge(challenge = this.activeDailyChallenge) {
    return isCrashBudgetDailyChallenge(challenge);
  },

  syncChallengeHudPrimaryStats() {
    const copyLabels = getDailyChallengeCopyLabels(this.activeDailyChallenge);
    if (this.isCrashBudgetDailyChallenge()) {
      const currentLaps = Math.max(
        0,
        Math.trunc(this.currentChallengeRun?.completedLaps || 0),
      );
      const bestLaps = Math.max(
        0,
        Math.trunc(this.dailyChallengeBestResult?.completedLaps || 0),
      );
      this.hud.setHudPrimaryMetric({
        label: copyLabels.hudPrimaryLabel,
        value: `${currentLaps}`,
        useTimer: false,
        visible: true,
      });
      this.hud.setHudBestMetric({
        label: "BEST LAPS",
        value: `${bestLaps}`,
        visible: true,
      });
      return;
    }

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
    if (this.currentChallengeRun.objectiveType === "finish_with_crash_budget") {
      const crashesLeft = Math.max(
        0,
        this.currentChallengeRun.maxCrashes -
        this.currentChallengeRun.crashCount,
      );
      return `${crashesLeft}`;
    }
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

  async loadDailyChallenge() {
    try {
      this.setLoadingStatus(40, "Checking Challenge...");
      const challenge = await getActiveDailyChallenge();
      this.activeDailyChallenge = challenge || null;
      await this.syncReadyBackgroundTrack(challenge);
      await this.refreshDailyChallengeSummary();
      return challenge;
    } catch (error) {
      console.error("Error loading daily challenge:", error);
      this.activeDailyChallenge = null;
      await this.syncReadyBackgroundTrack(null);
      this.dailyChallengeUi.setDailyChallengeSummary(null);
      return null;
    }
  },

  async refreshDailyChallengeSummary() {
    const challenge = this.activeDailyChallenge;
    if (!challenge) {
      this.dailyChallengeUi.setDailyChallengeSummary(null);
      return null;
    }

    let localData = getDailyChallengeData(challenge.id);
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
      ) || localData;
      this.dailyChallengeBestResult = localData ? { ...localData } : null;
      this.bestLapTime = Number.isFinite(localData?.bestTime)
        ? localData.bestTime
        : this.bestLapTime;
    }

    const bestTime = Number.isFinite(localData?.bestTime)
      ? localData.bestTime
      : null;
    const rankLabel = snapshot?.playerRankLabel || "--";
    const crashBudget = Math.max(
      0,
      Math.trunc(challenge.objectiveParams?.maxCrashes || 0),
    );
    const objectiveLabel =
      challenge.objectiveType === "finish_with_crash_budget"
        ? `${crashBudget} crash${crashBudget === 1 ? "" : "es"}`
        : getDailyChallengeObjectiveLabel(challenge);
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
      objectiveType: challenge.objectiveType,
      requiredLaps: getDailyChallengeRequiredLaps(challenge),
      maxCrashes: getDailyChallengeMaxCrashes(challenge),
      completedLaps: 0,
      crashCount: 0,
      elapsedTime: 0,
      lastLapAt: 0,
      bestLap: null,
      bestLapSecBeforeLastLap: null,
      recentLaps: [],
    };
  },

  applyDailyChallenge(challenge) {
    this.trackMedalBeforeLastLapWrite = null;
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.currentChallengeRun = this.createDailyChallengeRun(challenge);
    this.syncCurrentRunPolicy();
    this.setRuntimeConfig(
      applySkillPointAllocation(
        null,
        this.skillPoints?.getAllocation?.(),
      ),
    );

    const storedDaily = getDailyChallengeData(challenge.id);
    this.dailyChallengeBestResult = storedDaily ? { ...storedDaily } : null;
    this.bestLapTime = Number.isFinite(storedDaily?.bestTime)
      ? storedDaily.bestTime
      : null;
    const tk = challenge.trackKey;
    if (tk && Number.isFinite(storedDaily?.bestTime)) {
      const storedSec = Number(storedDaily.bestTime);
      const cur = this.sessionBestLapSecByTrackKey?.[tk];
      if (!Number.isFinite(cur) || storedSec < cur) {
        this.sessionBestLapSecByTrackKey[tk] = storedSec;
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

  async handleStartDailyChallenge() {
    if (
      this.status !== "ready" ||
      this.startButtonPending ||
      !this.activeDailyChallenge
    ) {
      return;
    }

    this.resetCanvasPresentation();
    this.startButtonPending = true;
    const playerTypeAlreadySent = this.sessionFlags.get("playerTypeSent");
    try {
      const challenge = this.activeDailyChallenge;
      if (challenge.trackKey && challenge.trackKey !== this.currentTrackKey) {
        await this.loadTrack(challenge.trackKey, {
          trackPageview: false,
          countMapSelection: true,
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
        const { isReturningPlayer } = await this.playerHistoryPromise;
        this.playerTypeSent = true;
        this.sessionFlags.set("playerTypeSent", "1");
        this.analytics.trackPlayerType(isReturningPlayer);
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
    const isCrashBudget = this.isCrashBudgetDailyChallenge(challenge);
    const finishMedal = getMedalForLapTime(challenge.trackKey, finalTime);
    const previousTrackMedal = isCrashBudget
      ? null
      : (this.hasTrackMedalBeforeLastLapWrite
          ? this.trackMedalBeforeLastLapWrite
          : readTrackLastLapMedal(challenge.trackKey));
    this.hasTrackMedalBeforeLastLapWrite = false;
    this.trackMedalBeforeLastLapWrite = null;
    writeTrackLastLapMedal(challenge.trackKey, finishMedal);
    const lapMedal = isCrashBudget ? null : readTrackLastLapMedal(challenge.trackKey);
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
    const previousPersonalBestSec = isCrashBudget
      ? undefined
      : storedChallengeBestSec != null
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
    this.hud.setBestTime(isCrashBudget ? null : this.bestLapTime, {
      persistToTrackCard: false,
    });
    this.hud.setHudPersonalBestsOpenAllowed(false);

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
        variant: isCrashBudget ? "daily-crash-budget" : null,
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
      },
    );
    if (this.modal.modalMsg) {
      this.modal.modalMsg.style.display = "";
      this.modal.modalMsg.textContent = isCrashBudget
        ? `${completedLaps} lap${completedLaps === 1 ? "" : "s"} before the final crash`
        : `${getDailyChallengeTrackName(challenge)} • ${getDailyChallengeObjectiveLabel(challenge)}`;
    }

    if (!isCrashBudget && trackKey && Number.isFinite(finalTime)) {
      if (!this.sessionBestLapSecByTrackKey) {
        this.sessionBestLapSecByTrackKey = Object.create(null);
      }
      const curSession = this.sessionBestLapSecByTrackKey[trackKey];
      if (!Number.isFinite(curSession) || finalTime < curSession) {
        this.sessionBestLapSecByTrackKey[trackKey] = finalTime;
      }
    }

    if (isNewBest) {
      const replayPayload = this.scoreboardReplay.getPayload(1);
      this.enqueueDailyChallengeVerificationSubmission({
        challenge,
        bestTime: finalTime,
        completedLaps,
        replay: replayPayload
          ? {
            ...replayPayload,
            skillPoints: this.skillPoints?.getAllocation?.() || null,
          }
          : null,
      });
    }
  },

  isValidatedWinData(winData) {
    if (!winData || typeof winData !== "object") return false;
    if (this.status !== "won") return false;
    if (winData.trackKey !== this.currentTrackKey) return false;
    if (winData.runId !== this.activeRunId) return false;

    const checkpointCount = this.currentTrack.checkpoints?.length || 0;
    if (winData.checkpointCount !== checkpointCount) return false;
    const endedOnCrash = Boolean(
      winData.challengeEndedOnCrash && this.isCrashBudgetDailyChallenge(),
    );
    if (!endedOnCrash && winData.completedCheckpointCount < checkpointCount) {
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
