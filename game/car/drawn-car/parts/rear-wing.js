import { fillWithOutline, insideShape, traceRoundRect } from "../paint.js";

// The rear wing: a flat plate across the back of the car. A dark band runs
// along its front edge, and a thin line shows the flap near its rear edge.
//
// Decal areas:
//   rearWing      the paint of the whole plate
//   rearWingFlap  the strip from the rear edge to the flap line
//   rearWingEnds  the two end plates, at the outer ends of the wing
//
// With "endFront" or "endBack", the end plates are tall plates of their own:
// they stand past the edges of the wing, and they have the wing paint when
// "rearWingEnds" has no paint.
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
    // The end plates stand this far in front of the wing and behind it.
    // Both 0: the end plates are only paint on the wing.
    endFront: 0,
    endBack: 0,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const {
      from, to, width, radius, frontBand, flapX, flapWidth, endLength, endFront, endBack,
    } = settings;
    const tallEnds = endFront > 0 || endBack > 0;
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
      if (ends && !tallEnds) {
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

    if (tallEnds) {
      const end = ends || plate;
      const back = from - endBack;
      const front = to + endFront;
      for (const y of [-half, half - endLength]) {
        const traceEnd = (c) => traceRoundRect(c, back, y, front - back, endLength, endLength / 2);
        fillWithOutline(ctx, traceEnd, end.base, { outline, outlineColor: colors.outline });
        insideShape(ctx, traceEnd, () => {
          ctx.fillStyle = end.shade;
          ctx.fillRect(front - frontBand * 1.5, y, frontBand * 1.5, endLength);
        });
      }
    }
  },
};
