import { facingBand, fillWithOutline, traceRoundedPolygon } from "../paint.js";

// The side pod intake, dark when unpainted; corners: rear outer, front outer, front inner, rear inner.
// Decal area: intakes.
export const sideIntake = {
  defaults: {
    corners: [[-24.5, -13.2], [-14.8, -16.9], [-12.6, -12.3], [-22.8, -9.8]],
    radius: 1.6,
    lightLine: 0.9,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { corners, radius, lightLine } = settings;
    const tones = paint("intakes");
    const trace = (c) => traceRoundedPolygon(c, corners, radius);
    fillWithOutline(ctx, trace, tones ? tones.base : colors.intake, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, tones ? tones.light : colors.intakeLight, -lightLine);
  },
};
