export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function clonePoint(point) {
    return { x: Number(point.x), y: Number(point.y) };
}

export function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
    };
}

export function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function subtract(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}

export function isFinitePoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

export function distanceSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

export function normalizeVector(x, y) {
    const length = Math.hypot(x, y);
    if (length < 0.000001) {
        return { x: 0, y: 0 };
    }
    return { x: x / length, y: y / length };
}
