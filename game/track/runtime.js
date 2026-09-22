export function smoothPoly(points, radius) {
    const uniquePoints = points.filter((p, i) => {
        const next = points[(i + 1) % points.length];
        return !(Math.abs(p.x - next.x) < 0.01 && Math.abs(p.y - next.y) < 0.01);
    });

    if (uniquePoints.length < 3) return uniquePoints;

    const newPoints = [];
    const len = uniquePoints.length;
    // Must match the server replay validator.
    const steps = 5;

    for (let i = 0; i < len; i++) {
        const prev = uniquePoints[(i - 1 + len) % len];
        const curr = uniquePoints[i];
        const next = uniquePoints[(i + 1) % len];

        const v1 = { x: curr.x - prev.x, y: curr.y - prev.y };
        const v2 = { x: next.x - curr.x, y: next.y - curr.y };

        const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
        const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);

        if (len1 < 0.001 || len2 < 0.001) {
            newPoints.push(curr);
            continue;
        }

        const r = Math.min(radius, len1 / 2.5, len2 / 2.5);
        const n1 = { x: v1.x / len1, y: v1.y / len1 };
        const n2 = { x: v2.x / len2, y: v2.y / len2 };
        const start = { x: curr.x - n1.x * r, y: curr.y - n1.y * r };
        const end = { x: curr.x + n2.x * r, y: curr.y + n2.y * r };

        for (let t = 0; t <= steps; t++) {
            const s = t / steps;
            const a = (1 - s) * (1 - s);
            const b = 2 * (1 - s) * s;
            const c = s * s;
            newPoints.push({
                x: a * start.x + b * curr.x + c * end.x,
                y: a * start.y + b * curr.y + c * end.y
            });
        }
    }

    return newPoints;
}

export function buildTrackGeometry(track) {
    const cornerRadius = track.cornerRadius ?? 3;
    return {
        outer: smoothPoly(track.outer, cornerRadius),
        inner: smoothPoly(track.inner, cornerRadius)
    };
}

function buildCollisionSegmentsForPoly(poly) {
    const segments = [];

    for (let i = 0; i < poly.length; i++) {
        const start = poly[i];
        const end = poly[(i + 1) % poly.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        segments.push({
            start,
            end,
            minX: Math.min(start.x, end.x),
            maxX: Math.max(start.x, end.x),
            minY: Math.min(start.y, end.y),
            maxY: Math.max(start.y, end.y),
            dx,
            dy,
            lenSq: dx * dx + dy * dy
        });
    }

    return segments;
}

function getCollisionCellKey(cellX, cellY) {
    return `${cellX},${cellY}`;
}

function buildCollisionHash(segments, cellSize = 6) {
    const cells = new Map();

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const startCellX = Math.floor(segment.minX / cellSize);
        const endCellX = Math.floor(segment.maxX / cellSize);
        const startCellY = Math.floor(segment.minY / cellSize);
        const endCellY = Math.floor(segment.maxY / cellSize);

        for (let cellY = startCellY; cellY <= endCellY; cellY++) {
            for (let cellX = startCellX; cellX <= endCellX; cellX++) {
                const key = getCollisionCellKey(cellX, cellY);
                let bucket = cells.get(key);
                if (!bucket) {
                    bucket = [];
                    cells.set(key, bucket);
                }
                bucket.push(segment);
            }
        }
    }

    return {
        cellSize,
        cells,
        segments,
        candidateSegments: [],
        queryStamp: 0
    };
}

export function buildCollisionRuntime(geometry) {
    const segments = [
        ...buildCollisionSegmentsForPoly(geometry.outer),
        ...buildCollisionSegmentsForPoly(geometry.inner)
    ];

    return {
        collisionSegments: segments,
        collisionHash: buildCollisionHash(segments)
    };
}
