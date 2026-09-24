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
// Decal areas:
//   body            the paint of the whole body
//   centerStripe    a stripe along the center of the tub, from the rear to
//                   the nose tip
//   sidePodStripes  a thin stripe along each side pod and the nose
//   noseTip         the front end of the nose
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

    // The center stripe: its half width at the rear and at the nose tip.
    centerStripe: { from: -34, to: 51, rearHalf: 2.4, noseHalf: 0.9 },
    // The side pod stripe runs through these points, on the left side.
    sidePodStripe: {
      points: [[-11.5, -16.3], [-3, -15.6], [3, -12.9], [10, -9.7], [18, -7.7], [29, -6.1], [38, -4.4]],
      width: 1.3,
    },
    // The nose tip starts here.
    noseTipFrom: 44.5,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const main = paint("body", "main");
    const shape = mirrorHalf(settings.shape);
    const tub = mirrorHalf(settings.tub);
    const traceBody = (c) => traceSmooth(c, shape);
    const traceTub = (c) => traceSmooth(c, tub);
    const traceChevrons = (c) => {
      traceSmooth(c, mirrorHalf(settings.rearChevron));
      traceSmooth(c, mirrorHalf(settings.noseChevron));
    };

    fillWithOutline(ctx, traceBody, mix(main.base, main.shade, 0.3), { outline, outlineColor: colors.outline });
    facingBand(ctx, traceBody, main.light, -settings.upperBand);
    facingBand(ctx, traceBody, main.deep, settings.lowerBand);

    insideShape(ctx, traceBody, () => {
      ctx.beginPath();
      traceTub(ctx);
      ctx.lineWidth = settings.valley * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = main.shade;
      ctx.stroke();

      fillShape(ctx, traceTub, main.base);
      edgeBand(ctx, traceTub, main.light, settings.rim);
      drawSidePodStripes(ctx, settings.sidePodStripe, paint("sidePodStripes"));
      insideShape(ctx, traceTub, () => {
        fillShape(ctx, traceChevrons, main.shade);
        drawCenterStripe(ctx, settings.centerStripe, paint("centerStripe"), traceChevrons);
      });
      facingBand(ctx, traceTub, main.shade, settings.lowerBand * 0.6);
      drawNoseTip(ctx, settings.noseTipFrom, paint("noseTip"), traceBody, settings.lowerBand);
    });
  },
};

// The stripe takes the shadow tone where the chevrons are dark.
function drawCenterStripe(ctx, stripe, tones, traceChevrons) {
  if (!tones) return;
  const { from, to, rearHalf, noseHalf } = stripe;
  const trace = (c) => {
    c.moveTo(from, -rearHalf);
    c.lineTo(to, -noseHalf);
    c.lineTo(to, noseHalf);
    c.lineTo(from, rearHalf);
    c.closePath();
  };
  fillShape(ctx, trace, tones.base);
  insideShape(ctx, trace, () => fillShape(ctx, traceChevrons, tones.shade));
}

function drawSidePodStripes(ctx, stripe, tones) {
  if (!tones) return;
  for (const side of [1, -1]) {
    ctx.beginPath();
    stripe.points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y * side);
      else ctx.lineTo(x, y * side);
    });
    ctx.lineWidth = stripe.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = tones.base;
    ctx.stroke();
  }
}

function drawNoseTip(ctx, from, tones, traceBody, lowerBand) {
  if (!tones) return;
  const traceTip = (c) => {
    c.rect(from, -20, 20, 40);
  };
  insideShape(ctx, traceTip, () => {
    fillShape(ctx, traceBody, tones.base);
    facingBand(ctx, traceBody, tones.light, -lowerBand * 0.6);
    facingBand(ctx, traceBody, tones.deep, lowerBand * 0.8);
  });
}
