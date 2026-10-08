import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { CONFIG } from "../game/config.js";
import { updateSimulation } from "../game/race/simulation.js";
import { createPbGhostPoseRecorder } from "../game/shared/pb-ghost-recorder.js";
import { TRACKS } from "../game/track/tracks.js";
import { CAMPAIGN_LIVE_STAGES } from "../game/campaign/manifest.js";
import { createReplaySimulationState, driveAutopilot } from "./helpers/autopilot.js";
import {
  packPbGhostTrace,
  storedRunGhost,
  unpackPbGhostTrace,
} from "../src/server/competition/pb-ghost-pack.ts";
import { classifyStoredPbRecordFor } from "../src/server/competition/pb-ghost-store.ts";
import { createTrackFingerprint } from "../src/server/competition/pb-ghost-trace.ts";
import { toCampaignCompetition } from "../src/server/competition/competition.ts";

// A real recorded ghost: the autopilot drives and the game's recorder samples.
function recordedGhost(stage) {
  const track = TRACKS[stage.trackKey];
  const run = driveAutopilot(track, { laps: stage.lapCount });
  const { state, collisionSegments } = createReplaySimulationState(track, { laps: stage.lapCount });
  const recorder = createPbGhostPoseRecorder({ timeSec: 0, position: { ...state.pos }, angle: state.angle });
  for (const input of run.replay.inputs) {
    for (let frame = 0; frame < input.frames; frame += 1) {
      state.keys.left = input.left;
      state.keys.right = input.right;
      const events = updateSimulation(state, CONFIG.fixedDt, CONFIG, track, collisionSegments);
      const pose = { timeSec: state.currentTime, position: { ...state.pos }, angle: state.angle };
      if (events.winTriggered) return recorder.finish(pose);
      recorder.sample(pose);
    }
  }
  throw new Error(`autopilot did not finish ${stage.trackKey}`);
}

const STAGES = CAMPAIGN_LIVE_STAGES.slice(0, 4);
const GHOSTS = STAGES.map(recordedGhost);

describe("packed ghosts", () => {
  it("give back exactly the same ghost, in about half the room the stored text takes today", () => {
    for (const ghost of GHOSTS) {
      const packed = packPbGhostTrace(ghost);
      expect(unpackPbGhostTrace(packed)).toEqual(ghost);
      const todayInRedis = 11 + Math.ceil(gzipSync(JSON.stringify(ghost)).length / 3) * 4;
      expect(packed.length).toBeLessThan(todayInRedis * 0.6);
    }
  });

  it("refuse what they cannot hold without a loss, and read nothing from damaged text", () => {
    const ghost = GHOSTS[0];
    expect(packPbGhostTrace({ ...ghost, extra: 1 })).toBeNull();
    expect(packPbGhostTrace({ ...ghost, deltas: [2 ** 40, 0, 0, ...ghost.deltas.slice(3)] })).toBeNull();
    expect(packPbGhostTrace({ ghost: "not a trace" })).toBeNull();
    const packed = packPbGhostTrace(ghost);
    expect(unpackPbGhostTrace(packed.slice(0, -8))).toBeNull();
    expect(unpackPbGhostTrace("not base64 brotli")).toBeNull();
    expect(unpackPbGhostTrace(null)).toBeNull();
  });

  it("are read by the best-time reader as a plain ghost", () => {
    const stage = STAGES[0];
    const track = TRACKS[stage.trackKey];
    const ghost = GHOSTS[0];
    const record = {
      schemaVersion: 2,
      trackKey: stage.trackKey,
      trackFingerprint: createTrackFingerprint(track),
      simulationRevision: 1,
      rulesRevision: 1,
      lapCount: stage.lapCount,
      bestTimeMs: ghost.finishTimeMs,
      checkpointTimesSec: null,
      lapCompletionTimesSec: null,
      ghost: null,
      ghostPacked: packPbGhostTrace(ghost),
      updatedAt: "2026-10-07T10:00:00.000Z",
    };
    const classified = classifyStoredPbRecordFor(JSON.stringify(record), toCampaignCompetition(stage.seriesId, stage), track);
    expect(classified.state).toBe("valid");
    expect(classified.record.ghost).toEqual(ghost);
    expect(storedRunGhost(record)).toEqual(ghost);
    expect(storedRunGhost({ ...record, ghost })).toEqual(ghost);
    expect(storedRunGhost({ ...record, ghostPacked: undefined })).toBeNull();
  });
});
