import { fillWithOutline, traceRoundRect } from "../paint.js";

// A rubber mud flap behind a rear tire.
export const mudFlap = {
  defaults: {
    x: -39.4,
    thickness: 1.8,
    from: -29.8,
    to: -19,
  },

  draw(ctx, { settings, colors, outline }) {
    const { x, thickness, from, to } = settings;
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, x - thickness, from, thickness, to - from, 0.5),
      colors.flap,
      { outline, outlineColor: colors.outline },
    );
  },
};
