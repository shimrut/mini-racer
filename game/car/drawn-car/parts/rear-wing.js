import { fillWithOutline, insideShape, traceRoundRect } from "../paint.js";

// The rear wing: a flat red plate across the back of the car. A dark band
// runs along its front edge, and a thin line shows the flap near its rear
// edge.
export const rearWing = {
  defaults: {
    from: -49.6,
    to: -40.2,
    width: 35,
    radius: 2.2,
    frontBand: 1,
    // The flap line: its distance from the rear and its length across.
    flapX: -45.8,
    flapWidth: 20,
  },

  draw(ctx, { settings, colors, outline }) {
    const { from, to, width, radius, frontBand, flapX, flapWidth } = settings;
    const half = width / 2;
    const trace = (c) => traceRoundRect(c, from, -half, to - from, width, radius);
    fillWithOutline(ctx, trace, colors.paint, { outline, outlineColor: colors.outline });

    insideShape(ctx, trace, () => {
      ctx.fillStyle = colors.paintShade;
      ctx.fillRect(to - frontBand, -half, frontBand, width);

      const flapHalf = flapWidth / 2;
      const bend = Math.min(1.6, flapX - from);
      ctx.beginPath();
      ctx.moveTo(from, -flapHalf);
      ctx.lineTo(flapX - bend, -flapHalf);
      ctx.quadraticCurveTo(flapX, -flapHalf, flapX, -flapHalf + bend);
      ctx.lineTo(flapX, flapHalf - bend);
      ctx.quadraticCurveTo(flapX, flapHalf, flapX - bend, flapHalf);
      ctx.lineTo(from, flapHalf);
      ctx.lineWidth = outline * 0.6;
      ctx.strokeStyle = colors.paintDeep;
      ctx.stroke();
    });
  },
};
