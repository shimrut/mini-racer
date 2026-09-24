// Drawing helpers that the car parts share. A "trace" function adds a shape
// to the current path. It does not start a new path, so that one shape can be
// used to fill, to outline and to clip.

// Adds a closed, smooth line through the points.
export function traceSmooth(ctx, points) {
  const count = points.length;
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

// The full outline of a shape that has the same left and right side. The
// points give the left half (negative y), from the rear to the front. The
// first and the last point must be on the center line (y = 0).
export function mirrorHalf(halfPoints) {
  const mirror = halfPoints.slice(1, -1).reverse().map(([x, y]) => [x, -y]);
  return [...halfPoints, ...mirror];
}

// Adds a closed shape through the corners, with rounded corners.
export function traceRoundedPolygon(ctx, corners, radius) {
  const last = corners[corners.length - 1];
  const first = corners[0];
  ctx.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    ctx.arcTo(corner[0], corner[1], next[0], next[1], radius);
  });
  ctx.closePath();
}

export function traceRoundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

// Fills a shape and draws its black outline.
export function fillWithOutline(ctx, trace, fill, { outline, outlineColor }) {
  ctx.beginPath();
  trace(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  if (outline > 0) {
    ctx.lineWidth = outline;
    ctx.strokeStyle = outlineColor;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

export function fillShape(ctx, trace, fill) {
  ctx.beginPath();
  trace(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
}

// Runs draw() with everything outside the shape masked off.
export function insideShape(ctx, trace, draw) {
  ctx.save();
  ctx.beginPath();
  trace(ctx);
  ctx.clip();
  draw();
  ctx.restore();
}

// Paints a band of the given width along all edges, inside the shape.
export function edgeBand(ctx, trace, color, width) {
  insideShape(ctx, trace, () => {
    ctx.beginPath();
    trace(ctx);
    ctx.lineWidth = width * 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
  });
}

// Paints a band along the edges that face one direction, inside the shape.
// A positive depth paints the edges that face +y (the lower edges), a
// negative depth paints the edges that face -y.
export function facingBand(ctx, trace, color, depth) {
  insideShape(ctx, trace, () => {
    ctx.beginPath();
    trace(ctx);
    ctx.save();
    ctx.translate(0, -depth);
    trace(ctx);
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fill("evenodd");
  });
}

function parseHex(hex) {
  const value = String(hex).replace("#", "");
  const full = value.length === 3 ? value.replace(/./g, "$&$&") : value;
  const number = parseInt(full, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

export function rgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

// A color between two colors. 0 gives the first color, 1 the second.
export function mix(fromHex, toHex, amount) {
  const from = parseHex(fromHex);
  const to = parseHex(toHex);
  const t = clamp01(amount);
  const channels = from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function isHexColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

// The four tones of one paint color: the color itself, its shadow, its deep
// shadow and its highlight. A color can also come as an object that gives
// some tones by hand; the missing tones are made from the base.
export function paintTones(color) {
  const tones = typeof color === "string" ? { base: color } : { ...color };
  if (!isHexColor(tones.base)) return null;
  return {
    base: tones.base,
    shade: isHexColor(tones.shade) ? tones.shade : mix(tones.base, "#000000", 0.28),
    deep: isHexColor(tones.deep) ? tones.deep : mix(tones.base, "#000000", 0.4),
    light: isHexColor(tones.light) ? tones.light : mix(tones.base, "#ffffff", 0.22),
  };
}
