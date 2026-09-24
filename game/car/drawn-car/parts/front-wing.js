import { fillWithOutline, insideShape, traceRoundedPolygon } from "../paint.js";

// One half of the front wing: a red blade that is narrow at its outer end
// and wide where it goes under the nose, with a dark plate below it that
// shows behind its rear edge. The corners go: rear inner, rear outer, front
// outer, front inner.
export const frontWing = {
  defaults: {
    wing: [[41.3, -3.2], [36.9, -18.9], [42, -18.9], [47.9, -3.2]],
    under: [[35.7, -3.2], [35.7, -17.6], [37.8, -18.6], [41.8, -3.2]],
    radius: 1,
    rearBand: 0.6,
  },

  draw(ctx, { settings, colors, outline }) {
    const { wing, under, radius, rearBand } = settings;
    const style = { outline, outlineColor: colors.outline };
    fillWithOutline(ctx, (c) => traceRoundedPolygon(c, under, radius), colors.frame, style);

    const traceWing = (c) => traceRoundedPolygon(c, wing, radius);
    fillWithOutline(ctx, traceWing, colors.paint, style);
    insideShape(ctx, traceWing, () => {
      ctx.beginPath();
      ctx.moveTo(wing[0][0], wing[0][1]);
      ctx.lineTo(wing[1][0], wing[1][1]);
      ctx.lineWidth = rearBand * 2;
      ctx.strokeStyle = colors.paintShade;
      ctx.stroke();
    });
  },
};
