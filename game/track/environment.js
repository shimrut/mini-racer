export function isLocalEnvironment() {
  if (typeof window === "undefined") return false;

  const hostname = window.location?.hostname || "";
  const isLocalAlias = hostname === "local" || hostname.endsWith(".local");
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    isLocalAlias ||
    window.location?.protocol === "file:"
  );
}

export function shouldExposeDebugHooks() {
  return isLocalEnvironment();
}

export function shouldAutoRetryVerificationQueue() {
  return !isLocalEnvironment();
}

/**
 * The track layer draws in ~5us per frame, so the worker never bought meaningful
 * parallelism -- it only added a structured-clone postMessage per frame and kept a
 * second thread resident for the whole race, which blocks SoC idle and costs power.
 * Everyone now uses the main-thread renderer that Android already ran on.
 * Flip this back to `clientName !== "ANDROID"` to restore the worker path.
 */
export function shouldUseTrackLayerWorker(
  // eslint-disable-next-line no-unused-vars
  clientName = globalThis.devvit?.context?.client?.name,
) {
  return false;
}

export function readCanvasDevicePixelRatio() {
  if (typeof window === "undefined") return 1;
  return window.devicePixelRatio || 1;
}

/** Measures canvas fill-rect throughput once at startup: 1 = low quality, 0 = high. */
export function detectDevicePerformance() {
  const testCanvas = document.createElement("canvas");
  testCanvas.width = 100;
  testCanvas.height = 100;
  const testCtx = testCanvas.getContext("2d");

  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    testCtx.fillRect(0, 0, 100, 100);
  }
  const elapsed = performance.now() - start;

  const isLowEnd = elapsed > 1;

  return isLowEnd ? 1 : 0;
}
