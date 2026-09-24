import { fillWithOutline, insideShape, traceRoundRect } from "../paint.js";

// The rear wing: a flat plate across the back of the car. A dark band runs
// along its front edge, and a thin line shows the flap near its rear edge.
//
// Decal areas:
//   rearWing      the paint of the whole plate
//   rearWingFlap  the strip from the rear edge to the flap line
//   rearWingEnds  the two end plates, at the outer ends of the wing
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
    // The length of each end plate, across the car.
    endLength: 4.2,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { from, to, width, radius, frontBand, flapX, flapWidth, endLength } = settings;
    const half = width / 2;
    const plate = paint("rearWing", "main");
    const flap = paint("rearWingFlap");
    const ends = paint("rearWingEnds");
    const trace = (c) => traceRoundRect(c, from, -half, to - from, width, radius);
    fillWithOutline(ctx, trace, plate.base, { outline, outlineColor: colors.outline });

    insideShape(ctx, trace, () => {
      if (flap) {
        ctx.fillStyle = flap.base;
        ctx.fillRect(from, -half, flapX - from, width);
      }
      ctx.fillStyle = plate.shade;
      ctx.fillRect(to - frontBand, -half, frontBand, width);
      if (ends) {
        for (const y of [-half, half - endLength]) {
          ctx.fillStyle = ends.base;
          ctx.fillRect(from, y, to - from, endLength);
          ctx.fillStyle = ends.shade;
          ctx.fillRect(to - frontBand, y, frontBand, endLength);
        }
        // A dark line where each end plate meets the wing.
        ctx.fillStyle = ends.deep;
        ctx.fillRect(from, -half + endLength - 0.3, to - from, 0.6);
        ctx.fillRect(from, half - endLength - 0.3, to - from, 0.6);
      }

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
      ctx.strokeStyle = (flap || plate).deep;
      ctx.stroke();
    });
  },
};
