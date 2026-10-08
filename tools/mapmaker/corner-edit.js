import { findCornerWallGroups } from './ribbon-walls.js';

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestIndex(points, target) {
    return points.reduce((best, point, index) => (
        distance(point, target) < distance(points[best], target) ? index : best
    ), 0);
}

function turnAmount(points, index) {
    const prev = points[(index - 1 + points.length) % points.length];
    const curr = points[index];
    const next = points[(index + 1) % points.length];
    const a = Math.atan2(curr.y - prev.y, curr.x - prev.x);
    const b = Math.atan2(next.y - curr.y, next.x - curr.x);
    return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

// A Draw corner pairs a sharp wall point with a run on the other wall; hand-shaped tracks use a soft selection.
export function selectCorner(track, path, index, roadWidth) {
    const point = track[path][index];
    if (!point) return null;
    const groups = findCornerWallGroups(track.outer, track.inner, roadWidth);
    const group = groups.find(({ pivot, facing }) => (
        (pivot.path === path && pivot.index === index)
        || (facing.path === path && facing.indices.includes(index))
    ));
    if (group) {
        const pivot = track[group.pivot.path][group.pivot.index];
        const facingPoints = group.facing.indices.map((at) => track[group.facing.path][at]);
        const facingMiddle = facingPoints[Math.floor(facingPoints.length / 2)];
        return {
            anchor: { x: (pivot.x + facingMiddle.x) / 2, y: (pivot.y + facingMiddle.y) / 2 },
            radiusPoints: [group.pivot],
            members: [
                { ...group.pivot, weight: 1 },
                ...group.facing.indices.map((at) => ({ path: group.facing.path, index: at, weight: 1 })),
            ],
        };
    }

    const otherPath = path === 'outer' ? 'inner' : 'outer';
    const otherIndex = nearestIndex(track[otherPath], point);
    const opposite = track[otherPath][otherIndex];
    const anchor = { x: (point.x + opposite.x) / 2, y: (point.y + opposite.y) / 2 };
    const reach = roadWidth * 2.5;
    const members = ['outer', 'inner'].flatMap((wall) => track[wall].flatMap((candidate, at) => {
        const t = Math.max(0, 1 - distance(candidate, anchor) / reach);
        const weight = t * t * (3 - 2 * t);
        return weight > 0.01 ? [{ path: wall, index: at, weight }] : [];
    }));
    const strongestNear = (wall, seed) => {
        const candidates = track[wall]
            .map((candidate, at) => ({ at, distance: distance(candidate, seed) }))
            .filter(({ distance: gap }) => gap <= roadWidth * 1.5);
        return candidates.reduce((best, candidate) => (
            !best || turnAmount(track[wall], candidate.at) > turnAmount(track[wall], best.at)
                ? candidate : best
        ), null)?.at ?? nearestIndex(track[wall], seed);
    };
    return {
        anchor,
        radiusPoints: [
            { path, index: strongestNear(path, point) },
            { path: otherPath, index: strongestNear(otherPath, opposite) },
        ],
        members,
    };
}

export function moveCorner(track, selection, startPoints, delta) {
    selection.members.forEach(({ path, index, weight }, memberIndex) => {
        const point = track[path][index];
        const start = startPoints[memberIndex];
        point.x = start.x + delta.x * weight;
        point.y = start.y + delta.y * weight;
    });
}
