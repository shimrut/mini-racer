import { CONFIG } from '../game/config.js';
import { updateSimulation } from '../game/race/simulation.js';
import { createRunPolicy } from '../game/race/run-policy.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';
import { TRACKS } from '../game/track/tracks.js';

const MAX_REPLAY_FRAMES = 20_000;
const EPSILON = 1e-9;

type ReplaySegment = {
  frames: number;
  left: boolean;
  right: boolean;
  relaunchDelay: boolean;
};

type ReplayPayload = {
  targetLapNumber?: unknown;
  inputs?: unknown;
};

type ReplayValidationFailure = {
  reason: string;
  frameCount?: number;
  simulatedTimeSec?: number;
  checkpointIndex?: number;
  status?: string;
  position?: { x: number; y: number };
  speed?: number;
};

type ReplayValidationResult = {
  bestTimeSec: number;
  bestTimeMs: number;
  completedLaps: number | null;
  checkpointTimesSec: number[] | null;
  method: 'finish';
};

export type DailyGpChallengeLike = {
  id: string;
  challengeDate: string | null;
  trackKey: string;
  startsAt: string | null;
  endsAt: string | null;
  availableUntil: string | null;
  status: 'active';
  objectiveType: 'single_lap_fastest';
  objectiveParams: Record<string, never>;
  skin: 'default';
};

export type ReplayValidationOutcome = {
  ok: true;
  run: ReplayValidationResult;
} | {
  ok: false;
  failure: ReplayValidationFailure;
};

function normalizeReplaySegment(raw: unknown): ReplaySegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const segment = raw as Record<string, unknown>;
  const frames = Number(segment.frames);
  if (!Number.isInteger(frames) || frames < 1) return null;
  if (typeof segment.left !== 'boolean') return null;
  if (typeof segment.right !== 'boolean') return null;
  if (typeof segment.relaunchDelay !== 'boolean') return null;

  return {
    frames,
    left: segment.left,
    right: segment.right,
    relaunchDelay: segment.relaunchDelay,
  };
}

function normalizeReplayInputs(replay: unknown): { segments: ReplaySegment[]; frameCount: number } | ReplayValidationFailure {
  if (!replay || typeof replay !== 'object') return { reason: 'missing_replay' };
  const payload = replay as ReplayPayload;
  if (!Array.isArray(payload.inputs) || payload.inputs.length === 0) return { reason: 'missing_replay_inputs' };

  const segments: ReplaySegment[] = [];
  let frameCount = 0;
  for (const rawSegment of payload.inputs) {
    const segment = normalizeReplaySegment(rawSegment);
    if (!segment) return { reason: 'invalid_replay_segment' };
    frameCount += segment.frames;
    if (frameCount > MAX_REPLAY_FRAMES) return { reason: 'replay_too_long', frameCount };
    segments.push(segment);
  }
  return { segments, frameCount };
}

function createWriteOnlyBuffer() {
  let lastSlot: Record<string, unknown> | null = null;
  return {
    write() {
      lastSlot = {};
      return lastSlot;
    },
    last() {
      return lastSlot;
    },
    clear() {
      lastSlot = null;
    },
  };
}

function createSimulationState(challenge: DailyGpChallengeLike, track: Record<string, any>) {
  const challengeRun = {
    objectiveType: challenge.objectiveType,
    requiredLaps: 1,
    completedLaps: 0,
    lastLapAt: 0,
  };
  const collisionRuntime = buildCollisionRuntime(buildTrackGeometry(track));

  const state: Record<string, any> = {
    status: 'playing',
    relaunchDelayRemaining: 0,
    currentTime: 0,
    keys: { left: false, right: false },
    angle: track.startAngle,
    velocity: { x: 0, y: 0 },
    pos: { ...track.startPos },
    prevPos: { ...track.startPos },
    cachedSpeed: 0,
    angularVelocity: 0,
    nextCheckpointIndex: 0,
    currentTrackKey: challenge.trackKey,
    activeRunId: 'server-replay-validation',
    currentModeKey: 'daily',
    currentChallengeRun: challengeRun,
    currentRunPolicy: createRunPolicy({ challengeRun } as any),
    frameSkip: 0,
    qualityLevel: 0,
    collisionHash: collisionRuntime.collisionHash,
    particles: [],
    trailTimer: 0,
    runHistoryTimer: 0,
    lapCheckpointTimesSec: [],
    skidMarks: createWriteOnlyBuffer(),
    routeTrace: createWriteOnlyBuffer(),
    runHistory: createWriteOnlyBuffer(),
    slipSpeedGateClamp: false,
  };

  return { state, collisionSegments: collisionRuntime.collisionSegments };
}

function getStateFailureDetails(reason: string, state: Record<string, any>, frameCount: number): ReplayValidationFailure {
  return {
    reason,
    frameCount,
    simulatedTimeSec: Number.isFinite(state.currentTime)
      ? Math.round(Number(state.currentTime) * 1000) / 1000
      : undefined,
    checkpointIndex: Number.isFinite(state.nextCheckpointIndex)
      ? Math.trunc(Number(state.nextCheckpointIndex))
      : undefined,
    status: typeof state.status === 'string' ? state.status : undefined,
    position: state.pos && Number.isFinite(state.pos.x) && Number.isFinite(state.pos.y)
      ? {
        x: Math.round(Number(state.pos.x) * 1000) / 1000,
        y: Math.round(Number(state.pos.y) * 1000) / 1000,
      }
      : undefined,
    speed: Number.isFinite(state.cachedSpeed)
      ? Math.round(Number(state.cachedSpeed) * 1000) / 1000
      : undefined,
  };
}

export function validateDailyGpReplayDetailed({
  challenge,
  replay,
  track = TRACKS[challenge.trackKey as keyof typeof TRACKS] as Record<string, any>,
}: {
  challenge: DailyGpChallengeLike;
  replay?: unknown;
  track?: Record<string, any>;
}): ReplayValidationOutcome {
  if (!challenge || !track) {
    return {
      ok: false,
      failure: { reason: 'unknown_track' },
    };
  }

  const normalizedReplay = normalizeReplayInputs(replay);
  if ('reason' in normalizedReplay) {
    return {
      ok: false,
      failure: normalizedReplay,
    };
  }
  const { segments, frameCount } = normalizedReplay;

  const { state, collisionSegments } = createSimulationState(challenge, track);
  const config = { ...CONFIG };
  const fixedDt = Number(config.fixedDt) || (1 / 60);

  for (const segment of segments) {
    for (let frame = 0; frame < segment.frames; frame += 1) {
      if (state.status !== 'playing') {
        return {
          ok: false,
          failure: getStateFailureDetails('ended_before_replay_finished', state, frameCount),
        };
      }

      state.keys.left = segment.left;
      state.keys.right = segment.right;
      if (segment.relaunchDelay) {
        state.relaunchDelayRemaining = Math.max(state.relaunchDelayRemaining, fixedDt + EPSILON);
      }

      const events = updateSimulation(
        state,
        fixedDt,
        config,
        track,
        collisionSegments,
      ) as Record<string, any>;

      if (events.crashEndedRun || state.status === 'crashed') {
        return {
          ok: false,
          failure: getStateFailureDetails('crashed', state, frameCount),
        };
      }
      if (events.winTriggered) {
        const winData = events.winData as Record<string, unknown> | null | undefined;
        const bestTimeSec = Number(winData?.lapTime);
        if (!Number.isFinite(bestTimeSec)) {
          return {
            ok: false,
            failure: getStateFailureDetails('missing_win_time', state, frameCount),
          };
        }
        return {
          ok: true,
          run: {
            bestTimeSec,
            bestTimeMs: Math.round(bestTimeSec * 1000),
            completedLaps: Number.isFinite(Number(winData?.completedLaps))
              ? Math.trunc(Number(winData?.completedLaps))
              : null,
            checkpointTimesSec: Array.isArray(state.lapCheckpointTimesSec) && state.lapCheckpointTimesSec.length
              ? state.lapCheckpointTimesSec.slice()
              : null,
            method: 'finish',
          },
        };
      }
    }
  }

  return {
    ok: false,
    failure: getStateFailureDetails('no_finish', state, frameCount),
  };
}
