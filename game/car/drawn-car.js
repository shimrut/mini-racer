// A race car drawn in code, not loaded from an image. It copies the red
// open-wheel car, seen from above, with the nose to the right.
//
// To change the car, edit DRAWN_CAR_DESIGN. To make a variant, give only the
// changes: new DrawnCar({ colors: { paint: "#1e6fe8" } }).
//
// All sizes are in car units. The car is 100 units long: the rear wing is at
// x = -50 and the nose tip is at x = 50. Negative y is the left side of the
// car and positive y is the right side. Parts that are on the two sides are
// given for the left side only. The right side is a mirror copy.
//
// Three parts move:
// - The front wheels turn left and right with the steering.
// - The tire treads roll with the speed.
// - The brake lights come on when the car loses speed quickly.

export const DRAWN_CAR_DESIGN = deepFreeze({
  colors: {
    paint: "#e8141c",
    paintShade: "#b00c14",
    paintShine: "#ff4d42",
    stripe: "#ffd21f",
    cockpit: "#3b4049",
    cockpitShine: "#7d8894",
    intake: "#3b4049",
    frame: "#3a3d43",
    frameShine: "#575b62",
    tire: "#2b2d32",
    tireFace: "#44474d",
    tireSide: "#666a72",
    tireGroove: "#1f2024",
    outline: "#111113",
    brakeLightOff: "#5c1418",
    brakeLightOn: "#ff3b30",
    brakeLightCore: "#ffe6de",
    brakeGlow: "#ff2d23",
  },
  // The width of the black outline.
  outline: 1.3,
  // The square that holds the car. The car is 100 units of it.
  boxSize: 110,

  body: {
    // The left half of the body, from the rear to the nose tip. The code
    // draws a smooth line through these points.
    points: [
      [-36.2, 0], [-35.6, -5.5], [-31, -8.5], [-27.5, -10.6], [-24.5, -14.8],
      [-17, -17.8], [-9, -19.2], [-3, -18.2], [3, -14.7], [10, -10.8],
      [18, -8.6], [28, -6.8], [38, -4.8], [46, -3], [50, 0],
    ],
    // The bright paint inside the dark edge, as a part of the body width.
    paintWidth: 0.74,
    // The light line along the top of the body.
    shine: [
      [-33, 0], [-29, -4.6], [-18, -6.2], [0, -5.6], [20, -3.6], [40, -1.6], [47.5, 0],
    ],
  },
  cockpit: { x: -3, length: 28, width: 17.4 },
  // The air intake on the side of the body, as four corners.
  intake: [[-24.5, -13], [-14.8, -16.8], [-12.6, -12.2], [-22.8, -9.6]],
  stripe: { from: 32.8, to: 41.2, width: 3.2 },
  gearbox: { from: -41, to: -34, width: 16 },
  // flapX is the line on the rear wing. flapWidth is its length.
  rearWing: { from: -49.6, to: -40.2, width: 35, flapX: -45.8, flapWidth: 20 },
  // The front wing, as four corners of its left half.
  frontWing: [[38.8, -4.5], [37.2, -18.6], [41.8, -18.6], [47.4, -5.2]],
  frontWingUnder: [[35.8, -4.5], [35.8, -17.2], [37.4, -17.8], [38.9, -4.5]],
  // The suspension arms, from the wheel hub to the body.
  arms: {
    width: 2.4,
    lines: [
      [[26.3, -19], [19.1, -8]],
      [[27.3, -19], [31.8, -5.5]],
      [[-30.5, -20], [-34.5, -9.5]],
      [[-29.5, -20], [-26, -9]],
      [[-40, -12.5], [-30, -8]],
    ],
  },
  // The wheel centers are on the left side.
  wheels: {
    front: { x: 26.8, y: -21.5, length: 16.6, width: 10.2 },
    rear: { x: -29.8, y: -22.7, length: 17.6, width: 12.4 },
    // The light oval on the side of the tire, as a part of the tire width.
    sideWidth: 0.24,
  },
  steering: {
    // The turn angle of the front wheels at full steering.
    maxAngleDeg: 24,
    // The time the wheels take to go most of the way to a new angle.
    responseSec: 0.06,
  },
  treads: {
    // The distance between two grooves across the tire.
    spacing: 4,
    width: 0.8,
    // The grooves move by this part of the spacing in one frame, or less.
    // A larger step makes a fast wheel look like it turns backward.
    maxStepPerFrame: 0.42,
  },
  brakeLights: {
    // The two lamps on the rear wing tips, then the rain light at the center.
    lamps: [
      { x: -47.8, y: -12.6, length: 2.8, width: 5 },
      { x: -47.8, y: 12.6, length: 2.8, width: 5 },
      { x: -51.2, y: 0, length: 2.8, width: 5 },
    ],
    // The lights come on when the car loses more speed than this.
    decelKphPerSec: 60,
    // The lights stay on for this time after the car stops losing speed.
    holdSec: 0.22,
    onSec: 0.05,
    offSec: 0.18,
    // The red light on the ground behind the car.
    glowRadius: 20,
    glowStrength: 0.55,
  },
});

export class DrawnCar {
  constructor(design = {}, { pixelsPerUnit = 2 } = {}) {
    this.design = mergeDesign(DRAWN_CAR_DESIGN, design);
    this.pixelsPerUnit = pixelsPerUnit;
    this.layers = null;
    this.frame = null;
    this.frameKey = "";
    this.staticSprite = null;
    this.resetMotion();
  }

  resetMotion() {
    this.steerAngle = 0;
    this.treadOffset = 0;
    this.treadBlur = 0;
    this.brake = 0;
    this.brakeHoldSec = 0;
    this.lastSpeedKph = null;
  }

  // dt: seconds since the last frame. 0 stops all motion.
  // speedKph: the car speed, for the brake lights.
  // speedPx: the car speed in world pixels per second, for the treads.
  // steer: -1 is full left, 1 is full right.
  // holding: true keeps the brake lights on, as on the start grid.
  // size: the drawn size of the car box in world pixels.
  update(dt, { speedKph = 0, speedPx = 0, steer = 0, holding = false, size = 52 } = {}) {
    if (!(dt > 0)) return;
    const { steering, treads, brakeLights, boxSize } = this.design;

    const steerTarget = clamp(steer, -1, 1) * steering.maxAngleDeg * (Math.PI / 180);
    this.steerAngle += (steerTarget - this.steerAngle)
      * (1 - Math.exp(-dt / Math.max(0.001, steering.responseSec)));

    const rolled = Math.max(0, speedPx) * dt * (boxSize / Math.max(1, size));
    const step = Math.min(rolled, treads.spacing * treads.maxStepPerFrame);
    this.treadOffset = (this.treadOffset + step) % treads.spacing;
    const blurTarget = clamp(rolled / (treads.spacing * 1.5), 0, 1);
    this.treadBlur += (blurTarget - this.treadBlur) * Math.min(1, dt * 10);

    const decel = this.lastSpeedKph === null ? 0 : (this.lastSpeedKph - speedKph) / dt;
    this.lastSpeedKph = speedKph;
    if (holding) {
      this.brakeHoldSec = brakeLights.holdSec;
      this.brake = 1;
    } else if (decel >= brakeLights.decelKphPerSec) {
      this.brakeHoldSec = brakeLights.holdSec;
    } else {
      this.brakeHoldSec = Math.max(0, this.brakeHoldSec - dt);
    }
    const brakeTarget = this.brakeHoldSec > 0 ? 1 : 0;
    if (brakeTarget > this.brake) {
      this.brake = Math.min(brakeTarget, this.brake + dt / Math.max(0.001, brakeLights.onSec));
    } else {
      this.brake = Math.max(brakeTarget, this.brake - dt / Math.max(0.001, brakeLights.offSec));
    }
  }

  // The car at rest, with straight wheels and the brake lights off. Other
  // screens use it as a plain car image: the ghost car and the track cards.
  get sprite() {
    if (!this.staticSprite) {
      this.staticSprite = this.paint(null, STILL_POSE);
    }
    return this.staticSprite;
  }

  // Draws the car at the origin, with the nose on the +x axis. The box of the
  // car is size x size pixels.
  draw(ctx, size) {
    const frame = this.renderFrame();
    if (!frame) return;
    ctx.drawImage(frame, -size / 2, -size / 2, size, size);
  }

  // Draws the red light on the ground behind the car. Call it before draw().
  drawBrakeGlow(ctx, size) {
    if (this.brake < 0.01) return;
    const { brakeLights, boxSize, colors } = this.design;
    const scale = size / boxSize;
    const rearX = Math.min(...brakeLights.lamps.map((lamp) => lamp.x - lamp.length / 2));
    const radius = brakeLights.glowRadius * scale;
    const alpha = brakeLights.glowStrength * this.brake;
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(rearX * scale, 0);
    ctx.scale(1, 1.6);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, rgba(colors.brakeGlow, alpha));
    glow.addColorStop(0.4, rgba(colors.brakeGlow, alpha * 0.45));
    glow.addColorStop(1, rgba(colors.brakeGlow, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The car in its current pose. The frame is drawn again only when the pose
  // changes.
  renderFrame() {
    const key = `${this.steerAngle.toFixed(3)}|${this.treadOffset.toFixed(2)}|`
      + `${this.treadBlur.toFixed(2)}|${this.brake.toFixed(2)}`;
    if (this.frame && key === this.frameKey) return this.frame;
    const frame = this.paint(this.frame, this);
    if (frame) {
      this.frame = frame;
      this.frameKey = key;
    }
    return frame;
  }

  paint(target, pose) {
    const layers = this.getLayers();
    if (!layers) return null;
    const canvas = target || createCanvas(layers.pixels, layers.pixels);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    const center = layers.pixels / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layers.under, 0, 0);
    ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, center, center);
    drawWheels(ctx, this.design, pose);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layers.over, 0, 0);
    ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, center, center);
    drawBrakeLights(ctx, this.design, pose.brake);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  // The parts that do not move, drawn one time. "under" is below the wheels
  // and "over" is above them.
  getLayers() {
    if (this.layers) return this.layers;
    const pixels = Math.ceil(this.design.boxSize * this.pixelsPerUnit);
    const under = createCanvas(pixels, pixels);
    const over = createCanvas(pixels, pixels);
    if (!under || !over) return null;
    for (const [canvas, drawLayer] of [[under, drawUnderLayer], [over, drawOverLayer]]) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(this.pixelsPerUnit, 0, 0, this.pixelsPerUnit, pixels / 2, pixels / 2);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      drawLayer(ctx, this.design);
    }
    this.layers = { pixels, under, over };
    return this.layers;
  }
}

const STILL_POSE = Object.freeze({ steerAngle: 0, treadOffset: 0, treadBlur: 0, brake: 0 });

function drawUnderLayer(ctx, design) {
  const { arms, colors, outline } = design;
  for (const side of [1, -1]) {
    for (const [from, to] of arms.lines) {
      ctx.beginPath();
      ctx.moveTo(from[0], from[1] * side);
      ctx.lineTo(to[0], to[1] * side);
      ctx.strokeStyle = colors.outline;
      ctx.lineWidth = arms.width + outline * 2;
      ctx.stroke();
      ctx.strokeStyle = colors.frame;
      ctx.lineWidth = arms.width;
      ctx.stroke();
      ctx.strokeStyle = colors.frameShine;
      ctx.lineWidth = arms.width * 0.3;
      ctx.stroke();
    }
  }
}

function drawOverLayer(ctx, design) {
  const { colors, outline, body } = design;
  ctx.lineWidth = outline;
  ctx.strokeStyle = colors.outline;

  const { gearbox } = design;
  roundRect(ctx, gearbox.from, -gearbox.width / 2, gearbox.to - gearbox.from, gearbox.width, 2);
  fillAndStroke(ctx, colors.frame);

  const wing = design.rearWing;
  roundRect(ctx, wing.from, -wing.width / 2, wing.to - wing.from, wing.width, 2.4);
  fillAndStroke(ctx, colors.paint);
  const flapHalf = wing.flapWidth / 2;
  const flapBend = wing.flapX - wing.from - 0.6;
  ctx.beginPath();
  ctx.moveTo(wing.from + 0.6, -flapHalf);
  ctx.quadraticCurveTo(wing.flapX, -flapHalf, wing.flapX, -flapHalf + flapBend);
  ctx.lineTo(wing.flapX, flapHalf - flapBend);
  ctx.quadraticCurveTo(wing.flapX, flapHalf, wing.from + 0.6, flapHalf);
  ctx.save();
  ctx.lineWidth = outline * 0.7;
  ctx.strokeStyle = colors.paintShade;
  ctx.stroke();
  ctx.restore();

  for (const side of [1, -1]) {
    polygon(ctx, design.frontWingUnder, side);
    fillAndStroke(ctx, colors.frame);
    polygon(ctx, design.frontWing, side);
    fillAndStroke(ctx, colors.paint);
  }

  traceMirrored(ctx, body.points);
  fillAndStroke(ctx, colors.paintShade);
  traceMirrored(ctx, body.points.map(([x, y], index) => (
    [index === 0 ? x + 2 : x, y * body.paintWidth]
  )));
  ctx.fillStyle = colors.paint;
  ctx.fill();
  traceMirrored(ctx, body.shine);
  ctx.fillStyle = colors.paintShine;
  ctx.fill();

  for (const side of [1, -1]) {
    polygon(ctx, design.intake, side);
    fillAndStroke(ctx, colors.intake);
  }

  const { cockpit } = design;
  ctx.beginPath();
  ctx.ellipse(cockpit.x, 0, cockpit.length / 2, cockpit.width / 2, 0, 0, Math.PI * 2);
  fillAndStroke(ctx, colors.cockpit);
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(
    cockpit.x + cockpit.length * 0.02,
    -cockpit.width * 0.27,
    cockpit.length * 0.32,
    cockpit.width * 0.09,
    -0.04,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = colors.cockpitShine;
  ctx.fill();
  ctx.restore();

  const { stripe } = design;
  const rearHalf = stripe.width / 2;
  const noseHalf = stripe.width * 0.35;
  ctx.beginPath();
  ctx.moveTo(stripe.from + rearHalf, -rearHalf);
  ctx.lineTo(stripe.to - noseHalf, -noseHalf);
  ctx.arc(stripe.to - noseHalf, 0, noseHalf, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(stripe.from + rearHalf, rearHalf);
  ctx.arc(stripe.from + rearHalf, 0, rearHalf, Math.PI / 2, Math.PI * 1.5);
  ctx.fillStyle = colors.stripe;
  ctx.fill();
}

function drawWheels(ctx, design, pose) {
  const { wheels } = design;
  for (const side of [1, -1]) {
    drawTire(ctx, design, wheels.front, side, pose.steerAngle, pose);
    drawTire(ctx, design, wheels.rear, side, 0, pose);
  }
}

function drawTire(ctx, design, wheel, side, angle, pose) {
  const { colors, outline, treads } = design;
  const halfLength = wheel.length / 2;
  const halfWidth = wheel.width / 2;
  const radius = Math.min(wheel.length, wheel.width) * 0.28;
  // The light oval is on the +y edge on the two sides of the car, as in the
  // image this car copies.
  const sideWidth = wheel.width * design.wheels.sideWidth;
  const inset = outline * 0.7;

  ctx.save();
  ctx.translate(wheel.x, wheel.y * side);
  ctx.rotate(angle);
  roundRect(ctx, -halfLength, -halfWidth, wheel.length, wheel.width, radius);
  ctx.fillStyle = colors.tire;
  ctx.fill();

  // The tread face, with grooves that roll toward the nose. The top of a
  // turning wheel moves forward.
  const faceX = -halfLength + inset;
  const faceY = -halfWidth + inset;
  const faceLength = wheel.length - inset * 2;
  const faceWidth = wheel.width - sideWidth - inset * 1.5;
  roundRect(ctx, faceX, faceY, faceLength, faceWidth, radius * 0.6);
  ctx.fillStyle = colors.tireFace;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.6 - pose.treadBlur * 0.35;
  ctx.fillStyle = colors.tireGroove;
  const first = faceX - treads.spacing + pose.treadOffset;
  for (let x = first; x < halfLength; x += treads.spacing) {
    ctx.fillRect(x, faceY, treads.width, faceWidth);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.ellipse(0, halfWidth - sideWidth * 0.62, halfLength - radius * 0.7, sideWidth * 0.36, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.tireSide;
  ctx.fill();

  roundRect(ctx, -halfLength, -halfWidth, wheel.length, wheel.width, radius);
  ctx.lineWidth = outline;
  ctx.strokeStyle = colors.outline;
  ctx.stroke();
  ctx.restore();
}

function drawBrakeLights(ctx, design, brake) {
  const { brakeLights, colors, outline } = design;
  ctx.lineWidth = outline * 0.8;
  ctx.strokeStyle = colors.outline;
  for (const lamp of brakeLights.lamps) {
    const x = lamp.x - lamp.length / 2;
    const y = lamp.y - lamp.width / 2;
    roundRect(ctx, x, y, lamp.length, lamp.width, 0.9);
    ctx.fillStyle = mixColors(colors.brakeLightOff, colors.brakeLightOn, brake);
    ctx.fill();
    ctx.stroke();
    if (brake > 0.01) {
      roundRect(ctx, x + lamp.length * 0.3, y + lamp.width * 0.25, lamp.length * 0.4, lamp.width * 0.5, 0.4);
      ctx.fillStyle = rgba(colors.brakeLightCore, brake);
      ctx.fill();
    }
  }
}

// Draws a closed, smooth shape through the points of the left half of an
// outline and through their mirror copy. The first and the last point must
// be on the center line (y = 0).
function traceMirrored(ctx, halfPoints) {
  const mirror = halfPoints.slice(1, -1).reverse().map(([x, y]) => [x, -y]);
  const points = [...halfPoints, ...mirror];
  const count = points.length;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 0; i < count; i += 1) {
    const before = points[(i - 1 + count) % count];
    const from = points[i];
    const to = points[(i + 1) % count];
    const after = points[(i + 2) % count];
    ctx.bezierCurveTo(
      from[0] + (to[0] - before[0]) / 6,
      from[1] + (to[1] - before[1]) / 6,
      to[0] - (after[0] - from[0]) / 6,
      to[1] - (after[1] - from[1]) / 6,
      to[0],
      to[1],
    );
  }
  ctx.closePath();
}

// Draws a closed shape through the corners. The corners are rounded.
function polygon(ctx, points, side, radius = 1.2) {
  const corners = points.map(([x, y]) => [x, y * side]);
  const last = corners[corners.length - 1];
  const first = corners[0];
  ctx.beginPath();
  ctx.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    ctx.arcTo(corner[0], corner[1], next[0], next[1], radius);
  });
  ctx.closePath();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fillAndStroke(ctx, color) {
  ctx.fillStyle = color;
  ctx.fill();
  ctx.stroke();
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

function parseHex(hex) {
  const value = String(hex).replace("#", "");
  const full = value.length === 3 ? value.replace(/./g, "$&$&") : value;
  const number = parseInt(full, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function rgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function mixColors(fromHex, toHex, amount) {
  const from = parseHex(fromHex);
  const to = parseHex(toHex);
  const t = clamp(amount, 0, 1);
  const [r, g, b] = from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Copies the base design, then puts the changes on top. Lists are replaced,
// not merged.
export function mergeDesign(base, changes) {
  const result = {};
  for (const key of Object.keys(base)) {
    const baseValue = base[key];
    const change = changes?.[key];
    if (change === undefined) result[key] = baseValue;
    else if (isPlainObject(baseValue) && isPlainObject(change)) result[key] = mergeDesign(baseValue, change);
    else result[key] = change;
  }
  return deepFreeze(result);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
