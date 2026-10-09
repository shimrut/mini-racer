import { facingBand, fillShape, fillWithOutline, insideShape, tracePolygon } from "../paint.js";

// A swept spaceship wing, left side (mirror for the right): dark under wing, painted top, a light facet and a tip light.
// Decal areas: wings, wingTips.
export const shipWing = {
  defaults: {
    under: [],
    top: [],
    facet: [],
    strip: [],
    // A thin line across the tip light.
    stripLine: null,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const main = paint("wings", "main");
    const style = { outline, outlineColor: colors.outline };
    const trace = (points) => (c) => tracePolygon(c, points);

    fillWithOutline(ctx, trace(settings.under), colors.frame, style);
    fillShape(ctx, trace(settings.facet), colors.frameLight);

    const traceTop = trace(settings.top);
    fillWithOutline(ctx, traceTop, main.base, style);
    facingBand(ctx, traceTop, main.light, -0.9);
    facingBand(ctx, traceTop, main.shade, 1.1);

    const tones = paint("wingTips");
    if (!tones) return;
    const traceStrip = trace(settings.strip);
    fillWithOutline(ctx, traceStrip, tones.base, { outline: outline * 0.8, outlineColor: colors.outline });
    if (settings.stripLine) {
      const [from, to] = settings.stripLine;
      insideShape(ctx, traceStrip, () => {
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = tones.shade;
        ctx.stroke();
      });
    }
  },
};
