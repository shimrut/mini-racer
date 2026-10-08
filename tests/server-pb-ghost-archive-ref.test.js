import { describe, expect, it } from "vitest";
import {
  classifyStoredPbRecordFor,
  isPbGhostArchiveRef,
} from "../src/server/competition/pb-ghost-store.ts";
import { createTrackFingerprint } from "../src/server/competition/pb-ghost-trace.ts";
import { toCampaignCompetition } from "../src/server/competition/competition.ts";
import { CAMPAIGN_LIVE_STAGES } from "../game/campaign/manifest.js";
import { TRACKS } from "../game/track/tracks.js";

const STAGE = CAMPAIGN_LIVE_STAGES[0];
const COMPETITION = toCampaignCompetition(STAGE.seriesId, STAGE);
const TRACK = TRACKS[STAGE.trackKey];
const REF = {
  v: 1,
  key: "daily-ghosts/v1/daily-gp-2026-09-20/field-0123456789abcdef.gz",
  sha256: "a".repeat(64),
};

// A record as the ghost move leaves it: every field kept, the ghost replaced by a reference.
function stubText(ghostArchive = REF) {
  return JSON.stringify({
    schemaVersion: 2,
    trackKey: STAGE.trackKey,
    trackFingerprint: createTrackFingerprint(TRACK),
    simulationRevision: 1,
    rulesRevision: 1,
    lapCount: STAGE.lapCount,
    bestTimeMs: 31000,
    checkpointTimesSec: [10, 20],
    lapCompletionTimesSec: null,
    ghost: null,
    ghostArchive,
    updatedAt: "2026-09-20T12:00:00.000Z",
  });
}

describe("a personal best whose ghost moved to blob storage", () => {
  it("reads as a valid best time without a ghost, and keeps its reference", () => {
    const classified = classifyStoredPbRecordFor(stubText(), COMPETITION, TRACK);
    expect(classified.state).toBe("valid");
    expect(classified.record).toMatchObject({ bestTimeMs: 31000, ghost: null, ghostArchive: REF });
  });

  it("drops a damaged reference and still reads the best time", () => {
    for (const damaged of [
      { ...REF, v: 2 },
      { ...REF, key: "" },
      { ...REF, sha256: "short" },
      "daily-ghosts/v1/x.gz",
    ]) {
      const classified = classifyStoredPbRecordFor(stubText(damaged), COMPETITION, TRACK);
      expect(classified.state).toBe("valid");
      expect(classified.record.ghostArchive).toBeUndefined();
    }
  });

  it("accepts only a version 1 reference with a key and a full sha256", () => {
    expect(isPbGhostArchiveRef(REF)).toBe(true);
    expect(isPbGhostArchiveRef({ ...REF, key: "k".repeat(901) })).toBe(false);
    expect(isPbGhostArchiveRef(null)).toBe(false);
    expect(isPbGhostArchiveRef([REF])).toBe(false);
  });
});
