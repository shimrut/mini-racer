import { CONFIG } from "../config.js";
import { RingBuffer } from "./ring-buffer.js";
import { getCarRearAxleWorldPoint } from "./simulation.js";
import { KPH_PER_WORLD_UNIT } from "../car/handling.js";
import { getTrackGround } from "../track/grounds.js";

// Look-only ground effects (tracks, spray, skid look, wake, engine trails), outside the shared simulation.

const TYRE_TRACK_DEFAULT_SECONDS = 3;
const TYRE_TRACK_MAX_SECONDS = 5;
const TYRE_TRACK_CAPACITY = TYRE_TRACK_MAX_SECONDS * 60;
const TYRE_TRACK_MIN_SPEED = 2.5;
const MARK_HALF_WIDTH = 0.17;
const MARK_GAP_BREAK_DIST_SQ = 0.45 * 0.45;
const TYRE_TRACK_FADE_STEPS = 6;
// On a slow device, fewer fade steps halve the strokes.
const TYRE_TRACK_LOW_QUALITY_FADE_STEPS = 3;
// The shade side of a groove, as parts of its width.
const TYRE_TRACK_SHADE_OFFSET = 0.35;
const TYRE_TRACK_SHADE_WIDTH = 0.45;

const SPRAY_MIN_SPEED = 3;
// Spray starts just behind the rear tires, not from under the car.
const SPRAY_BEHIND_CENTER = 0.6;
const SPRAY_HALF_WIDTH = 0.28;
// Front dust starts behind the front tires, tire-wide (4-6 px) and full size at once.
const SPRAY_FRONT_AHEAD_OF_CENTER = 0.2;
const SPRAY_FRONT_HALF_WIDTH = 0.26;
const SPRAY_FRONT_POP = 0.12;
const SPRAY_FRONT_SPREAD_SCALE = 0.3;
const SPRAY_FRONT_MIN_SIZE = 2.3;
const SPRAY_FRONT_MAX_SIZE = 3;
// Spray follows speed: a few small lumps just above SPRAY_MIN_SPEED, more full-size ones at top speed.
const SPRAY_SLOW_SIZE = 0.3;
const SPRAY_FAST_SIZE = 1;
// Top-speed share of the style amount, so lumps stay apart instead of one plume.
const SPRAY_FAST_AMOUNT = 0.5;

// Spray lumps keep some car speed, fly back and out, grow, then shrink; shaded when the ground gives colours.
// Styles: lumps (water splashes), snow (all wheels), dust (low merging cloud); frontShare and followsSpeed tune them.
const SPRAY_LUMPS = Object.freeze({
  baseChance: 0.45,
  slipChance: 0.9,
  carry: 0.35,
  throw: 1.5,
  spread: 2.2,
  minSize: 4,
  maxSize: 9,
  minLife: 0.45,
  lifeRange: 0.35,
  // The part of its life a lump takes to reach its full size.
  pop: 0.2,
  frontShare: 0,
});
const SPRAY_STYLES = Object.freeze({
  lumps: SPRAY_LUMPS,
  snow: Object.freeze({ ...SPRAY_LUMPS, frontShare: 0.5, followsSpeed: true }),
  dust: Object.freeze({
    baseChance: 0.6,
    slipChance: 0.8,
    carry: 0.5,
    throw: 0.5,
    spread: 0.6,
    minSize: 6,
    maxSize: 10,
    minLife: 0.3,
    lifeRange: 0.15,
    pop: 0.35,
    frontShare: 0.5,
    followsSpeed: true,
  }),
});
const SPRAY_DRAG = 3;
// Wall hit lumps pop up like snow lumps.
const SPRAY_POP = SPRAY_STYLES.lumps.pop;
const SPRAY_SHADE_OFFSET_X = 1.5;
const SPRAY_SHADE_OFFSET_Y = 2;
const SPRAY_LIGHT_OFFSET_X = -1;
const SPRAY_LIGHT_OFFSET_Y = -1.2;
const SPRAY_LIGHT_SCALE = 0.55;

// A bank hit throws bank lumps instead of sparks, drawn like spray; harder hits throw more.
const SCRAPE_MIN_LUMPS = 10;
const SCRAPE_MAX_LUMPS = 18;
const SCRAPE_THROW = 5;
const SCRAPE_SPREAD = 2.5;
const SCRAPE_CARRY = 0.3;
const SCRAPE_MIN_SIZE = 4;
const SCRAPE_MAX_SIZE = 9;

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

function spawnSpray(engine, heading, slipRatio, maxSpeedWorld, groundMaxSpeedWorld, presentation) {
  const style = SPRAY_STYLES[presentation.sprayStyle] || SPRAY_STYLES.lumps;
  const lowQuality = engine.frameSkip > 0 || engine.qualityLevel > 0;
  let chance;
  let rearSize = 1;
  let frontSize = 1;
  if (style.followsSpeed) {
    // 0 at SPRAY_MIN_SPEED, 1 at the top speed of the ground.
    const speedShare = Math.max(0, Math.min(1,
      (engine.cachedSpeed - SPRAY_MIN_SPEED) / Math.max(0.001, groundMaxSpeedWorld - SPRAY_MIN_SPEED)));
    chance = (style.baseChance + style.slipChance * slipRatio) * speedShare * SPRAY_FAST_AMOUNT;
    rearSize = SPRAY_SLOW_SIZE + (SPRAY_FAST_SIZE - SPRAY_SLOW_SIZE) * speedShare;
    frontSize = Math.min(1, rearSize);
  } else {
    const speedRatio = Math.min(1, engine.cachedSpeed / maxSpeedWorld);
    chance = style.baseChance * speedRatio + style.slipChance * slipRatio;
  }
  if (lowQuality) chance *= 0.5;

  const axles = [{
    ahead: -SPRAY_BEHIND_CENTER,
    halfWidth: SPRAY_HALF_WIDTH,
    chance,
    spreadScale: 1,
    pop: style.pop,
    minSize: style.minSize * rearSize,
    maxSize: style.maxSize * rearSize,
  }];
  if (style.frontShare > 0) {
    axles.push({
      ahead: SPRAY_FRONT_AHEAD_OF_CENTER,
      halfWidth: SPRAY_FRONT_HALF_WIDTH,
      chance: chance * style.frontShare,
      spreadScale: SPRAY_FRONT_SPREAD_SCALE,
      pop: SPRAY_FRONT_POP,
      minSize: SPRAY_FRONT_MIN_SIZE * frontSize,
      maxSize: SPRAY_FRONT_MAX_SIZE * frontSize,
    });
  }
  for (const axle of axles) {
    const axleX = engine.pos.x + heading.cos * axle.ahead;
    const axleY = engine.pos.y + heading.sin * axle.ahead;
    for (const side of [-1, 1]) {
      if (Math.random() >= axle.chance) continue;
      spawnSprayLump(engine, heading, presentation, style, axle, side,
        axleX + side * heading.sin * axle.halfWidth,
        axleY - side * heading.cos * axle.halfWidth);
    }
  }
}

function spawnSprayLump(engine, heading, presentation, style, axle, side, x, y) {
  const throwSpeed = style.throw * (0.6 + Math.random() * 0.8);
  // Each wheel throws its spray out to its own side, so the cloud fans out.
  const spread = side * style.spread * axle.spreadScale * (0.2 + Math.random());
  const life = style.minLife + Math.random() * style.lifeRange;
  engine.particles.push({
    x,
    y,
    vx: engine.velocity.x * style.carry - heading.cos * throwSpeed + heading.sin * spread,
    vy: engine.velocity.y * style.carry - heading.sin * throwSpeed - heading.cos * spread,
    life,
    maxLife: life,
    color: presentation.sprayColor,
    size: axle.minSize + Math.random() * (axle.maxSize - axle.minSize),
    pop: axle.pop,
    spray: true,
  });
}

// The point on the nearest wall line, and the direction from it into the road.
function findNearestWall(collisionHash, pos) {
  const segments = collisionHash?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let best = null;
  let bestDistSq = Infinity;
  for (const segment of segments) {
    const t = segment.lenSq > 0
      ? Math.max(0, Math.min(1, ((pos.x - segment.start.x) * segment.dx + (pos.y - segment.start.y) * segment.dy) / segment.lenSq))
      : 0;
    const x = segment.start.x + segment.dx * t;
    const y = segment.start.y + segment.dy * t;
    const distSq = (pos.x - x) * (pos.x - x) + (pos.y - y) * (pos.y - y);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = { x, y };
    }
  }
  const dist = Math.sqrt(bestDistSq);
  if (!(dist > 1e-6)) return null;
  return { point: best, normal: { x: (pos.x - best.x) / dist, y: (pos.y - best.y) / dist } };
}

function spawnScrapeDebris(engine, presentation, config, severity) {
  // Take away the sparks that the simulation made for this hit.
  const particles = engine.particles;
  while (particles.length > 0) {
    const last = particles[particles.length - 1];
    if (last.spray || last.color !== config?.sparkColor) break;
    particles.pop();
  }

  const wall = findNearestWall(engine.collisionHash, engine.pos);
  const normal = wall ? wall.normal : { x: -Math.cos(engine.angle), y: -Math.sin(engine.angle) };
  const origin = wall ? wall.point : engine.pos;
  const tangentX = -normal.y;
  const tangentY = normal.x;
  const hardness = Math.max(0, Math.min(1, Number(severity) || 0));
  const lowQuality = engine.frameSkip > 0 || engine.qualityLevel > 0;
  const count = Math.round((SCRAPE_MIN_LUMPS + (SCRAPE_MAX_LUMPS - SCRAPE_MIN_LUMPS) * hardness)
    * (lowQuality ? 0.5 : 1));
  for (let i = 0; i < count; i += 1) {
    const throwSpeed = SCRAPE_THROW * (0.4 + Math.random() * 0.8) * (0.7 + hardness * 0.5);
    const spread = (Math.random() - 0.5) * 2 * SCRAPE_SPREAD;
    const start = (Math.random() - 0.5) * 0.5;
    const life = 0.35 + Math.random() * 0.3;
    particles.push({
      x: origin.x + tangentX * start,
      y: origin.y + tangentY * start,
      vx: normal.x * throwSpeed + tangentX * spread + engine.velocity.x * SCRAPE_CARRY,
      vy: normal.y * throwSpeed + tangentY * spread + engine.velocity.y * SCRAPE_CARRY,
      life,
      maxLife: life,
      color: presentation.scrapeDebris.color,
      size: SCRAPE_MIN_SIZE + Math.random() * (SCRAPE_MAX_SIZE - SCRAPE_MIN_SIZE),
      spray: true,
      debris: true,
    });
  }
}

// Spray puffs slow down in the air. The shared particle step moves them.
function slowSpray(particles, dt) {
  const keep = Math.max(0, 1 - SPRAY_DRAG * dt);
  for (const particle of particles) {
    if (!particle.spray) continue;
    particle.vx *= keep;
    particle.vy *= keep;
  }
}

// Call once per physics step, after the car moved, with that step's events.
export function recordGroundEffects(engine, presentation, config, events = null) {
  const tracks = engine.tyreTracks;
  const trackColor = presentation?.tyreTrackColor;
  const sprayColor = presentation?.sprayColor;
  const scrapeDebris = presentation?.scrapeDebris;
  if (scrapeDebris && events?.wallImpact?.kind === "scrape" && Array.isArray(engine.particles)) {
    spawnScrapeDebris(engine, presentation, config, events.wallImpact.severity);
  }
  if ((sprayColor || scrapeDebris) && Array.isArray(engine.particles)) {
    slowSpray(engine.particles, Number(config?.fixedDt) || 1 / 60);
  }
  if (!tracks || (!trackColor && !sprayColor)) return;
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

  if (sprayColor && engine.cachedSpeed > SPRAY_MIN_SPEED && Array.isArray(engine.particles)) {
    const maxSpeedWorld = Math.max(0.001, (Number(config?.maxSpeed) || 220) / KPH_PER_WORLD_UNIT);
    const groundMaxSpeedWorld = maxSpeedWorld * getTrackGround(engine.currentTrack).maxSpeed;
    spawnSpray(engine, heading, getSlipRatio(engine), maxSpeedWorld, groundMaxSpeedWorld, presentation);
  }
}

// A lump grows to its full size, then shrinks away.
function getSprayRadius(particle) {
  const age = particle.maxLife > 0 ? 1 - Math.max(0, particle.life / particle.maxLife) : 1;
  const pop = particle.pop || SPRAY_POP;
  return particle.size * Math.min(1, age / pop) * Math.sqrt(1 - age);
}

// One fill per layer, so touching lumps merge.
function fillSprayLayer(ctx, particles, gs, debris, color, scale, offsetX, offsetY) {
  ctx.fillStyle = color;
  ctx.beginPath();
  let lumps = 0;
  for (const particle of particles) {
    if (!particle.spray || Boolean(particle.debris) !== debris) continue;
    const radius = getSprayRadius(particle) * scale;
    if (!(radius > 0.3)) continue;
    const x = particle.x * gs + offsetX;
    const y = particle.y * gs + offsetY;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    lumps += 1;
  }
  if (lumps > 0) ctx.fill();
}

// Spray and bank lumps, under the car and sparks; other particles are flat dots.
export function drawSpray(ctx, particles, presentation, gs) {
  if (!presentation || !Array.isArray(particles) || particles.length === 0) return;
  const debris = presentation.scrapeDebris;
  const layers = [
    [false, presentation.sprayColor, presentation.sprayShadeColor, presentation.sprayLightColor],
    [true, debris?.color, debris?.shade, debris?.light],
  ];
  ctx.save();
  for (const [isDebris, color, shade, light] of layers) {
    if (!color) continue;
    if (shade) {
      fillSprayLayer(ctx, particles, gs, isDebris, shade, 1, SPRAY_SHADE_OFFSET_X, SPRAY_SHADE_OFFSET_Y);
    }
    fillSprayLayer(ctx, particles, gs, isDebris, color, 1, 0, 0);
    if (light) {
      fillSprayLayer(ctx, particles, gs, isDebris, light, SPRAY_LIGHT_SCALE,
        SPRAY_LIGHT_OFFSET_X, SPRAY_LIGHT_OFFSET_Y);
    }
  }
  ctx.restore();
}

// Track and skid line offset from the car middle, in world units; a ground can set it.
export function getMarkHalfWidth(presentation) {
  return Number(presentation?.markHalfWidth) || MARK_HALF_WIDTH;
}

// One side of a mark line behind the rear wheels; a gap starts a new line, offset shifts it, halfWidthAt varies it.
export function addMarkSide(path, marks, start, end, gs, side, offset = 0, halfWidthAt = null) {
  const first = marks.get(start);
  const firstHalf = halfWidthAt ? halfWidthAt(start) : MARK_HALF_WIDTH;
  path.moveTo(
    (first.x + side * first.sin * firstHalf) * gs + offset,
    (first.y - side * first.cos * firstHalf) * gs + offset,
  );
  for (let i = start + 1; i <= end; i++) {
    const prev = marks.get(i - 1);
    const mark = marks.get(i);
    const dx = mark.x - prev.x;
    const dy = mark.y - prev.y;
    const half = halfWidthAt ? halfWidthAt(i) : MARK_HALF_WIDTH;
    const x = (mark.x + side * mark.sin * half) * gs + offset;
    const y = (mark.y - side * mark.cos * half) * gs + offset;
    if (dx * dx + dy * dy > MARK_GAP_BREAK_DIST_SQ) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}

// Tracks fade with age; lowQuality draws fewer fade steps.
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
  // Tire-wide tracks keep their world width; others keep most of their screen width when zoomed out.
  const lineWidth = presentation.tyreTrackIsTireWidth === true
    ? width
    : Math.max(width * 0.8, width / zoom);
  // A groove in earth or snow, shaded on its upper left side.
  const shadeColor = presentation.tyreTrackShadeColor;
  const shadeOffset = lineWidth * TYRE_TRACK_SHADE_OFFSET;
  const shadeWidth = lineWidth * TYRE_TRACK_SHADE_WIDTH;
  const fadeSteps = lowQuality ? TYRE_TRACK_LOW_QUALITY_FADE_STEPS : TYRE_TRACK_FADE_STEPS;
  const chunk = Math.ceil(visible / fadeSteps);
  // A wake opens out: each second, its two lines move this far apart.
  const spread = Number(presentation.tyreTrackSpread) || 0;
  const newest = tracks.length - 1;
  const halfWidth = getMarkHalfWidth(presentation);
  const halfWidthAt = spread > 0
    ? (index) => halfWidth + ((newest - index) / 60) * spread
    : () => halfWidth;
  const strokeChunk = (start, end, offset, strokeStyle, strokeWidth) => {
    ctx.beginPath();
    addMarkSide(ctx, tracks, start, end, gs, -1, offset, halfWidthAt);
    addMarkSide(ctx, tracks, start, end, gs, 1, offset, halfWidthAt);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  };
  for (let step = 0; step < fadeSteps; step++) {
    const start = first + step * chunk;
    if (start >= tracks.length - 1) break;
    const end = Math.min(tracks.length - 1, start + chunk);
    ctx.globalAlpha = (step + 1) / fadeSteps;
    if (shadeColor) strokeChunk(start, end, -shadeOffset, shadeColor, shadeWidth);
    strokeChunk(start, end, 0, color, lineWidth);
  }
  ctx.restore();
}

// Skid marks where the car slid, stroked with the current style.
export function strokeSkidMarks(ctx, presentation, zoom, strokePaths) {
  const lineWidth = Math.max(3.4, 4.2 / zoom) * (Number(presentation?.skidWidthScale) || 1);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = presentation?.skidColor || CONFIG.skidColor;
  ctx.lineWidth = lineWidth;
  strokePaths();
  ctx.restore();
}

// Skid marks with no path cache, for the Mapmaker playtest.
export function drawSkidMarks(ctx, skidMarks, presentation, gs, zoom) {
  if (!skidMarks || skidMarks.length < 2) return;
  const end = skidMarks.length - 1;
  const halfWidth = getMarkHalfWidth(presentation);
  strokeSkidMarks(ctx, presentation, zoom, () => {
    ctx.beginPath();
    addMarkSide(ctx, skidMarks, 0, end, gs, -1, 0, () => halfWidth);
    addMarkSide(ctx, skidMarks, 0, end, gs, 1, 0, () => halfWidth);
    ctx.stroke();
  });
}
