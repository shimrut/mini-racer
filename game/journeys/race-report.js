import { getGuestPlayerToken, getOrCreatePlayerId } from "../scoreboard/player-identity.js";

const REPORTED_MODES = new Set(["daily", "campaign", "challenge"]);

export const RACE_START_URL = "/api/analytics/race-start";

export function reportRaceStart(mode, root = globalThis) {
  if (!REPORTED_MODES.has(mode) || typeof root?.fetch !== "function") return;

  try {
    void root.fetch(RACE_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        playerId: getOrCreatePlayerId("race start"),
        guestToken: getGuestPlayerToken(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
  }
}
