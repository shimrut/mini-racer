import { facingBand, fillShape, fillWithOutline, insideShape, mix, traceRoundedPolygon } from "../paint.js";

// A spaceship wing, left side (mirror for the right). Decal areas: wings, wingTips, wingStripes.
export const shipWing = {
  defaults: {
    // Corners: root front and rear, then tip front and rear.
    corners: [[-2, -14], [-26, -28.6], [-34.5, -28.6], [-37, -12.5]],
    radius: 1.6,
    // The under blade shows behind the rear edge by this length.
    underShift: 2.4,
    tipFrom: -23.5,
    stripe: { from: [-5, -15.2], to: [-24.5, -27.2], width: 1.6 },
    // Panel lines, as pairs of points.
    panels: [
      [[-12, -16.4], [-31, -26.4]],
      [[-22, -15], [-34, -22]],
    ],
    endPlate: { from: -36.5, to: -24, y: -28.6, width: 2.6 },
    frontBand: 1.1,
    rearBand: 1.4,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const main = paint("wings", "main");
    const tips = paint("wingTips");
    const style = { outline, outlineColor: colors.outline };
    const { corners, radius, underShift } = settings;
    const under = corners.map(([x, y]) => [x - underShift, y]);
    fillWithOutline(ctx, (c) => traceRoundedPolygon(c, under, radius), colors.frame, style);

    const trace = (c) => traceRoundedPolygon(c, corners, radius);
    fillWithOutline(ctx, trace, mix(main.base, main.shade, 0.15), style);
    insideShape(ctx, trace, () => {
      if (tips) fillShape(ctx, (c) => c.rect(-60, -40, 80, 40 + settings.tipFrom), tips.base);
      const stripe = paint("wingStripes");
      if (stripe) {
        const { from, to, width } = settings.stripe;
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.strokeStyle = stripe.base;
        ctx.stroke();
      }
      ctx.beginPath();
      for (const [from, to] of settings.panels) {
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
      }
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = mix(main.base, main.deep, 0.55);
      ctx.stroke();

      // The front edge is light and the rear edge is dark.
      const edge = (from, to, width, color) => {
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.lineWidth = width * 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      edge(corners[0], corners[1], settings.frontBand, main.light);
      edge(corners[2], corners[3], settings.rearBand, main.shade);
    });

    // The end plate: a long, narrow pod along the tip.
    const plate = settings.endPlate;
    const plateTones = tips || main;
    const tracePlate = (c) => traceRoundedPolygon(c, [
      [plate.from, plate.y - plate.width / 2],
      [plate.to + plate.width, plate.y],
      [plate.from, plate.y + plate.width / 2],
    ], plate.width / 2);
    fillWithOutline(ctx, tracePlate, plateTones.base, style);
    facingBand(ctx, tracePlate, plateTones.light, -0.7);
  },
};
