// Watch: plays a leaderboard ghost in the race view. The race camera follows
// the ghost car, and the player can pause and scrub. The stored ghost keeps
// only the position and the heading of the car, so speed and steering come
// from the change between two points. Tyre marks, spray and sound come from
// the race code, so a replay does not show them.

import { CONFIG } from "../config.js";
import { DRAWN_CAR_MODELS, DrawnCar } from "../car/drawn-car.js";
import { DRAWN_CAR_SKINS, isDrawnCarAsset } from "../car/drawn-car-skins.js";
import { DRAWN_CAR_DRAW_PIXELS } from "../car/drawn-car/formula.js";
import { DEFAULT_PHYSICS_TUNING, KPH_PER_WORLD_UNIT } from "../car/handling.js";
import { trailStrokeStyleForId } from "../car/player-trail.js";
import { CarSpriteLoader } from "../car/sprite.js";
import {
  getCameraZoom,
  getDesiredLookAhead,
  getLookAheadLerpFactor,
  isMobileCameraMode,
  NARROW_VIEWPORT_MAX_WIDTH,
} from "../race/race-camera.js";
import { configureCanvasViewport } from "../track/canvas-resolution.js";
import { readCanvasDevicePixelRatio } from "../track/environment.js";
import { getTrackGround } from "../track/grounds.js";
import { TrackLayerRenderer } from "../track/layer.js";
import { interpolatePbGhostPose } from "./pb-ghost.js";
import { getCarRearAxleWorldPoint } from "../race/simulation.js";

// Speed and steering read the ghost this far before and after the frame.
export const GHOST_WATCH_MOTION_WINDOW_MS = 50;
const MAX_FRAME_DT_S = 0.1;
// The trail has the default colour and the width of the race trail.
const TRAIL_STROKE_STYLE = trailStrokeStyleForId("sky");
const TRAIL_LINE_WIDTH = 4;

const PLAY_ICON = '<svg class="ghost-watch__icon ghost-watch__icon--play" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M91.2 36.9c-12.4-6.8-27.4-6.5-39.6 .7S32 57.9 32 72l0 368c0 14.1 7.5 27.2 19.6 34.4s27.2 7.5 39.6 .7l336-184c12.8-7 20.8-20.5 20.8-35.1s-8-28.1-20.8-35.1l-336-184z"/></svg>';
const PAUSE_ICON = '<svg class="ghost-watch__icon ghost-watch__icon--pause" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M48 32C21.5 32 0 53.5 0 80L0 432c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48L48 32zm224 0c-26.5 0-48 21.5-48 48l0 352c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48l-64 0z"/></svg>';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapAngle(angle) {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

export function formatGhostWatchClock(timeMs) {
  return (Math.max(0, Number(timeMs) || 0) / 1000).toFixed(3);
}

// The pose of the ghost at timeMs, with the velocity (world units per
// second), the speed and the steering (-1 to 1) that the race camera and the
// drawn car need. Null when the ghost has no pose.
// The rear axle points of the ghost from the start to timeMs, as the race
// trail draws them behind the car.
export function getGhostWatchTrailPoints(samples, timeMs, config = CONFIG) {
  const points = [];
  if (!Array.isArray(samples) || samples.length < 2) return points;
  for (const sample of samples) {
    if (sample.timeMs > timeMs) break;
    points.push(getCarRearAxleWorldPoint(sample, sample.angle, config));
  }
  const pose = interpolatePbGhostPose(samples, timeMs);
  if (pose && timeMs > samples[0].timeMs) {
    points.push(getCarRearAxleWorldPoint(pose, pose.angle, config));
  }
  return points;
}

export function getGhostWatchMotion(samples, timeMs, { turnRate = DEFAULT_PHYSICS_TUNING.turnRate } = {}) {
  const pose = interpolatePbGhostPose(samples, timeMs);
  if (!pose) return null;
  const finishMs = samples[samples.length - 1].timeMs;
  const fromMs = clamp(timeMs - GHOST_WATCH_MOTION_WINDOW_MS, 0, finishMs);
  const toMs = clamp(timeMs + GHOST_WATCH_MOTION_WINDOW_MS, 0, finishMs);
  const spanSec = (toMs - fromMs) / 1000;
  let vx = 0;
  let vy = 0;
  let yawRate = 0;
  if (spanSec > 0) {
    const from = interpolatePbGhostPose(samples, fromMs);
    const to = interpolatePbGhostPose(samples, toMs);
    vx = (to.x - from.x) / spanSec;
    vy = (to.y - from.y) / spanSec;
    yawRate = wrapAngle(to.angle - from.angle) / spanSec;
  }
  const speed = Math.hypot(vx, vy);
  const steer = turnRate > 0 ? clamp(yawRate / turnRate, -1, 1) : 0;
  return {
    x: pose.x,
    y: pose.y,
    angle: pose.angle,
    velocity: { x: vx, y: vy },
    speed,
    steer,
  };
}

function createDrawnCar(assetName) {
  if (!isDrawnCarAsset(assetName)) return null;
  const skin = DRAWN_CAR_SKINS[assetName];
  const model = DRAWN_CAR_MODELS[skin?.car];
  return model ? new DrawnCar(model, skin, { pixelsPerUnit: 3 }) : null;
}

export class GhostWatchView {
  constructor({
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    track,
    trackCanvasAsset,
    presentation,
    samples,
    carAssetName,
    title = "",
    turnRate = DEFAULT_PHYSICS_TUNING.turnRate,
    isCoarsePointer = false,
    lowQuality = false,
    onClose = null,
  } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.track = track;
    this.trackCanvasAsset = trackCanvasAsset;
    this.presentation = presentation;
    this.samples = samples;
    this.durationMs = samples[samples.length - 1].timeMs;
    this.title = title;
    this.turnRate = turnRate * getTrackGround(track).turnRate;
    this.isCoarsePointer = isCoarsePointer;
    this.lowQuality = lowQuality;
    this.onClose = onClose;

    this.timeMs = 0;
    this.playing = false;
    this.showTrail = false;
    this.scrubbing = false;
    this.snapCamera = true;
    this.lastFrameTs = 0;
    this.frameId = null;
    this.camera = { x: 0, y: 0 };
    this.lookAhead = { x: 0, y: 0 };
    this.desiredLookAhead = { x: 0, y: 0 };
    this.viewport = { width: 0, height: 0, devicePixelRatio: 1 };

    this.drawnCar = createDrawnCar(carAssetName);
    this.carImage = null;
    if (!this.drawnCar) {
      const record = new CarSpriteLoader().prefetch(carAssetName);
      record?.promise?.then((image) => {
        this.carImage = image;
        this.requestFrame();
      }).catch(() => {});
    }

    this.boundFrame = (ts) => this.frame(ts);
    this.boundResize = () => this.resize();
    this.boundKeydown = (event) => this.handleKeydown(event);
  }

  open() {
    const doc = this.document;
    const root = doc.createElement("section");
    root.className = "ghost-watch";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", this.title ? `Replay: ${this.title}` : "Replay");
    root.innerHTML = `
      <canvas class="ghost-watch__canvas"></canvas>
      <div class="ghost-watch__top">
        <button class="ghost-watch__back" type="button">Back</button>
        <span class="ghost-watch__title"></span>
      </div>
      <div class="ghost-watch__bar">
        <div class="ghost-watch__seek-wrap">
          <div class="ghost-watch__seek-track" aria-hidden="true"><span class="ghost-watch__seek-fill"></span></div>
          <span class="ghost-watch__seek-knob" aria-hidden="true"></span>
          <input class="ghost-watch__seek" type="range" min="0" max="1" value="0" step="1" aria-label="Replay position">
        </div>
        <div class="ghost-watch__chrome">
          <button class="ghost-watch__toggle" type="button" data-playing="false" aria-label="Play">${PLAY_ICON}${PAUSE_ICON}</button>
          <button class="ghost-watch__trail" type="button" aria-pressed="false">Trail</button>
          <span class="ghost-watch__spacer"></span>
          <span class="ghost-watch__clock" aria-live="off">0.000</span>
        </div>
      </div>`;
    this.root = root;
    this.canvas = root.querySelector(".ghost-watch__canvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false }) || this.canvas.getContext("2d");
    this.trackLayer = new TrackLayerRenderer(this.ctx);
    this.backButton = root.querySelector(".ghost-watch__back");
    this.toggleButton = root.querySelector(".ghost-watch__toggle");
    this.trailButton = root.querySelector(".ghost-watch__trail");
    this.seek = root.querySelector(".ghost-watch__seek");
    this.seekWrap = root.querySelector(".ghost-watch__seek-wrap");
    this.clock = root.querySelector(".ghost-watch__clock");
    root.querySelector(".ghost-watch__title").textContent = this.title;
    this.seek.max = String(Math.max(1, Math.round(this.durationMs)));

    this.backButton.addEventListener("click", () => this.close());
    this.toggleButton.addEventListener("click", () => this.togglePlayback());
    this.trailButton.addEventListener("click", () => this.toggleTrail());
    this.canvas.addEventListener("click", () => this.togglePlayback());
    this.seek.addEventListener("pointerdown", () => this.beginScrub());
    this.seek.addEventListener("input", () => {
      this.seekTo(Number(this.seek.value));
    });
    const endScrub = () => this.endScrub();
    this.seek.addEventListener("change", endScrub);
    this.seek.addEventListener("pointerup", endScrub);
    this.seek.addEventListener("pointercancel", endScrub);

    this.focusBeforeOpen = doc.activeElement;
    doc.body.appendChild(root);
    // A capture listener on the window runs before the game's own key
    // handlers, so the race and the modal behind the replay see no keys.
    this.window?.addEventListener("keydown", this.boundKeydown, true);
    this.window?.addEventListener("resize", this.boundResize);
    this.resize();
    this.toggleButton.focus();
    this.play();
    return this;
  }

  close() {
    if (!this.root) return;
    this.pause();
    this.window?.removeEventListener("keydown", this.boundKeydown, true);
    this.window?.removeEventListener("resize", this.boundResize);
    if (this.frameId !== null) {
      this.window?.cancelAnimationFrame?.(this.frameId);
      this.frameId = null;
    }
    this.root.remove();
    this.root = null;
    if (this.focusBeforeOpen?.isConnected) this.focusBeforeOpen.focus?.();
    this.focusBeforeOpen = null;
    this.onClose?.();
  }

  isOpen() {
    return Boolean(this.root);
  }

  play() {
    if (this.timeMs >= this.durationMs) {
      this.timeMs = 0;
      this.snapCamera = true;
    }
    this.playing = true;
    this.lastFrameTs = 0;
    this.syncControls();
    this.requestFrame();
  }

  pause() {
    this.playing = false;
    this.syncControls();
    this.requestFrame();
  }

  togglePlayback() {
    if (this.playing) this.pause();
    else this.play();
  }

  toggleTrail() {
    this.showTrail = !this.showTrail;
    this.syncControls();
    this.requestFrame();
  }

  beginScrub() {
    this.scrubbing = true;
    this.resumeAfterScrub = this.playing;
    this.playing = false;
  }

  endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.resumeAfterScrub && this.timeMs < this.durationMs) this.play();
    this.resumeAfterScrub = false;
  }

  seekTo(timeMs) {
    this.timeMs = clamp(Number(timeMs) || 0, 0, this.durationMs);
    this.snapCamera = true;
    this.syncControls();
    this.requestFrame();
  }

  handleKeydown(event) {
    if (!this.root) return;
    event.stopPropagation();
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (key === "Tab") {
      const focusables = [this.backButton, this.seek, this.toggleButton, this.trailButton];
      const index = focusables.indexOf(this.document.activeElement);
      const step = event.shiftKey ? -1 : 1;
      const next = focusables[(index + step + focusables.length) % focusables.length];
      event.preventDefault();
      next.focus();
      return;
    }
    const active = this.document.activeElement;
    if ((key === " " || key === "Spacebar") && active?.tagName !== "BUTTON") {
      event.preventDefault();
      this.togglePlayback();
    }
  }

  syncControls() {
    if (!this.root) return;
    this.toggleButton.dataset.playing = String(this.playing);
    this.toggleButton.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    this.trailButton.setAttribute("aria-pressed", String(this.showTrail));
    if (!this.scrubbing) this.seek.value = String(Math.round(this.timeMs));
    const progress = this.durationMs > 0 ? this.timeMs / this.durationMs : 0;
    this.seekWrap.style.setProperty("--progress-n", String(progress));
    this.clock.textContent = formatGhostWatchClock(this.timeMs);
  }

  resize() {
    if (!this.root) return;
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width <= 0 || height <= 0) return;
    const viewport = configureCanvasViewport(
      this.canvas,
      this.ctx,
      width,
      height,
      readCanvasDevicePixelRatio(),
    );
    this.viewport.width = viewport.cssWidth;
    this.viewport.height = viewport.cssHeight;
    this.viewport.devicePixelRatio = viewport.devicePixelRatio;
    this.requestFrame();
  }

  requestFrame() {
    if (!this.root || this.frameId !== null) return;
    this.frameId = this.window.requestAnimationFrame(this.boundFrame);
  }

  frame(ts) {
    this.frameId = null;
    if (!this.root) return;
    const dt = this.lastFrameTs ? Math.min((ts - this.lastFrameTs) / 1000, MAX_FRAME_DT_S) : 0;
    this.lastFrameTs = ts;
    if (this.playing) {
      this.timeMs = Math.min(this.durationMs, this.timeMs + dt * 1000);
      if (this.timeMs >= this.durationMs) this.playing = false;
      this.syncControls();
    }
    this.render(this.playing ? dt : 0);
    if (this.playing) this.requestFrame();
    else this.lastFrameTs = 0;
  }

  drawTrail(ctx, gs) {
    const points = getGhostWatchTrailPoints(this.samples, this.timeMs);
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = TRAIL_STROKE_STYLE;
    ctx.lineWidth = TRAIL_LINE_WIDTH;
    ctx.lineJoin = "round";
    ctx.moveTo(points[0].x * gs, points[0].y * gs);
    for (let index = 1; index < points.length; index++) {
      ctx.lineTo(points[index].x * gs, points[index].y * gs);
    }
    ctx.stroke();
  }

  // The same steps as the race render: the camera follows the car with the
  // race look-ahead, then the track and the car are drawn.
  render(dt) {
    const ctx = this.ctx;
    const motion = getGhostWatchMotion(this.samples, this.timeMs, { turnRate: this.turnRate });
    if (!ctx || !motion) return;
    const cw = this.viewport.width;
    const ch = this.viewport.height;
    const gs = CONFIG.gridSize;

    const mobileCameraMode = isMobileCameraMode({
      coarsePointer: this.isCoarsePointer,
      narrowViewport: (this.window?.innerWidth ?? cw) <= NARROW_VIEWPORT_MAX_WIDTH,
    });
    const zoom = getCameraZoom(mobileCameraMode);
    const desired = getDesiredLookAhead(
      this.desiredLookAhead,
      motion.velocity,
      motion.speed,
      cw,
      ch,
      mobileCameraMode,
    );
    if (this.snapCamera) {
      this.lookAhead.x = desired.x;
      this.lookAhead.y = desired.y;
      this.snapCamera = false;
    } else {
      const lerpFactor = getLookAheadLerpFactor(dt, mobileCameraMode);
      this.lookAhead.x += (desired.x - this.lookAhead.x) * lerpFactor;
      this.lookAhead.y += (desired.y - this.lookAhead.y) * lerpFactor;
    }
    this.camera.x = motion.x * gs + this.lookAhead.x - cw / 2 / zoom;
    this.camera.y = motion.y * gs + this.lookAhead.y - ch / 2 / zoom;

    ctx.clearRect(0, 0, cw, ch);
    this.trackLayer.draw({
      camera: this.camera,
      zoom,
      viewportWidth: cw,
      viewportHeight: ch,
      devicePixelRatio: this.viewport.devicePixelRatio,
      trackCanvas: this.trackCanvasAsset.canvas,
      trackCanvasOrigin: this.trackCanvasAsset.origin,
      presentation: this.presentation,
      container: this.root,
      fallbackWidth: this.canvas.width,
      fallbackHeight: this.canvas.height,
    });

    const size = DRAWN_CAR_DRAW_PIXELS * (CONFIG.carSpriteRenderScale ?? 1);
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-this.camera.x, -this.camera.y);
    if (this.showTrail) this.drawTrail(ctx, gs);
    ctx.translate(motion.x * gs, motion.y * gs);
    ctx.rotate(motion.angle);
    if (this.drawnCar) {
      this.drawnCar.update(dt, {
        speedKph: motion.speed * KPH_PER_WORLD_UNIT,
        speedPx: motion.speed * gs,
        steer: motion.steer,
        size,
        lowQuality: this.lowQuality,
      });
      this.drawnCar.drawGround(ctx, size);
    }
    if (!this.lowQuality) {
      const look = this.presentation;
      ctx.shadowColor = look?.carShadowColor ?? CONFIG.carSpriteShadowColor;
      ctx.shadowBlur = look?.carShadowBlur ?? CONFIG.carSpriteShadowBlur;
      ctx.shadowOffsetX = look?.carShadowOffsetX ?? CONFIG.carSpriteShadowOffsetX;
      ctx.shadowOffsetY = look?.carShadowOffsetY ?? CONFIG.carSpriteShadowOffsetY;
    }
    if (this.drawnCar) {
      this.drawnCar.draw(ctx, size);
    } else if (this.carImage) {
      ctx.drawImage(this.carImage, -size / 2, -size / 2, size, size);
    }
    ctx.restore();
  }
}
