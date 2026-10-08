import { facingBand, fillWithOutline, insideShape, traceRoundRect, traceRoundedPolygon } from "../paint.js";

// Small jet ski parts: sponsons, windscreen, mirrors and grab handle.

// A side sponson near the stern, left side (mirror for the right).
export const sponson = {
  defaults: {
    corners: [[-42.5, -23], [-25, -25.2], [-28.5, -28.6], [-40.5, -28.2]],
    radius: 1.2,
  },

  draw(ctx, { settings, colors, outline }) {
    const trace = (c) => traceRoundedPolygon(c, settings.corners, settings.radius);
    fillWithOutline(ctx, trace, colors.fender, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, colors.fenderLight, -0.8);
  },
};

// The low windscreen, drawn like the cockpit glass.
export const windscreen = {
  defaults: {
    x: 19,
    halfWidth: 11.5,
    // How far the middle of the glass bows to the front, and its depth.
    bow: 3.2,
    depth: 6.5,
  },

  draw(ctx, { settings, colors, outline }) {
    const { x, halfWidth, bow, depth } = settings;
    const trace = (c) => {
      c.moveTo(x, -halfWidth);
      c.quadraticCurveTo(x + bow * 2, 0, x, halfWidth);
      c.lineTo(x - depth, halfWidth - 1.4);
      c.quadraticCurveTo(x + bow * 2 - depth * 2, 0, x - depth, -halfWidth + 1.4);
      c.closePath();
    };
    fillWithOutline(ctx, trace, colors.glassShade, { outline, outlineColor: colors.outline });
    insideShape(ctx, trace, () => {
      ctx.beginPath();
      ctx.moveTo(x + 1, -halfWidth);
      ctx.quadraticCurveTo(x + bow * 2 + 1, 0, x + 1, halfWidth);
      ctx.lineTo(x - depth * 0.45, halfWidth);
      ctx.quadraticCurveTo(x + bow * 2 - depth, 0, x - depth * 0.45, -halfWidth);
      ctx.closePath();
      ctx.fillStyle = colors.glass;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 1.2, -halfWidth * 0.78);
      ctx.quadraticCurveTo(x + bow * 1.1, -halfWidth * 0.4, x + bow * 1.2, -halfWidth * 0.06);
      ctx.lineWidth = 1.3;
      ctx.lineCap = "round";
      ctx.strokeStyle = colors.glassShine;
      ctx.stroke();
    });
  },
};

// A left rear-view mirror (mirror for the right). Decal area: mirrors (hull paint when unpainted).
export const rearMirror = {
  defaults: {
    base: [12.5, -15.4],
    head: [10.8, -20.2],
    length: 3.2,
    width: 4.6,
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const tones = paint("mirrors", "main");
    const { base, head, length, width } = settings;
    ctx.beginPath();
    ctx.moveTo(base[0], base[1]);
    ctx.lineTo(head[0], head[1]);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.2 + outline * 2;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = colors.bar;
    ctx.stroke();

    const trace = (c) => traceRoundRect(c, head[0] - length / 2, head[1] - width / 2, length, width, 1.2);
    fillWithOutline(ctx, trace, tones.base, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, tones.light, -0.7);
    ctx.beginPath();
    traceRoundRect(ctx, head[0] - length / 2 + 0.2, head[1] - width / 2 + 0.7, 1, width - 1.4, 0.4);
    ctx.fillStyle = colors.glassShine;
    ctx.fill();
  },
};

// The grab handle behind the seat.
export const grabHandle = {
  defaults: {
    x: -41.5,
    halfWidth: 7,
    length: 2.2,
  },

  draw(ctx, { settings, colors, outline }) {
    const { x, halfWidth, length } = settings;
    const trace = (c) => traceRoundRect(c, x - length / 2, -halfWidth, length, halfWidth * 2, length / 2);
    fillWithOutline(ctx, trace, colors.bar, { outline, outlineColor: colors.outline });
    facingBand(ctx, trace, colors.fenderLight, -0.6);
  },
};
