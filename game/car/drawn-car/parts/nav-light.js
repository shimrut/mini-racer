import { fillWithOutline } from "../paint.js";

// A small round light, such as a red or green light at a wing tip of the
// spaceship or a lamp on the nose of the jet ski. It has a white shine on
// its upper side.
export const navLight = {
  defaults: {
    x: 0,
    y: 0,
    radius: 1.4,
    // The name of the color in the colors of the car.
    color: "lamp",
  },

  draw(ctx, { settings, colors, outline }) {
    const { x, y, radius } = settings;
    fillWithOutline(ctx, (c) => {
      c.moveTo(x + radius, y);
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.closePath();
    }, colors[settings.color], { outline: outline * 0.6, outlineColor: colors.outline });
    ctx.beginPath();
    ctx.ellipse(x - radius * 0.25, y - radius * 0.35, radius * 0.45, radius * 0.28, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = colors.lampShine;
    ctx.fill();
  },
};
