import { fillWithOutline, traceRoundRect } from "../paint.js";

// The rally light pod on the nose: a dark bar across the nose with round
// lamps in a row.
export const lightPod = {
  defaults: {
    x: 43.4,
    length: 3.8,
    width: 13.4,
    lamps: 3,
    lampRadius: 1.8,
  },

  draw(ctx, { settings, colors, outline }) {
    const { x, length, width, lamps, lampRadius } = settings;
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, x - length / 2, -width / 2, length, width, 1.4),
      colors.frame,
      { outline, outlineColor: colors.outline },
    );
    const gap = (width - lampRadius * 2 * lamps) / (lamps + 1);
    for (let i = 0; i < lamps; i += 1) {
      const y = -width / 2 + gap + lampRadius + i * (gap + lampRadius * 2);
      ctx.beginPath();
      ctx.arc(x, y, lampRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.lamp;
      ctx.fill();
      ctx.lineWidth = outline * 0.6;
      ctx.strokeStyle = colors.outline;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x - lampRadius * 0.3, y - lampRadius * 0.35, lampRadius * 0.45, lampRadius * 0.28, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = colors.lampShine;
      ctx.fill();
    }
  },
};
