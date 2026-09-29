import { CONFIG } from '../../game/config.js';
import { isFinitePoint } from '../geometry.js';

// Nose to tail, matching the ghost car: half-length plus the rounded end, twice.
export const CAR_LENGTH = (CONFIG.carCollisionHalfLength + CONFIG.carRadius) * 2;

export function snapLineBuildPoint(from, toward, step = CAR_LENGTH) {
    if (!isFinitePoint(toward) || !(step > 0)) {
        return null;
    }
    if (!isFinitePoint(from)) {
        return { x: toward.x, y: toward.y };
    }
    const dx = toward.x - from.x;
    const dy = toward.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.000001) {
        return null;
    }
    const steps = Math.round(dist / step);
    if (steps < 1) {
        return null;
    }
    const scale = (steps * step) / dist;
    return {
        x: from.x + dx * scale,
        y: from.y + dy * scale,
    };
}
