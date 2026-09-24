// The yellow stripe on the nose. It is wider at the rear and narrow at the
// front, with round ends.
export const noseStripe = {
  defaults: {
    from: 32.8,
    to: 41.2,
    width: 3.2,
    frontWidth: 1.8,
  },

  draw(ctx, { settings, colors }) {
    const { from, to, width, frontWidth } = settings;
    const rearHalf = width / 2;
    const frontHalf = frontWidth / 2;
    ctx.beginPath();
    ctx.moveTo(from + rearHalf, -rearHalf);
    ctx.lineTo(to - frontHalf, -frontHalf);
    ctx.arc(to - frontHalf, 0, frontHalf, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(from + rearHalf, rearHalf);
    ctx.arc(from + rearHalf, 0, rearHalf, Math.PI / 2, Math.PI * 1.5);
    ctx.fillStyle = colors.stripe;
    ctx.fill();
  },
};
