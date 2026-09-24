import { fillWithOutline, traceRoundRect } from "../paint.js";

// Vent slots on a side pod: short dark slots in a row, tilted toward the
// rear.
export const louvers = {
  defaults: {
    // The center of each slot.
    slots: [[-10.5, -15], [-7.2, -15.2], [-3.9, -14.4]],
    length: 3.8,
    width: 1,
    tilt: 0.35,
  },

  draw(ctx, { settings, colors, outline }) {
    const { slots, length, width, tilt } = settings;
    for (const [x, y] of slots) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 2 - tilt);
      fillWithOutline(
        ctx,
        (c) => traceRoundRect(c, -length / 2, -width / 2, length, width, width / 2),
        colors.intake,
        { outline: outline * 0.6, outlineColor: colors.outline },
      );
      ctx.restore();
    }
  },
};
