import { DEFAULT_PHYSICS_TUNING } from './car/handling.js';

// --- Mode Constants ---
export const TRACK_MODE_DAILY_GP = 'daily';

// --- Game Config ---
export const CONFIG = {
    gridSize: 40,
    // Server Daily GP allowlist + test guardrails — NOT a player-facing track picker list.
    // Player track comes from the active daily challenge API (see src/server/daily-gp-model.ts).
    visibleTrackKeys: [
        'circuit',
        'sunlitTemple',
        'moebiusStrip',
        'blueSector',
        'harborParkLoop',
        'jadeSpiralCircuit',
        'cedarRidgeCircuit',
        'sakuraWeave',
        'royalPlateau',
        'twinRise',
        'templeStraight',
        'harborPrincipality',
        'serpentCrossing',
        'ardennesRidge',
        'wingArena',
        'albertGardens',
        'caspianBoulevard'
    ],

    // Environment Colors
    offTrackColor: '#0f172a', // Deep Blue/Grey for runoff areas
    trackColor: '#334155',    // Lighter Slate for Asphalt

    // Style Colors
    curbRed: '#dc5a5a',
    curbWhite: '#f8fafc',
    carColor: '#dc2626',
    carAccent: '#facc15',
    tireColor: '#171717',

    skidColor: 'rgba(0, 0, 0, 0.4)',
    smokeColor: 'rgba(200,200,200,0.4)',
    sparkColor: '#fcd34d',

    finishLineColor: '#fff',
    finishLineDarkColor: '#020617',
    finishLineBorderColor: 'rgba(248, 250, 252, 0.45)',

    // Physics Constants
    fixedDt: 1 / 60,
    ...DEFAULT_PHYSICS_TUNING,
    wallScrapeReferenceImpactKph: 150,
    wallScrapeSpeedSeverityWeight: 0.8,
    wallScrapeDepthSeverityWeight: 0.2,
    wallScrapeMaxTangentialRetention: 0.85,
    wallScrapeMinTangentialRetention: 0.35,
    wallScrapeMinBounce: 0.05,
    wallScrapeMaxBounce: 0.15,
    wallImpactCooldownSec: 0.12,
    wallContactReleaseSec: 0.12,
    wallContactPadding: 0.001,
    resumeRelaunchDelay: 0.5, // Brief buffer before throttle resumes after unpausing
    crashRelaunchDelay: 0.5, // Brief buffer before throttle resumes after crash reset
    minLapTime: 2.0,

    // Oriented capsule collision body. Radius covers the car width; the axis
    // extends toward the nose and rear so visible body orientation matters.
    carRadius: 0.275,
    carCollisionHalfLength: 0.34,

    /** Grid units from car center to rear axle along heading — skid marks, route trail, run history. */
    carRearAxleOffset: 0.32,

    /** Soft shadow under the car sprite so it reads on asphalt-toned track surfaces. */
    carSpriteShadowColor: 'rgba(0, 0, 0, 0.75)',
    carSpriteShadowBlur: 2,
    carSpriteShadowOffsetX: 0,
    carSpriteShadowOffsetY: 0,

    /** Multiplier on `carSpriteDrawWidth` / `carSpriteDrawHeight` when painting the car (1 = full size). */
    carSpriteRenderScale: 1
};

// --- Geometry & Math Helpers ---
export const Point = (x, y) => ({ x, y });
const SEGMENT_EPSILON = 1e-9;

/** Shared line–segment intersection params; avoids allocating a Point on miss. */
function segmentIntersectionParams(A, B, C, D) {
    const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
    const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
    const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);

    if (bottom === 0) return null;
    const t = tTop / bottom;
    const u = uTop / bottom;
    if (
        t >= -SEGMENT_EPSILON
        && t <= 1 + SEGMENT_EPSILON
        && u >= -SEGMENT_EPSILON
        && u <= 1 + SEGMENT_EPSILON
    ) {
        return { t, u };
    }
    return null;
}

export function segmentsIntersect(A, B, C, D) {
    return segmentIntersectionParams(A, B, C, D) !== null;
}

export function getIntersection(A, B, C, D) {
    const params = segmentIntersectionParams(A, B, C, D);
    if (!params) return null;
    return {
        x: A.x + (B.x - A.x) * params.t,
        y: A.y + (B.y - A.y) * params.t
    };
}
