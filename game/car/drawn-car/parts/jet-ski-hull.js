import {
  edgeBand,
  facingBand,
  fillShape,
  fillWithOutline,
  insideShape,
  mirrorHalf,
  mix,
  traceRoundedPolygon,
  traceSmooth,
} from "../paint.js";

// The jet ski hull, drawn like the car body; shapes give the left half, rear to front.
// Decal areas: hull, hullStripes, hoodStripe, noseTip.
export const jetSkiHull = {
  defaults: {
    shape: [
      [-46, 0], [-46, -16], [-44.8, -20.5], [-41, -23.2], [-30, -24.8], [-16, -25.8],
      [-2, -25.6], [10, -24], [21, -21], [30, -17], [38, -12.4], [44, -7.6], [48, -3.6], [49.5, 0],
    ],
    // The raised center: the base of the seat and the hood.
    center: [
      [-44, 0], [-44, -8.4], [-40, -9.6], [-20, -9.8], [-6, -10.2], [0, -12], [6, -15.6],
      [14, -17.2], [24, -15.6], [32, -12.4], [39, -8.6], [44, -4.6], [46.5, 0],
    ],
    // The rubber rail: the points of the hull edge that it runs along.
    rail: { from: 2, to: 10, width: 2.4 },
    // The left footwell, and the gap between the lines of its mat.
    footwell: {
      corners: [[-38.5, -11.4], [-37.5, -19.4], [-33, -22], [-18, -22.9], [-4, -22.6], [1, -19.6], [1.6, -14.8], [-1.5, -11.6]],
      radius: 2.2,
      lineStep: 2.2,
    },
    stripe: {
      points: [[47, -3.6], [42, -8.8], [34, -14], [24, -19], [12, -22.6], [-2, -24], [-18, -24.2], [-34, -23.4]],
      width: 1.3,
    },
    hoodStripe: { from: 6, to: 49, rearHalf: 2.4, noseHalf: 0.8 },
    noseTipFrom: 45,
    upperBand: 1.4,
    lowerBand: 1.8,
    valley: 1.2,
    rim: 1.1,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const main = paint("hull", "main");
    const traceHull = (c) => traceSmooth(c, mirrorHalf(settings.shape));
    const traceCenter = (c) => traceSmooth(c, mirrorHalf(settings.center));

    fillWithOutline(ctx, traceHull, mix(main.base, main.shade, 0.3), { outline, outlineColor: colors.outline });
    facingBand(ctx, traceHull, main.light, -settings.upperBand);
    facingBand(ctx, traceHull, main.deep, settings.lowerBand);

    insideShape(ctx, traceHull, () => {
      drawRails(ctx, settings.shape, settings.rail, colors);
      drawFootwells(ctx, settings.footwell, colors, outline);
      drawSideStripes(ctx, settings.stripe, paint("hullStripes"));

      // The raised center, as the tub of the car body.
      ctx.beginPath();
      traceCenter(ctx);
      ctx.lineWidth = settings.valley * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = main.shade;
      ctx.stroke();
      fillShape(ctx, traceCenter, main.base);
      edgeBand(ctx, traceCenter, main.light, settings.rim);
      insideShape(ctx, traceCenter, () => {
        const stripe = paint("hoodStripe");
        if (!stripe) return;
        const { from, to, rearHalf, noseHalf } = settings.hoodStripe;
        fillShape(ctx, (c) => {
          c.moveTo(from, -rearHalf);
          c.lineTo(to, -noseHalf);
          c.lineTo(to, noseHalf);
          c.lineTo(from, rearHalf);
          c.closePath();
        }, stripe.base);
      });
      facingBand(ctx, traceCenter, main.shade, settings.lowerBand * 0.6);

      const tip = paint("noseTip");
      if (tip) {
        insideShape(ctx, (c) => c.rect(settings.noseTipFrom, -30, 20, 60), () => {
          fillShape(ctx, traceHull, tip.base);
          facingBand(ctx, traceHull, tip.light, -settings.lowerBand * 0.6);
          facingBand(ctx, traceHull, tip.deep, settings.lowerBand * 0.8);
        });
      }
    });
  },
};

// A rubber rail along each side, stern to bow.
function drawRails(ctx, shape, rail, colors) {
  const points = shape.slice(rail.from, rail.to + 1);
  ctx.lineWidth = rail.width * 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = colors.fender;
  for (const side of [1, -1]) {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y * side);
      else ctx.lineTo(x, y * side);
    });
    ctx.stroke();
  }
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = colors.fenderLight;
  for (const side of [1, -1]) {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const inset = y * side - Math.sign(y * side) * (rail.width - 0.7);
      if (index === 0) ctx.moveTo(x, inset);
      else ctx.lineTo(x, inset);
    });
    ctx.stroke();
  }
}

// A sunken footwell mat on each side of the seat.
function drawFootwells(ctx, footwell, colors, outline) {
  for (const side of [1, -1]) {
    const corners = footwell.corners.map(([x, y]) => [x, y * side]);
    const trace = (c) => traceRoundedPolygon(c, corners, footwell.radius);
    fillWithOutline(ctx, trace, colors.mat, { outline: outline * 0.6, outlineColor: colors.outline });
    insideShape(ctx, trace, () => {
      ctx.beginPath();
      for (let x = -40; x < 4; x += footwell.lineStep) {
        ctx.moveTo(x, -30);
        ctx.lineTo(x + 3, 30);
      }
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = colors.matLine;
      ctx.stroke();
    });
    facingBand(ctx, trace, colors.matShade, -1.4);
  }
}

function drawSideStripes(ctx, stripe, tones) {
  if (!tones) return;
  ctx.lineWidth = stripe.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = tones.base;
  for (const side of [1, -1]) {
    ctx.beginPath();
    stripe.points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y * side);
      else ctx.lineTo(x, y * side);
    });
    ctx.stroke();
  }
}
