import { describe, expect, it, vi } from "vitest";
import { JourneyService, JOURNEY_START_REASONS } from "../game/journeys/service.js";

function createClient({ activeJourneyId } = {}) {
  let activeId = activeJourneyId;
  const calls = [];
  const receipt = { status: "JOURNEY_RECEIPT_VALID", message: "recorded" };
  return {
    calls,
    getActiveJourneyId: vi.fn(() => activeId),
    appReady: vi.fn(async () => {
      calls.push(["appReady"]);
      return { receipt };
    }),
    startJourney: vi.fn(async () => {
      calls.push(["startJourney"]);
      activeId = "journey-new";
      return { journeyId: activeId, receipt };
    }),
    progress: vi.fn(async (input) => {
      calls.push(["progress", input]);
      return { receipt };
    }),
    interaction: vi.fn(async (input) => {
      calls.push(["interaction", input]);
      return { receipt };
    }),
    endJourney: vi.fn(async (input) => {
      calls.push(["endJourney", input]);
      activeId = undefined;
      return { receipt };
    }),
  };
}

describe("JourneyService", () => {
  it("reports app ready exactly once and keeps receipt handling developer-only", async () => {
    const client = createClient();
    const receiptLogger = vi.fn();
    const service = new JourneyService({ client, receiptLogger });

    await service.appReady();
    await service.appReady();

    expect(client.appReady).toHaveBeenCalledTimes(1);
    expect(receiptLogger).toHaveBeenCalledWith(
      "app_ready",
      expect.objectContaining({ status: "JOURNEY_RECEIPT_VALID" }),
    );
  });

  it("ends a stale browser-session journey before the first explicit attempt", async () => {
    const client = createClient({ activeJourneyId: "journey-stale" });
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.startAttempt();
    await service.startAttempt();

    expect(client.calls).toEqual([
      ["endJourney", { complete: false }],
      ["startJourney"],
    ]);
  });

  it("emits only monotonic checkpoint progress after an explicit start", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.progressCheckpoint(0, 3);
    await service.startAttempt();
    await service.progressCheckpoint(0, 3);
    await service.progressCheckpoint(0, 3);
    await service.progressCheckpoint(2, 3);
    await service.progressCheckpoint(1, 3);

    expect(client.progress.mock.calls).toEqual([
      [{ progress: 0.25, action: "checkpoint" }],
      [{ progress: 0.75, action: "checkpoint" }],
    ]);
    expect(client.progress.mock.calls.flat(2).join(" ")).not.toMatch(
      /player|username|token|challenge|track|replay/i,
    );
  });

  it("allows only fixed pause and resume interactions during an attempt", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.interaction("pause");
    await service.startAttempt();
    await service.interaction("pause");
    await service.interaction("settings_opened");
    await service.interaction("resume");

    expect(client.interaction.mock.calls).toEqual([
      [{ action: "pause" }],
      [{ action: "resume" }],
    ]);
  });

  it("serializes manual restarts as incomplete end then a new start", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    void service.startAttempt({ reason: "initial_start" });
    void service.endAttempt({ complete: false });
    await service.startAttempt({ reason: "restart" });

    expect(client.calls).toEqual([
      ["startJourney"],
      ["endJourney", { complete: false }],
      ["startJourney"],
    ]);
  });

  it("replaces an active attempt when replaceActive is true", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.startAttempt({ reason: "initial_start" });
    await service.startAttempt({ reason: "track_switch", replaceActive: true });

    expect(client.calls).toEqual([
      ["startJourney"],
      ["endJourney", { complete: false }],
      ["startJourney"],
    ]);
  });

  it("ignores unknown start reasons", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.startAttempt({ reason: "invalid_reason" });

    expect(client.startJourney).not.toHaveBeenCalled();
  });

  it("exports the supported journey start reasons", () => {
    expect([...JOURNEY_START_REASONS]).toEqual([
      "initial_start",
      "retry",
      "improve",
      "restart",
      "track_switch",
    ]);
  });

  it("ends a valid finish without attaching a score or other metadata", async () => {
    const client = createClient();
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await service.startAttempt();
    await service.endAttempt({ complete: true });
    await service.endAttempt({ complete: true });

    expect(client.endJourney).toHaveBeenCalledTimes(1);
    expect(client.endJourney).toHaveBeenCalledWith({ complete: true });
  });

  it("contains SDK failures without rejecting gameplay callers", async () => {
    const client = createClient();
    client.startJourney.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new JourneyService({ client, receiptLogger: vi.fn() });

    await expect(service.startAttempt()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[Devvit Journeys] journey_start:initial_start failed.",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("reports the race start under the mode being raced right now", async () => {
    const client = createClient();
    const onRaceStart = vi.fn();
    let activeRaceMode = "daily";
    const service = new JourneyService({
      client,
      receiptLogger: vi.fn(),
      resolveMode: () => activeRaceMode,
      onRaceStart,
    });

    await service.startAttempt({ reason: "initial_start" });
    expect(onRaceStart).toHaveBeenLastCalledWith("daily");

    activeRaceMode = "campaign";
    await service.startAttempt({ reason: "restart", replaceActive: true });
    expect(onRaceStart).toHaveBeenLastCalledWith("campaign");
    expect(onRaceStart).toHaveBeenCalledTimes(2);
  });

  it("does not report a start that its own guards refused", async () => {
    const client = createClient();
    const onRaceStart = vi.fn();
    const service = new JourneyService({
      client,
      receiptLogger: vi.fn(),
      resolveMode: () => "daily",
      onRaceStart,
    });

    await service.startAttempt({ reason: "initial_start" });
    await service.startAttempt({ reason: "initial_start" });
    await service.startAttempt({ reason: "not_a_reason" });

    expect(onRaceStart).toHaveBeenCalledTimes(1);
  });
});
