import { rgba } from "../paint.js";

// Mud on the car: brown splashes with small drops around them. The mud goes
// only where the car already has paint, so it never shows on the ground.
// It must come after the parts it covers, in the same group of parts that do
// not move.
//
// Each zone gives an area of the left side of the car, the number of
// splashes and their size. The right side gets its own splashes, so the two
// sides do not look the same. The seed makes the same splashes every time.
//
// A thin film of dust also covers the rear of the car. "dust" is its
// strength at the rear edge, and "dustTo" is where it ends.
export const mud = {
  defaults: {
    seed: 7,
    zones: [
      { x: [-18, 10], y: [-19.5, -11], count: 10, size: [0.8, 1.9] },
      { x: [-35, -24], y: [-12, -6], count: 4, size: [0.7, 1.5] },
      { x: [-49, -41], y: [-17, -6], count: 6, size: [0.7, 1.6] },
      { x: [14, 34], y: [-8, -4], count: 5, size: [0.6, 1.3] },
      { x: [37, 46], y: [-18, -8], count: 4, size: [0.6, 1.3] },
    ],
    dust: 0.3,
    dustTo: -12,
  },

  draw(ctx, { settings, colors }) {
    const random = seededRandom(settings.seed);
    const between = ([low, high]) => low + random() * (high - low);
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    if (settings.dust > 0) {
      const film = ctx.createLinearGradient(-55, 0, settings.dustTo, 0);
      film.addColorStop(0, rgba(colors.mud, settings.dust));
      film.addColorStop(1, rgba(colors.mud, 0));
      ctx.fillStyle = film;
      ctx.fillRect(-55, -55, settings.dustTo + 55, 110);
    }
    for (const zone of settings.zones) {
      for (const side of [1, -1]) {
        for (let i = 0; i < zone.count; i += 1) {
          splash(ctx, between(zone.x), between(zone.y) * side, between(zone.size), colors, random);
        }
      }
    }
    ctx.restore();
  },
};

function splash(ctx, x, y, size, colors, random) {
  ctx.globalAlpha = 0.6 + random() * 0.3;
  ctx.fillStyle = colors.mud;
  ctx.beginPath();
  ctx.ellipse(x, y, size * (0.8 + random() * 0.5), size * (0.6 + random() * 0.4), random() * Math.PI, 0, Math.PI * 2);
  ctx.fill();
  const drops = 2 + Math.floor(random() * 3);
  for (let i = 0; i < drops; i += 1) {
    const angle = random() * Math.PI * 2;
    const distance = size * (1.3 + random() * 1.1);
    const dropX = x + Math.cos(angle) * distance;
    const dropY = y + Math.sin(angle) * distance;
    const dropSize = size * (0.15 + random() * 0.2);
    ctx.beginPath();
    ctx.arc(dropX, dropY, dropSize, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha *= 0.7;
  ctx.fillStyle = colors.mudLight;
  ctx.beginPath();
  ctx.ellipse(x - size * 0.25, y - size * 0.25, size * 0.35, size * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// The same list of numbers from 0 to 1 for the same seed.
function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
