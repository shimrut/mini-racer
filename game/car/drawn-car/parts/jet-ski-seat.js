import { facingBand, fillWithOutline, mirrorHalf, traceSmooth } from "../paint.js";

// The long seat of a jet ski, along the middle behind the handlebars. It
// has a light top where the light falls, and a seam near its edge.
//
// Decal area:
//   seat  the cover of the seat; with no paint, it is dark
//
// The shape gives its left half (negative y), from the rear to the front.
export const jetSkiSeat = {
  defaults: {
    shape: [[-39, 0], [-39, -6], [-35, -7.6], [-18, -8.2], [-6, -8.6], [0, -7.8], [3.6, -4.6], [4.2, 0]],
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const tones = paint("seat");
    const trace = (c) => traceSmooth(c, mirrorHalf(settings.shape));
    fillWithOutline(ctx, trace, tones ? tones.base : colors.seat, { outline: outline * 0.8, outlineColor: colors.outline });
    facingBand(ctx, trace, tones ? tones.light : colors.seatLight, -1.4);

    // The seam: the seat shape, a little smaller.
    ctx.save();
    ctx.translate(-17.4, 0);
    ctx.scale(0.92, 0.76);
    ctx.translate(17.4, 0);
    ctx.beginPath();
    trace(ctx);
    ctx.restore();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = colors.seatSeam;
    ctx.stroke();
  },
};
