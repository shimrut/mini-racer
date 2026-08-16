// Production stand-in for `pb-ghost-size-debug.js`.
//
// `vite.config.js` resolves the real recorder to this file for the shipped
// client build, so the measurement code, its storage key, and its URL opt-in
// never reach a player's bundle. Every consumer reaches the recorder through
// optional chaining behind `shouldCapturePbGhostSize()`, so returning `false`
// here leaves `pbGhostSizeCapture` null and turns each call into a no-op.

export const PB_GHOST_SIZE_ENABLED_STORAGE_KEY = '';

export function shouldCapturePbGhostSize() {
  return false;
}

export function getLargestPbGhostSizeReport() {
  return null;
}

export function createLocalPbGhostTraceRecorder() {
  return null;
}

export function createLocalPbGhostStorageRecord() {
  return null;
}

export async function measurePbGhostStorage() {
  return null;
}

export function exposePbGhostSizeDebugHooks() {}

export class PbGhostSizeCapture {}
