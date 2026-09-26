import { fillWithOutline, traceRoundRect } from "../paint.js";

// The handlebars of a jet ski. The part origin is the steering column. The
// bars turn with the steering. The rider holds the grips at their ends.
//
// Decal area:
//   barPad  the pad on the steering column
export const handlebar = {
  defaults: {
    // The distance from the column to each grip, and how far the ends
    // sweep back.
    halfWidth: 11.5,
    sweep: 1.6,
    grip: 3.4,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { halfWidth, sweep, grip } = settings;
    const traceBar = () => {
      ctx.beginPath();
      ctx.moveTo(-sweep, -halfWidth);
      ctx.quadraticCurveTo(1.4, 0, -sweep, halfWidth);
    };
    ctx.lineCap = "round";
    traceBar();
    ctx.lineWidth = 1.6 + outline * 2;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
    traceBar();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = colors.bar;
    ctx.stroke();

    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(-sweep, side * (halfWidth - grip));
      ctx.lineTo(-sweep, side * halfWidth);
    }
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = colors.grip;
    ctx.stroke();

    const pad = paint("barPad", "main");
    fillWithOutline(ctx, (c) => traceRoundRect(c, -2.4, -2.8, 4.4, 5.6, 1.4), pad.base, {
      outline: outline * 0.6,
      outlineColor: colors.outline,
    });
  },
};
