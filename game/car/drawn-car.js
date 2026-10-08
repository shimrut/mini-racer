import { FORMULA_CAR } from "./drawn-car/formula.js";
import { CIRCUIT_CAR } from "./drawn-car/circuit.js";
import { RALLY_CAR } from "./drawn-car/rally.js";
import { SNOW_CAR } from "./drawn-car/snow.js";
import { JET_SKI } from "./drawn-car/jet-ski.js";
import { SPACESHIP } from "./drawn-car/spaceship.js";
import { isHexColor, paintTones } from "./drawn-car/paint.js";
import { DRAWN_CAR_SKINS, isDrawnCarAsset } from "./drawn-car-skins.js";

// Draws a car from part files placed by a car file (drawn-car/formula.js); skins override paint or parts.
// Only steering, tire roll, brake light, wake and flames move; still parts are drawn once and cached.

export const DRAWN_CAR_MODELS = Object.freeze({
  formula: FORMULA_CAR,
  circuit: CIRCUIT_CAR,
  rally: RALLY_CAR,
  snow: SNOW_CAR,
  jetski: JET_SKI,
  spaceship: SPACESHIP,
});

// Motion parts read: steerAngle (rad), roll and pace (car units), rollBlur and brake (0 to 1).
const STILL = Object.freeze({ steerAngle: 0, roll: 0, rollBlur: 0, brake: 0, pace: 0 });

// Oversample the race picture so thin lines survive the shrink.
const FRAME_OVERSAMPLE = 2;
// A moving car repaints at most every second frame at 60 fps.
const REPAINT_INTERVAL_SEC = 1 / 40;
// On a slow device, the race picture is painted 15 times each second.
const SLOW_REPAINT_INTERVAL_SEC = 1 / 15;

export class DrawnCar {
  constructor(car = FORMULA_CAR, skin = {}, { pixelsPerUnit = 3, paint = null, decalStyle = null } = {}) {
    this.car = car;
    this.pixelsPerUnit = pixelsPerUnit;
    this.livery = { ...car.livery, ...(skin.livery || {}), ...paint };
    const styleSkin = isDrawnCarAsset(decalStyle) ? DRAWN_CAR_SKINS[decalStyle] : null;
    const selectedStyle = styleSkin && DRAWN_CAR_MODELS[styleSkin.car] === car ? styleSkin : null;
    this.decals = { ...car.decals, ...((selectedStyle || skin).decals || {}) };
    // A custom livery shows the third color even if the decals skip it; picked decals keep their layout.
    if (selectedStyle === null && paint !== null && !Object.values(this.decals).includes("tertiary")) {
      this.decals.rearWingEnds = "tertiary";
    }
    this.paintForArea = makePaint(this.livery, this.decals);
    this.placements = placeParts(car, skin, this.paintForArea);
    this.runs = groupRuns(this.placements);
    // The layers of each picture size, by pixels per car unit.
    this.layerSets = new Map();
    this.frame = null;
    this.frameKey = "";
    this.framePixelsPerUnit = pixelsPerUnit;
    this.staticSprite = null;
    this.repaintIntervalSec = REPAINT_INTERVAL_SEC;
    this.resetMotion();
  }

  resetMotion() {
    this.steerAngle = 0;
    this.roll = 0;
    this.rollBlur = 0;
    this.brake = 0;
    this.brakeHoldSec = 0;
    this.pace = 0;
    this.lastSpeedKph = null;
    this.moving = false;
    this.paintedRoll = 0;
    this.sincePaintSec = Infinity;
  }

  // dt 0 stops motion; steer -1..1; speedPx in world px/s; holding keeps the brake light on.
  update(dt, {
    speedKph = 0, speedPx = 0, steer = 0, holding = false, size = 52, lowQuality = false,
  } = {}) {
    if (!(dt > 0)) {
      this.moving = false;
      return;
    }
    const { steering, wheelSpin, brakes, boxSize } = this.car;
    this.sincePaintSec += dt;
    this.repaintIntervalSec = lowQuality ? SLOW_REPAINT_INTERVAL_SEC : REPAINT_INTERVAL_SEC;

    const steerTarget = clamp(steer, -1, 1) * steering.maxAngleDeg * (Math.PI / 180);
    this.steerAngle += (steerTarget - this.steerAngle)
      * (1 - Math.exp(-dt / Math.max(0.001, steering.responseSec)));

    const rolled = Math.max(0, Number(speedPx) || 0) * dt * (boxSize / Math.max(1, size));
    this.moving = rolled > 0;
    this.roll += Math.min(rolled, wheelSpin.maxStepPerFrame);
    const blurTarget = clamp(rolled / wheelSpin.blurStep, 0, 1);
    this.rollBlur += (blurTarget - this.rollBlur) * Math.min(1, dt * 10);
    this.pace += (rolled / dt - this.pace) * Math.min(1, dt * 10);

    const decel = this.lastSpeedKph === null ? 0 : (this.lastSpeedKph - speedKph) / dt;
    this.lastSpeedKph = speedKph;
    if (holding) {
      this.brakeHoldSec = brakes.holdSec;
      this.brake = 1;
    } else if (decel >= brakes.decelKphPerSec) {
      this.brakeHoldSec = brakes.holdSec;
    } else {
      this.brakeHoldSec = Math.max(0, this.brakeHoldSec - dt);
    }
    const brakeTarget = this.brakeHoldSec > 0 ? 1 : 0;
    if (brakeTarget > this.brake) {
      this.brake = Math.min(brakeTarget, this.brake + dt / Math.max(0.001, brakes.onSec));
    } else {
      this.brake = Math.max(brakeTarget, this.brake - dt / Math.max(0.001, brakes.offSec));
    }
  }

  // The car at rest, for the garage, the ghost and track cards.
  get sprite() {
    if (!this.staticSprite) this.staticSprite = this.paint(null, STILL);
    return this.staticSprite;
  }

  // Named parts only, without tires or frame, for Garage thumbnails.
  partSprite(partIds, { paint = null, single = false } = {}) {
    const pixels = Math.ceil(this.car.boxSize * this.pixelsPerUnit);
    const canvas = createCanvas(pixels, pixels);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, pixels / 2, pixels / 2);
    for (const placement of this.placements) {
      if (!partIds.includes(placement.id)) continue;
      drawPlacement(ctx, paint ? { ...placement, paint } : placement, STILL, this.car.outline);
      if (single) break;
    }
    return canvas;
  }

  // Draws the car at the origin, nose on +x, in a size x size box.
  draw(ctx, size) {
    const frame = this.renderFrame(this.getFramePixelsPerUnit(ctx, size));
    if (!frame) return;
    // Oversample so thin lines survive the shrink.
    const quality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame, -size / 2, -size / 2, size, size);
    ctx.imageSmoothingQuality = quality;
  }

  // Ground effects, such as the brake glow; call before draw().
  drawGround(ctx, size) {
    const scale = size / this.car.boxSize;
    for (const placement of this.placements) {
      if (!placement.part.drawGround) continue;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.scale(scale, scale);
      drawPlacement(ctx, placement, this, this.car.outline, "drawGround");
      ctx.restore();
    }
  }

  // FRAME_OVERSAMPLE times the on-screen car, capped at the sprite size.
  getFramePixelsPerUnit(ctx, size) {
    const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
    const screenScale = transform ? Math.hypot(transform.a, transform.b) : 0;
    if (!(screenScale > 0)) return this.pixelsPerUnit;
    const wanted = (size * screenScale * FRAME_OVERSAMPLE) / this.car.boxSize;
    // Quarter steps, so a small change of scale does not make a new size.
    return Math.min(this.pixelsPerUnit, Math.max(0.5, Math.ceil(wanted * 4) / 4));
  }

  // Repaints only on a pose change, and limits the roll step so a fast wheel never looks reversed.
  renderFrame(pixelsPerUnit = this.pixelsPerUnit) {
    if (pixelsPerUnit !== this.framePixelsPerUnit) {
      this.frame = null;
      this.framePixelsPerUnit = pixelsPerUnit;
    }
    if (this.frame && this.moving && this.sincePaintSec < this.repaintIntervalSec) {
      return this.frame;
    }
    const maxStep = this.car.wheelSpin.maxStepPerFrame;
    if (this.roll - this.paintedRoll > maxStep) this.roll = this.paintedRoll + maxStep;
    const key = `${this.steerAngle.toFixed(3)}|${this.roll.toFixed(2)}|`
      + `${this.rollBlur.toFixed(2)}|${this.brake.toFixed(2)}`;
    if (this.frame && key === this.frameKey) return this.frame;
    const frame = this.paint(this.frame, this, pixelsPerUnit);
    if (frame) {
      this.frame = frame;
      this.frameKey = key;
      this.paintedRoll = this.roll;
      this.sincePaintSec = 0;
    }
    return frame;
  }

  paint(target, motion, pixelsPerUnit = this.pixelsPerUnit) {
    const layers = this.getLayers(pixelsPerUnit);
    if (!layers) return null;
    const canvas = target?.width === layers.pixels ? target : createCanvas(layers.pixels, layers.pixels);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    const center = layers.pixels / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.runs.forEach((run, index) => {
      if (run.still) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layers.canvases[index], 0, 0);
        return;
      }
      ctx.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, center, center);
      for (const placement of run.placements) {
        drawPlacement(ctx, placement, motion, this.car.outline);
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  // Each still group is drawn once per picture size, on its own layer.
  getLayers(pixelsPerUnit = this.pixelsPerUnit) {
    const cached = this.layerSets.get(pixelsPerUnit);
    if (cached) return cached;
    const pixels = Math.ceil(this.car.boxSize * pixelsPerUnit);
    const canvases = [];
    for (const run of this.runs) {
      if (!run.still) {
        canvases.push(null);
        continue;
      }
      const canvas = createCanvas(pixels, pixels);
      const ctx = canvas?.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, pixels / 2, pixels / 2);
      for (const placement of run.placements) {
        drawPlacement(ctx, placement, STILL, this.car.outline);
      }
      canvases.push(canvas);
    }
    const layers = { pixels, canvases };
    this.layerSets.set(pixelsPerUnit, layers);
    return layers;
  }
}

// Parts with skin changes, in drawing order; a mirrored part gets a right-side copy.
function placeParts(car, skin, paint) {
  const carColors = { ...car.colors, ...(skin.colors || {}) };
  const placements = [];
  for (const item of car.parts) {
    const change = skin.parts?.[item.id] || {};
    if (change.hidden) continue;
    const part = change.part || item.part;
    const placement = {
      id: item.id,
      part,
      at: item.at || [0, 0],
      settings: { ...part.defaults, ...(item.settings || {}), ...(change.settings || {}) },
      colors: { ...carColors, ...(item.colors || {}), ...(change.colors || {}) },
      steers: item.steers === true,
      // -1 turns the part against the steering, as a jet ski's nozzle turns.
      steerScale: Number.isFinite(item.steerScale) ? item.steerScale : 1,
      pivot: item.pivot || [0, 0],
      flip: false,
      paint,
    };
    placements.push(placement);
    if (item.mirror) placements.push({ ...placement, flip: true });
  }
  return placements;
}

// The four tones of a decal area, or null; fallback is for areas that always need paint.
function makePaint(livery, decals) {
  const tones = new Map();
  const tonesOf = (value) => {
    if (value === null || value === undefined) return null;
    if (!tones.has(value)) {
      const color = typeof value === "string" && Object.hasOwn(livery, value) ? livery[value] : value;
      tones.set(value, isHexColor(color) || (color && typeof color === "object") ? paintTones(color) : null);
    }
    return tones.get(value);
  };
  const paint = (area, fallback = null) => tonesOf(decals[area]) ?? tonesOf(fallback);
  paint.channelFor = (area, fallback = null) => {
    const value = tonesOf(decals[area]) ? decals[area] : fallback;
    return tonesOf(value) && Object.hasOwn(livery, value) ? value : null;
  };
  return paint;
}

// Adjacent still parts share a group; each moving part is its own group.
function groupRuns(placements) {
  const runs = [];
  for (const placement of placements) {
    const still = !placement.part.moves && !placement.steers;
    const last = runs[runs.length - 1];
    if (still && last?.still) last.placements.push(placement);
    else runs.push({ still, placements: [placement] });
  }
  return runs;
}

function drawPlacement(ctx, placement, motion, outline, method = "draw") {
  ctx.save();
  // A mirror copy flips across the center line of the car.
  if (placement.flip) ctx.scale(1, -1);
  ctx.translate(placement.at[0], placement.at[1]);
  if (placement.steers && motion.steerAngle) {
    const [px, py] = placement.pivot;
    ctx.translate(px, py);
    const angle = motion.steerAngle * placement.steerScale;
    ctx.rotate(placement.flip ? -angle : angle);
    ctx.translate(-px, -py);
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  placement.part[method](ctx, {
    settings: placement.settings,
    colors: placement.colors,
    paint: placement.paint,
    motion,
    outline,
  });
  ctx.restore();
}

function createCanvas(width, height) {
  if (typeof document !== "undefined" && document.createElement) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  return null;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min < 0 && max > 0 ? 0 : min;
  return Math.min(max, Math.max(min, number));
}
