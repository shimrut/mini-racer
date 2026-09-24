import { fillWithOutline, insideShape, traceRoundedPolygon } from "../paint.js";

// One half of the front wing: a blade that is narrow at its outer end and
// wide where it goes under the nose, with a dark plate below it that shows
// behind its rear edge. The corners go: rear inner, rear outer, front outer,
// front inner.
//
// Decal areas:
//   frontWing      the paint of the whole blade
//   frontWingTips  the outer end of the blade
//   frontWingEdge  a band along the rear edge of the blade
export const frontWing = {
  defaults: {
    wing: [[41.3, -3.2], [36.9, -18.9], [42, -18.9], [47.9, -3.2]],
    under: [[35.7, -3.2], [35.7, -17.6], [37.8, -18.6], [41.8, -3.2]],
    radius: 1,
    rearBand: 0.6,
    edgeBand: 1.1,
    // The tip starts at this distance from the center line.
    tipFrom: 14.2,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { wing, under, radius, rearBand, edgeBand, tipFrom } = settings;
    const blade = paint("frontWing", "main");
    const tips = paint("frontWingTips");
    const edge = paint("frontWingEdge");
    const style = { outline, outlineColor: colors.outline };
    fillWithOutline(ctx, (c) => traceRoundedPolygon(c, under, radius), colors.frame, style);

    const traceWing = (c) => traceRoundedPolygon(c, wing, radius);
    fillWithOutline(ctx, traceWing, blade.base, style);
    insideShape(ctx, traceWing, () => {
      if (tips) {
        ctx.fillStyle = tips.base;
        ctx.fillRect(30, -30, 30, 30 - tipFrom);
        ctx.fillStyle = tips.deep;
        ctx.fillRect(30, -tipFrom - 0.3, 30, 0.6);
      }
      ctx.beginPath();
      ctx.moveTo(wing[0][0], wing[0][1]);
      ctx.lineTo(wing[1][0], wing[1][1]);
      ctx.lineWidth = (edge ? edgeBand : rearBand) * 2;
      ctx.strokeStyle = edge ? edge.base : blade.shade;
      ctx.stroke();
    });
  },
};
