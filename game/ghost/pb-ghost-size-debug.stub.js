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
