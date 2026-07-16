import { DEFAULT_PHYSICS_TUNING } from './car/handling.js';

// --- Mode Constants ---
export const TRACK_MODE_DAILY_GP = 'daily';

// --- Game Config ---
export const CONFIG = {
    gridSize: 40,

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
