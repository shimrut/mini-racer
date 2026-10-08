// The nose stripe. Decal area: noseStripe (not drawn when unpainted).
export const noseStripe = {
  defaults: {
    from: 32.8,
    to: 41.2,
    width: 3.2,
    frontWidth: 1.8,
  },

  draw(ctx, { settings, paint }) {
    const tones = paint("noseStripe");
    if (!tones) return;
    const { from, to, width, frontWidth } = settings;
    const rearHalf = width / 2;
    const frontHalf = frontWidth / 2;
    ctx.beginPath();
    ctx.moveTo(from + rearHalf, -rearHalf);
    ctx.lineTo(to - frontHalf, -frontHalf);
    ctx.arc(to - frontHalf, 0, frontHalf, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(from + rearHalf, rearHalf);
    ctx.arc(from + rearHalf, 0, rearHalf, Math.PI / 2, Math.PI * 1.5);
    ctx.fillStyle = tones.base;
    ctx.fill();
  },
};
