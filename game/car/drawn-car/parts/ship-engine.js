import { facingBand, fillShape, fillWithOutline, tracePolygon, traceRoundRect } from "../paint.js";

// A spaceship engine, left side (mirror for the right): a dark barrel, a colored nozzle ring and an angled housing.
// Decal area: engineRing.
export const shipEngine = {
  defaults: {
    from: -45.6,
    to: -33,
    y: -7.3,
    halfWidth: 5.8,
    ring: { from: -47.8, to: -45.4 },
    housing: [],
    housingFacet: [],
    glint: { from: -44.5, to: -37.5, y: -8.9 },
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { from, to, y, halfWidth } = settings;
    const style = { outline, outlineColor: colors.outline };

    const traceBarrel = (c) => traceRoundRect(c, from, y - halfWidth, to - from, halfWidth * 2, 1.6);
    fillWithOutline(ctx, traceBarrel, colors.engine, style);
    facingBand(ctx, traceBarrel, colors.engineLight, -halfWidth * 0.3);
    const { glint } = settings;
    fillShape(ctx, (c) => traceRoundRect(c, glint.from, glint.y - 0.3, glint.to - glint.from, 0.6, 0.3), colors.frameLight);

    const ringTones = paint("engineRing");
    const ringHalf = halfWidth * 0.92;
    const { ring } = settings;
    const traceRing = (c) => traceRoundRect(c, ring.from, y - ringHalf, ring.to - ring.from, ringHalf * 2, 1);
    fillWithOutline(ctx, traceRing, ringTones ? ringTones.deep : colors.nozzle, style);
    if (ringTones) {
      fillShape(ctx, (c) => traceRoundRect(c, ring.from + 0.4, y - ringHalf * 0.8, 0.9, ringHalf * 1.6, 0.45), ringTones.base);
    }

    const traceHousing = (c) => tracePolygon(c, settings.housing);
    fillWithOutline(ctx, traceHousing, colors.frame, style);
    fillShape(ctx, (c) => tracePolygon(c, settings.housingFacet), colors.frameLight);
  },
};
