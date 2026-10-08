import { fillShape, insideShape, traceRoundRect } from "../paint.js";

// A road tire; its grooves roll toward the nose, side wall on +y, mirror for the right.
export const tire = {
  moves: true,
  defaults: {
    length: 17.8,
    width: 10.8,
    // The side wall, as a part of the tire width.
    sideWidth: 0.3,
    // The number of grooves around the tire.
    grooves: 16,
    grooveWidth: 0.7,
    grooveStrength: 0.2,
  },

  draw(ctx, { settings, colors, motion, outline }) {
    const { length, width, sideWidth, grooves, grooveWidth, grooveStrength } = settings;
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const radius = Math.min(length, width) * 0.28;
    const trace = (c) => traceRoundRect(c, -halfLength, -halfWidth, length, width, radius);

    const drum = ctx.createLinearGradient(-halfLength, 0, halfLength, 0);
    drum.addColorStop(0, colors.tire);
    drum.addColorStop(0.35, colors.tireFace);
    drum.addColorStop(0.65, colors.tireFace);
    drum.addColorStop(1, colors.tire);
    fillShape(ctx, trace, drum);

    const side = width * sideWidth;
    const faceBottom = halfWidth - side;
    insideShape(ctx, trace, () => {
      const step = (Math.PI * 2) / grooves;
      const turn = ((motion.roll / halfLength) % step + step) % step;
      const strength = grooveStrength * (1 - motion.rollBlur * 0.65);
      ctx.fillStyle = colors.tireLine;
      for (let angle = -Math.PI / 2 + turn; angle < Math.PI / 2; angle += step) {
        const depth = Math.cos(angle);
        const x = halfLength * Math.sin(angle);
        const grooveLength = grooveWidth * depth;
        ctx.globalAlpha = strength * depth;
        ctx.fillRect(x - grooveLength / 2, -halfWidth, grooveLength, faceBottom + halfWidth);
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = colors.tire;
      ctx.fillRect(-halfLength, faceBottom, length, side);
      ctx.fillStyle = colors.tireLine;
      ctx.fillRect(-halfLength, faceBottom - 0.25, length, 0.5);
    });

    ctx.beginPath();
    trace(ctx);
    ctx.lineWidth = outline;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
  },
};
