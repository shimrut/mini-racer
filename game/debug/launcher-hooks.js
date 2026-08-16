// Headless-driving hooks for the launcher posts, which have no engine of their
// own. The payload shapes are built here rather than at the call sites so the
// shipped build drops them with this module; see `vite.config.js`.

function expose(getState) {
  globalThis.render_game_to_text = () => JSON.stringify(getState());
  globalThis.advanceTime = () => {};
}

export function exposeCampaignLauncherTestHooks() {
  expose(() => ({
    screen: 'campaign-launcher',
    destination: 'campaign',
  }));
}

export function exposeHeadToHeadLauncherTestHooks(challenge, access) {
  expose(() => ({
    screen: 'head-to-head-preview',
    challengeId: challenge.challengeId,
    challengerUsername: challenge.challengerUsername,
    trackKey: challenge.trackKey,
    lapCount: challenge.lapCount,
    targetTimeMs: challenge.targetTimeMs,
    signedIn: access.signedIn,
    canRace: access.canRace,
    ownChallenge: access.ownChallenge === true,
  }));
}
