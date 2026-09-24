import { fillWithOutline, insideShape } from "../paint.js";

// The cockpit: a dark glass dome with a painted rim around it. The glass is
// darker at its lower rear side and has a curved shine on its upper side.
//
// Decal area:
//   cockpitRim  the rim around the glass
// Adds an oval as its own closed shape.
function oval(ctx, cx, cy, rx, ry) {
  ctx.moveTo(cx + rx, cy);
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.closePath();
}

export const cockpit = {
  defaults: {
    x: -3,
    length: 28.4,
    width: 17.6,
    rim: 1.6,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { x, length, width, rim } = settings;
    const rx = length / 2;
    const ry = width / 2;
    const traceGlass = (c) => oval(c, x, 0, rx, ry);

    ctx.beginPath();
    oval(ctx, x, 0, rx + rim, ry + rim);
    ctx.fillStyle = paint("cockpitRim", "main").base;
    ctx.fill();

    fillWithOutline(ctx, traceGlass, colors.glassShade, { outline, outlineColor: colors.outline });
    insideShape(ctx, traceGlass, () => {
      ctx.beginPath();
      oval(ctx, x + rx * 0.08, -ry * 0.12, rx * 0.93, ry * 0.8);
      ctx.fillStyle = colors.glass;
      ctx.fill();

      // The shine: the part of an upper oval that is not in a lower oval.
      const upper = (c) => oval(c, x + rx * 0.2, -ry * 0.1, rx * 0.78, ry * 0.72);
      insideShape(ctx, upper, () => {
        ctx.beginPath();
        upper(ctx);
        oval(ctx, x + rx * 0.26, ry * 0.08, rx * 0.8, ry * 0.74);
        ctx.fillStyle = colors.glassShine;
        ctx.fill("evenodd");
      });
    });
  },
};
