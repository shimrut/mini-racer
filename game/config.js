import { DEFAULT_PHYSICS_TUNING } from './car/handling.js';

export const TRACK_MODE_DAILY_GP = 'daily';

export const CONFIG = {
    gridSize: 40,

    offTrackColor: '#0f172a',
    trackColor: '#334155',

    curbRed: '#dc5a5a',
    curbWhite: '#f8fafc',
    carColor: '#dc2626',
    carAccent: '#facc15',
    tireColor: '#171717',

    skidColor: 'rgba(0, 0, 0, 0.4)',
    sparkColor: '#fcd34d',

    finishLineColor: '#fff',
    finishLineDarkColor: '#020617',

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
    resumeRelaunchDelay: 0.5,

    // Capsule body: radius covers the width, the axis runs nose to rear so orientation matters.
    carRadius: 0.275,
    carCollisionHalfLength: 0.34,

    carRearAxleOffset: 0.32,

    carSpriteShadowColor: 'rgba(0, 0, 0, 0.75)',
    carSpriteShadowBlur: 2,
    carSpriteShadowOffsetX: 0,
    carSpriteShadowOffsetY: 0,

    carSpriteRenderScale: 1
};
