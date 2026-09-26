import { fillWithOutline, traceRoundRect } from "../paint.js";

// The jet nozzle at the stern of a jet ski. The part origin is its mount on
// the stern, and the nozzle sticks out to the rear. It turns with the
// steering, against the car's front wheels: to turn right, its rear end
// swings right. Place it with steerScale -1.
export const jetNozzle = {
  defaults: {
    length: 5,
    halfWidth: 2.6,
  },

  draw(ctx, { settings, colors, outline }) {
    const { length, halfWidth } = settings;
    fillWithOutline(ctx, (c) => traceRoundRect(c, -length, -halfWidth, length + 1, halfWidth * 2, 1.2), colors.nozzle, {
      outline,
      outlineColor: colors.outline,
    });
    ctx.beginPath();
    traceRoundRect(ctx, -length + 0.6, -halfWidth * 0.55, 1.4, halfWidth * 1.1, 0.5);
    ctx.fillStyle = colors.nozzleLight;
    ctx.fill();
  },
};
