import { fillWithOutline, traceRoundRect } from "../paint.js";

// The dark block between the rear wing and the body.
export const gearbox = {
  defaults: {
    from: -40.5,
    to: -34,
    width: 17,
    radius: 2,
  },

  draw(ctx, { settings, colors, outline }) {
    const { from, to, width, radius } = settings;
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, from, -width / 2, to - from, width, radius),
      colors.frame,
      { outline, outlineColor: colors.outline },
    );
  },
};
