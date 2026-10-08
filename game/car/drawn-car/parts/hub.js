// The tire hub, its own part so a skin can color it; give it the same size and steering as its tire.
export const hub = {
  defaults: {
    length: 17.8,
    width: 10.8,
    sideWidth: 0.3,
  },

  draw(ctx, { settings, colors }) {
    const { length, width, sideWidth } = settings;
    const halfLength = length / 2;
    const radius = Math.min(length, width) * 0.28;
    const side = width * sideWidth;
    ctx.beginPath();
    ctx.ellipse(0, width / 2 - side * 0.5, halfLength - radius * 0.6, side * 0.26, 0, 0, Math.PI * 2);
    ctx.fillStyle = colors.tireSide;
    ctx.fill();
  },
};
