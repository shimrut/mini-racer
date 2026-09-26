import { facingBand, fillShape, fillWithOutline, insideShape, mix, traceRoundRect } from "../paint.js";

// One engine pod of the spaceship, on the left side, drawn like the side pods
// of the car: a light upper edge and a dark lower edge. It has a dark intake
// at its front end, a ring of paint, panel lines, a row of vent slots, and
// the nozzle at its rear end. The inside of the nozzle glows. Place it with
// mirror: true for the right pod.
//
// Decal areas:
//   pods     the paint of the pod; with no paint, it is bare metal
//   podRing  a ring of paint around the front part of the pod
export const enginePod = {
  defaults: {
    from: -46,
    to: -16,
    y: -14,
    halfWidth: 4.6,
    ringAt: -24,
    ringWidth: 2.4,
    nozzle: 2.8,
    intake: 1.6,
    panels: [-38, -30],
    vents: { from: -36.5, count: 3, step: 2.4, y: -2.2, length: 1.6 },
  },

  draw(ctx, { settings, colors, paint, outline }) {
    const { from, to, y, halfWidth, ringAt, ringWidth, nozzle, intake } = settings;
    const tones = paint("pods");
    const base = tones ? tones.base : colors.frameLight;
    const light = tones ? tones.light : mix(colors.frameLight, "#ffffff", 0.3);
    const deep = tones ? tones.deep : colors.frame;
    const trace = (c) => traceRoundRect(c, from, y - halfWidth, to - from, halfWidth * 2, halfWidth);
    fillWithOutline(ctx, trace, base, { outline, outlineColor: colors.outline });
    insideShape(ctx, trace, () => {
      const ring = paint("podRing");
      if (ring) {
        fillShape(ctx, (c) => c.rect(ringAt, y - halfWidth, ringWidth, halfWidth * 2), ring.base);
        fillShape(ctx, (c) => c.rect(ringAt, y + halfWidth * 0.35, ringWidth, halfWidth), ring.shade);
      }
      ctx.beginPath();
      for (const x of settings.panels) {
        ctx.moveTo(x, y - halfWidth);
        ctx.lineTo(x, y + halfWidth);
      }
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = mix(base, deep, 0.7);
      ctx.stroke();

      const { vents } = settings;
      for (let i = 0; i < vents.count; i += 1) {
        const x = vents.from + i * vents.step;
        fillShape(ctx, (c) => traceRoundRect(c, x, y + vents.y - 0.5, vents.length, 1, 0.5), colors.intake);
      }
      fillShape(ctx, (c) => c.rect(from - 1, y - halfWidth, nozzle + 1, halfWidth * 2), colors.nozzle);
    });
    facingBand(ctx, trace, light, -1.1);
    facingBand(ctx, trace, deep, 1.4);
    fillShape(ctx, (c) => traceRoundRect(c, from + 0.4, y - halfWidth * 0.55, nozzle - 0.8, halfWidth * 1.1, 0.8), colors.nozzleGlow);

    // The intake: a dark mouth at the front end.
    fillWithOutline(
      ctx,
      (c) => traceRoundRect(c, to - intake - 0.6, y - halfWidth * 0.62, intake, halfWidth * 1.24, intake / 2),
      colors.intake,
      { outline: outline * 0.6, outlineColor: colors.outline },
    );
  },
};
