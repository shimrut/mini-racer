import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CONFIG } from "../game/config.js";
import { RealTimeRacer } from "../game/engine.js";
import { RingBuffer } from "../game/race/ring-buffer.js";
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

  it("draws the track into the race canvas context it was handed", () => {
    const ctx = createRenderContext();
    const renderer = new TrackLayerRenderer(ctx);
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

    expect(ctx.drawImage).toHaveBeenCalledWith(
      trackCanvas,
      0,
      0,
      320,
      200,
      0,
      0,
      320,
      200,
    );
  });

  it("falls back to the engine backing store before the container is measured", () => {
    const ctx = createRenderContext();
    const renderer = new TrackLayerRenderer(ctx);

    renderer.draw({
      camera: { x: 0, y: 0 },
      zoom: 1,
      viewportWidth: 0,
      viewportHeight: 0,
      devicePixelRatio: 2,
      trackCanvas: { width: 800, height: 800 },
      trackCanvasOrigin: { x: 0, y: 0 },
      presentation: {},
      container: { clientWidth: 0, clientHeight: 0 },
      fallbackWidth: 780,
      fallbackHeight: 1688,
    });

    expect(ctx.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      390,
      800,
      0,
      0,
      390,
      800,
    );
  });

  it("never reaches for a worker or an OffscreenCanvas", () => {
    const originalWorker = global.Worker;
    const originalCreateImageBitmap = global.createImageBitmap;
    const workerCtor = vi.fn();
    const createImageBitmap = vi.fn();
    global.Worker = workerCtor;
    global.createImageBitmap = createImageBitmap;

    try {
      const ctx = createRenderContext();
      const renderer = new TrackLayerRenderer(ctx);

      renderer.draw({
        camera: { x: 0, y: 0 },
        zoom: 1,
        viewportWidth: 320,
        viewportHeight: 200,
        devicePixelRatio: 1,
        trackCanvas: { width: 400, height: 300 },
        trackCanvasOrigin: { x: 0, y: 0 },
        presentation: {},
        container: { clientWidth: 320, clientHeight: 200 },
      });

      expect(workerCtor).not.toHaveBeenCalled();
      expect(createImageBitmap).not.toHaveBeenCalled();
      expect(renderer.ctx).toBe(ctx);
      expect(renderer.canvas).toBeUndefined();
    } finally {
      global.Worker = originalWorker;
      global.createImageBitmap = originalCreateImageBitmap;
    }
  });
});

describe("single game canvas", () => {
  it("ships exactly one race canvas in the game shell", () => {
    const html = readFileSync(new URL("../game.html", import.meta.url), "utf8");
    const raceCanvases = html.match(/<canvas[^>]*class="game-layer-canvas"/g);

    expect(raceCanvases).toHaveLength(1);
    expect(html).toContain('<canvas id="gameCanvas"');
    expect(html).not.toContain("trackLayerCanvas");
  });

  it("styles the single race canvas without stacking rules", () => {
    const css = readFileSync(
      new URL("../styles/lobby-and-garage.css", import.meta.url),
      "utf8",
    );
    const foundation = readFileSync(
      new URL("../styles/foundation.css", import.meta.url),
      "utf8",
    );

    expect(css).not.toContain("trackLayerCanvas");
    expect(css).not.toContain("--z-canvas");
    expect(foundation).not.toContain("--z-canvas");
  });
});
