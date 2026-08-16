// Production stand-in for `test-hooks.js`. See `vite.config.js`.
//
// The shipped client resolves the headless-driving hooks to these no-ops, so
// neither the engine state dump nor the `__RACER_DEBUG__` surface reaches a
// player's bundle.

export function renderGameToText() {
  return '';
}

export function exposeTestHooks() {}
