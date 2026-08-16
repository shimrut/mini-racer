import { CONFIG } from '../game/config.js';
import { getIntersection } from '../game/track/geometry.js';

const DT = 1 / 60;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
// Nudge inward-cast rays off the wall they start on so they do not hit it.
const NORMAL_PROBE = 0.01;
// How close to a wall corner a crossing has to be before it counts as the two
// segments simply meeting there. Well under the car's 0.55 width, so a fold big
// enough to drive into is still caught.
const SEAM_TOLERANCE = 0.2;
// Steps taken along an inward ray when looking for the roomiest spot on it.
const GUIDE_RAY_STEPS = 16;
// How hard a guide candidate is penalised for sitting away from the last pick.
const CONTINUITY_WEIGHT = 0.6;
// Cap on how far inward a guide point may sit, as a multiple of the track's
// median wall-to-wall reach.
const MAX_OFFSET_SLACK = 0.75;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    };
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];
        const intersects = ((a.y > point.y) !== (b.y > point.y))
            && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 0.000001) + a.x);
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function isFinitePoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function rotateArray(points, startIndex) {
    if (!points.length) {
        return [];
    }
    return points.slice(startIndex).concat(points.slice(0, startIndex));
}

function rotateToNearest(points, target) {
    if (!points.length) {
        return [];
    }
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i++) {
        const currentDistance = distanceSq(points[i], target);
        if (currentDistance < bestDistance) {
            bestDistance = currentDistance;
            bestIndex = i;
        }
    }
    return rotateArray(points, bestIndex);
}

function perimeterOfClosed(points) {
    let total = 0;
    for (let i = 0; i < points.length; i++) {
        total += distance(points[i], points[(i + 1) % points.length]);
    }
    return total;
}

function resampleClosedPolygon(points, sampleCount) {
    if (!points.length) {
        return [];
    }
    if (points.length === 1) {
        return Array.from({ length: sampleCount }, () => ({ ...points[0] }));
    }

    const lengths = [];
    let total = 0;
    for (let i = 0; i < points.length; i++) {
        const segmentLength = distance(points[i], points[(i + 1) % points.length]);
        lengths.push(segmentLength);
        total += segmentLength;
    }

    if (total === 0) {
        return points.map((point) => ({ ...point }));
    }

    const result = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        const target = (sampleIndex / sampleCount) * total;
        let traversed = 0;
        for (let segmentIndex = 0; segmentIndex < points.length; segmentIndex++) {
            const segmentLength = lengths[segmentIndex];
            const nextTraversed = traversed + segmentLength;
            if (target <= nextTraversed || segmentIndex === points.length - 1) {
                const start = points[segmentIndex];
                const end = points[(segmentIndex + 1) % points.length];
                const t = segmentLength === 0 ? 0 : (target - traversed) / segmentLength;
                result.push({
                    x: lerp(start.x, end.x, t),
                    y: lerp(start.y, end.y, t)
                });
                break;
            }
            traversed = nextTraversed;
        }
    }
    return result;
}

function smoothPoly(points, radius) {
    const uniquePoints = points.filter((point, index) => {
        const next = points[(index + 1) % points.length];
        return !(Math.abs(point.x - next.x) < 0.01 && Math.abs(point.y - next.y) < 0.01);
    });

    if (uniquePoints.length < 3) {
        return uniquePoints.map((point) => ({ ...point }));
    }

    const smoothed = [];
    const steps = 5;

    for (let i = 0; i < uniquePoints.length; i++) {
        const prev = uniquePoints[(i - 1 + uniquePoints.length) % uniquePoints.length];
        const current = uniquePoints[i];
        const next = uniquePoints[(i + 1) % uniquePoints.length];
        const v1 = { x: current.x - prev.x, y: current.y - prev.y };
        const v2 = { x: next.x - current.x, y: next.y - current.y };
        const len1 = Math.hypot(v1.x, v1.y);
        const len2 = Math.hypot(v2.x, v2.y);

        if (len1 < 0.001 || len2 < 0.001) {
            smoothed.push({ ...current });
            continue;
        }

        const curveRadius = Math.min(radius, len1 / 2.5, len2 / 2.5);
        const n1 = { x: v1.x / len1, y: v1.y / len1 };
        const n2 = { x: v2.x / len2, y: v2.y / len2 };
        const start = { x: current.x - n1.x * curveRadius, y: current.y - n1.y * curveRadius };
        const end = { x: current.x + n2.x * curveRadius, y: current.y + n2.y * curveRadius };

        for (let step = 0; step <= steps; step++) {
            const t = step / steps;
            const a = (1 - t) * (1 - t);
            const b = 2 * (1 - t) * t;
            const c = t * t;
            smoothed.push({
                x: a * start.x + b * current.x + c * end.x,
                y: a * start.y + b * current.y + c * end.y
            });
        }
    }

    return smoothed;
}

function directionBetween(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
}

function lineLength(line) {
    if (!line || !isFinitePoint(line.p1) || !isFinitePoint(line.p2)) {
        return 0;
    }
    return distance(line.p1, line.p2);
}

function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return { distance: distance(point, a), closest: { ...a } };
    }
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
    t = clamp(t, 0, 1);
    const closest = {
        x: a.x + dx * t,
        y: a.y + dy * t
    };
    return {
        distance: distance(point, closest),
        closest
    };
}

function dedupeIntersections(points) {
    const unique = [];
    const thresholdSq = 0.02 * 0.02;
    points.forEach((point) => {
        if (!unique.some((candidate) => distanceSq(candidate, point) <= thresholdSq)) {
            unique.push(point);
        }
    });
    return unique;
}

function linePolygonIntersections(line, polygon) {
    const hits = [];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const hit = getIntersection(line.p1, line.p2, a, b);
        if (hit) {
            hits.push(hit);
        }
    }
    return dedupeIntersections(hits);
}

function polygonsSelfIntersect(points) {
    if (points.length < 4) {
        return false;
    }
    for (let i = 0; i < points.length; i++) {
        const a1 = points[i];
        const a2 = points[(i + 1) % points.length];
        for (let j = i + 1; j < points.length; j++) {
            const b1 = points[j];
            const b2 = points[(j + 1) % points.length];
            const sameSegment = i === j;
            const adjacent = (i + 1) % points.length === j || i === (j + 1) % points.length;
            const wrapAdjacent = i === 0 && j === points.length - 1;
            if (sameSegment || adjacent || wrapAdjacent) {
                continue;
            }
            const hit = getIntersection(a1, a2, b1, b2);
            // Only a crossing through the middle of both segments folds a wall.
            // Two segments meeting at a corner also "intersect", and a polygon
            // that repeats its first vertex as its last, or closes a hair away
            // from it, puts such a corner outside the adjacency window above.
            if (hit && [a1, a2, b1, b2].every((end) => distance(hit, end) > SEAM_TOLERANCE)) {
                return true;
            }
        }
    }
    return false;
}

function getBounds(...collections) {
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };

    collections.flat().forEach((value) => {
        if (Array.isArray(value)) {
            value.forEach((point) => {
                if (isFinitePoint(point)) {
                    bounds.minX = Math.min(bounds.minX, point.x);
                    bounds.minY = Math.min(bounds.minY, point.y);
                    bounds.maxX = Math.max(bounds.maxX, point.x);
                    bounds.maxY = Math.max(bounds.maxY, point.y);
                }
            });
            return;
        }

        if (isFinitePoint(value)) {
            bounds.minX = Math.min(bounds.minX, value.x);
            bounds.minY = Math.min(bounds.minY, value.y);
            bounds.maxX = Math.max(bounds.maxX, value.x);
            bounds.maxY = Math.max(bounds.maxY, value.y);
        }
    });

    if (!Number.isFinite(bounds.minX)) {
        return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    }
    return bounds;
}

function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return '--';
    }
    return value.toFixed(digits).replace(/\.?0+$/, '');
}

function makeIssue(severity, title, detail, options = {}) {
    return {
        severity,
        title,
        detail,
        hotspot: options.hotspot || null,
        code: options.code || '',
        source: options.source || 'analysis'
    };
}

function classifyGate(name, gate, prepared) {
    if (!gate || !isFinitePoint(gate.p1) || !isFinitePoint(gate.p2)) {
        return makeIssue('error', `${name} is missing`, `${name} needs two valid points before the track can be validated.`, {
            code: `${name.toLowerCase().replace(/\s+/g, '-')}-missing`,
            source: 'structure'
        });
    }

    const length = lineLength(gate);
    if (length < 0.25) {
        return makeIssue('error', `${name} is too short`, `${name} is effectively zero-length, so bots cannot rely on it.`, {
            hotspot: midpoint(gate.p1, gate.p2),
            code: `${name.toLowerCase().replace(/\s+/g, '-')}-short`,
            source: 'structure'
        });
    }

    const outerHits = linePolygonIntersections(gate, prepared.outer).length;
    const innerHits = linePolygonIntersections(gate, prepared.inner).length;
    const mid = midpoint(gate.p1, gate.p2);
    const midpointOnTrack = pointInPolygon(mid, prepared.outer) && !pointInPolygon(mid, prepared.inner);

    if (outerHits === 0 || innerHits === 0 || !midpointOnTrack) {
        return makeIssue('error', `${name} does not bridge the drivable lane`, `${name} should cut across the corridor once. Current hits: outer ${outerHits}, inner ${innerHits}.`, {
            hotspot: mid,
            code: `${name.toLowerCase().replace(/\s+/g, '-')}-disconnected`,
            source: 'structure'
        });
    }

    if (outerHits > 2 || innerHits > 2) {
        return makeIssue('warning', `${name} crosses boundary multiple times`, `${name} appears to snake across the walls, which can make lap logic ambiguous.`, {
            hotspot: mid,
            code: `${name.toLowerCase().replace(/\s+/g, '-')}-multi-hit`,
            source: 'structure'
        });
    }

    return null;
}

function nearestWallDistance(prepared, point) {
    let bestDistance = Infinity;
    let bestPoint = null;

    const checkPoly = (poly) => {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const result = distanceToSegment(point, a, b);
            if (result.distance < bestDistance) {
                bestDistance = result.distance;
                bestPoint = result.closest;
            }
        }
    };

    checkPoly(prepared.outer);
    checkPoly(prepared.inner);

    return {
        distance: bestDistance,
        point: bestPoint || { ...point }
    };
}

function checkWallCollisionDetailed(prepared, p1, p2) {
    const carRadiusSq = CONFIG.carRadius * CONFIG.carRadius;
    let hit = false;
    let bestDistance = Infinity;
    let bestPoint = null;

    const checkPoly = (poly) => {
        const minX = Math.min(p1.x, p2.x) - CONFIG.carRadius;
        const maxX = Math.max(p1.x, p2.x) + CONFIG.carRadius;
        const minY = Math.min(p1.y, p2.y) - CONFIG.carRadius;
        const maxY = Math.max(p1.y, p2.y) + CONFIG.carRadius;

        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const wallMinX = Math.min(a.x, b.x);
            const wallMaxX = Math.max(a.x, b.x);
            const wallMinY = Math.min(a.y, b.y);
            const wallMaxY = Math.max(a.y, b.y);

            if (maxX < wallMinX || minX > wallMaxX || maxY < wallMinY || minY > wallMaxY) {
                continue;
            }

            const lineHit = getIntersection(p1, p2, a, b);
            if (lineHit) {
                hit = true;
                const currentDistance = distance(p2, lineHit);
                if (currentDistance < bestDistance) {
                    bestDistance = currentDistance;
                    bestPoint = lineHit;
                }
            }

            const segmentDistance = distanceToSegment(p2, a, b);
            if (segmentDistance.distance < bestDistance) {
                bestDistance = segmentDistance.distance;
                bestPoint = segmentDistance.closest;
            }

            const dx = p2.x - segmentDistance.closest.x;
            const dy = p2.y - segmentDistance.closest.y;
            if ((dx * dx + dy * dy) < carRadiusSq) {
                hit = true;
            }
        }
    };

    checkPoly(prepared.outer);
    checkPoly(prepared.inner);

    return {
        hit,
        clearance: bestDistance,
        point: bestPoint || { ...p2 }
    };
}

function getTurnSeverity(centerline, index, lookAhead) {
    if (centerline.length < 6) {
        return 0;
    }
    const a = centerline[index];
    const b = centerline[(index + lookAhead) % centerline.length];
    const c = centerline[(index + lookAhead * 2) % centerline.length];
    const dir1 = directionBetween(a, b);
    const dir2 = directionBetween(b, c);
    const delta = Math.acos(clamp(dir1.x * dir2.x + dir1.y * dir2.y, -1, 1));
    return delta / Math.PI;
}

function getTurnSeverityAhead(centerline, progressIndex, lookAhead, anticipationSamples) {
    let maxSeverity = 0;
    const len = centerline.length;
    for (let offset = 0; offset <= anticipationSamples; offset++) {
        const idx = (progressIndex + offset + len) % len;
        const s = getTurnSeverity(centerline, idx, lookAhead);
        if (s > maxSeverity) {
            maxSeverity = s;
        }
    }
    return maxSeverity;
}

function sampleClosedProgress(points, progress) {
    if (!points.length) {
        return { x: 0, y: 0 };
    }
    const length = points.length;
    const wrapped = ((progress % length) + length) % length;
    const index = Math.floor(wrapped);
    const nextIndex = (index + 1) % length;
    const t = wrapped - index;
    return {
        x: lerp(points[index].x, points[nextIndex].x, t),
        y: lerp(points[index].y, points[nextIndex].y, t)
    };
}

function sampleLanePoint(prepared, progress, laneBias) {
    const basePoint = sampleClosedProgress(prepared.centerline, progress);
    const normal = sampleClosedProgress(prepared.centerlineNormals, progress);
    const clearance = sampleClosedProgress(prepared.centerlineClearances, progress).x;
    const maxOffset = Math.max(0, (clearance - CONFIG.carRadius - 0.04) * 0.72);
    const candidate = {
        x: basePoint.x + normal.x * maxOffset * laneBias,
        y: basePoint.y + normal.y * maxOffset * laneBias
    };
    const onTrack = pointInPolygon(candidate, prepared.outer) && !pointInPolygon(candidate, prepared.inner);
    return onTrack ? candidate : basePoint;
}

function makeHotspotBuckets(events, radius, minCount, label, severity) {
    const buckets = [];
    const radiusSq = radius * radius;

    events.forEach((event) => {
        let bucket = buckets.find((candidate) => distanceSq(candidate, event) <= radiusSq);
        if (!bucket) {
            bucket = { x: event.x, y: event.y, count: 0, label, severity };
            buckets.push(bucket);
        }
        bucket.count += 1;
        bucket.x = lerp(bucket.x, event.x, 1 / bucket.count);
        bucket.y = lerp(bucket.y, event.y, 1 / bucket.count);
    });

    return buckets
        .filter((bucket) => bucket.count >= minCount)
        .sort((a, b) => b.count - a.count);
}

function createBotProfiles(botCount) {
    return Array.from({ length: botCount }, (_, index) => {
        const spread = botCount === 1 ? 0 : (index / (botCount - 1)) * 2 - 1;
        const family = index % 4;
        return {
            id: index + 1,
            laneBias: spread * 0.62,
            pace: 0.88 + family * 0.07 + (index % 3) * 0.02,
            caution: 0.82 + family * 0.06,
            scrapeLimit: 18 + family * 6
        };
    });
}

function nearestPointOnPolygon(point, polygon) {
    let best = { distance: Infinity, closest: { ...point } };
    for (let i = 0; i < polygon.length; i++) {
        const result = distanceToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]);
        if (result.distance < best.distance) {
            best = result;
        }
    }
    return best;
}

// Distance from a guide candidate to the nearest wall, or 0 when the candidate
// left the drivable corridor — off-track points otherwise score a wide berth
// from the middle of the infield.
function guideClearance(walls, point) {
    const onTrack = pointInPolygon(point, walls.outer) && !pointInPolygon(point, walls.inner);
    return onTrack ? nearestWallDistance(walls, point).distance : 0;
}

function inwardNormalAt(outerFlow, index, outer, inner) {
    const previous = outerFlow[(index - 1 + outerFlow.length) % outerFlow.length];
    const next = outerFlow[(index + 1) % outerFlow.length];
    const tangent = directionBetween(previous, next);
    const candidates = [
        { x: -tangent.y, y: tangent.x },
        { x: tangent.y, y: -tangent.x }
    ];
    const point = outerFlow[index];
    return candidates.find((normal) => {
        const probe = { x: point.x + normal.x * NORMAL_PROBE, y: point.y + normal.y * NORMAL_PROBE };
        return pointInPolygon(probe, outer) && !pointInPolygon(probe, inner);
    }) || null;
}

// Every spot the guide could sit for one outer wall sample: the midpoint to the
// closest inner point, plus steps along the inward ray up to the first wall the
// ray meets. `maxOffset` keeps a ray fired down a long straight from parking the
// guide half a track away.
function guideCandidates(outerFlow, index, walls, reach, maxOffset) {
    const point = outerFlow[index];
    const candidates = [midpoint(point, nearestPointOnPolygon(point, walls.inner).closest)];
    const normal = inwardNormalAt(outerFlow, index, walls.outer, walls.inner);

    if (normal) {
        const from = { x: point.x + normal.x * NORMAL_PROBE, y: point.y + normal.y * NORMAL_PROBE };
        const to = { x: point.x + normal.x * reach, y: point.y + normal.y * reach };
        const hits = [
            ...linePolygonIntersections({ p1: from, p2: to }, walls.outer),
            ...linePolygonIntersections({ p1: from, p2: to }, walls.inner)
        ];
        if (hits.length) {
            const span = Math.min(hits.reduce((closest, hit) => Math.min(closest, distance(point, hit)), Infinity), maxOffset);
            for (let step = 1; step < GUIDE_RAY_STEPS; step++) {
                const travelled = (step / GUIDE_RAY_STEPS) * span;
                candidates.push({ x: point.x + normal.x * travelled, y: point.y + normal.y * travelled });
            }
        }
    }

    const scored = candidates
        .map((candidate) => ({ point: candidate, clearance: guideClearance(walls, candidate) }))
        .filter((candidate) => candidate.clearance > 0);
    return scored.length ? scored : [{ point: candidates[0], clearance: 0 }];
}

function medianOf(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Trace the drivable corridor once around the track. Walking the outer wall and
// pairing each sample with its closest inner point is the cheap version of this,
// but that pairing jumps to the far lobe wherever a track crosses or doubles
// back on itself, so the guide teleports across a wall. Walk the samples in
// order instead and, at each one, take the candidate with the most room around
// it that also sits near the previous pick. (Matching the two resampled walls by
// index — the original approach — is worse still: the walls have different
// perimeters, so the pairing drifts out of phase and drags the guide straight
// across the infield.)
function buildCenterline(outer, inner, sampleCount) {
    if (outer.length < 3 || inner.length < 3) {
        return resampleClosedPolygon(outer.length >= 3 ? outer : inner, sampleCount);
    }

    const walls = { outer, inner };
    const outerFlow = resampleClosedPolygon(outer, sampleCount);
    const reach = perimeterOfClosed(outer);
    const maxOffset = medianOf(outerFlow.map((point) => nearestPointOnPolygon(point, inner).distance)) * MAX_OFFSET_SLACK;
    const candidates = outerFlow.map((point, index) => guideCandidates(outerFlow, index, walls, reach, maxOffset));

    // Start where the corridor is widest, so the walk never anchors on an
    // ambiguous first pick.
    const seedIndex = candidates.reduce((best, entry, index) => (
        entry[0].clearance > candidates[best][0].clearance ? index : best
    ), 0);

    const traced = new Array(sampleCount);
    let previous = candidates[seedIndex].reduce((best, entry) => (entry.clearance > best.clearance ? entry : best)).point;
    for (let step = 0; step < sampleCount; step++) {
        const index = (seedIndex + step) % sampleCount;
        const pick = candidates[index].reduce((best, entry) => {
            const score = entry.clearance - distance(entry.point, previous) * CONTINUITY_WEIGHT;
            return score > best.score ? { ...entry, score } : best;
        }, { point: null, clearance: 0, score: -Infinity });
        traced[index] = pick.point;
        previous = pick.point;
    }

    // The samples are evenly spaced along the outer wall, not along the guide, so
    // resample once more so every progress step covers the same distance.
    return resampleClosedPolygon(traced, sampleCount);
}

function prepareTrack(track, requestedSamples) {
    const cornerRadius = Number.isFinite(track.cornerRadius) ? track.cornerRadius : 3;
    const outer = smoothPoly(track.outer || [], cornerRadius);
    const inner = smoothPoly(track.inner || [], cornerRadius);
    const fallbackMid = midpoint(outer[0] || { x: 0, y: 0 }, inner[0] || { x: 1, y: 1 });
    const startMid = lineLength(track.startLine) > 0 ? midpoint(track.startLine.p1, track.startLine.p2) : fallbackMid;
    const perimeter = perimeterOfClosed(outer) + perimeterOfClosed(inner);
    const sampleCount = clamp(
        Number.isFinite(requestedSamples) ? requestedSamples : Math.round(perimeter * 2),
        120,
        900
    );

    let centerline = buildCenterline(outer, inner, sampleCount);
    centerline = rotateToNearest(centerline, startMid);
    const startDir = {
        x: Math.cos(Number.isFinite(track.startAngle) ? track.startAngle : 0),
        y: Math.sin(Number.isFinite(track.startAngle) ? track.startAngle : 0)
    };

    if (centerline.length > 6) {
        const probeDirection = directionBetween(centerline[0], centerline[6]);
        const dot = probeDirection.x * startDir.x + probeDirection.y * startDir.y;
        if (dot < 0) {
            centerline = rotateToNearest(centerline.slice().reverse(), startMid);
        }
    }

    const centerlineNormals = centerline.map((point, index) => {
        const prev = centerline[(index - 1 + centerline.length) % centerline.length];
        const next = centerline[(index + 1) % centerline.length];
        const tangent = directionBetween(prev, next);
        return { x: -tangent.y, y: tangent.x };
    });
    const wallGaps = centerline.map((point) => ({
        outer: nearestPointOnPolygon(point, outer).distance,
        inner: nearestPointOnPolygon(point, inner).distance
    }));
    const centerlineClearances = wallGaps.map((gap) => ({ x: Math.min(gap.outer, gap.inner), y: 0 }));
    // Reach to one wall plus reach to the other, rather than twice the nearer
    // one: a guide point is rarely dead centre, and doubling the short side
    // reports a pinch that is not there.
    const widths = wallGaps.map((gap) => gap.outer + gap.inner);

    const checkpointPoints = (track.checkpoints || []).flatMap((checkpoint) => [checkpoint.p1, checkpoint.p2]);
    const bounds = getBounds(outer, inner, track.startPos, track.startLine?.p1, track.startLine?.p2, checkpointPoints);

    return {
        track,
        outer,
        inner,
        centerline,
        centerlineNormals,
        centerlineClearances,
        widths,
        sampleCount,
        bounds
    };
}

function validateStructure(prepared) {
    const issues = [];
    const { track, outer, inner, centerline, widths } = prepared;

    if ((track.outer || []).length < 3) {
        issues.push(makeIssue('error', 'Outer wall is incomplete', 'The selected track needs at least 3 outer wall points.', {
            code: 'outer-too-small',
            source: 'structure'
        }));
    }
    if ((track.inner || []).length < 3) {
        issues.push(makeIssue('error', 'Inner wall is incomplete', 'The selected track needs at least 3 inner wall points.', {
            code: 'inner-too-small',
            source: 'structure'
        }));
    }
    if (polygonsSelfIntersect(track.outer || [])) {
        issues.push(makeIssue('error', 'Outer wall self-intersects', 'The outer polygon crosses itself, which will break collision and gate logic.', {
            code: 'outer-self-intersection',
            source: 'structure'
        }));
    }
    if (polygonsSelfIntersect(track.inner || [])) {
        issues.push(makeIssue('error', 'Inner wall self-intersects', 'The inner polygon crosses itself, which will break collision and gate logic.', {
            code: 'inner-self-intersection',
            source: 'structure'
        }));
    }

    if (outer.length >= 3 && inner.length >= 3 && !pointInPolygon(inner[0], outer)) {
        issues.push(makeIssue('error', 'Inner wall sits outside the track shell', 'The inner polygon should be fully contained by the outer polygon.', {
            hotspot: inner[0],
            code: 'inner-outside-outer',
            source: 'structure'
        }));
    }

    if (!isFinitePoint(track.startPos)) {
        issues.push(makeIssue('error', 'Start position is missing', 'Bots need a valid start position on the drivable surface.', {
            code: 'start-pos-missing',
            source: 'structure'
        }));
    } else {
        const onTrack = pointInPolygon(track.startPos, outer) && !pointInPolygon(track.startPos, inner);
        const startClearance = nearestWallDistance(prepared, track.startPos).distance;
        if (!onTrack) {
            issues.push(makeIssue('error', 'Start position is off track', 'The start point is outside the drivable corridor.', {
                hotspot: track.startPos,
                code: 'start-off-track',
                source: 'structure'
            }));
        } else if (startClearance < CONFIG.carRadius + 0.05) {
            issues.push(makeIssue('warning', 'Start position is too close to a wall', 'Bots will spawn almost touching a boundary, which often causes false scrapes.', {
                hotspot: track.startPos,
                code: 'start-clearance-low',
                source: 'structure'
            }));
        }
    }

    const finishIssue = classifyGate('Finish line', track.startLine, prepared);
    if (finishIssue) {
        issues.push(finishIssue);
    }

    if (!Array.isArray(track.checkpoints) || track.checkpoints.length === 0) {
        issues.push(makeIssue('warning', 'No checkpoints defined', 'The validator can still run, but it cannot verify full lap order without checkpoints.', {
            code: 'checkpoints-missing',
            source: 'structure'
        }));
    } else {
        track.checkpoints.forEach((checkpoint, index) => {
            const checkpointIssue = classifyGate(`Checkpoint ${index + 1}`, checkpoint, prepared);
            if (checkpointIssue) {
                issues.push(checkpointIssue);
            }
        });
    }

    let minWidth = Infinity;
    let narrowIndex = 0;
    widths.forEach((width, index) => {
        if (width < minWidth) {
            minWidth = width;
            narrowIndex = index;
        }
    });

    if (Number.isFinite(minWidth)) {
        if (minWidth < 0.7) {
            issues.push(makeIssue('error', 'Track pinches below safe width', `The tightest measured section is ${formatNumber(minWidth)} units wide.`, {
                hotspot: centerline[narrowIndex],
                code: 'track-too-narrow',
                source: 'structure'
            }));
        } else if (minWidth < 1.2) {
            issues.push(makeIssue('warning', 'Track has a very narrow section', `The tightest measured section is ${formatNumber(minWidth)} units wide.`, {
                hotspot: centerline[narrowIndex],
                code: 'track-narrow-warning',
                source: 'structure'
            }));
        }
    }

    const fatal = issues.some((issue) => issue.severity === 'error');
    return { issues, fatal, minWidth };
}

function simulateBot(prepared, profile, settings) {
    let progress = 0;
    let pos = sampleLanePoint(prepared, progress, profile.laneBias);
    let time = 0;
    let laps = 0;
    let nextCheckpointIndex = 0;
    let finishCrosses = 0;
    let crashes = 0;
    let scrapes = 0;
    let status = 'timeout';
    let bestProgressRatio = 0;
    let furthestCheckpoint = 0;
    let armedForFinish = false;
    const checkpoints = prepared.track.checkpoints || [];
    const checkpointHits = Array.from({ length: checkpoints.length }, () => 0);
    const path = [{ ...pos }];
    const hotspots = [];
    const notes = [];
    const maxSteps = Math.ceil(settings.maxSeconds / DT);

    for (let step = 0; step < maxSteps; step++) {
        time += DT;
        const progressIndex = Math.floor(progress) % prepared.centerline.length;
        const guideWidth = prepared.widths[progressIndex] || 1;
        const turnSeverity = getTurnSeverityAhead(prepared.centerline, progressIndex, 4, 6);
        const widthFactor = clamp((guideWidth - CONFIG.carRadius * 4) / 3, 0.45, 1.2);
        const advance = clamp((prepared.sampleCount / 13) * DT * profile.pace * widthFactor * (1 - turnSeverity * 0.82 * profile.caution), 0.08, 0.95);
        const nextProgress = progress + advance;
        const nextPos = sampleLanePoint(prepared, nextProgress, profile.laneBias);
        bestProgressRatio = Math.max(bestProgressRatio, Math.min(1, nextProgress / prepared.sampleCount));

        if (nextCheckpointIndex < checkpoints.length) {
            const checkpoint = checkpoints[nextCheckpointIndex];
            if (getIntersection(pos, nextPos, checkpoint.p1, checkpoint.p2)) {
                checkpointHits[nextCheckpointIndex] += 1;
                nextCheckpointIndex += 1;
                furthestCheckpoint = Math.max(furthestCheckpoint, nextCheckpointIndex);
                armedForFinish = true;
            }
        }

        const crossedFinish = prepared.track.startLine && getIntersection(pos, nextPos, prepared.track.startLine.p1, prepared.track.startLine.p2);
        const allPassed = checkpoints.length === 0 || nextCheckpointIndex >= checkpoints.length;
        if (!armedForFinish && bestProgressRatio >= 0.35) {
            armedForFinish = true;
        }
        if (crossedFinish && armedForFinish) {
            finishCrosses += 1;
            if (allPassed && time >= 1.5) {
                laps += 1;
                if (laps >= settings.laps) {
                    pos = nextPos;
                    path.push({ ...pos });
                    status = 'finished';
                    break;
                }
            }
            nextCheckpointIndex = 0;
            armedForFinish = false;
            progress = nextProgress % prepared.sampleCount;
        }

        const collision = checkWallCollisionDetailed(prepared, pos, nextPos);
        const clearance = nearestWallDistance(prepared, nextPos).distance;
        const riskyClearance = CONFIG.carRadius + 0.02;
        if (collision.hit || clearance < riskyClearance) {
            const hotspotPoint = collision.point || nextPos;
            const severeHit = collision.hit && clearance < CONFIG.carRadius * 0.55;
            hotspots.push({
                x: hotspotPoint.x,
                y: hotspotPoint.y,
                type: severeHit ? 'crash' : 'scrape'
            });

            if (severeHit) {
                crashes += 1;
                status = 'crashed';
                pos = { ...hotspotPoint };
                path.push({ ...pos });
                break;
            }

            scrapes += 1;
            profile.laneBias *= 0.72;
            const recoveryPos = sampleLanePoint(prepared, nextProgress, profile.laneBias);
            pos = recoveryPos;
            progress = nextProgress;
            path.push({ ...pos });

            if (scrapes >= profile.scrapeLimit) {
                status = 'scrapedOut';
                path.push({ ...pos });
                break;
            }
        } else {
            pos = nextPos;
            progress = nextProgress;
        }

        if (step % 3 === 0) {
            path.push({ ...pos });
        }
    }

    if (status === 'timeout' && finishCrosses > 0 && laps === 0 && checkpoints.length > 0) {
        notes.push('finish crossed without completing checkpoint order');
    }
    if (status === 'timeout' && furthestCheckpoint < checkpoints.length) {
        notes.push(`never reached checkpoint ${furthestCheckpoint + 1}`);
    }
    if (scrapes > 0 && crashes === 0) {
        notes.push(`${scrapes} near-wall path samples`);
    }

    return {
        id: profile.id,
        status,
        laps,
        finishCrosses,
        crashes,
        scrapes,
        furthestCheckpoint,
        bestProgressRatio,
        notes: notes.slice(0, 3),
        checkpointHits,
        hotspots,
        path
    };
}

function simulateSwarm(prepared, settings) {
    const profiles = createBotProfiles(settings.botCount);
    const results = profiles.map((profile) => simulateBot(prepared, profile, settings));

    const aggregate = {
        botCount: settings.botCount,
        finishers: 0,
        crashes: 0,
        scrapes: 0,
        stuck: 0,
        timeouts: 0,
        finishCrosses: 0,
        suspiciousCollisions: 0,
        checkpointHits: Array.from({ length: prepared.track.checkpoints?.length || 0 }, () => 0),
        maxCheckpointReached: 0,
        bestProgressRatio: 0,
        crashHotspots: [],
        scrapeHotspots: [],
        suspiciousHotspots: []
    };

    results.forEach((result) => {
        if (result.status === 'finished') {
            aggregate.finishers += 1;
        }
        if (result.status === 'crashed' || result.status === 'scrapedOut') {
            aggregate.crashes += result.crashes;
        }
        if (result.status === 'stuck') {
            aggregate.stuck += 1;
        }
        if (result.status === 'timeout') {
            aggregate.timeouts += 1;
        }
        aggregate.scrapes += result.scrapes;
        aggregate.finishCrosses += result.finishCrosses;
        aggregate.maxCheckpointReached = Math.max(aggregate.maxCheckpointReached, result.furthestCheckpoint);
        aggregate.bestProgressRatio = Math.max(aggregate.bestProgressRatio, result.bestProgressRatio);
        result.checkpointHits.forEach((count, index) => {
            aggregate.checkpointHits[index] += count;
        });
        result.hotspots.forEach((hotspot) => {
            if (hotspot.type === 'crash') {
                aggregate.crashHotspots.push(hotspot);
            } else {
                aggregate.scrapeHotspots.push(hotspot);
            }
        });
        const suspiciousNotes = result.notes.filter((note) => note.includes('suspicious wall contacts')).length;
        aggregate.suspiciousCollisions += suspiciousNotes;
    });

    aggregate.suspiciousHotspots = makeHotspotBuckets(
        aggregate.scrapeHotspots.filter((hotspot) => hotspot.type === 'scrape'),
        1.1,
        Math.max(3, Math.ceil(settings.botCount / 5)),
        'scrape hotspot',
        'warning'
    );

    return { results, aggregate };
}

function deriveSimulationIssues(prepared, simulation) {
    const issues = [];
    const { aggregate, results } = simulation;
    const checkpointCount = prepared.track.checkpoints?.length || 0;
    const earlyBottleneck = aggregate.maxCheckpointReached <= 1 && aggregate.bestProgressRatio < 0.35;

    if (aggregate.finishers === 0) {
        issues.push(makeIssue(earlyBottleneck ? 'warning' : 'error', earlyBottleneck ? 'Bots failed early in the lap model' : 'No bot completed a lap', earlyBottleneck
            ? `The swarm topped out around ${(aggregate.bestProgressRatio * 100).toFixed(0)}% lap progress and only reached checkpoint ${aggregate.maxCheckpointReached}. Treat downstream checkpoint warnings as bot-model noise unless the same area also looks wrong visually.`
            : 'The swarm never produced a clean lap, so the track likely has lap-flow, collision, or gate problems.', {
            code: 'no-finishers',
            source: 'simulation'
        }));
    }

    if (aggregate.finishCrosses === 0) {
        issues.push(makeIssue('warning', 'Finish line was never crossed', 'Bots never intersected the finish line during the run window.', {
            hotspot: prepared.track.startLine ? midpoint(prepared.track.startLine.p1, prepared.track.startLine.p2) : null,
            code: 'finish-never-crossed',
            source: 'simulation'
        }));
    }

    for (let index = 0; index < checkpointCount; index++) {
        const previousReached = index === 0 || aggregate.checkpointHits[index - 1] > 0;
        if (aggregate.checkpointHits[index] === 0 && previousReached) {
            const checkpoint = prepared.track.checkpoints[index];
            issues.push(makeIssue('warning', `Bots bottleneck before checkpoint ${index + 1}`, 'No bot intersected this checkpoint after clearing the previous lap segment.', {
                hotspot: midpoint(checkpoint.p1, checkpoint.p2),
                code: `checkpoint-${index + 1}-unreached`,
                source: 'simulation'
            }));
            break;
        }
    }

    const crashRate = aggregate.botCount === 0 ? 0 : aggregate.crashes / aggregate.botCount;
    if (crashRate >= 0.5) {
        issues.push(makeIssue('warning', 'Crash rate is unusually high', `${aggregate.crashes} crash events were recorded across ${aggregate.botCount} bots.`, {
            code: 'crash-rate-high',
            source: 'simulation'
        }));
    }

    if (aggregate.stuck >= Math.ceil(aggregate.botCount / 3)) {
        issues.push(makeIssue('warning', 'Many bots became stuck', `${aggregate.stuck} bots stalled before completing the route.`, {
            code: 'stuck-rate-high',
            source: 'simulation'
        }));
    }

    const crashClusters = makeHotspotBuckets(
        aggregate.crashHotspots,
        1.2,
        Math.max(2, Math.ceil(aggregate.botCount / 6)),
        'crash hotspot',
        'warning'
    ).slice(0, 3);

    crashClusters.forEach((cluster) => {
        issues.push(makeIssue('warning', 'Crash hotspot detected', `${cluster.count} crash contacts clustered here during the run.`, {
            hotspot: { x: cluster.x, y: cluster.y },
            code: 'crash-hotspot',
            source: 'simulation'
        }));
    });

    aggregate.suspiciousHotspots.slice(0, 3).forEach((cluster) => {
        issues.push(makeIssue('warning', 'Wall-scrape hotspot detected', `${cluster.count} low-speed wall contacts clustered here.`, {
            hotspot: { x: cluster.x, y: cluster.y },
            code: 'scrape-hotspot',
            source: 'simulation'
        }));
    });

    const finishWithoutLap = results.filter((result) => result.finishCrosses > 0 && result.laps === 0).length;
    if (finishWithoutLap >= Math.ceil(aggregate.botCount / 4) && checkpointCount > 0 && aggregate.maxCheckpointReached >= Math.max(1, checkpointCount - 1)) {
        issues.push(makeIssue('warning', 'Finish line is easy to hit without valid lap order', `${finishWithoutLap} bots crossed the finish line but still failed the lap sequence.`, {
            hotspot: prepared.track.startLine ? midpoint(prepared.track.startLine.p1, prepared.track.startLine.p2) : null,
            code: 'finish-order-ambiguous',
            source: 'simulation'
        }));
    }

    return issues;
}

function assignIssueMarkers(issues) {
    let marker = 1;
    issues.forEach((issue) => {
        if (issue.hotspot) {
            issue.marker = marker;
            marker += 1;
        } else {
            issue.marker = null;
        }
    });
    return issues;
}

function buildSummary(report) {
    const header = `${report.track.name}: ${report.issues.length} issue(s), ${report.simulation ? report.simulation.aggregate.finishers : 0}/${report.settings.botCount} finishers`;
    const issueLines = report.issues
        .slice(0, 10)
        .map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.detail}`);
    return [header, ...issueLines].join('\n');
}

async function loadTracksFresh() {
    // The timestamp pulls in edits made since the page loaded, so the lab picks
    // up a track you just saved from the mapmaker. Vite refuses to pre-bundle an
    // import it cannot read statically, hence the ignore comment.
    const module = await import(/* @vite-ignore */ `../game/track/tracks.js?v=${Date.now()}`);
    return module.TRACKS;
}

class RunnerApp {
    constructor() {
        this.canvas = document.getElementById('runner-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.trackSelect = document.getElementById('runner-track-select');
        this.botCountInput = document.getElementById('bot-count-input');
        this.lapCountInput = document.getElementById('lap-count-input');
        this.maxSecondsInput = document.getElementById('max-seconds-input');
        this.pathSamplesInput = document.getElementById('path-samples-input');
        this.runButton = document.getElementById('run-validation-btn');
        this.copySummaryButton = document.getElementById('copy-summary-btn');
        this.statusText = document.getElementById('runner-status-text');
        this.runStatePill = document.getElementById('run-state-pill');
        this.issueTotalPill = document.getElementById('issue-total-pill');
        this.fatalPill = document.getElementById('fatal-pill');
        this.finishersMetric = document.getElementById('finishers-metric');
        this.crashesMetric = document.getElementById('crashes-metric');
        this.scrapesMetric = document.getElementById('scrapes-metric');
        this.widthMetric = document.getElementById('width-metric');
        this.issueList = document.getElementById('issue-list');
        this.stageTitle = document.getElementById('stage-title');
        this.stageSubtitle = document.getElementById('stage-subtitle');
        this.botSummaryPill = document.getElementById('bot-summary-pill');
        this.botRunsBody = document.getElementById('bot-runs-body');

        this.state = {
            selectedTrackKey: '',
            tracks: {},
            prepared: null,
            report: null
        };

        this.bindEvents();
        this.resizeCanvas();
        this.initialize();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.canvas.parentElement);
    }

    bindEvents() {
        this.trackSelect.addEventListener('change', async () => {
            await this.loadTrack(this.trackSelect.value, true);
        });
        this.runButton.addEventListener('click', async () => this.runValidation());
        this.copySummaryButton.addEventListener('click', () => this.copySummary());
        window.addEventListener('focus', async () => {
            await this.refreshTracks(false);
        });
    }

    async initialize() {
        await this.refreshTracks(true);
        if (this.state.selectedTrackKey) {
            await this.loadTrack(this.state.selectedTrackKey, true);
        }
    }

    async refreshTracks(rebuildOptions = false) {
        this.state.tracks = await loadTracksFresh();
        const trackKeys = Object.keys(this.state.tracks);
        if (!trackKeys.length) {
            this.setStatus('No tracks were found in tracks.js.', 'issues');
            return;
        }

        if (!this.state.selectedTrackKey || !this.state.tracks[this.state.selectedTrackKey]) {
            this.state.selectedTrackKey = trackKeys[0];
        }

        if (rebuildOptions) {
            this.populateTrackSelect();
        } else {
            this.syncTrackSelectOptions();
        }
    }

    populateTrackSelect() {
        this.trackSelect.innerHTML = '';
        this.syncTrackSelectOptions();
    }

    syncTrackSelectOptions() {
        const currentValue = this.state.selectedTrackKey;
        this.trackSelect.innerHTML = '';
        const fragment = document.createDocumentFragment();
        Object.entries(this.state.tracks).forEach(([key, track]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = track.name;
            fragment.appendChild(option);
        });
        this.trackSelect.appendChild(fragment);
        this.trackSelect.value = currentValue;
    }

    getSettings() {
        return {
            botCount: clamp(Number(this.botCountInput.value) || 18, 1, 48),
            laps: clamp(Number(this.lapCountInput.value) || 1, 1, 5),
            maxSeconds: clamp(Number(this.maxSecondsInput.value) || 40, 5, 180),
            pathSamples: clamp(Number(this.pathSamplesInput.value) || 360, 120, 900)
        };
    }

    setStatus(text, state = 'ready') {
        this.statusText.textContent = text;
        this.runStatePill.textContent = state;
        this.runStatePill.className = 'pill';
        if (state === 'running') {
            this.runStatePill.classList.add('pill-warn');
        } else if (state === 'issues') {
            this.runStatePill.classList.add('pill-danger');
        } else if (state === 'clean') {
            this.runStatePill.classList.add('pill-ok');
        }
    }

    async loadTrack(trackKey, autoRun = false) {
        await this.refreshTracks(false);
        if (!this.state.tracks[trackKey]) {
            return;
        }
        this.state.selectedTrackKey = trackKey;
        this.trackSelect.value = trackKey;
        this.state.prepared = prepareTrack(this.state.tracks[trackKey], this.getSettings().pathSamples);
        this.stageTitle.textContent = `${this.state.tracks[trackKey].name} Preview`;
        this.stageSubtitle.textContent = 'The canvas overlays bot paths, gate lines, and hotspot markers from the latest run.';
        this.drawCanvas(this.state.prepared, null);
        if (autoRun) {
            await this.runValidation();
        }
    }

    async runValidation() {
        await this.refreshTracks(false);
        const track = this.state.tracks[this.state.selectedTrackKey];
        if (!track) {
            this.setStatus('Selected track is no longer available.', 'issues');
            return;
        }
        const settings = this.getSettings();
        this.setStatus(`Running ${settings.botCount} bots on ${track.name}...`, 'running');

        const prepared = prepareTrack(track, settings.pathSamples);
        const structure = validateStructure(prepared);
        const simulation = structure.fatal ? null : simulateSwarm(prepared, settings);
        let issues = [...structure.issues];

        if (simulation) {
            issues = issues.concat(deriveSimulationIssues(prepared, simulation));
        }

        issues.sort((a, b) => {
            const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
            if (severityDelta !== 0) {
                return severityDelta;
            }
            return a.title.localeCompare(b.title);
        });
        assignIssueMarkers(issues);

        if (!issues.length) {
            issues.push(makeIssue('info', 'No obvious issues found in this pass', 'The current run did not surface structural or simulation-level problems.', {
                code: 'clean-pass',
                source: 'analysis'
            }));
        }

        this.state.prepared = prepared;
        this.state.report = {
            track,
            settings,
            prepared,
            structure,
            simulation,
            issues,
            summary: buildSummary({ track, settings, simulation, issues })
        };

        const stateKind = issues.some((issue) => issue.severity === 'error') ? 'issues' : 'clean';
        this.setStatus(`Validation finished for ${track.name}.`, stateKind);
        this.renderReport();
    }

    async copySummary() {
        if (!this.state.report) {
            this.setStatus('Run the validator before copying a report.', 'issues');
            return;
        }
        try {
            await navigator.clipboard.writeText(this.state.report.summary);
            this.setStatus('Copied validation summary to clipboard.', 'clean');
        } catch (error) {
            this.setStatus('Clipboard copy failed in this browser context.', 'issues');
        }
    }

    resizeCanvas() {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.drawCanvas(this.state.prepared, this.state.report);
    }

    renderReport() {
        const report = this.state.report;
        const finishers = report.simulation ? report.simulation.aggregate.finishers : 0;
        const crashCount = report.simulation ? report.simulation.aggregate.crashes : 0;
        const scrapeCount = report.simulation ? report.simulation.aggregate.scrapes : 0;

        // The clean-pass card is an info note, not a problem to count.
        const issueCount = report.issues.filter((issue) => issue.severity !== 'info').length;
        this.issueTotalPill.textContent = `${issueCount} issue${issueCount === 1 ? '' : 's'}`;
        this.issueTotalPill.className = 'pill';
        if (report.issues.some((issue) => issue.severity === 'error')) {
            this.issueTotalPill.classList.add('pill-danger');
        } else if (report.issues.some((issue) => issue.severity === 'warning')) {
            this.issueTotalPill.classList.add('pill-warn');
        } else {
            this.issueTotalPill.classList.add('pill-ok');
        }

        this.fatalPill.textContent = report.structure.fatal ? 'Structural blocker' : 'Simulation allowed';
        this.fatalPill.className = `pill ${report.structure.fatal ? 'pill-danger' : 'pill-ok'}`;
        this.finishersMetric.textContent = `${finishers} / ${report.settings.botCount}`;
        this.crashesMetric.textContent = String(crashCount);
        this.scrapesMetric.textContent = String(scrapeCount);
        this.widthMetric.textContent = Number.isFinite(report.structure.minWidth) ? formatNumber(report.structure.minWidth) : '--';
        this.botSummaryPill.textContent = report.simulation
            ? `${finishers} finishers, ${crashCount} crashes`
            : 'Structure only';
        this.botSummaryPill.className = `pill ${report.structure.fatal ? 'pill-danger' : 'pill-ok'}`;

        this.issueList.innerHTML = '';
        report.issues.forEach((issue) => {
            const card = document.createElement('article');
            card.className = `issue-card issue-card--${issue.severity}`;
            const markerText = issue.marker ? `#${issue.marker} ` : '';
            card.innerHTML = `
                <strong>${markerText}${issue.title}</strong>
                <p>${issue.detail}</p>
                <div class="issue-meta">
                    <span>${issue.severity}</span>
                    <span>${issue.source}</span>
                </div>
            `;
            this.issueList.appendChild(card);
        });

        if (!report.simulation) {
            this.botRunsBody.innerHTML = '<tr><td colspan="8" class="empty-row">Simulation skipped because a structural error blocks bot runs.</td></tr>';
        } else {
            this.botRunsBody.innerHTML = '';
            report.simulation.results.forEach((result) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>Bot ${result.id}</td>
                    <td><span class="status-chip status-chip--${result.status.toLowerCase()}">${result.status}</span></td>
                    <td>${result.laps}</td>
                    <td>${result.finishCrosses}</td>
                    <td>${result.crashes}</td>
                    <td>${result.scrapes}</td>
                    <td>${result.furthestCheckpoint}</td>
                    <td>${result.notes.length ? result.notes.join('; ') : 'none'}</td>
                `;
                this.botRunsBody.appendChild(row);
            });
        }

        this.drawCanvas(report.prepared, report);
    }

    drawCanvas(prepared, report) {
        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;
        ctx.clearRect(0, 0, width, height);

        if (!prepared) {
            return;
        }

        const bounds = prepared.bounds;
        const padding = 48 * (window.devicePixelRatio || 1);
        const drawWidth = Math.max(1, bounds.maxX - bounds.minX);
        const drawHeight = Math.max(1, bounds.maxY - bounds.minY);
        const scale = Math.min(
            (width - padding * 2) / drawWidth,
            (height - padding * 2) / drawHeight
        );

        const offsetX = (width - drawWidth * scale) / 2 - bounds.minX * scale;
        const offsetY = (height - drawHeight * scale) / 2 - bounds.minY * scale;
        const toCanvas = (point) => ({
            x: point.x * scale + offsetX,
            y: point.y * scale + offsetY
        });

        ctx.fillStyle = '#09131d';
        ctx.fillRect(0, 0, width, height);

        const drawLoop = (points, strokeStyle, lineWidth, fillStyle = null) => {
            if (!points.length) {
                return;
            }
            ctx.beginPath();
            const start = toCanvas(points[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < points.length; i++) {
                const point = toCanvas(points[i]);
                ctx.lineTo(point.x, point.y);
            }
            ctx.closePath();
            if (fillStyle) {
                ctx.fillStyle = fillStyle;
                ctx.fill();
            }
            ctx.strokeStyle = strokeStyle;
            ctx.lineWidth = lineWidth;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
        };

        drawLoop(prepared.outer, 'rgba(125, 211, 252, 0.95)', 4, 'rgba(14, 24, 36, 0.92)');
        drawLoop(prepared.inner, 'rgba(125, 211, 252, 0.95)', 4, 'rgba(5, 10, 16, 1)');

        if (prepared.centerline.length) {
            ctx.beginPath();
            const start = toCanvas(prepared.centerline[0]);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < prepared.centerline.length; i += 2) {
                const point = toCanvas(prepared.centerline[i]);
                ctx.lineTo(point.x, point.y);
            }
            ctx.strokeStyle = 'rgba(74, 222, 128, 0.18)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 8]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const drawGate = (gate, color, widthValue) => {
            if (!gate || !isFinitePoint(gate.p1) || !isFinitePoint(gate.p2)) {
                return;
            }
            const p1 = toCanvas(gate.p1);
            const p2 = toCanvas(gate.p2);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = widthValue;
            ctx.setLineDash([10, 8]);
            ctx.stroke();
            ctx.setLineDash([]);
        };

        drawGate(prepared.track.startLine, '#fbbf24', 4);
        (prepared.track.checkpoints || []).forEach((checkpoint) => {
            drawGate(checkpoint, 'rgba(251, 191, 36, 0.55)', 2);
        });

        if (isFinitePoint(prepared.track.startPos)) {
            const start = toCanvas(prepared.track.startPos);
            ctx.fillStyle = '#4ade80';
            ctx.beginPath();
            ctx.arc(start.x, start.y, 6, 0, Math.PI * 2);
            ctx.fill();
        }

        if (report?.simulation) {
            report.simulation.results.forEach((result) => {
                if (!result.path.length) {
                    return;
                }
                ctx.beginPath();
                const start = toCanvas(result.path[0]);
                ctx.moveTo(start.x, start.y);
                for (let i = 1; i < result.path.length; i++) {
                    const point = toCanvas(result.path[i]);
                    ctx.lineTo(point.x, point.y);
                }
                ctx.strokeStyle = result.status === 'finished'
                    ? 'rgba(74, 222, 128, 0.35)'
                    : result.status === 'crashed'
                        ? 'rgba(251, 113, 133, 0.35)'
                        : 'rgba(148, 163, 184, 0.24)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            });
        }

        if (report?.issues) {
            report.issues
                .filter((issue) => issue.marker && issue.hotspot)
                .forEach((issue) => {
                    const point = toCanvas(issue.hotspot);
                    ctx.fillStyle = issue.severity === 'error' ? '#fb7185' : '#fbbf24';
                    ctx.beginPath();
                    ctx.arc(point.x, point.y, 12, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(7, 17, 26, 0.92)';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    ctx.fillStyle = '#07111a';
                    ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(issue.marker), point.x, point.y + 0.5);
                });
        }
    }
}

new RunnerApp();
