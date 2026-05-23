/**
 * Runtime environment detection utilities.
 * Used to gate debug hooks, auto-retry behaviour, and device pixel ratio reads.
 */

export function isLocalEnvironment() {
  if (typeof window === "undefined") return false;

  const hostname = window.location?.hostname || "";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    window.location?.protocol === "file:"
  );
}

export function shouldExposeDebugHooks() {
  return isLocalEnvironment();
}

export function shouldAutoRetryVerificationQueue() {
  return !isLocalEnvironment();
}

export function readCanvasDevicePixelRatio() {
  if (typeof window === "undefined") return 1;
  return window.devicePixelRatio || 1;
}

/**
 * Measures canvas fill-rect throughput and checks the user-agent string to
 * estimate whether this is a low-end or mobile device.
 *
 * Returns 1 (low quality) or 0 (high quality).
 * Called once at engine startup before the first track load.
 */
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

  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
  const isLowEnd = elapsed > 1 || isMobile;

  return isLowEnd ? 1 : 0; // 1 = low quality, 0 = high quality
}
