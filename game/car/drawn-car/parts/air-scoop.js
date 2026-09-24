import { facingBand, fillWithOutline, traceRoundRect } from "../paint.js";

// The air scoop on the engine cover, behind the cockpit. It is a painted box
// with a dark mouth at its front end.
//
// Decal area:
//   scoop  the box
export const airScoop = {
  defaults: {
    from: -27,
    to: -19.4,
    width: 7.2,
    mouth: 1.8,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { from, to, width, mouth } = settings;
    const tones = paint("scoop", "main");
    const trace = (c) => traceRoundRect(c, from, -width / 2, to - from, width, 1.6);
    fillWithOutline(ctx, trace, tones.base, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, tones.light, -1);
    facingBand(ctx, trace, tones.deep, 1.2);
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, to - mouth - 0.8, -width / 2 + 1.1, mouth, width - 2.2, 0.7),
      colors.intake,
      { outline: outline * 0.6, outlineColor: colors.outline },
    );
  },
};
