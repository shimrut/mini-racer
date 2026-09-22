import { getLargestPbGhostSizeReport } from "../ghost/pb-ghost-size-debug.js";

export function renderGameToText(engine) {
  return JSON.stringify({
    coordinateSystem:
      "origin top-left, x increases right, y increases down, units are track-grid cells",
    mode: engine.status,
    lobbyMode: engine.lobbyUi?.getMode?.() || null,
    raceMode: engine.activeRaceMode,
    startupUi: {
      loadingActive: document.body.classList.contains("loading-active"),
      overlayReady: engine.startOverlay?.startOverlay?.classList?.contains?.("is-ready") || false,
      interactive: engine.startOverlay?._isInteractive === true,
    },
    track: engine.currentTrackKey,
    player: {
      x: Number(engine.pos.x.toFixed(2)),
      y: Number(engine.pos.y.toFixed(2)),
      angle: Number(engine.angle.toFixed(3)),
      angularVelocity: Number(engine.angularVelocity.toFixed(3)),
      velocityX: Number(engine.velocity.x.toFixed(2)),
      velocityY: Number(engine.velocity.y.toFixed(2)),
      speed: Number(engine.cachedSpeed.toFixed(2)),
      wallImpactCooldownSec: Number((Number(engine.wallImpactCooldownRemaining) || 0).toFixed(3)),
      wallContactActive: Boolean(engine.wallContactActive),
      wallContactReleaseSec: Number((Number(engine.wallContactReleaseRemaining) || 0).toFixed(3)),
    },
    lapTime: Number(engine.currentTime.toFixed(3)),
    challenge: engine.currentChallengeRun
      ? {
          completedLaps: engine.currentChallengeRun.completedLaps || 0,
          requiredLaps: engine.currentChallengeRun.requiredLaps || 1,
          currentLap: Math.min(
            (engine.currentChallengeRun.completedLaps || 0) + 1,
            engine.currentChallengeRun.requiredLaps || 1,
          ),
          intermediateMedalFlash:
            engine.hud?.lapFlash?.classList?.contains?.("visible")
              ? engine.hud?.lapFlashMedal?.dataset?.medal || null
              : null,
        }
      : null,
    campaignRaceId: engine.activeCampaignStage?.raceId || null,
    playerChallengeId: engine.activeHeadToHead?.challengeId || null,
    raceComparison: engine.raceComparisonTarget
      ? {
          displayName: engine.raceComparisonTarget.displayName,
          finishTimeSec: engine.raceComparisonTarget.finishTimeSec,
          rank: engine.raceComparisonTarget.rank,
          carAssetName: engine.raceComparisonTarget.carAssetName,
        }
      : null,
    startLine: engine.currentTrack.startLine,
    routeTracePoints: engine.routeTrace.length,
    liveParticles: engine.particles.length,
  });
}

export function exposeTestHooks(engine) {
  const renderText = () => renderGameToText(engine);
  const advanceTime = (ms) => engine.advanceTime(ms);
  const getPbGhostSizeReports = () => (
    engine.pbGhostSizeCapture?.getReports?.() || []
  );
  const getLastPbGhostSizeReport = () => (
    engine.pbGhostSizeCapture?.getLastReport?.() || null
  );
  const getLargestPbGhostSizeReportForDebug = () => (
    getLargestPbGhostSizeReport(engine.pbGhostSizeCapture?.getReports?.() || [])
  );

  window.__RACER_DEBUG__ = Object.freeze({
    renderGameToText: renderText,
    advanceTime,
    getPbGhostSizeReports,
    getLastPbGhostSizeReport,
    getLargestPbGhostSizeReport: getLargestPbGhostSizeReportForDebug,
  });
  window.render_game_to_text = renderText;
  window.advanceTime = advanceTime;
}
