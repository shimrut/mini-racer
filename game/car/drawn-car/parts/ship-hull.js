import {
  facingBand,
  fillShape,
  fillWithOutline,
  insideShape,
  mirrorHalf,
  mix,
  rgba,
  tracePolygon,
  traceSmooth,
} from "../paint.js";

// The spaceship hull: side strakes and vents, the raised pod with its nose, and the canopy.
// Shapes give the left half, rear to front. Decal area: body.
export const shipHull = {
  defaults: {
    strake: [],
    ventRim: [],
    ventSlot: [],
    pod: [],
    recess: [],
    canopy: [],
    shine: [],
    chevron: [],
    // The edge light and shadow fade out over this span, so the nose stays even.
    edgeFade: [16, 30],
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const main = paint("body", "main");
    const style = { outline, outlineColor: colors.outline };
    const sides = (points) => [points, points.map(([x, y]) => [x, -y])];
    const plain = (points) => (c) => tracePolygon(c, points);
    const smooth = (points) => (c) => traceSmooth(c, points);

    for (const strake of sides(settings.strake)) {
      fillWithOutline(ctx, plain(strake), mix(main.base, main.shade, 0.12), style);
    }
    for (const rim of sides(settings.ventRim)) fillWithOutline(ctx, plain(rim), main.base, style);
    for (const slot of sides(settings.ventSlot)) {
      fillWithOutline(ctx, plain(slot), colors.frame, { outline: outline * 0.7, outlineColor: colors.outline });
    }

    const tracePod = smooth(mirrorHalf(settings.pod));
    fillWithOutline(ctx, tracePod, main.base, style);
    const [fadeFrom, fadeTo] = settings.edgeFade;
    const fading = (color) => {
      const gradient = ctx.createLinearGradient(fadeFrom, 0, fadeTo, 0);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, rgba(color, 0));
      return gradient;
    };
    // The highlight stays on the top half, so it leaves no seam on the lower edge.
    insideShape(ctx, (c) => c.rect(-60, -30, 120, 30), () => facingBand(ctx, tracePod, fading(main.light), -1));
    facingBand(ctx, tracePod, fading(main.deep), 1.4);
    insideShape(ctx, tracePod, () => {
      fillShape(ctx, smooth(mirrorHalf(settings.recess)), mix(main.base, main.shade, 0.55));
      fillShape(ctx, smooth(mirrorHalf(settings.chevron)), mix(main.base, main.shade, 0.6));
    });

    // A dark valley around the canopy rim.
    const traceCanopy = smooth(mirrorHalf(settings.canopy));
    ctx.beginPath();
    traceCanopy(ctx);
    ctx.lineJoin = "round";
    ctx.lineWidth = 5;
    ctx.strokeStyle = main.shade;
    ctx.stroke();
    ctx.lineWidth = 3.6;
    ctx.strokeStyle = main.base;
    ctx.stroke();

    fillWithOutline(ctx, traceCanopy, colors.glassShade, style);
    insideShape(ctx, traceCanopy, () => {
      ctx.save();
      ctx.translate(1, -0.9);
      fillShape(ctx, traceCanopy, colors.glass);
      ctx.restore();
      fillShape(ctx, smooth(settings.shine), colors.glassShine);
    });
  },
};
