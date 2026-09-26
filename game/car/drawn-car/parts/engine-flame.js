// The flame of one spaceship engine, behind its nozzle, on the left side.
// Place it with mirror: true for the right engine. The flame is a flat
// point of light with a white core. It grows with the speed and flickers
// a little. It is drawn under the pod.
export const engineFlame = {
  moves: true,
  defaults: {
    // At this pace (car units each second), the flame is at its full length.
    fullPace: 1420,
    x: -45,
    y: -12.5,
    halfWidth: 3.4,
    // The flame length at rest and at full speed. The box of the car ends
    // at x = -55.
    length: [2.5, 8],
    flicker: 0.9,
  },

  draw(ctx, { settings, colors, motion }) {
    const share = Math.min(1, Math.max(0, (motion.pace || 0) / settings.fullPace));
    const { x, y, halfWidth } = settings;
    const flicker = Math.sin((motion.roll || 0) * 2.7) * settings.flicker * (0.3 + share * 0.7);
    const length = settings.length[0] + share * (settings.length[1] - settings.length[0]) + flicker;
    const traceFlame = (half, reach) => {
      ctx.beginPath();
      ctx.moveTo(x + 1, y - half);
      ctx.quadraticCurveTo(x - reach * 0.55, y - half, x - reach, y);
      ctx.quadraticCurveTo(x - reach * 0.55, y + half, x + 1, y + half);
      ctx.closePath();
    };
    traceFlame(halfWidth, length);
    ctx.fillStyle = colors.flame;
    ctx.fill();
    traceFlame(halfWidth * 0.5, length * 0.6);
    ctx.fillStyle = colors.flameCore;
    ctx.fill();
  },
};
