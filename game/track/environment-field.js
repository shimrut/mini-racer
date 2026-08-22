function pointInPolygon(x, y, points) {
  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++
  ) {
    const a = points[current];
    const b = points[previous];
    const crosses =
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function buildLoopSegments(points, boundary, startId) {
  const segments = [];
  let totalLength = 0;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) continue;
    segments.push({
      id: startId + segments.length,
      start,
      end,
      dx,
      dy,
      length,
      lengthSq: length * length,
      alongStart: totalLength,
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
      boundary,
    });
    totalLength += length;
  }
  for (const segment of segments) {
    segment.alongStart /= totalLength || 1;
    segment.alongScale = segment.length / (totalLength || 1);
  }
  return segments;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

/** Spatial distance index used only to reject scenery that conflicts with the circuit. */
export function buildTrackDistanceIndex(geometry, scale = 1, cellSize = 280) {
  if (!geometry?.outer?.length || !geometry?.inner?.length) return null;
  const mapLoop = (points) =>
    points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  const outer = mapLoop(geometry.outer);
  const inner = mapLoop(geometry.inner);
  const outerSegments = buildLoopSegments(outer, "outer", 0);
  const innerSegments = buildLoopSegments(inner, "inner", outerSegments.length);
  const segments = [...outerSegments, ...innerSegments];
  const cells = new Map();

  for (const segment of segments) {
    const firstX = Math.floor(segment.minX / cellSize);
    const lastX = Math.floor(segment.maxX / cellSize);
    const firstY = Math.floor(segment.minY / cellSize);
    const lastY = Math.floor(segment.maxY / cellSize);
    for (let cellY = firstY; cellY <= lastY; cellY += 1) {
      for (let cellX = firstX; cellX <= lastX; cellX += 1) {
        const key = cellKey(cellX, cellY);
        const bucket = cells.get(key) || [];
        bucket.push(segment);
        cells.set(key, bucket);
      }
    }
  }

  const seen = new Uint32Array(segments.length);
  let queryStamp = 0;
  const query = (x, y, maxDistance = 720) => {
    queryStamp += 1;
    if (queryStamp >= 0xffffffff) {
      seen.fill(0);
      queryStamp = 1;
    }
    const radius = Math.ceil(maxDistance / cellSize);
    const centerX = Math.floor(x / cellSize);
    const centerY = Math.floor(y / cellSize);
    let nearest = null;
    let nearestSq = maxDistance * maxDistance;
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const bucket = cells.get(cellKey(centerX + offsetX, centerY + offsetY));
        if (!bucket) continue;
        for (const segment of bucket) {
          if (seen[segment.id] === queryStamp) continue;
          seen[segment.id] = queryStamp;
          const projection = Math.max(
            0,
            Math.min(
              1,
              ((x - segment.start.x) * segment.dx +
                (y - segment.start.y) * segment.dy) /
                segment.lengthSq
            )
          );
          const closestX = segment.start.x + segment.dx * projection;
          const closestY = segment.start.y + segment.dy * projection;
          const dx = x - closestX;
          const dy = y - closestY;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > nearestSq) continue;
          nearestSq = distanceSq;
          nearest = {
            distance: Math.sqrt(distanceSq),
            along: (segment.alongStart + segment.alongScale * projection) % 1,
            boundary: segment.boundary,
          };
        }
      }
    }
    return nearest;
  };

  return {
    outer,
    inner,
    query,
    containsTrack(x, y) {
      return pointInPolygon(x, y, outer) && !pointInPolygon(x, y, inner);
    },
  };
}
