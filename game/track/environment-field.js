import { createSeededRandom, hashSeed } from './seeded-random.js';

function smoothstep(value) {
    return value * value * (3 - 2 * value);
}

function mix(a, b, amount) {
    return a + (b - a) * amount;
}

function latticeValue(seed, x, y) {
    let value = seed ^ Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return ((value >>> 0) / 4294967295) * 2 - 1;
}

/** Low-frequency deterministic value noise with smooth interpolation. */
export function createEnvironmentNoise(seedKey) {
    const seed = hashSeed(seedKey);

    const octave = (x, y, scale, salt) => {
        const cellX = Math.floor(x / scale);
        const cellY = Math.floor(y / scale);
        const localX = smoothstep(x / scale - cellX);
        const localY = smoothstep(y / scale - cellY);
        const octaveSeed = seed ^ Math.imul(salt + 1, 0x27d4eb2d);
        const top = mix(
            latticeValue(octaveSeed, cellX, cellY),
            latticeValue(octaveSeed, cellX + 1, cellY),
            localX,
        );
        const bottom = mix(
            latticeValue(octaveSeed, cellX, cellY + 1),
            latticeValue(octaveSeed, cellX + 1, cellY + 1),
            localX,
        );
        return mix(top, bottom, localY);
    };

    return (x, y, scale) => (
        octave(x, y, scale, 0) * 0.62
        + octave(x, y, scale * 0.52, 1) * 0.28
        + octave(x, y, scale * 0.27, 2) * 0.1
    );
}

function pointInPolygon(x, y, points) {
    let inside = false;
    for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
        const a = points[current];
        const b = points[previous];
        const crosses = (a.y > y) !== (b.y > y)
            && x < ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
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

/**
 * Spatial index over the smoothed inner and outer circuit walls. The environment
 * uses it only for local runoff widths and prop exclusion without changing
 * collision, gameplay geometry, or the world terrain field.
 */
export function buildTrackDistanceIndex(geometry, scale = 1, cellSize = 280) {
    if (!geometry?.outer?.length || !geometry?.inner?.length) return null;

    const mapLoop = (points) => points.map((point) => ({
        x: point.x * scale,
        y: point.y * scale,
    }));
    const outer = mapLoop(geometry.outer);
    const inner = mapLoop(geometry.inner);
    const outerSegments = buildLoopSegments(outer, 'outer', 0);
    const innerSegments = buildLoopSegments(inner, 'inner', outerSegments.length);
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
                    const projection = Math.max(0, Math.min(1, (
                        (x - segment.start.x) * segment.dx
                        + (y - segment.start.y) * segment.dy
                    ) / segment.lengthSq));
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

function isFarEnough(grid, point, minDistance, cellSize) {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const radius = Math.ceil(minDistance / cellSize);
    const minDistanceSq = minDistance * minDistance;
    for (let y = cellY - radius; y <= cellY + radius; y += 1) {
        for (let x = cellX - radius; x <= cellX + radius; x += 1) {
            const bucket = grid.get(cellKey(x, y));
            if (!bucket) continue;
            for (const other of bucket) {
                const dx = point.x - other.x;
                const dy = point.y - other.y;
                if (dx * dx + dy * dy < minDistanceSq) return false;
            }
        }
    }
    return true;
}

/** Seeded Poisson-style rejection sampling with both isolated and clustered points. */
export function sampleEnvironmentProps({
    seedKey,
    area,
    minDistance,
    targetCount,
    clustering = 0,
    clusterRadius = minDistance * 3.5,
    accept = () => true,
    createCandidate = null,
}) {
    const random = createSeededRandom(seedKey);
    const points = [];
    const clusterCenters = [];
    const grid = new Map();
    const gridSize = minDistance / Math.SQRT2;
    const clusterCount = Math.max(1, Math.round(targetCount * clustering / 6));

    for (let index = 0; index < clusterCount * 8 && clusterCenters.length < clusterCount; index += 1) {
        const center = createCandidate?.(random) || {
            x: area.minX + random() * (area.maxX - area.minX),
            y: area.minY + random() * (area.maxY - area.minY),
        };
        if (accept(center.x, center.y)) clusterCenters.push(center);
    }

    const maxAttempts = Math.max(80, targetCount * 45);
    for (let attempt = 0; attempt < maxAttempts && points.length < targetCount; attempt += 1) {
        let x;
        let y;
        let candidateMetadata = null;
        if (clusterCenters.length > 0 && random() < clustering) {
            const center = clusterCenters[Math.floor(random() * clusterCenters.length)];
            const radius = Math.sqrt(random()) * clusterRadius;
            const angle = random() * Math.PI * 2;
            x = center.x + Math.cos(angle) * radius;
            y = center.y + Math.sin(angle) * radius;
            candidateMetadata = center;
        } else {
            const candidate = createCandidate?.(random);
            x = candidate?.x ?? (area.minX + random() * (area.maxX - area.minX));
            y = candidate?.y ?? (area.minY + random() * (area.maxY - area.minY));
            candidateMetadata = candidate;
        }
        if (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY) continue;
        if (!accept(x, y)) continue;
        const point = {
            ...(candidateMetadata || {}),
            x,
            y,
            seed: `${seedKey}:${attempt}`,
        };
        if (!isFarEnough(grid, point, minDistance, gridSize)) continue;
        points.push(point);
        const key = cellKey(Math.floor(x / gridSize), Math.floor(y / gridSize));
        const bucket = grid.get(key) || [];
        bucket.push(point);
        grid.set(key, bucket);
    }

    return points;
}
