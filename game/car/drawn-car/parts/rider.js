import { facingBand, fillWithOutline, insideShape } from "../paint.js";

// The rider of a jet ski, seen from above: legs down to the footwells, a
// life vest, arms to the grips of the handlebars, and a helmet with a visor
// to the front. The hands hold the grips, so they follow the handlebars
// when they turn. Place it after the handlebars.
//
// Decal areas:
//   helmet  the paint of the helmet
//   vest    the paint of the life vest
export const rider = {
  moves: true,
  defaults: {
    // The steering column, the distance from it to each grip, and how far
    // the grips sweep back: as for the handlebars.
    barPivot: [9, 0],
    grip: 10.2,
    gripSweep: 1.6,
    hip: [-15, 4.8],
    knee: [-3, 10.2],
    foot: [-10, 11.2],
    shoulder: [-7, 8.2],
    elbow: [1, 11.6],
    limb: 3.4,
    torso: { x: -12.5, rx: 7.6, ry: 9.2 },
    helmet: { x: -5.6, radius: 5.8 },
  },

  draw(ctx, { settings, colors, paint, motion, outline }) {
    const angle = motion.steerAngle || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const [pivotX, pivotY] = settings.barPivot;
    const gripAt = (side) => {
      const x = -settings.gripSweep;
      const y = side * settings.grip;
      return [pivotX + x * cos - y * sin, pivotY + x * sin + y * cos];
    };
    const limb = (points, width, color) => {
      ctx.beginPath();
      points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = width + outline * 2;
      ctx.strokeStyle = colors.outline;
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    const mirror = ([x, y], side) => [x, y * side];

    for (const side of [-1, 1]) {
      limb([settings.hip, settings.knee, settings.foot].map((point) => mirror(point, side)), settings.limb * 1.2, colors.suit);
    }

    const vest = paint("vest", "accent");
    const { torso } = settings;
    const traceTorso = (c) => {
      c.moveTo(torso.x + torso.rx, 0);
      c.ellipse(torso.x, 0, torso.rx, torso.ry, 0, 0, Math.PI * 2);
      c.closePath();
    };
    fillWithOutline(ctx, traceTorso, vest.base, { outline, outlineColor: colors.outline });
    facingBand(ctx, traceTorso, vest.light, -1.2);
    facingBand(ctx, traceTorso, vest.shade, 1.6);

    for (const side of [-1, 1]) {
      const grip = gripAt(side);
      limb([mirror(settings.shoulder, side), mirror(settings.elbow, side), grip], settings.limb, colors.suit);
      ctx.beginPath();
      ctx.arc(grip[0], grip[1], settings.limb * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = colors.glove;
      ctx.fill();
    }

    const helmet = paint("helmet", "accent");
    const { x, radius } = settings.helmet;
    const traceHelmet = (c) => {
      c.moveTo(x + radius, 0);
      c.arc(x, 0, radius, 0, Math.PI * 2);
      c.closePath();
    };
    fillWithOutline(ctx, traceHelmet, helmet.base, { outline, outlineColor: colors.outline });
    insideShape(ctx, traceHelmet, () => {
      // The visor covers the front of the helmet.
      ctx.beginPath();
      ctx.arc(x + radius * 1.05, 0, radius * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = colors.visor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x - radius * 0.35, -radius * 0.4, radius * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = helmet.light;
      ctx.fill();
    });
  },
};
