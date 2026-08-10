import { describe, expect, it, vi } from "vitest";
import { CONFIG } from "../game/config.js";
import { RealTimeRacer } from "../game/engine.js";
import { RingBuffer } from "../game/race/ring-buffer.js";
import { shouldUseTrackLayerWorker } from "../game/track/environment.js";
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
  it("draws the car sprite without extra exhaust layers", () => {
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
      skidMarks: { length: 0 },
      routeTrace: { length: 0 },
      particles: [],
      carSprite: { id: "stock" },
      carSpriteDrawWidth: 52,
      carSpriteDrawHeight: 52,
      carSpriteAssetKey: "assets/cars/mr_mr_red.webp",
      currentTrackPresentation: { backgroundStyle: "flat" },
      currentTime: 1.2,
      FIXED_DT: 1 / 60,
      pbGhost: { render: vi.fn() },
      drawVisibleTrackCanvas: vi.fn(),
      getDesiredLookAhead: RealTimeRacer.prototype.getDesiredLookAhead,
    };

    RealTimeRacer.prototype.render.call(engine, 1 / 60, 0.25);

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
    expect(engine.pbGhost.render).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        raceTimeSec: 1.2 - (1 / 60) * 0.75,
      }),
    );
  });

  it("reuses cached skid mark paths between unchanged renders", () => {
    const ctx = createRenderContext();
    const skidMarks = new RingBuffer(8, () => ({ x: 0, y: 0, cos: 0, sin: 0 }));
    Object.assign(skidMarks.write(), { x: 1, y: 1, cos: 1, sin: 0 });
    Object.assign(skidMarks.write(), { x: 2, y: 1.2, cos: 1, sin: 0 });
    Object.assign(skidMarks.write(), { x: 3, y: 1.4, cos: 1, sin: 0 });

    const originalPath2D = global.Path2D;
    const pathCtor = vi.fn(function Path2DMock() {
      this.moveTo = vi.fn();
      this.lineTo = vi.fn();
    });
    global.Path2D = pathCtor;

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
      skidMarks,
      routeTrace: { length: 0 },
      particles: [],
      carSprite: { id: "stock" },
      carSpriteDrawWidth: 52,
      carSpriteDrawHeight: 52,
      qualityLevel: 1,
      frameSkip: 0,
      currentTrackPresentation: { backgroundStyle: "flat" },
      drawVisibleTrackCanvas: vi.fn(),
      getDesiredLookAhead: RealTimeRacer.prototype.getDesiredLookAhead,
    };

    try {
      RealTimeRacer.prototype.render.call(engine, 1 / 60, 1);
      RealTimeRacer.prototype.render.call(engine, 1 / 60, 1);

      expect(pathCtor).toHaveBeenCalledTimes(2);
      expect(ctx.stroke).toHaveBeenCalledTimes(4);
    } finally {
      global.Path2D = originalPath2D;
    }
  });

  it("uses the worker track layer when the browser supports it", () => {
    const fallbackContext = { id: "2d-context" };
    const transferControlToOffscreen = vi.fn(() => ({
      id: "offscreen-canvas",
    }));
    const getContext = vi.fn(() => fallbackContext);
    const worker = { postMessage: vi.fn() };
    const workerCtor = vi.fn(() => worker);
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

      renderer.setup();

      expect(transferControlToOffscreen).toHaveBeenCalled();
      expect(workerCtor).toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledWith(
        { type: "init", canvas: { id: "offscreen-canvas" } },
        [{ id: "offscreen-canvas" }],
      );
      expect(getContext).not.toHaveBeenCalled();
      expect(renderer.ctx).toBe(null);
      expect(renderer.workerReady).toBe(true);
    } finally {
      global.Worker = originalWorker;
      global.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it("keeps the Android Reddit client on the main-thread track layer", () => {
    const fallbackContext = { id: "2d-context" };
    const transferControlToOffscreen = vi.fn();
    const getContext = vi.fn(() => fallbackContext);
    const workerCtor = vi.fn();
    const createImageBitmap = vi.fn();

    const originalWorker = global.Worker;
    const originalCreateImageBitmap = global.createImageBitmap;
    const originalDevvit = globalThis.devvit;

    global.Worker = workerCtor;
    global.createImageBitmap = createImageBitmap;
    globalThis.devvit = { context: { client: { name: "ANDROID" } } };

    try {
      const renderer = new TrackLayerRenderer({
        transferControlToOffscreen,
        getContext,
      });

      renderer.setup({
        allowWorker: shouldUseTrackLayerWorker(),
      });

      // Every client now renders the track layer on the main thread: the worker's
      // per-frame postMessage cost more power than the ~5us of drawing it offloaded.
      expect(shouldUseTrackLayerWorker()).toBe(false);
      expect(shouldUseTrackLayerWorker("IOS")).toBe(false);
      expect(shouldUseTrackLayerWorker("WEB")).toBe(false);
      expect(transferControlToOffscreen).not.toHaveBeenCalled();
      expect(workerCtor).not.toHaveBeenCalled();
      expect(getContext).toHaveBeenCalledWith("2d", { alpha: false });
      expect(renderer.ctx).toBe(fallbackContext);
      expect(renderer.workerReady).toBe(false);
    } finally {
      global.Worker = originalWorker;
      global.createImageBitmap = originalCreateImageBitmap;
      if (originalDevvit === undefined) {
        delete globalThis.devvit;
      } else {
        globalThis.devvit = originalDevvit;
      }
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

  it("sizes its backing store during draw when no resize has landed yet", () => {
    const setTransform = vi.fn();
    const canvas = { width: 300, height: 150 };
    const renderer = new TrackLayerRenderer(canvas);
    renderer.ctx = {
      setTransform,
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };

    // No updateViewportSize() call first: this is the state the main-thread path
    // lands in whenever the container was unmeasured when setup() ran.
    renderer.draw({
      camera: { x: 0, y: 0 },
      zoom: 1,
      viewportWidth: 390,
      viewportHeight: 844,
      devicePixelRatio: 2,
      trackCanvas: { width: 800, height: 800 },
      trackCanvasOrigin: { x: 0, y: 0 },
      presentation: {},
      container: { clientWidth: 390, clientHeight: 844 },
    });

    expect(canvas.width).toBe(780);
    expect(canvas.height).toBe(1688);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });
});

describe("merged canvas mode", () => {
  it("draws the track into the shared context and never touches the canvas", () => {
    const sharedContext = createRenderContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(),
      transferControlToOffscreen: vi.fn(),
    };
    const renderer = new TrackLayerRenderer(canvas);

    renderer.setup({ sharedContext });

    expect(renderer.merged).toBe(true);
    expect(renderer.ctx).toBe(sharedContext);
    expect(renderer.canvas).toBe(null);
    expect(canvas.getContext).not.toHaveBeenCalled();
    expect(canvas.transferControlToOffscreen).not.toHaveBeenCalled();

    // The engine owns sizing in merged mode, so resizing must be inert.
    renderer.updateViewportSize({ clientWidth: 800, clientHeight: 600 }, 2);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);

    // A draw still blits the track into the shared context.
    const trackCanvas = { width: 400, height: 300 };
    renderer.draw({
      camera: { x: 0, y: 0 },
      zoom: 1,
      viewportWidth: 320,
      viewportHeight: 200,
      devicePixelRatio: 2,
      trackCanvas,
      trackCanvasOrigin: { x: 0, y: 0 },
      presentation: {},
      container: { clientWidth: 320, clientHeight: 200 },
    });

    expect(sharedContext.drawImage).toHaveBeenCalled();
    expect(canvas.width).toBe(0);
  });
});
