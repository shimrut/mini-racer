import { CONFIG } from "../config.js";
import { updateSimulation, getCarRearAxleWorldPoint } from "./simulation.js";
import { getScoreboardReplayMaxFrames } from "./replay.js";
import { createModalActions } from "./result-flow.js";
import {
  PLAYER_SELECTABLE_CAR_ASSETS,
  STOCK_CAR_ASSET_NAME,
} from "../car/sprite.js";
import { readPlayerCarSkinAssetName } from "../car/player-car-skin.js";
import {
  getDailyChallengeCopyLabels,
} from "../daily-challenge/labels.js";
import {
  getDailyChallengeTrackName,
} from "../daily-challenge/service.js";
import { getTrackName } from "../track/catalog.js";
import { createPersonalBestPaceBaseline } from "../ghost/pb-pace.js";
import {
  PbGhostSizeCapture,
  shouldCapturePbGhostSize,
} from "../ghost/pb-ghost-size-debug.js";
import { normalizeLapCompletionTimesSec } from "../shared/lap-completion-times.js";

const CAMERA_DT_MIN_S = 1 / 120;
const CAMERA_DT_MAX_S = 1 / 45;
const SKID_GAP_BREAK_DIST_SQ = 0.45 * 0.45;
const COMPARISON_TIE_EPSILON_SEC = 0.005;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function chooseOpponentCarAsset({
  playerAssetName = STOCK_CAR_ASSET_NAME,
  random = Math.random,
} = {}) {
  const alternatives = PLAYER_SELECTABLE_CAR_ASSETS.filter(
    (assetName) => assetName !== playerAssetName,
  );
  const choices = alternatives.length > 0
    ? alternatives
    : PLAYER_SELECTABLE_CAR_ASSETS;
  if (choices.length === 0) return STOCK_CAR_ASSET_NAME;
  const sample = Number(random?.());
  const index = Number.isFinite(sample)
    ? Math.min(choices.length - 1, Math.max(0, Math.floor(sample * choices.length)))
    : 0;
  return choices[index] || STOCK_CAR_ASSET_NAME;
}

export function normalizeRaceComparisonTarget(rawTarget, {
  playerAssetName = STOCK_CAR_ASSET_NAME,
  random = Math.random,
  lapCount = 1,
} = {}) {
  if (!rawTarget || typeof rawTarget !== "object") return null;
  const finishTimeSec = finitePositive(
    rawTarget.finishTimeSec
      ?? rawTarget.bestTime
      ?? (finitePositive(rawTarget.finishTimeMs ?? rawTarget.bestTimeMs) ?? 0) / 1000,
  );
  if (!finishTimeSec) return null;
  const displayName = typeof rawTarget.displayName === "string"
    ? rawTarget.displayName.trim().slice(0, 64)
    : "";
  if (!displayName) return null;
  const checkpointTimesSec = Array.isArray(rawTarget.checkpointTimesSec)
    ? rawTarget.checkpointTimesSec.map(Number)
    : [];
  if (
    checkpointTimesSec.some((time) => !Number.isFinite(time) || time <= 0 || time >= finishTimeSec)
    || checkpointTimesSec.some((time, index) => index > 0 && time <= checkpointTimesSec[index - 1])
  ) {
    return null;
  }
  const lapCompletionTimesSec = normalizeLapCompletionTimesSec(
    finishTimeSec,
    rawTarget.lapCompletionTimesSec,
    lapCount,
  ) ?? [];
  const carAssetName = chooseOpponentCarAsset({ playerAssetName, random });
  return Object.freeze({
    kind: "leaderboard-opponent",
    displayName,
    finishTimeSec,
    checkpointTimesSec: Object.freeze(checkpointTimesSec),
    lapCompletionTimesSec: Object.freeze(lapCompletionTimesSec),
    rank: Number.isInteger(Number(rawTarget.rank)) && Number(rawTarget.rank) > 0
      ? Number(rawTarget.rank)
      : null,
    competitionId: typeof rawTarget.competitionId === "string"
      ? rawTarget.competitionId
      : null,
    mode: rawTarget.mode === "campaign" ? "campaign" : "daily",
    carAssetName,
  });
}

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * t;
}

/** Particle alpha is quantised to this many steps so same-colour particles batch into one fill. */
const PARTICLE_ALPHA_STEPS = 12;

function getSkidMarkStartIndex(skidMarks, frameSkip) {
  return frameSkip > 0 ? Math.max(0, skidMarks.length - 50) : 0;
}

function addSkidMarkSidePath(path, skidMarks, startIdx, gs, side) {
  const tw = 0.17;
  const m0 = skidMarks.get(startIdx);
  path.moveTo((m0.x + side * m0.sin * tw) * gs, (m0.y - side * m0.cos * tw) * gs);
  for (let i = startIdx + 1; i < skidMarks.length; i++) {
    const prev = skidMarks.get(i - 1);
    const mark = skidMarks.get(i);
    const dx = mark.x - prev.x;
    const dy = mark.y - prev.y;
    const x = (mark.x + side * mark.sin * tw) * gs;
    const y = (mark.y - side * mark.cos * tw) * gs;
    if (dx * dx + dy * dy > SKID_GAP_BREAK_DIST_SQ) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}

function drawSkidMarksImmediate(ctx, skidMarks, startIdx, gs) {
  ctx.beginPath();
  addSkidMarkSidePath(ctx, skidMarks, startIdx, gs, -1);
  ctx.stroke();

  ctx.beginPath();
  addSkidMarkSidePath(ctx, skidMarks, startIdx, gs, 1);
  ctx.stroke();
}

function getSkidMarkPathCache(engine, skidMarks, frameSkip, gs, startIdx) {
  const version = skidMarks.version ?? -1;
  const cache = engine._skidMarkPathCache;
  if (
    cache &&
    cache.version === version &&
    cache.length === skidMarks.length &&
    cache.frameSkip === frameSkip &&
    cache.gridSize === gs &&
    cache.startIdx === startIdx
  ) {
    return cache;
  }

  const leftPath = new Path2D();
  const rightPath = new Path2D();
  addSkidMarkSidePath(leftPath, skidMarks, startIdx, gs, -1);
  addSkidMarkSidePath(rightPath, skidMarks, startIdx, gs, 1);

  engine._skidMarkPathCache = {
    version,
    length: skidMarks.length,
    frameSkip,
    gridSize: gs,
    startIdx,
    leftPath,
    rightPath,
  };
  return engine._skidMarkPathCache;
}

export const raceEngineMethods = {
  installRaceComparisonTarget(rawTarget, {
    random = Math.random,
    track = this.currentTrack,
    lapCount = this.currentRunPolicy?.requiredLaps || 1,
  } = {}) {
    const paceBaseline = createPersonalBestPaceBaseline(rawTarget, track, lapCount);
    const target = normalizeRaceComparisonTarget({
      ...rawTarget,
      lapCompletionTimesSec: paceBaseline?.lapCompletionTimesSec
        ?? rawTarget?.lapCompletionTimesSec,
    }, {
      playerAssetName: this.getSelectedCarAssetName?.() || STOCK_CAR_ASSET_NAME,
      random,
      lapCount,
    });
    const ghostRecord = {
      bestTimeMs: Math.round((target?.finishTimeSec || 0) * 1000),
      ghost: rawTarget?.ghost ?? rawTarget?.opponentGhost ?? rawTarget?.frozenGhost,
      samples: rawTarget?.samples,
    };
    if (!target || this.pbGhost?.prepareOpponent?.(ghostRecord) !== true) {
      return null;
    }

    this.raceComparisonTarget = target;
    this.opponentCarSprite = this.opponentCarSprite || this.carSprite;
    const installLoadedSprite = (image) => {
      if (this.raceComparisonTarget !== target) return;
      this.opponentCarSprite = image;
      this.requestRender?.();
    };
    const installPlayerSpriteFallback = () => {
      if (this.raceComparisonTarget !== target) return;
      this.opponentCarSprite = this.carSprite;
      this.requestRender?.();
    };
    this.opponentCarSpriteLoader?.load?.(target.carAssetName, {
      onLoaded: installLoadedSprite,
      onError: () => {
        if (this.raceComparisonTarget !== target) return;
        if (target.carAssetName === STOCK_CAR_ASSET_NAME) {
          installPlayerSpriteFallback();
          return;
        }
        this.opponentCarSpriteLoader?.load?.(STOCK_CAR_ASSET_NAME, {
          onLoaded: installLoadedSprite,
          onError: installPlayerSpriteFallback,
        });
      },
    });
    return target;
  },

  clearRaceComparisonTarget() {
    const previous = this.raceComparisonTarget;
    this.raceComparisonTarget = null;
    this.pbGhost?.clearOpponent?.();
    this.opponentCarSprite = this.carSprite;
    return previous;
  },

  getRaceComparisonResult(finalTime) {
    const target = this.raceComparisonTarget;
    if (!target || !Number.isFinite(Number(finalTime))) return null;
    const deltaSec = Number(finalTime) - target.finishTimeSec;
    const outcome = Math.abs(deltaSec) <= COMPARISON_TIE_EPSILON_SEC
      ? "tie"
      : deltaSec < 0
        ? "won"
        : "lost";
    return Object.freeze({ outcome, deltaSec, target });
  },

  getActiveRacePaceBaseline() {
    return this.raceComparisonTarget || this.activePersonalBestPaceBaseline || null;
  },

  clearTimers() {
    this.activeTimers.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    this.activeTimers = [];
  },

  snapRenderPoseToCurrentPose() {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevAngle = this.angle;
  },

  getPbGhostSizeRunMetadata() {
    const challenge = this.activeDailyChallenge;
    const campaignStage = this.activeCampaignStage;
    const headToHead = this.activeHeadToHead;
    const rulesRevision = Number.isInteger(challenge?.rulesRevision)
      ? challenge.rulesRevision
      : Number.isInteger(campaignStage?.rulesRevision)
        ? campaignStage.rulesRevision
        : Number.isInteger(headToHead?.rulesRevision)
          ? headToHead.rulesRevision
          : Number.isInteger(this.currentRunPolicy?.rulesRevision)
            ? this.currentRunPolicy.rulesRevision
            : 0;
    const challengeId = challenge?.id
      || campaignStage?.raceId
      || headToHead?.challengeId
      || null;

    return {
      trackKey: this.currentTrackKey,
      mode: this.activeRaceMode,
      challengeId,
      rulesRevision,
      lapCount: this.currentRunPolicy?.requiredLaps || 1,
      position: this.pos,
      angle: this.angle,
    };
  },

  beginPbGhostSizeRun() {
    if (!this.pbGhostSizeCapture && shouldCapturePbGhostSize()) {
      this.pbGhostSizeCapture = new PbGhostSizeCapture();
    }
    this.pbGhostSizeCapture?.beginRun?.(this.getPbGhostSizeRunMetadata());
  },

  finishPbGhostSizeRun(winData) {
    if (!this.pbGhostSizeCapture) return;
    if (!this.pbGhostSizeCapture.recorder) {
      this.beginPbGhostSizeRun?.();
    }
    const finishTimeSec = Number.isFinite(winData?.lapTime)
      ? winData.lapTime
      : this.currentTime;
    void this.pbGhostSizeCapture.finishRun?.({
      finishTimeSec,
      position: this.pos,
      angle: this.angle,
      checkpointTimesSec: this.getLapCheckpointTimesSec?.() ?? null,
    }).catch?.((error) => {
      console.error('[PB ghost size] capture failed', error);
    });
  },

  _resetLapTrailAfterIntermediateLap() {
    this.routeTrace.clear();
    this.runHistory.clear();
    this.runHistoryTimer = 0;
    this.trailTimer = 0;
    this.recordRunPoint(getCarRearAxleWorldPoint(this.pos, this.angle, this.runtimeConfig));
  },

  startSequence() {
    if (this.status !== "ready") return;

    this.beginPbGhostSizeRun?.();
    this.status = "starting";
    this.activePersonalBestPaceBaseline = null;
    this.carEffectsAudio?.prepareOnUserGesture?.();
    this.medalEffectsAudio?.prepareOnUserGesture?.();
    this.proceduralMusic?.prepareOnUserGesture?.();
    this.hud.setHudPersonalBestsOpenAllowed(false);
    this.hud.setPauseVisible(false);
    const replayRulesRevision = Number.isInteger(this.activeDailyChallenge?.rulesRevision)
      ? this.activeDailyChallenge.rulesRevision
      : Number.isInteger(this.currentRunPolicy?.rulesRevision)
        ? this.currentRunPolicy.rulesRevision
        : 0;
    const replayLapCount = Math.max(
      1,
      Math.trunc(this.currentRunPolicy?.requiredLaps || 1),
    );
    this.scoreboardReplay.reset({
      maxFrames: getScoreboardReplayMaxFrames({
        rulesRevision: replayRulesRevision,
        lapCount: replayLapCount,
      }),
      targetLapNumber: replayLapCount,
      rulesRevision: replayRulesRevision,
    });
    this.runHadTimingAnomaly = false;
    this.rankedSubmissionBlockedReason = null;
    this.syncChallengeHudPrimaryStats();
    this.runHistory.clear();
    this.runHistoryTimer = 0;
    this.recordRunPoint(getCarRearAxleWorldPoint(this.pos, this.angle, this.runtimeConfig));
    this.startOverlay.hideStartOverlay();
    this.hud.showStartLights();

    this.activeTimers.push(
      setTimeout(() => {
        this.hud.turnOnCountdownLight(0);
        this.carEffectsAudio?.scheduleCountdownLight?.(0);
      }, 100),
    );
    this.activeTimers.push(
      setTimeout(() => {
        this.hud.turnOnCountdownLight(1);
        this.carEffectsAudio?.scheduleCountdownLight?.(1);
      }, 433),
    );
    this.activeTimers.push(
      setTimeout(() => {
        this.hud.turnOnCountdownLight(2);
        this.carEffectsAudio?.scheduleCountdownLight?.(2);
      }, 767),
    );

    this.activeTimers.push(
      setTimeout(() => {
        this.hud.hideStartLights();
        this.hud.showGoMessage();
        this.carEffectsAudio?.scheduleGo?.();

        this.pendingStartFrame = requestAnimationFrame((time) => {
          this.pendingStartFrame = null;
          const ghostStart = this.beginPersonalBestGhostRunAtGo?.()
            ?? { ghostActive: this.pbGhost?.beginRun?.() === true, noticeNeeded: false };
          this.snapRenderPoseToCurrentPose();
          this.accumulator = 0;
          this.status = "playing";
          this.activeRunId += 1;
          this.currentTime = 0;
          this.lapCheckpointTimesSec = [];
          this.lastTime = time;
          this.resetFrameTimingHistory();
          this.frameSkip = 0;
          this.hud.setPauseVisible(true);
          this.updateDailyChallengeHud();
          this.requestRender();

          this.activeTimers.push(
            setTimeout(() => {
              this.hud.resetCountdown();
              if (ghostStart.noticeNeeded) {
                this.hud.showGhostUnavailableNotice?.();
              }
            }, 300),
          );
        });
      }, 1100),
    );
  },

  setSteeringSource(direction, sourceId, isDown) {
    this.steeringInput.setSource(direction, sourceId, isDown);
  },

  setTouchSteering(direction, isDown) {
    this.steeringInput.setTouch(direction, isDown);
  },

  getSteeringDirection(event) {
    return this.steeringInput.getDirection(event);
  },

  getSteeringSourceId(event, direction) {
    return this.steeringInput.getSourceId(event, direction);
  },

  clearSteeringInput() {
    this.steeringInput.clearSources();
    this.interactions.resetTouchControls();
  },

  armRelaunchDelay(delaySeconds) {
    this.clearSteeringInput();
    this.relaunchDelayRemaining = delaySeconds;
  },

  restartCurrentRunAfterCollision() {
    this.status = "playing";
    this.pbGhost?.beginRun?.();
    this.pbGhostSizeCapture?.cancelRun?.();
    this.scoreboardReplay.reset();
    this.runHadTimingAnomaly = false;
    this.rankedSubmissionBlockedReason = null;
    this.resetChallengeRunAfterCollisionRestart();
    this.resetRunToTrackStart({
      currentTime: 0,
      relaunchDelay: this.collisionRestartDelaySec,
    });
    this.beginPbGhostSizeRun?.();
    this.modal.closeModal();
    this.hud.setPauseVisible(true);
    this.hud.setHudPersonalBestsOpenAllowed(false);
    this.hud.syncHud({ time: 0, speed: 0, force: true });
    this.updateDailyChallengeHud();
    this.accumulator = 0;
    this.lastTime = this.getNow();
    this.requestRender();
  },

  resetChallengeRunAfterCollisionRestart() {
    if (!this.currentChallengeRun) return;
    this.currentChallengeRun.completedLaps = 0;
    this.currentChallengeRun.lastLapAt = 0;
    this.currentChallengeRun.bestLap = null;
    this.currentChallengeRun.bestLapSecBeforeLastLap = null;
    this.currentChallengeRun.recentLaps = [];
  },

  resetRunToTrackStart({ currentTime = 0, relaunchDelay = 0 } = {}) {
    this.pos = { ...this.currentTrack.startPos };
    this.prevPos = { ...this.currentTrack.startPos };
    this.velocity = { x: 0, y: 0 };
    this.angle = this.currentTrack.startAngle;
    this.prevAngle = this.currentTrack.startAngle;
    this.cachedSpeed = 0;
    this.angularVelocity = 0;
    this.currentTime = currentTime;
    this.wallImpactCooldownRemaining = 0;
    this.wallContactActive = false;
    this.wallContactReleaseRemaining = 0;
    this.lapCheckpointTimesSec = [];
    this.runHadTimingAnomaly = false;
    this.rankedSubmissionBlockedReason = null;
    this.armRelaunchDelay(relaunchDelay);
    this.nextCheckpointIndex = 0;
    this.skidMarks.clear();
    this._resetLapTrailAfterIntermediateLap();
  },

  getLapCheckpointTimesSec() {
    return Array.isArray(this.lapCheckpointTimesSec)
      ? this.lapCheckpointTimesSec.slice()
      : [];
  },

  handleCheckpointPassed({ index, splitTimeSec }) {
    if (!Number.isFinite(splitTimeSec) || index < 0) return;

    void this.journeys?.progressCheckpoint?.(
      index,
      this.currentTrack?.checkpoints?.length || 0,
    );

    const raceKey = this.activeDailyChallenge?.id || this.currentTrackKey;
    const pbTimes = this.raceComparisonTarget?.checkpointTimesSec
      ?? this.getActiveRacePaceBaseline?.()?.checkpointTimesSec
      ?? (
        raceKey && this.sessionBestCheckpointTimesByTrackKey
          ? this.sessionBestCheckpointTimesByTrackKey[raceKey]
          : null
      );
    const pbSec = Array.isArray(pbTimes) ? pbTimes[index] : undefined;
    const deltaVsBest = Number.isFinite(pbSec)
      ? splitTimeSec - pbSec
      : undefined;

    this.hud.showCheckpointFlash({
      checkpointNumber: index + 1,
      splitTimeSec,
      deltaVsBest,
    });
  },

  getSelectedCarAssetName() {
    return readPlayerCarSkinAssetName();
  },

  syncCarSpriteAsset() {
    return this.loadCarSpriteAsset(this.getSelectedCarAssetName());
  },

  prefetchCarSpriteAsset(assetName) {
    return this.carSpriteLoader.prefetch(assetName);
  },

  loadCarSpriteAsset(assetName) {
    return new Promise((resolve) => {
      this.carSpriteLoader.load(assetName, {
        onLoaded: (image) => {
          this.carSprite = image;
          this.carSpriteDrawWidth = 52;
          this.carSpriteDrawHeight = 52;
          this.dailyCarousel?.refreshPreviews?.();
          this.campaignCarousel?.refreshPreviews?.();
          this.requestRender();
          resolve(image);
        },
        onError: (name) => {
          console.warn(`Unable to load ${name}; using fallback car sprite.`);
          this.dailyCarousel?.refreshPreviews?.();
          this.campaignCarousel?.refreshPreviews?.();
          resolve(this.carSprite);
        },
        onSuperseded: () => {
          resolve(this.carSprite);
        },
      });
    });
  },

  handleKey(event, isDown) {
    if (!event.key && !event.code) return;
    const isEscape =
      event.key === "Escape" || event.code === "Escape";
    if (
      isDown &&
      isEscape &&
      this.status === "ready" &&
      this.startOverlay?.isStartOverlayVisible?.() &&
      this.garage?.isGarageOpen?.()
    ) {
      event.preventDefault?.();
      this.garage.setPanelVisible(false);
      return;
    }
    if (
      isDown &&
      isEscape &&
      this.status === "paused" &&
      this.modal?.isPauseModalActive?.()
    ) {
      event.preventDefault?.();
      this.resumeActiveRun();
      return;
    }
    if (
      isDown &&
      !this.isCoarsePointer &&
      isEscape &&
      this.status === "playing"
    ) {
      event.preventDefault?.();
      this.pauseActiveRun();
      return;
    }
    const isPlainR =
      isDown &&
      event.key.toLowerCase() === "r" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey;
    if (isPlainR) {
      if (this.modal?.isModalActive?.() && this.modal.isStandaloneRunsViewActive()) {
        event.preventDefault();
        this.modal.closeModal();
        return;
      }
      if (
        this.status === "playing" ||
        this.status === "paused" ||
        this.modal?.isModalActive?.()
      ) {
        event.preventDefault();
        if (this.currentChallengeRun) {
          if (typeof this.restartActiveRace === "function") {
            this.restartActiveRace();
          } else {
            this.restartDailyChallenge({ reason: "restart" });
          }
        } else {
          this.reset(true);
        }
        return;
      }
    }
    const steeringDirection = this.getSteeringDirection(event);
    if (steeringDirection) {
      event.preventDefault?.();
      this.setSteeringSource(
        steeringDirection,
        this.getSteeringSourceId(event, steeringDirection),
        isDown,
      );
    }
  },

  pauseActiveRun() {
    if (this.status !== "playing") return;

    this.clearSteeringInput();
    this.status = "paused";
    void this.journeys?.interaction?.("pause");

    const rawBestTime = this.bestLapTime;
    const bestTime = Number.isFinite(rawBestTime) && rawBestTime > 0
      ? rawBestTime
      : null;
    const deltaToBest =
      bestTime === null || bestTime === undefined
        ? null
        : this.currentTime - bestTime;
    this.modal.showModal(
      "PAUSED",
      null,
      {
        variant: "daily-pause",
        lapTime: this.currentTime,
        bestTime,
        deltaToBest,
        primaryStatLabel: getDailyChallengeCopyLabels(this.activeDailyChallenge)
          .primaryStatLabel,
      },
      {
        ...createModalActions({
          modalKind: "pause",
          primaryActionLabel: "Resume",
          primaryAction: () => this.resumeActiveRun(),
          restartAction: () => this.restartActiveRace(),
          secondaryActionLabel: this.activeRaceMode === "daily" ? "Done" : "Back",
          secondaryAction: () => this.returnToActiveLobby(),
        }),
        pauseTrackPreview: {
          trackKey: this.currentTrackKey,
          skin: this.activeDailyChallenge?.skin ?? null,
          trackName: this.activeDailyChallenge
            ? getDailyChallengeTrackName(this.activeDailyChallenge)
            : getTrackName(this.currentTrackKey, this.currentTrackKey),
          bestTime,
        },
        settingsAction: () => this.settings.openSettings(),
        playlistAction: this.activeRaceMode === "daily"
          ? () => void this.openDailyChallengePlaylist()
          : null,
      },
    );
  },

  resumeActiveRun() {
    if (this.status !== "paused") return;

    this.carEffectsAudio?.prepareOnUserGesture?.();
    this.medalEffectsAudio?.prepareOnUserGesture?.();
    this.proceduralMusic?.prepareOnUserGesture?.();
    this.status = "playing";
    void this.journeys?.interaction?.("resume");
    this.armRelaunchDelay(this.runtimeConfig.resumeRelaunchDelay);
    this.accumulator = 0;
    this.lastTime = this.getNow();
    this.modal.closeModal();
    this.updateDailyChallengeHud();
    this.requestRender();
  },

  update(dt) {
    if (this.status === "playing") {
      this.scoreboardReplay.record(
        Boolean(this.keys.left),
        Boolean(this.keys.right),
        this.relaunchDelayRemaining > 0,
      );
    }

    const events = updateSimulation(
      this,
      dt,
      this.runtimeConfig,
      this.currentTrack,
      this.collisionSegments,
    );

    this.pbGhostSizeCapture?.sample?.({
      timeSec: this.currentTime,
      position: this.pos,
      angle: this.angle,
    });

    if (events.wallImpact?.kind === "scrape") {
      this.carEffectsAudio?.scheduleScrape?.(
        events.wallImpact.impactKph,
        events.wallImpact.severity,
      );
      if (this.collisionAutoRestartEnabled) {
        this.restartCurrentRunAfterCollision();
        return;
      }
    }

    if (events.checkpointPassed) {
      this.handleCheckpointPassed(events.checkpointPassed);
    }

    if (events.challengeLapCompleted) {
      this.pbGhostSizeCapture?.recordLapCompletion?.(
        events.challengeElapsedTime,
      );
      this.handleActiveRaceLapCompleted(events.challengeCompletedLapTime, {
        elapsedTimeSec: events.challengeElapsedTime,
        completedLaps: events.challengeProgressLaps,
        requiredLaps: events.challengeRequiredLaps,
        isFinalLap: events.challengeIsFinalLap,
      });
    }
    if (events.winTriggered) {
      this.finishPbGhostSizeRun?.(events.winData);
      this.handleActiveRaceWin(events.winData);
    }
  },

  reset(
    autoStart = false,
    {
      preserveDailyChallenge = false,
      preserveRaceComparisonTarget = preserveDailyChallenge,
      showStartOverlay = !autoStart,
    } = {},
  ) {
    this.pbGhostSizeCapture?.cancelRun?.();
    if (!autoStart) {
      void this.journeys?.endAttempt?.({ complete: false });
    }
    this.clearTimers();
    if (this.pendingStartFrame !== null) {
      cancelAnimationFrame(this.pendingStartFrame);
      this.pendingStartFrame = null;
    }

    const dailyChallengeToRestore = preserveDailyChallenge
      ? this.activeDailyChallenge
      : null;

    this.pos = { ...this.currentTrack.startPos };
    this.prevPos = { ...this.currentTrack.startPos };
    this.velocity = { x: 0, y: 0 };
    this.angle = this.currentTrack.startAngle;
    this.prevAngle = this.currentTrack.startAngle;
    this.cachedSpeed = 0;
    this.angularVelocity = 0;
    this.lapCheckpointTimesSec = [];
    this.activePersonalBestPaceBaseline = null;
    this.clearSteeringInput();
    this.relaunchDelayRemaining = 0;
    this.wallImpactCooldownRemaining = 0;
    this.wallContactActive = false;
    this.wallContactReleaseRemaining = 0;
    this.status = "ready";
    this.activeRunId += 1;
    this.nextCheckpointIndex = 0;
    this.accumulator = 0;
    this.currentTime = 0;
    this.runHadTimingAnomaly = false;
    this.rankedSubmissionBlockedReason = null;
    this.skidMarks.clear();
    this.routeTrace.clear();
    this.runHistory.clear();
    this.runHistoryTimer = 0;
    this.particles = [];
    if (!preserveRaceComparisonTarget) {
      this.clearRaceComparisonTarget?.();
    }
    if (dailyChallengeToRestore) {
      this.currentChallengeRun = null;
      this.dailyChallengeBestResult = null;
      this.syncCurrentRunPolicy();
    } else {
      this.clearDailyChallengeRun();
    }
    this.modal.closeModal();
    this.hud.setHudPersonalBestsOpenAllowed(false);
    this.hud.setPauseVisible(false);

    this.hud.resetCountdown();
    this.hud.resetHud();
    if (dailyChallengeToRestore) {
      this.applyDailyChallenge(dailyChallengeToRestore);
    }

    this._lookAheadX = 0;
    this._lookAheadY = 0;

    if (!showStartOverlay) {
      this.startOverlay.hideStartOverlay();
    } else {
      this.startOverlay.showStartOverlay(this.hasAnyData, this.isReturningPlayer);
    }

    this.resize({ render: false });
    const cw =
      this.viewportWidth || this.container.clientWidth || this.canvas.width;
    const ch =
      this.viewportHeight || this.container.clientHeight || this.canvas.height;
    const gs = CONFIG.gridSize;
    this.camera.x = this.pos.x * gs - cw / 2 / this.zoom;
    this.camera.y = this.pos.y * gs - ch / 2 / this.zoom;
    this.requestRender();

    if (autoStart) {
      this.startSequence();
    }
  },

  recordRunPoint(point) {
    const roundedX = Math.round(point.x * 1000) / 1000;
    const roundedY = Math.round(point.y * 1000) / 1000;
    const last = this.runHistory.last();
    if (
      last &&
      Math.abs(last.x - roundedX) < 0.001 &&
      Math.abs(last.y - roundedY) < 0.001
    ) {
      return;
    }
    const slot = this.runHistory.write();
    slot.x = roundedX;
    slot.y = roundedY;
  },

  getDesiredLookAhead(speed, cw, ch, mobileCameraMode) {
    const out = this._desiredLookAhead;
    out.x = 0;
    out.y = 0;

    if (speed > 1) {
      const multiplier = mobileCameraMode ? 12 : 5;
      const maxOffset = mobileCameraMode
        ? Math.min(cw, ch) / 2.5
        : Math.min(cw, ch) / 5;

      out.x = this.velocity.x * multiplier;
      out.y = this.velocity.y * multiplier;

      const magnitude = Math.hypot(out.x, out.y);
      if (magnitude > maxOffset) {
        out.x = (out.x / magnitude) * maxOffset;
        out.y = (out.y / magnitude) * maxOffset;
      }
    }

    return out;
  },

  render(dt, alpha = 1) {
    const ctx = this.ctx;
    const cw =
      this.viewportWidth || this.container.clientWidth || this.canvas.width;
    const ch =
      this.viewportHeight || this.container.clientHeight || this.canvas.height;
    const gs = CONFIG.gridSize;

    const displayPos = this._displayPos;
    if (this.status === "playing") {
      displayPos.x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
      displayPos.y = this.prevPos.y + (this.pos.y - this.prevPos.y) * alpha;
    } else {
      displayPos.x = this.pos.x;
      displayPos.y = this.pos.y;
    }
    const displayAngle =
      this.status === "playing"
        ? lerpAngle(this.prevAngle, this.angle, alpha)
        : this.angle;

    ctx.clearRect(0, 0, cw, ch);

    const speed = this.cachedSpeed;
    const mobileCameraMode = this.isCoarsePointer || this.isNarrowViewport;
    this.zoom = mobileCameraMode ? 0.75 : 1.0;

    const desiredLookAhead = this.getDesiredLookAhead(
      speed,
      cw,
      ch,
      mobileCameraMode,
    );

    const smoothSpeed = mobileCameraMode ? 2 : 4;
    const cameraDt =
      dt > 0 ? Math.min(Math.max(dt, CAMERA_DT_MIN_S), CAMERA_DT_MAX_S) : 0;
    const lerpFactor = cameraDt > 0 ? 1 - Math.exp(-cameraDt * smoothSpeed) : 0;

    this._lookAheadX += (desiredLookAhead.x - this._lookAheadX) * lerpFactor;
    this._lookAheadY += (desiredLookAhead.y - this._lookAheadY) * lerpFactor;

    this.camera.x = displayPos.x * gs + this._lookAheadX - cw / 2 / this.zoom;
    this.camera.y = displayPos.y * gs + this._lookAheadY - ch / 2 / this.zoom;

    this.drawVisibleTrackCanvas();

    ctx.save();
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    if (this.skidMarks.length > 0) {
      const startIdx = getSkidMarkStartIndex(this.skidMarks, this.frameSkip);
      const z = this.zoom;

      ctx.save();
      ctx.strokeStyle = CONFIG.skidColor;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(3.4, 4.2 / z);

      if (typeof Path2D === "function") {
        const skidPathCache = getSkidMarkPathCache(
          this,
          this.skidMarks,
          this.frameSkip,
          gs,
          startIdx,
        );
        ctx.stroke(skidPathCache.leftPath);
        ctx.stroke(skidPathCache.rightPath);
      } else {
        drawSkidMarksImmediate(ctx, this.skidMarks, startIdx, gs);
      }
      ctx.restore();
    }

    if (this.routeTraceStrokeStyle !== null && this.routeTrace.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle =
        this.routeTraceStrokeStyle ?? "rgba(56, 189, 248, 0.5)";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      const firstPt = this.routeTrace.get(0);
      ctx.moveTo(firstPt.x * gs, firstPt.y * gs);
      const traceStep = Math.max(
        this.frameSkip > 0 ? 2 : 1,
        Math.ceil(this.routeTrace.length / 240),
      );
      for (let i = traceStep; i < this.routeTrace.length; i += traceStep) {
        const pt = this.routeTrace.get(i);
        ctx.lineTo(pt.x * gs, pt.y * gs);
      }
      const lastTracePoint = this.routeTrace.get(this.routeTrace.length - 1);
      ctx.lineTo(lastTracePoint.x * gs, lastTracePoint.y * gs);
      ctx.lineTo(displayPos.x * gs, displayPos.y * gs);
      ctx.stroke();
    }

    if (this.particles.length > 0) {
      // Buckets persist across frames and are emptied by resetting length, so a
      // race no longer churns a Map plus one string key per particle per frame.
      const buckets = this._particleBuckets;
      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i];
        const rawAlpha =
          particle.maxLife > 0 ? particle.life / particle.maxLife : 0;
        const alphaStep = Math.max(
          0,
          Math.min(PARTICLE_ALPHA_STEPS, Math.round(rawAlpha * PARTICLE_ALPHA_STEPS)),
        );
        let byAlphaStep = buckets.get(particle.color);
        if (!byAlphaStep) {
          byAlphaStep = [];
          for (let step = 0; step <= PARTICLE_ALPHA_STEPS; step++) {
            byAlphaStep.push([]);
          }
          buckets.set(particle.color, byAlphaStep);
        }
        byAlphaStep[alphaStep].push(particle);
      }
      for (const [color, byAlphaStep] of buckets) {
        ctx.fillStyle = color;
        for (let step = 0; step <= PARTICLE_ALPHA_STEPS; step++) {
          const list = byAlphaStep[step];
          if (list.length === 0) continue;
          ctx.globalAlpha = step / PARTICLE_ALPHA_STEPS;
          ctx.beginPath();
          for (let i = 0; i < list.length; i++) {
            const particle = list[i];
            const px = particle.x * gs;
            const py = particle.y * gs;
            ctx.moveTo(px + particle.size, py);
            ctx.arc(px, py, particle.size, 0, Math.PI * 2);
          }
          ctx.fill();
          list.length = 0;
        }
      }
      ctx.globalAlpha = 1.0;
    }

    const px = displayPos.x * gs;
    const py = displayPos.y * gs;
    const renderScale = CONFIG.carSpriteRenderScale ?? 1;
    const drawWidth = this.carSpriteDrawWidth * renderScale;
    const drawHeight = this.carSpriteDrawHeight * renderScale;
    const ghostRaceTimeSec = this.status === "playing"
      ? Math.max(0, this.currentTime - this.FIXED_DT * (1 - alpha))
      : this.currentTime;
    this.pbGhost?.render?.(ctx, {
      raceTimeSec: ghostRaceTimeSec,
      gridSize: gs,
      carSprite: this.raceComparisonTarget
        ? (this.opponentCarSprite || this.carSprite)
        : this.carSprite,
      drawWidth,
      drawHeight,
    });

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(displayAngle);

    if (this.qualityLevel <= 0) {
      ctx.shadowColor = CONFIG.carSpriteShadowColor;
      ctx.shadowBlur = CONFIG.carSpriteShadowBlur;
      ctx.shadowOffsetX = CONFIG.carSpriteShadowOffsetX;
      ctx.shadowOffsetY = CONFIG.carSpriteShadowOffsetY;
    }
    ctx.drawImage(
      this.carSprite,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight,
    );

    ctx.restore();
    ctx.restore();
  },

  loop(now) {
    this._frameRequestId = null;

    const rawDt = Math.min((now - this.lastTime) / 1000, 0.1);
    const frameTime = now - this.lastTime;
    this.lastTime = now;

    const animateFrame = this.shouldAnimateFrame();
    const shouldUpdate = this.status === "playing";
    const timingAnomalyMessage = "Leaderboard rank disabled because the run had severe frame stalls.";

    if (shouldUpdate && frameTime >= 250) {
      this.runHadTimingAnomaly = true;
      this.rankedSubmissionBlockedReason = timingAnomalyMessage;
    }

    if (frameTime < 250) {
      this.frameTimeTotal -= this.frameTimeHistory[this.frameTimeHistoryIndex] || 0;
      this.frameTimeHistory[this.frameTimeHistoryIndex] = frameTime;
      this.frameTimeTotal += frameTime;
      this.frameTimeHistoryIndex =
        (this.frameTimeHistoryIndex + 1) % Math.max(1, 30);

      const sampleCount = Math.min(this.frameTimeHistory.length, 30);
      const avgFrameTime = sampleCount > 0 ? this.frameTimeTotal / sampleCount : frameTime;
      if (avgFrameTime >= 22) this.frameSkip = 1;
      else if (avgFrameTime <= 18) this.frameSkip = 0;
    }

    if (shouldUpdate) {
      this.accumulator += rawDt;
      let stepCount = 0;
      const maxStepsPerFrame = 3;
      while (this.accumulator >= this.FIXED_DT && stepCount < maxStepsPerFrame) {
        this.prevPos.x = this.pos.x;
        this.prevPos.y = this.pos.y;
        this.prevAngle = this.angle;
        this.update(this.FIXED_DT);
        this.accumulator -= this.FIXED_DT;
        stepCount++;
      }
      if (this.accumulator >= this.FIXED_DT) {
        this.runHadTimingAnomaly = true;
        this.rankedSubmissionBlockedReason = timingAnomalyMessage;
        this.accumulator = 0;
      }
    }

    if (animateFrame || this._needsRender) {
      const alpha = shouldUpdate ? this.accumulator / this.FIXED_DT : 1;
      this.render(rawDt, alpha);
      this._needsRender = false;
    }

    if (shouldUpdate && this.status === "playing") {
      this.hud.syncHud({ time: this.currentTime, speed: this.cachedSpeed });
    }

    const cs = this.cachedSpeed;
    const vx = Math.cos(this.angle);
    const vy = Math.sin(this.angle);
    const sideSlip = Math.abs(-vy * this.velocity.x + vx * this.velocity.y);
    const slipRatio = cs > 0.001 ? sideSlip / cs : 0;
    this.carEffectsAudio?.syncFrame?.({
      status: this.status,
      speed: cs,
      maxSpeedKph: this.runtimeConfig.maxSpeed,
      slipRatio,
      throttleBlocked: this.relaunchDelayRemaining > 0,
    });
    this.proceduralMusic?.syncFrame?.({
      status: this.status,
      speed: cs,
      maxSpeedKph: this.runtimeConfig.maxSpeed,
    });

    if (animateFrame || shouldUpdate || this._needsRender) {
      this.requestFrame();
    }
  },
};
