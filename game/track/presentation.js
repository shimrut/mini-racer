import { CONFIG } from '../config.js';
import { isTrackGroundKey } from './grounds.js';

export const TRACK_PRESENTATION_SURFACES = Object.freeze({
    RACE: 'race',
    DAILY_CHALLENGE_PREVIEW: 'daily-challenge-preview',
    TRACK_PICKER: 'track-picker',
    SHARE: 'share'
});

const DEFAULT_TRACK_PRESENTATION = Object.freeze({
    offTrackColor: CONFIG.offTrackColor,
    trackColor: CONFIG.trackColor,
    infieldColor: CONFIG.offTrackColor,
    outerStrokeColor: '#f8fafc',
    innerStrokeColor: '#cbd5e1',
    backgroundStyle: 'flat',
    trackStyle: 'track',
    showCurbs: true,
    showTireWalls: true,
    curbRed: CONFIG.curbRed,
    curbWhite: CONFIG.curbWhite,
    tireWallColor: '#111827',
    tireWallInnerStrokeColor: 'rgba(248, 250, 252, 0.14)',
    tireWallCoreColor: '#020617',
    tireWallTreadColor: 'rgba(248, 250, 252, 0.1)',
    skidColor: CONFIG.skidColor,
    schematicRoadColor: '#475569',
    schematicEdgeColor: '#f8fafc'
});

// The look of each non-tarmac ground. An event look still wins over it.
const GROUND_TRACK_PRESENTATIONS = Object.freeze({
    dirt: Object.freeze({
        trackColor: '#634833',
        patchColors: Object.freeze(['rgba(146, 112, 78, 0.1)', 'rgba(60, 42, 28, 0.14)']),
        patchAreaPerDot: 1400,
        edgeBandColor: 'rgba(150, 118, 84, 0.2)',
        edgeBandWidth: 16,
        speckleColors: Object.freeze(['#735a43', '#4f3a29', '#86694e']),
        speckleAreaPerDot: 200,
        outerStrokeColor: '#f1e4cc',
        innerStrokeColor: '#d8c3a0',
        curbRed: '#b07a4c',
        curbWhite: '#f1e4cc',
        skidColor: 'rgba(30, 16, 6, 0.62)',
        skidEdgeColor: 'rgba(168, 134, 96, 0.5)',
        skidEdgeWidth: 1.5,
        tyreTrackColor: 'rgba(40, 26, 14, 0.32)',
        dustColor: 'rgba(222, 192, 150, 0.75)',
        carShadowColor: 'rgba(24, 14, 6, 0.55)',
        carShadowBlur: 6,
        carShadowOffsetX: 2,
        carShadowOffsetY: 3,
        schematicRoadColor: '#7a5c42',
        schematicEdgeColor: '#f1e4cc'
    }),
    snow: Object.freeze({
        trackColor: '#a9bbcc',
        speckleColors: Object.freeze(['#c4d3e1', '#94a8bc']),
        speckleAreaPerDot: 320,
        outerStrokeColor: '#f8fafc',
        innerStrokeColor: '#cfe0ee',
        curbRed: '#6fa8d6',
        curbWhite: '#f8fafc',
        skidColor: 'rgba(70, 92, 118, 0.42)',
        tyreTrackColor: 'rgba(66, 88, 116, 0.55)',
        tyreTrackEdgeColor: 'rgba(236, 243, 250, 0.7)',
        tyreTrackEdgeWidth: 1.5,
        tyreTrackSeconds: 5,
        tyreTrackWidth: 5,
        dustColor: '#f8fbff',
        dustEdgeColor: 'rgba(96, 120, 148, 0.55)',
        dustSizeScale: 1.3,
        carShadowColor: 'rgba(28, 42, 62, 0.3)',
        carShadowBlur: 4,
        carShadowOffsetX: 1,
        carShadowOffsetY: 2,
        schematicRoadColor: '#b7c7d6',
        schematicEdgeColor: '#f8fafc'
    }),
    // Race asphalt: a little darker than tarmac.
    grip: Object.freeze({
        trackColor: '#2d3644',
        schematicRoadColor: '#3b4554'
    })
});

const EVENT_TRACK_PRESENTATION_OVERRIDES = Object.freeze({
    'daily-challenge': Object.freeze({
        kettleRun: Object.freeze({
            desert: Object.freeze({
                key: 'event:daily-challenge:kettleRun:desert',
                surfaces: Object.freeze([
                    TRACK_PRESENTATION_SURFACES.RACE,
                    TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW
                ]),
                offTrackColor: '#8d6a3b',
                trackColor: '#5b4127',
                infieldColor: 'transparent',
                outerStrokeColor: '#d7b07a',
                innerStrokeColor: '#6f4a2b',
                backgroundStyle: 'desert',
                trackStyle: 'canyon',
                showCurbs: false,
                showTireWalls: false,
                canyonWallShadowColor: 'rgba(0, 34, 18, 0.28)',
                canyonWallShadowWidth: 0,
                canyonWallHighlightColor: 'rgba(245, 221, 182, 0.4)',
                canyonWallHighlightWidth: 7,
                canyonWallCoreColor: '#6f4a2b',
                canyonWallCoreWidth: 3,
                debrisStyle: 'outer-drift',
                debrisColor: 'rgba(84, 54, 26, 0.72)',
                debrisAccentColor: 'rgba(156, 113, 67, 0.24)',
                debrisMinRadius: 6,
                debrisMaxRadius: 15,
                debrisStrokeWidth: 1.4,
                debrisSidesMin: 6,
                debrisSidesMax: 8,
                debrisStretchMin: 1,
                debrisStretchMax: 1.35,
                debrisFillProbability: 0.72,
                finishLineColor: '#f6e7c5',
                finishLineAltColor: '#5b4127'
            })
        })
    })
});

function getDefaultPresentationKey(trackKey) {
    return `track:${trackKey}:default`;
}

function getForcedPresentationEventTrackKey() {
    if (typeof window === 'undefined' || !window.location?.search) return null;

    try {
        const params = new URLSearchParams(window.location.search);
        const forcedTrackKey = params.get('eventSkinTrack');
        return typeof forcedTrackKey === 'string' && forcedTrackKey.trim()
            ? forcedTrackKey.trim()
            : null;
    } catch (error) {
        return null;
    }
}

function getForcedPresentationEventSkin(trackKey) {
    if (typeof window !== 'undefined' && window.location?.search) {
        try {
            const params = new URLSearchParams(window.location.search);
            const forcedSkin = params.get('eventSkin');
            if (typeof forcedSkin === 'string' && forcedSkin.trim()) {
                return forcedSkin.trim();
            }
        } catch (error) {
        }
    }

    const configuredSkins = EVENT_TRACK_PRESENTATION_OVERRIDES['daily-challenge']?.[trackKey];
    if (!configuredSkins) return 'default';
    const firstSkinKey = Object.keys(configuredSkins)[0];
    return firstSkinKey || 'default';
}

export function createDailyChallengePresentationEvent(challenge) {
    const forcedTrackKey = getForcedPresentationEventTrackKey();
    if (forcedTrackKey) {
        return {
            key: 'daily-challenge',
            trackKey: forcedTrackKey,
            skin: getForcedPresentationEventSkin(forcedTrackKey)
        };
    }

    if (typeof challenge?.trackKey !== 'string' || !challenge.trackKey) return null;
    return {
        key: 'daily-challenge',
        trackKey: challenge.trackKey,
        skin: typeof challenge?.skin === 'string' && challenge.skin.trim()
            ? challenge.skin.trim()
            : 'default'
    };
}

export function resolveTrackPresentation(trackKey, {
    surface = TRACK_PRESENTATION_SURFACES.RACE,
    event = null,
    ground = null
} = {}) {
    const groundPresentation = isTrackGroundKey(ground)
        ? GROUND_TRACK_PRESENTATIONS[ground]
        : null;
    const basePresentation = groundPresentation
        ? {
            ...DEFAULT_TRACK_PRESENTATION,
            ...groundPresentation,
            key: `track:${trackKey || 'default'}:ground:${ground}`
        }
        : {
            ...DEFAULT_TRACK_PRESENTATION,
            key: getDefaultPresentationKey(trackKey || 'default')
        };

    if (!trackKey || !event || event.trackKey !== trackKey) {
        return basePresentation;
    }

    const eventPresentation = EVENT_TRACK_PRESENTATION_OVERRIDES[event.key]?.[trackKey]?.[event.skin];
    if (!eventPresentation) return basePresentation;
    if (Array.isArray(eventPresentation.surfaces) && !eventPresentation.surfaces.includes(surface)) {
        return basePresentation;
    }

    return {
        ...basePresentation,
        ...eventPresentation
    };
}
