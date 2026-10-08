import { describe, expect, it, vi } from 'vitest';
import { PbGhost } from '../game/ghost/pb-ghost.js';
import {
  chooseOpponentCarAsset,
  normalizeRaceComparisonTarget,
  raceEngineMethods,
} from '../game/race/engine-methods.js';
import {
  PLAYER_SELECTABLE_CAR_ASSETS,
  STOCK_CAR_ASSET_NAME,
} from '../game/car/sprite.js';
import { RaceHud } from '../game/race/ui-hud.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { campaignEngineMethods } from '../game/campaign/engine-methods.js';
import { trackEngineMethods } from '../game/track/engine-methods.js';
import { loadRaceDefinitions } from '../game/track/client-registry.js';

const ghost = {
  schemaVersion: 2,
  sampleIntervalMs: 50,
  finishTimeMs: 100,
  origin: [100, 200, 0],
  deltas: [100, 100, 0, 100, 100, 0],
};

describe('leaderboard race comparison target', () => {
  it('chooses one shipped opponent skin and excludes the live skin', () => {
    const selected = PLAYER_SELECTABLE_CAR_ASSETS[0];
    const chosen = chooseOpponentCarAsset({
      playerAssetName: selected,
      random: () => 0,
    });
    expect(PLAYER_SELECTABLE_CAR_ASSETS).toContain(chosen);
    expect(chosen).not.toBe(selected);
  });

  it('normalizes and freezes opponent identity, time, checkpoints, and skin', () => {
    const target = normalizeRaceComparisonTarget({
      displayName: '  Rival  ',
      bestTimeMs: 12_500,
      checkpointTimesSec: [3, 8],
      rank: 4,
      competitionId: 'daily-1',
    }, {
      playerAssetName: STOCK_CAR_ASSET_NAME,
      random: () => 0,
    });

    expect(target).toMatchObject({
      displayName: 'Rival',
      finishTimeSec: 12.5,
      checkpointTimesSec: [3, 8],
      rank: 4,
      competitionId: 'daily-1',
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.checkpointTimesSec)).toBe(true);
  });

  it('rejects invalid target times and checkpoint ordering', () => {
    expect(normalizeRaceComparisonTarget({
      displayName: 'Rival',
      finishTimeSec: 0,
    })).toBe(null);
    expect(normalizeRaceComparisonTarget({
      displayName: 'Rival',
      finishTimeSec: 10,
      checkpointTimesSec: [7, 6],
    })).toBe(null);
  });

  it('installs one opponent for retries, classifies outcomes, and falls back to the stock sprite', () => {
    const pbGhost = new PbGhost({ enabled: false });
    const playerSprite = { id: 'player' };
    const stockSprite = { id: 'stock' };
    const engine = {
      pbGhost,
      carSprite: playerSprite,
      opponentCarSprite: null,
      opponentCarSpriteLoader: {
        load: vi.fn((assetName, callbacks) => {
          if (assetName === STOCK_CAR_ASSET_NAME) callbacks.onLoaded(stockSprite);
          else callbacks.onError();
        }),
      },
      getSelectedCarAssetName: () => STOCK_CAR_ASSET_NAME,
      requestRender: vi.fn(),
      raceComparisonTarget: null,
    };

    const target = raceEngineMethods.installRaceComparisonTarget.call(engine, {
      displayName: 'Rival',
      finishTimeSec: 0.1,
      checkpointTimesSec: [0.05],
      ghost,
      rank: 2,
    }, { random: () => 0 });

    expect(target?.displayName).toBe('Rival');
    expect(engine.opponentCarSprite).toBe(stockSprite);
    expect(pbGhost.beginRun()).toBe(true);
    const win = raceEngineMethods.getRaceComparisonResult.call(engine, 0.09);
    expect(win?.outcome).toBe('won');
    expect(win?.deltaSec).toBeCloseTo(-0.01);
    expect(raceEngineMethods.getRaceComparisonResult.call(engine, 0.104)).toMatchObject({
      outcome: 'tie',
    });
    expect(raceEngineMethods.getRaceComparisonResult.call(engine, 0.11)).toMatchObject({
      outcome: 'lost',
    });

    expect(raceEngineMethods.clearRaceComparisonTarget.call(engine)).toBe(target);
    expect(engine.raceComparisonTarget).toBe(null);
    expect(pbGhost.getPose(0.025)).toBe(null);
  });

  it('uses opponent checkpoints for race flashes without replacing PB state', () => {
    const showCheckpointFlash = vi.fn();
    const engine = {
      raceComparisonTarget: { checkpointTimesSec: [4, 9] },
      sessionBestCheckpointTimesByTrackKey: { 'daily-1': [5, 10] },
      activeDailyChallenge: { id: 'daily-1', trackKey: 'track-1' },
      currentTrack: { checkpoints: [{}, {}] },
      journeys: { progressCheckpoint: vi.fn() },
      hud: { showCheckpointFlash },
    };

    raceEngineMethods.handleCheckpointPassed.call(engine, {
      index: 1,
      splitTimeSec: 8.5,
    });

    expect(showCheckpointFlash).toHaveBeenCalledWith({
      checkpointNumber: 2,
      splitTimeSec: 8.5,
      deltaVsBest: -0.5,
    });
    expect(engine.sessionBestCheckpointTimesByTrackKey['daily-1']).toEqual([5, 10]);
  });

  it('uses the frozen Campaign PB checkpoint baseline keyed by stage id', () => {
    const showCheckpointFlash = vi.fn();
    const engine = {
      raceComparisonTarget: null,
      activePersonalBestPaceBaseline: { checkpointTimesSec: [4, 9] },
      getActiveRacePaceBaseline: raceEngineMethods.getActiveRacePaceBaseline,
      sessionBestCheckpointTimesByTrackKey: {
        'numbered-v1-00': [5, 10],
        numberZero: [50, 100],
      },
      activeDailyChallenge: {
        id: 'numbered-v1-00',
        trackKey: 'numberZero',
      },
      currentTrack: { checkpoints: [{}, {}] },
      journeys: { progressCheckpoint: vi.fn() },
      hud: { showCheckpointFlash },
    };

    raceEngineMethods.handleCheckpointPassed.call(engine, {
      index: 1,
      splitTimeSec: 8.5,
    });

    expect(showCheckpointFlash).toHaveBeenCalledWith({
      checkpointNumber: 2,
      splitTimeSec: 8.5,
      deltaVsBest: -0.5,
    });
  });

  it('presents the frozen opponent name and finish time in the HUD target slot', () => {
    const setHudBestMetric = vi.fn();
    const hud = {
      setHudBestMetric,
    };

    RaceHud.prototype.setComparisonTarget.call(hud, {
      displayName: 'Rival',
      finishTimeSec: 12.345,
    });

    expect(setHudBestMetric).toHaveBeenCalledWith({
      value: '12.345',
      visible: true,
    });
  });

  it('routes Daily and Campaign leaderboard starts through opponent-preserving entry points', async () => {
    // The mode loader resolves definitions before standings show opponent rows.
    await loadRaceDefinitions(['circuit', 'numberZero'], { requireConfirmation: false });
    const target = { displayName: 'Rival', bestTimeMs: 12_000, ghost };
    const dailyChallenge = {
      id: 'daily-1',
      trackKey: 'circuit',
      objectiveParams: { lapCount: 1 },
    };
    const dailyEngine = {
      raceComparisonTarget: null,
      activeDailyChallenge: null,
      clearRaceComparisonTarget: vi.fn(),
      installRaceComparisonTarget: vi.fn((value) => {
        dailyEngine.raceComparisonTarget = value;
        return value;
      }),
      handleStartDailyChallenge: vi.fn(() => {
        dailyEngine.activeDailyChallenge = dailyChallenge;
      }),
    };
    await expect(
      dailyChallengeEngineMethods.startDailyChallengeAgainstOpponent.call(
        dailyEngine,
        dailyChallenge,
        target,
      ),
    ).resolves.toBe(true);
    expect(dailyEngine.installRaceComparisonTarget).toHaveBeenCalledWith(
      { ...target, mode: 'daily' },
      { track: expect.any(Object), lapCount: 1 },
    );
    expect(dailyEngine.handleStartDailyChallenge).toHaveBeenCalledWith(
      dailyChallenge,
      { preserveRaceComparisonTarget: true },
    );

    const campaignStage = {
      raceId: 'race-1',
      trackKey: 'numberZero',
      lapCount: 1,
    };
    const campaignEngine = {
      raceComparisonTarget: null,
      activeCampaignStage: null,
      clearRaceComparisonTarget: vi.fn(),
      installRaceComparisonTarget: vi.fn((value) => {
        campaignEngine.raceComparisonTarget = value;
        return value;
      }),
      startCampaignStage: vi.fn(() => {
        campaignEngine.activeCampaignStage = campaignStage;
      }),
    };
    await expect(
      campaignEngineMethods.startCampaignStageAgainstOpponent.call(
        campaignEngine,
        campaignStage,
        target,
      ),
    ).resolves.toBe(true);
    expect(campaignEngine.installRaceComparisonTarget).toHaveBeenCalledWith(
      { ...target, mode: 'campaign' },
      { track: expect.any(Object), lapCount: 1 },
    );
    expect(campaignEngine.startCampaignStage).toHaveBeenCalledWith(
      campaignStage,
      { preserveRaceComparisonTarget: true },
    );
  });

  it('drops the opponent when a leaderboard start never reaches its race', async () => {
    const target = { displayName: 'Rival', bestTimeMs: 12_000, ghost };
    const dailyEngine = {
      raceComparisonTarget: null,
      activeDailyChallenge: { id: 'daily-rolled-forward' },
      clearRaceComparisonTarget: vi.fn(function clear() {
        this.raceComparisonTarget = null;
      }),
      installRaceComparisonTarget: vi.fn(function install(value) {
        this.raceComparisonTarget = value;
        return value;
      }),
      handleStartDailyChallenge: vi.fn(),
    };

    await expect(
      dailyChallengeEngineMethods.startDailyChallengeAgainstOpponent.call(
        dailyEngine,
        { id: 'daily-1' },
        target,
      ),
    ).resolves.toBe(false);
    expect(dailyEngine.raceComparisonTarget).toBe(null);

    const campaignEngine = {
      raceComparisonTarget: null,
      activeCampaignStage: null,
      clearRaceComparisonTarget: vi.fn(function clear() {
        this.raceComparisonTarget = null;
      }),
      installRaceComparisonTarget: vi.fn(function install(value) {
        this.raceComparisonTarget = value;
        return value;
      }),
      startCampaignStage: vi.fn(),
    };

    await expect(
      campaignEngineMethods.startCampaignStageAgainstOpponent.call(
        campaignEngine,
        { raceId: 'race-1' },
        target,
      ),
    ).resolves.toBe(false);
    expect(campaignEngine.raceComparisonTarget).toBe(null);
  });

  it('keeps the installed opponent through a track-level ghost clear', () => {
    const pbGhost = new PbGhost({ enabled: true });
    expect(pbGhost.prepareOpponent({ bestTimeMs: 100, ghost })).toBe(true);

    expect(pbGhost.clearTrack()).toBe(false);
    expect(pbGhost.beginRun()).toBe(true);
    expect(pbGhost.getPose(0.025)).toMatchObject({ x: 1.5 });

    expect(pbGhost.clearOpponent()).toBe(true);
    expect(pbGhost.clearTrack()).toBe(true);
  });

  it('carries the opponent through the track load a leaderboard start needs', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    const pbGhost = new PbGhost({ enabled: true });
    pbGhost.prepareOpponent({ bestTimeMs: 100, ghost });
    const engine = {
      trackLoadRequestId: 0,
      currentTrackKey: 'harborParkLoop',
      currentTrack: null,
      pbGhost,
      preparedPbGhostChallengeId: 'daily-1',
      qualityLevel: 'low',
      frameSkip: 0,
      activeGeometry: {},
      bestLapTime: 12,
      raceComparisonTarget: { displayName: 'Rival' },
      setLoadingStatus: vi.fn(),
      refreshTrackPresentation: vi.fn(),
      syncCurrentRunPolicy: vi.fn(),
      clearDailyChallengeRun: vi.fn(),
      hud: { setBestTime: vi.fn() },
      reset: vi.fn(function reset(_autoStart, { preserveRaceComparisonTarget } = {}) {
        if (!preserveRaceComparisonTarget) {
          this.raceComparisonTarget = null;
          this.pbGhost.clearOpponent();
        }
      }),
    };

    try {
      await trackEngineMethods.loadTrack.call(engine, 'blueSector', {
        loadPlayerProgress: false,
        preserveDailyChallengeContext: true,
        preserveRaceComparisonTarget: true,
        showStartOverlayOnReset: false,
      });
    } finally {
      globalThis.document = originalDocument;
    }

    expect(engine.reset).toHaveBeenCalledWith(false, {
      preserveDailyChallenge: false,
      preserveRaceComparisonTarget: true,
      showStartOverlay: false,
      keepScreen: false,
    });
    expect(engine.raceComparisonTarget).not.toBe(null);
    expect(pbGhost.beginRun()).toBe(true);
  });

  it('preserves the opponent when a Daily leaderboard start switches tracks', async () => {
    const challenge = { id: 'daily-2', trackKey: 'blueSector' };
    const engine = {
      status: 'ready',
      startButtonPending: false,
      currentDailyChallenge: null,
      activeDailyChallenge: null,
      currentTrackKey: 'harborParkLoop',
      raceComparisonTarget: { displayName: 'Rival' },
      clearRaceComparisonTarget: vi.fn(),
      startOverlay: { hideStartOverlay: vi.fn() },
      reset: vi.fn(),
      loadTrack: vi.fn(),
      applyDailyChallenge: vi.fn(),
      prepareTrackPersonalBestGhost: vi.fn(),
      pbGhost: { clearTrack: vi.fn(), clearPrepared: vi.fn() },
      journeys: { startAttempt: vi.fn() },
      startSequence: vi.fn(),
    };

    await dailyChallengeEngineMethods.handleStartDailyChallenge.call(
      engine,
      challenge,
      { preserveRaceComparisonTarget: true },
    );

    expect(engine.clearRaceComparisonTarget).not.toHaveBeenCalled();
    expect(engine.loadTrack).toHaveBeenCalledWith('blueSector', {
      loadPlayerProgress: false,
      preserveDailyChallengeContext: true,
      preserveRaceComparisonTarget: true,
      showStartOverlayOnReset: false,
      keepScreen: true,
      prepared: null,
      loadedOnly: true,
      challenge,
    });
    expect(engine.prepareTrackPersonalBestGhost).not.toHaveBeenCalled();
    expect(engine.pbGhost.clearTrack).not.toHaveBeenCalled();
  });

  it('supplies Campaign finish splits and opponent outcome without changing submission data', () => {
    const showModal = vi.fn();
    const comparisonTarget = {
      displayName: 'Rival',
      finishTimeSec: 12,
      checkpointTimesSec: [4, 8],
    };
    const engine = {
      modal: { showModal, modalMsg: null },
      getLapCheckpointTimesSec: () => [3.8, 7.9],
      getRaceComparisonResult: () => ({
        target: comparisonTarget,
        outcome: 'won',
        deltaSec: -0.25,
      }),
      trackPersonalBestByTrackKey: {
        'numbered-v1-00': { bestTime: 12.5 },
      },
      openCampaignStandings: vi.fn(),
      startCampaignStage: vi.fn(),
      restartActiveRace: vi.fn(),
      showCampaignLobby: vi.fn(),
      settings: { openSettings: vi.fn() },
    };

    campaignEngineMethods.showCampaignFinish.call(engine, {
      raceId: 'numbered-v1-00',
      trackKey: 'circuit',
      lapCount: 1,
    }, {
      finalTime: 11.75,
      medal: 'gold',
      scoreboardSnapshot: { currentPlayerRow: { bestTime: 11.75 } },
    });

    const lapData = showModal.mock.calls[0][2];
    expect(lapData).toMatchObject({
      lapTime: 11.75,
      previousPersonalBestSec: 12.5,
      deltaToPersonalBest: -0.75,
      raceComparisonTarget: comparisonTarget,
      comparisonOutcome: 'won',
      deltaToComparison: -0.25,
      lapCheckpointTimes: [3.8, 7.9],
      pbCheckpointTimes: [4, 8],
      pbFinishSec: 12,
    });
    showModal.mock.calls[0][3].restartAction();
    expect(engine.startCampaignStage).toHaveBeenCalledWith({
      raceId: 'numbered-v1-00',
      trackKey: 'circuit',
      lapCount: 1,
    });
    expect(engine.restartActiveRace).not.toHaveBeenCalled();
  });
});
