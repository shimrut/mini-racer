import { fillWithOutline, traceRoundRect } from "../paint.js";

// The jet ski nozzle; it steers against the front wheels, so place it with steerScale -1.
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
