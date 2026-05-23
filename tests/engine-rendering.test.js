import { describe, expect, it, vi } from "vitest";
import { CONFIG } from "../game/config.js";
import { RealTimeRacer } from "../game/engine.js";
import { TrackLayerRenderer } from "../game/track/layer.js";

function createRenderContext() {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    arc: vi.fn(),
    quadraticCurveTo: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineJoin: "round",
    lineCap: "round",
  };
}

describe("RealTimeRacer track layer renderer", () => {
  it("draws the car sprite on the space skin without extra exhaust layers", () => {
    const ctx = createRenderContext();
    const engine = {
      ctx,
      viewportWidth: 320,
      viewportHeight: 200,
      container: { clientWidth: 320, clientHeight: 200 },
      canvas: { width: 320, height: 200 },
      pos: { x: 10, y: 8 },
      prevPos: { x: 10, y: 8 },
      angle: 0.18,
      prevAngle: 0.18,
      status: "playing",
      cachedSpeed: 9.5,
      velocity: { x: 8.8, y: 2.1 },
      isCoarsePointer: false,
      isNarrowViewport: false,
      zoom: 1,
      camera: { x: 0, y: 0 },
      _displayPos: { x: 0, y: 0 },
      _desiredLookAhead: { x: 0, y: 0 },
      _lookAheadX: 0,
      _lookAheadY: 0,
      keys: { left: true, right: false },
      _prevSteeringCommand: 0,
      _spaceRcsBurst: 0,
      skidMarks: { length: 0 },
      routeTrace: { length: 0 },
      particles: [],
      carSprite: { id: "stock" },
      carSpriteDrawWidth: 52,
      carSpriteDrawHeight: 52,
      carSpriteAssetKey: "assets/cars/mr_mr_red.webp",
      currentTrackPresentation: { backgroundStyle: "space" },
      currentTime: 1.2,
      drawVisibleTrackCanvas: vi.fn(),
      getDesiredLookAhead: RealTimeRacer.prototype.getDesiredLookAhead,
    };

    RealTimeRacer.prototype.render.call(engine, 1 / 60, 1);

    expect(ctx.createLinearGradient).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
    const side = 52 * CONFIG.carSpriteRenderScale;
    const half = side / 2;
    expect(ctx.drawImage).toHaveBeenCalledWith(
      engine.carSprite,
      -half,
      -half,
      side,
      side,
    );
  });

  it("falls back to the main-thread track layer on coarse-pointer devices", () => {
    const fallbackContext = { id: "2d-context" };
    const transferControlToOffscreen = vi.fn(() => ({
      id: "offscreen-canvas",
    }));
    const getContext = vi.fn(() => fallbackContext);
    const workerCtor = vi.fn();
    const createImageBitmap = vi.fn();

    const originalWorker = global.Worker;
    const originalCreateImageBitmap = global.createImageBitmap;

    global.Worker = workerCtor;
    global.createImageBitmap = createImageBitmap;

    try {
      const renderer = new TrackLayerRenderer({
        transferControlToOffscreen,
        getContext,
      });

      renderer.setup(/* isCoarsePointer */ true);

      expect(transferControlToOffscreen).not.toHaveBeenCalled();
      expect(workerCtor).not.toHaveBeenCalled();
      expect(getContext).toHaveBeenCalled();
      expect(renderer.ctx).toBe(fallbackContext);
      expect(renderer.workerReady).toBe(false);
    } finally {
      global.Worker = originalWorker;
      global.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it("uses the resolved track presentation off-track color when syncing the worker bitmap", async () => {
    const bitmap = { close: vi.fn() };
    const createImageBitmap = vi.fn().mockResolvedValue(bitmap);
    const postMessage = vi.fn();
    const originalCreateImageBitmap = global.createImageBitmap;

    global.createImageBitmap = createImageBitmap;

    try {
      const renderer = new TrackLayerRenderer(null);
      renderer.workerReady = true;
      renderer.worker = { postMessage };

      await renderer.syncBitmap({
        trackCanvas: { width: 20, height: 20 },
        trackCanvasOrigin: { x: 12, y: 18 },
        offTrackColor: "#41291f",
        presentation: { offTrackColor: "#41291f" },
        trackLoadRequestId: 7,
        currentTrackLoadRequestId: 7,
      });

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "track",
          bitmap,
          origin: { x: 12, y: 18 },
          offTrackColor: "#41291f",
        }),
        [bitmap],
      );
    } finally {
      global.createImageBitmap = originalCreateImageBitmap;
    }
  });
});
