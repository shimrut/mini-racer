// One suspension arm between two points.
export const suspensionArm = {
  defaults: {
    from: [0, 0],
    to: [10, 0],
    width: 2.4,
  },

  draw(ctx, { settings, colors, outline }) {
    const { from, to, width } = settings;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    // The side of the bar that faces -y gets the light line.
    let nx = -dy / length;
    let ny = dx / length;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const shift = width * 0.18;

    ctx.lineCap = "round";
    const bar = (color, lineWidth, offset = 0) => {
      ctx.beginPath();
      ctx.moveTo(from[0] + nx * offset, from[1] + ny * offset);
      ctx.lineTo(to[0] + nx * offset, to[1] + ny * offset);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    };
    bar(colors.outline, width + outline * 2);
    bar(colors.frame, width);
    bar(colors.frameLight, width * 0.3, shift);
  },
};
