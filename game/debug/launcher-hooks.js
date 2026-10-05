function expose(getState) {
  globalThis.render_game_to_text = () => JSON.stringify(getState());
  globalThis.advanceTime = () => {};
}

export function exposeCampaignLauncherTestHooks(finished = null) {
  expose(() => ({
    screen: finished ? 'campaign-finished-poster' : 'campaign-launcher',
    destination: 'campaign',
    ...(finished || {}),
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
