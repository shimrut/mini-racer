import { CONFIG } from "../config.js";
import { RingBuffer } from "./ring-buffer.js";
import { getCarRearAxleWorldPoint } from "./simulation.js";
import { KPH_PER_WORLD_UNIT } from "../car/handling.js";

// Look-only effects that keep the car on the ground on a loose surface:
// tyre tracks behind the rear wheels, small dust puffs, and the look of the
// skid marks. They never change the drive, so they live outside the shared
// simulation.

const TYRE_TRACK_DEFAULT_SECONDS = 3;
const TYRE_TRACK_MAX_SECONDS = 5;
const TYRE_TRACK_CAPACITY = TYRE_TRACK_MAX_SECONDS * 60;
const TYRE_TRACK_MIN_SPEED = 2.5;
const MARK_HALF_WIDTH = 0.17;
const MARK_GAP_BREAK_DIST_SQ = 0.45 * 0.45;
const TYRE_TRACK_FADE_STEPS = 6;
// On a slow device, fewer fade steps halve the strokes.
const TYRE_TRACK_LOW_QUALITY_FADE_STEPS = 3;

const DUST_MIN_SPEED = 3;
const DUST_BASE_CHANCE = 0.18;
const DUST_SLIP_CHANCE = 0.55;
// Dust starts just behind the rear edge of the car, in line with the rear
// tires, so it comes out from behind the car and not from under its middle.
const DUST_BEHIND_CENTER = 0.6;
const DUST_HALF_WIDTH = 0.28;

export function createTyreTrackBuffer() {
  return new RingBuffer(TYRE_TRACK_CAPACITY, () => ({
    x: 0,
    y: 0,
    cos: 0,
    sin: 0,
  }));
}

function getSlipRatio(engine) {
  const speed = engine.cachedSpeed;
  if (!(speed > 0.001)) return 0;
  const vx = Math.cos(engine.angle);
  const vy = Math.sin(engine.angle);
  return Math.abs(-vy * engine.velocity.x + vx * engine.velocity.y) / speed;
}

function spawnDust(engine, heading, slipRatio, maxSpeedWorld, presentation) {
  const color = presentation.dustColor;
  const edgeColor = presentation.dustEdgeColor;
  const sizeScale = Number(presentation.dustSizeScale) || 1;
  const speedRatio = Math.min(1, engine.cachedSpeed / maxSpeedWorld);
  const lowQuality = engine.frameSkip > 0 || engine.qualityLevel > 0;
  const chance = (DUST_BASE_CHANCE * speedRatio + DUST_SLIP_CHANCE * slipRatio)
    * (lowQuality ? 0.5 : 1);

  const backX = engine.pos.x - heading.cos * DUST_BEHIND_CENTER;
  const backY = engine.pos.y - heading.sin * DUST_BEHIND_CENTER;
  for (const side of [-1, 1]) {
    if (Math.random() >= chance) continue;
    const wheelX = backX + side * heading.sin * DUST_HALF_WIDTH;
    const wheelY = backY - side * heading.cos * DUST_HALF_WIDTH;
    const drift = 0.4 + Math.random() * 0.8;
    const spread = (Math.random() - 0.5) * 1.2;
    const life = 0.35 + Math.random() * 0.3;
    const size = (4 + Math.random() * 4) * sizeScale;
    const vx = -heading.cos * drift - heading.sin * spread;
    const vy = -heading.sin * drift + heading.cos * spread;
    // On a pale ground, a slightly larger darker puff underneath gives the
    // spray an edge, so it stands out from the road.
    if (edgeColor) {
      engine.particles.push({
        x: wheelX, y: wheelY, vx, vy, life, maxLife: life, color: edgeColor, size: size + 1.5,
      });
    }
    engine.particles.push({
      x: wheelX, y: wheelY, vx, vy, life, maxLife: life, color, size,
    });
  }
}

// Call once per physics step, after the simulation moved the car.
export function recordGroundEffects(engine, presentation, config) {
  const tracks = engine.tyreTracks;
  const trackColor = presentation?.tyreTrackColor;
  const dustColor = presentation?.dustColor;
  if (!tracks || (!trackColor && !dustColor)) return;
  if (engine.status !== "playing" || engine.relaunchDelayRemaining > 0) return;
  if (!(engine.cachedSpeed > TYRE_TRACK_MIN_SPEED)) return;

  const rear = getCarRearAxleWorldPoint(engine.pos, engine.angle, config);
  const heading = { cos: Math.cos(engine.angle), sin: Math.sin(engine.angle) };

  if (trackColor) {
    const slot = tracks.write();
    slot.x = rear.x;
    slot.y = rear.y;
    slot.cos = heading.cos;
    slot.sin = heading.sin;
  }

  if (dustColor && engine.cachedSpeed > DUST_MIN_SPEED && Array.isArray(engine.particles)) {
    const maxSpeedWorld = Math.max(0.001, (Number(config?.maxSpeed) || 220) / KPH_PER_WORLD_UNIT);
    spawnDust(engine, heading, getSlipRatio(engine), maxSpeedWorld, presentation);
  }
}

// One side of a line of marks behind the rear wheels, for tyre tracks and
// skid marks. A gap in the marks starts a new line.
export function addMarkSide(path, marks, start, end, gs, side) {
  const first = marks.get(start);
  path.moveTo(
    (first.x + side * first.sin * MARK_HALF_WIDTH) * gs,
    (first.y - side * first.cos * MARK_HALF_WIDTH) * gs,
  );
  for (let i = start + 1; i <= end; i++) {
    const prev = marks.get(i - 1);
    const mark = marks.get(i);
    const dx = mark.x - prev.x;
    const dy = mark.y - prev.y;
    const x = (mark.x + side * mark.sin * MARK_HALF_WIDTH) * gs;
    const y = (mark.y - side * mark.cos * MARK_HALF_WIDTH) * gs;
    if (dx * dx + dy * dy > MARK_GAP_BREAK_DIST_SQ) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}

// The oldest part of the tracks is the faintest, so they fade out behind the car.
// lowQuality: true draws fewer fade steps, for a slow device.
export function drawTyreTracks(ctx, tracks, presentation, gs, zoom, lowQuality = false) {
  const color = presentation?.tyreTrackColor;
  if (!color || !tracks || tracks.length < 2) return;

  // A ground sets how many seconds of tracks stay visible behind the car.
  const seconds = Math.min(
    TYRE_TRACK_MAX_SECONDS,
    Number(presentation.tyreTrackSeconds) || TYRE_TRACK_DEFAULT_SECONDS,
  );
  const first = Math.max(0, tracks.length - Math.round(seconds * 60));
  const visible = tracks.length - first;
  if (visible < 2) return;
  const width = Number(presentation.tyreTrackWidth) || 3;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const lineWidth = Math.max(width * 0.8, width / zoom);
  // A rut: a light ridge of pushed-aside snow or soil under a darker groove.
  const edgeColor = presentation.tyreTrackEdgeColor;
  const edgeWidth = lineWidth + 2 * (Number(presentation.tyreTrackEdgeWidth) || 1.5);
  const fadeSteps = lowQuality ? TYRE_TRACK_LOW_QUALITY_FADE_STEPS : TYRE_TRACK_FADE_STEPS;
  const chunk = Math.ceil(visible / fadeSteps);
  for (let step = 0; step < fadeSteps; step++) {
    const start = first + step * chunk;
    if (start >= tracks.length - 1) break;
    const end = Math.min(tracks.length - 1, start + chunk);
    ctx.globalAlpha = (step + 1) / fadeSteps;
    ctx.beginPath();
    addMarkSide(ctx, tracks, start, end, gs, -1);
    addMarkSide(ctx, tracks, start, end, gs, 1);
    if (edgeColor) {
      ctx.strokeStyle = edgeColor;
      ctx.lineWidth = edgeWidth;
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

// Skid marks show where the car slid. A ground can put a light ridge of
// pushed-aside soil along each dark mark, so a slide stands out from the
// tyre tracks. strokePaths strokes the mark paths with the current style.
export function strokeSkidMarks(ctx, presentation, zoom, strokePaths) {
  const lineWidth = Math.max(3.4, 4.2 / zoom);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const edgeColor = presentation?.skidEdgeColor;
  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = lineWidth + 2 * (Number(presentation.skidEdgeWidth) || 1.5);
    strokePaths();
  }
  ctx.strokeStyle = presentation?.skidColor || CONFIG.skidColor;
  ctx.lineWidth = lineWidth;
  strokePaths();
  ctx.restore();
}

// Skid marks with no path cache, for the Mapmaker playtest.
export function drawSkidMarks(ctx, skidMarks, presentation, gs, zoom) {
  if (!skidMarks || skidMarks.length < 2) return;
  const end = skidMarks.length - 1;
  strokeSkidMarks(ctx, presentation, zoom, () => {
    ctx.beginPath();
    addMarkSide(ctx, skidMarks, 0, end, gs, -1);
    addMarkSide(ctx, skidMarks, 0, end, gs, 1);
    ctx.stroke();
  });
}
