import { facingBand, fillWithOutline, traceRoundedPolygon } from "../paint.js";

// The dark air intake on top of a side pod, with a light line on its upper
// edge. The corners go: rear outer, front outer, front inner, rear inner.
export const sideIntake = {
  defaults: {
    corners: [[-24.5, -13.2], [-14.8, -16.9], [-12.6, -12.3], [-22.8, -9.8]],
    radius: 1.6,
    lightLine: 0.9,
  },

  draw(ctx, { settings, colors, outline }) {
    const { corners, radius, lightLine } = settings;
    const trace = (c) => traceRoundedPolygon(c, corners, radius);
    fillWithOutline(ctx, trace, colors.intake, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, colors.intakeLight, -lightLine);
  },
};
