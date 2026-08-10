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

/** Android's embedded Reddit WebView advertises OffscreenCanvas but does not reliably present it, so it stays on the main-thread renderer. */
export function shouldUseTrackLayerWorker(
  clientName = globalThis.devvit?.context?.client?.name,
) {
  return clientName !== "ANDROID";
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
