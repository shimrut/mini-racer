import { fillWithOutline, mix, rgba, traceRoundRect } from "../paint.js";

// The one red light at the rear center of the car, below the rear wing. From
// above, only its rear end shows behind the wing. When the car brakes, the
// light comes on and a red glow shows on the ground behind the car.
export const brakeLight = {
  moves: true,
  defaults: {
    from: -52.9,
    to: -47,
    width: 4.8,
    glowRadius: 20,
    glowStrength: 0.55,
  },

  draw(ctx, { settings, colors, motion, outline }) {
    const { from, to, width } = settings;
    const length = to - from;
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, from, -width / 2, length, width, 1),
      mix(colors.lightOff, colors.lightOn, motion.brake),
      { outline: outline * 0.8, outlineColor: colors.outline },
    );
    if (motion.brake > 0.01) {
      ctx.beginPath();
      traceRoundRect(ctx, from + 0.6, -width * 0.22, 2, width * 0.44, 0.5);
      ctx.fillStyle = rgba(colors.lightCore, motion.brake);
      ctx.fill();
    }
  },

  drawGround(ctx, { settings, colors, motion }) {
    if (motion.brake < 0.01) return;
    const { from, glowRadius, glowStrength } = settings;
    const alpha = glowStrength * motion.brake;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(from - 1, 0);
    ctx.scale(1, 1.4);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
    glow.addColorStop(0, rgba(colors.lightGlow, alpha));
    glow.addColorStop(0.4, rgba(colors.lightGlow, alpha * 0.45));
    glow.addColorStop(1, rgba(colors.lightGlow, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};
