import {
  edgeBand,
  facingBand,
  fillShape,
  fillWithOutline,
  insideShape,
  mirrorHalf,
  mix,
  traceSmooth,
} from "../paint.js";

// The body: the side pods and the nose, with the raised center tub on top.
// The side pods are a little darker than the tub. The tub has a light rim,
// a dark chevron behind the cockpit and a dark chevron in front of it. The
// lower edges are dark and the upper edges are light, as if the light comes
// from the -y side.
//
// All shapes give their left half (negative y), from the rear to the front.
export const body = {
  defaults: {
    shape: [
      [-36.2, 0], [-35.6, -5.5], [-31, -8.5], [-27.5, -10.6], [-24.5, -14.8],
      [-17, -17.8], [-9, -19.2], [-3, -18.2], [3, -14.7], [10, -10.8],
      [18, -8.6], [28, -6.8], [38, -4.8], [46, -3], [50, 0],
    ],
    tub: [
      [-33.6, 0], [-33, -4.2], [-30.5, -7], [-25, -7.8], [-19, -9.4],
      [-12, -11], [-3, -11.4], [5, -10.4], [11, -8.4], [18, -6.6],
      [28, -5.3], [38, -3.8], [45.5, -2.3], [48.4, 0],
    ],
    rearChevron: [
      [-33.2, 0], [-30, -1.9], [-24, -4.6], [-18, -7], [-11, -8.4], [-6, 0],
    ],
    noseChevron: [
      [5, 0], [6, -6.4], [12, -5.6], [16, -4], [19.6, -1.9], [21.8, 0],
    ],
    // Bands along the edges of the side pods.
    upperBand: 1.4,
    lowerBand: 1.8,
    // The dark valley around the tub, and its light rim.
    valley: 1.2,
    rim: 1.1,
  },

  draw(ctx, { settings, colors, outline }) {
    const shape = mirrorHalf(settings.shape);
    const tub = mirrorHalf(settings.tub);
    const traceBody = (c) => traceSmooth(c, shape);
    const traceTub = (c) => traceSmooth(c, tub);

    const sidePod = mix(colors.paint, colors.paintShade, 0.3);
    fillWithOutline(ctx, traceBody, sidePod, { outline, outlineColor: colors.outline });
    facingBand(ctx, traceBody, colors.paintLight, -settings.upperBand);
    facingBand(ctx, traceBody, colors.paintDeep, settings.lowerBand);

    insideShape(ctx, traceBody, () => {
      ctx.beginPath();
      traceTub(ctx);
      ctx.lineWidth = settings.valley * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = colors.paintShade;
      ctx.stroke();

      fillShape(ctx, traceTub, colors.paint);
      edgeBand(ctx, traceTub, colors.paintLight, settings.rim);
      insideShape(ctx, traceTub, () => {
        fillShape(ctx, (c) => traceSmooth(c, mirrorHalf(settings.rearChevron)), colors.paintShade);
        fillShape(ctx, (c) => traceSmooth(c, mirrorHalf(settings.noseChevron)), colors.paintShade);
      });
      facingBand(ctx, traceTub, colors.paintShade, settings.lowerBand * 0.6);
    });
  },
};
