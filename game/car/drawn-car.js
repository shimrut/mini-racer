import { FORMULA_CAR } from "./drawn-car/formula.js";
import { isHexColor, paintTones } from "./drawn-car/paint.js";

// Draws a car in code from its parts. Each part is its own file in
// game/car/drawn-car/parts/, and a car file such as
// game/car/drawn-car/formula.js puts the parts in place and gives the colors.
//
// A part is an object with:
//   defaults    its own settings: sizes and shapes
//   moves       true when its look changes while the car drives
//   draw()      draws the part in car units
//   drawGround() optional: draws on the ground below the car
//
// The paint of a car has three colors, the livery:
//   main      the body color
//   accent    the second color
//   tertiary  the third color
// Each color is one value, such as "#1e6fe8". The shadow, deep shadow and
// highlight tones come from it. To set a tone by hand, give an object:
//   { base: "#f90815", shade: "#b40106", deep: "#960000", light: "#ff3c40" }
//
// The decals are the areas of the car that take paint. Each area takes
// "main", "accent", "tertiary", a color such as "#ffffff", or null for no
// paint. The car file lists the areas and their default paint.
//
// A skin changes a car without a copy of it:
//   livery            new main, accent or tertiary colors
//   decals            new paint for some areas
//   colors            new colors for the materials: glass, tires, frame
//   parts[id].colors  new material colors for one part
//   parts[id].settings  size or shape changes for one part
//   parts[id].part    a different part file in that place
//   parts[id].hidden  true: the part is not drawn
//
// Three things move: the front wheels turn with the steering, the tires roll
// with the speed, and the brake light comes on when the car loses speed
// quickly. The parts that do not move are drawn one time and kept.

export const DRAWN_CAR_MODELS = Object.freeze({ formula: FORMULA_CAR });

const STILL = Object.freeze({ steerAngle: 0, roll: 0, rollBlur: 0, brake: 0 });

export class DrawnCar {
  constructor(car = FORMULA_CAR, skin = {}, { pixelsPerUnit = 3 } = {}) {
    this.car = car;
    this.pixelsPerUnit = pixelsPerUnit;
    this.placements = placeParts(car, skin);
    this.runs = groupRuns(this.placements);
    this.layers = null;
    this.frame = null;
    this.frameKey = "";
    this.staticSprite = null;
    this.resetMotion();
  }

  resetMotion() {
    this.steerAngle = 0;
    this.roll = 0;
    this.rollBlur = 0;
    this.brake = 0;
    this.brakeHoldSec = 0;
    this.lastSpeedKph = null;
  }

  // dt: seconds since the last frame. 0 stops all motion.
  // speedKph: the car speed, for the brake light.
  // speedPx: the car speed in world pixels per second, for the tires.
  // steer: -1 is full left, 1 is full right.
  // holding: true keeps the brake light on, as on the start grid.
  // size: the drawn size of the car box in world pixels.
  update(dt, { speedKph = 0, speedPx = 0, steer = 0, holding = false, size = 52 } = {}) {
    if (!(dt > 0)) return;
    const { steering, wheelSpin, brakes, boxSize } = this.car;

    const steerTarget = clamp(steer, -1, 1) * steering.maxAngleDeg * (Math.PI / 180);
    this.steerAngle += (steerTarget - this.steerAngle)
      * (1 - Math.exp(-dt / Math.max(0.001, steering.responseSec)));

    const rolled = Math.max(0, Number(speedPx) || 0) * dt * (boxSize / Math.max(1, size));
    this.roll += Math.min(rolled, wheelSpin.maxStepPerFrame);
    const blurTarget = clamp(rolled / wheelSpin.blurStep, 0, 1);
    this.rollBlur += (blurTarget - this.rollBlur) * Math.min(1, dt * 10);

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

  // The car at rest, with straight wheels and the brake light off. Other
  // screens use it as a plain car picture: the garage, the ghost car and the
  // track cards.
  get sprite() {
    if (!this.staticSprite) this.staticSprite = this.paint(null, STILL);
    return this.staticSprite;
  }

  // Draws the car at the origin, with the nose on the +x axis. The box of the
  // car is size x size pixels.
  draw(ctx, size) {
    const frame = this.renderFrame();
    if (!frame) return;
    // The frame is larger than the car on screen. A high quality shrink keeps
    // the thin lines from breaking up.
    const quality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame, -size / 2, -size / 2, size, size);
    ctx.imageSmoothingQuality = quality;
  }

  // Draws what the parts put on the ground, such as the red glow of the
  // brake light. Call it before draw().
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

  // The car in its current pose. The frame is drawn again only when the pose
  // changes.
  renderFrame() {
    const key = `${this.steerAngle.toFixed(3)}|${this.roll.toFixed(2)}|`
      + `${this.rollBlur.toFixed(2)}|${this.brake.toFixed(2)}`;
    if (this.frame && key === this.frameKey) return this.frame;
    const frame = this.paint(this.frame, this);
    if (frame) {
      this.frame = frame;
      this.frameKey = key;
    }
    return frame;
  }

  paint(target, motion) {
    const layers = this.getLayers();
    if (!layers) return null;
    const canvas = target || createCanvas(layers.pixels, layers.pixels);
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
      ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, center, center);
      for (const placement of run.placements) {
        drawPlacement(ctx, placement, motion, this.car.outline);
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  // Each group of parts that do not move is drawn one time, on its own
  // layer.
  getLayers() {
    if (this.layers) return this.layers;
    const pixels = Math.ceil(this.car.boxSize * this.pixelsPerUnit);
    const canvases = [];
    for (const run of this.runs) {
      if (!run.still) {
        canvases.push(null);
        continue;
      }
      const canvas = createCanvas(pixels, pixels);
      const ctx = canvas?.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, pixels / 2, pixels / 2);
      for (const placement of run.placements) {
        drawPlacement(ctx, placement, STILL, this.car.outline);
      }
      canvases.push(canvas);
    }
    this.layers = { pixels, canvases };
    return this.layers;
  }
}

// The parts of the car with the skin changes, in drawing order. A mirrored
// part gets a second placement for the right side.
function placeParts(car, skin = {}) {
  const carColors = { ...car.colors, ...(skin.colors || {}) };
  const paint = makePaint(car, skin);
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
      pivot: item.pivot || [0, 0],
      flip: false,
      paint,
    };
    placements.push(placement);
    if (item.mirror) placements.push({ ...placement, flip: true });
  }
  return placements;
}

// Gives the paint of a decal area: the four tones of its color, or null when
// the area has no paint. "fallback" is the paint when the area has no paint
// or an unknown one, for the areas that always need paint.
function makePaint(car, skin = {}) {
  const livery = { ...car.livery, ...(skin.livery || {}) };
  const decals = { ...car.decals, ...(skin.decals || {}) };
  const tones = new Map();
  const tonesOf = (value) => {
    if (value === null || value === undefined) return null;
    if (!tones.has(value)) {
      const color = typeof value === "string" && Object.hasOwn(livery, value) ? livery[value] : value;
      tones.set(value, isHexColor(color) || (color && typeof color === "object") ? paintTones(color) : null);
    }
    return tones.get(value);
  };
  return (area, fallback = null) => tonesOf(decals[area]) ?? tonesOf(fallback);
}

// Splits the parts into groups: parts that do not move and are next to each
// other share a group, and each moving part is its own group.
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
    ctx.rotate(placement.flip ? -motion.steerAngle : motion.steerAngle);
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
