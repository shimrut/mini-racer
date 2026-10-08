import { rgba } from "../paint.js";

// Jet ski bow waves and stern foam, drawn on the water; both grow with speed.
export const wake = {
  defaults: {
    // At this pace (car units each second), the wake is at its full size.
    fullPace: 1180,
    sternX: -45,
    // Stern wash half width, and its length at rest and at full speed.
    washHalfWidth: 9,
    washLength: [6, 34],
    washSpread: 7,
    bubbles: 7,
    // Bow wave reach from the hull, at rest and at full speed.
    bowWave: [0.6, 5],
    // The left hull edge, bow to the end of the bow wave.
    bowEdge: [[48, 0], [46.5, -2.6], [40, -6.5], [30, -11], [18, -15], [4, -17.6], [-10, -18.6]],
    alpha: 0.85,
  },

  draw() {},

  drawGround(ctx, { settings, colors, motion }) {
    const share = Math.min(1, Math.max(0, (motion.pace || 0) / settings.fullPace));
    const foam = rgba(colors.foam, settings.alpha);
    const { sternX, washHalfWidth, washSpread } = settings;
    const washLength = settings.washLength[0] + share * (settings.washLength[1] - settings.washLength[0]);
    const endHalf = washHalfWidth + washSpread * share;

    ctx.fillStyle = foam;
    ctx.beginPath();
    ctx.moveTo(sternX + 2, -washHalfWidth);
    ctx.lineTo(sternX - washLength, -endHalf);
    ctx.lineTo(sternX - washLength - 3, 0);
    ctx.lineTo(sternX - washLength, endHalf);
    ctx.lineTo(sternX + 2, washHalfWidth);
    ctx.closePath();
    ctx.fill();

    // Bubbles stream back from the stern and stay in the wash.
    ctx.fillStyle = rgba(colors.foam, 1);
    ctx.beginPath();
    for (let i = 0; i < settings.bubbles; i += 1) {
      const along = ((i * 0.37 + (motion.roll || 0) * 0.02) % 1) * washLength;
      const across = Math.sin(i * 2.3) * (washHalfWidth + (washSpread * share * along) / washLength) * 0.7;
      const radius = 1.2 + (i % 3) * 0.5;
      const x = sternX - along;
      ctx.moveTo(x + radius, across);
      ctx.arc(x, across, radius, 0, Math.PI * 2);
    }
    ctx.fill();

    // The bow waves: a band along each side of the bow, wider at the rear.
    const standOut = settings.bowWave[0] + share * (settings.bowWave[1] - settings.bowWave[0]);
    const edge = settings.bowEdge;
    ctx.fillStyle = foam;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      edge.forEach(([x, y], index) => {
        const push = (standOut * index) / (edge.length - 1);
        if (index === 0) ctx.moveTo(x, y * side);
        else ctx.lineTo(x - push * 0.3, (y - push) * side);
      });
      for (let index = edge.length - 1; index >= 0; index -= 1) {
        const [x, y] = edge[index];
        ctx.lineTo(x, y * side);
      }
      ctx.closePath();
      ctx.fill();
    }
  },
};
