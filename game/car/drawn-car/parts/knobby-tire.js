import { fillShape, insideShape, traceRoundRect } from "../paint.js";

// A knobby tire for dirt roads. Square tread blocks stand out from the rubber
// in two rows, and the blocks stick out past the long edges of the tire. The
// blocks go around the drum, so they roll with the speed like the grooves of
// the road tire: fast at the center and slow at the ends.
//
// The side wall is on the +y edge. The light oval on it is the hub, which is
// its own part.
export const knobbyTire = {
  moves: true,
  defaults: {
    length: 18.4,
    width: 12.6,
    // The side wall, as a part of the tire width.
    sideWidth: 0.26,
    // The number of blocks around the tire, in each row.
    blocks: 14,
    blockLength: 2.6,
    // How far the blocks stick out past the edges of the tire.
    knob: 0.8,
  },

  draw(ctx, { settings, colors, motion, outline }) {
    const { length, width, sideWidth, blocks, blockLength, knob } = settings;
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const radius = Math.min(length, width) * 0.22;
    const side = width * sideWidth;
    const faceBottom = halfWidth - side;
    const middle = (faceBottom - halfWidth) / 2;
    const step = (Math.PI * 2) / blocks;
    const turn = ((motion.roll / halfLength) % step + step) % step;
    const contrast = 1 - motion.rollBlur * 0.6;

    // The blocks that face up, as [x, length, depth] for each row. The second
    // row is half a block behind the first.
    const rowBlocks = (offset) => {
      const list = [];
      for (let angle = -Math.PI / 2 + ((turn + offset) % step); angle < Math.PI / 2; angle += step) {
        const depth = Math.cos(angle);
        list.push([halfLength * Math.sin(angle), blockLength * depth, depth]);
      }
      return list;
    };
    const outerRow = rowBlocks(0);
    const innerRow = rowBlocks(step / 2);

    // The knobs past the edges, under the tire.
    ctx.fillStyle = colors.tire;
    ctx.strokeStyle = colors.outline;
    ctx.lineWidth = outline * 0.8;
    for (const [x, blockSize, depth] of outerRow) {
      if (depth < 0.35) continue;
      ctx.beginPath();
      traceRoundRect(ctx, x - blockSize / 2, -halfWidth - knob, blockSize, knob + 1, 0.3);
      ctx.fill();
      ctx.stroke();
    }
    for (const [x, blockSize, depth] of innerRow) {
      if (depth < 0.35) continue;
      ctx.beginPath();
      traceRoundRect(ctx, x - blockSize / 2, halfWidth - 1, blockSize, knob + 1, 0.3);
      ctx.fill();
      ctx.stroke();
    }

    const trace = (c) => traceRoundRect(c, -halfLength, -halfWidth, length, width, radius);
    fillShape(ctx, trace, colors.tireLine);
    insideShape(ctx, trace, () => {
      const drum = ctx.createLinearGradient(-halfLength, 0, halfLength, 0);
      drum.addColorStop(0, colors.tire);
      drum.addColorStop(0.35, colors.tireFace);
      drum.addColorStop(0.65, colors.tireFace);
      drum.addColorStop(1, colors.tire);
      const rows = [
        [outerRow, -halfWidth + 0.6, middle - 0.35],
        [innerRow, middle + 0.35, faceBottom - 0.5],
      ];
      ctx.fillStyle = drum;
      for (const [row, top, bottom] of rows) {
        for (const [x, blockSize, depth] of row) {
          ctx.globalAlpha = Math.min(1, 0.35 + depth) * contrast + (1 - contrast) * 0.5;
          ctx.fillRect(x - blockSize / 2, top, blockSize, bottom - top);
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.tire;
      ctx.fillRect(-halfLength, faceBottom, length, side);
      ctx.fillStyle = colors.tireLine;
      ctx.fillRect(-halfLength, faceBottom - 0.25, length, 0.5);
    });

    ctx.beginPath();
    trace(ctx);
    ctx.lineWidth = outline;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
  },
};
