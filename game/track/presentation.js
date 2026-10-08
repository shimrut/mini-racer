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
    // Dirt: earth banks in place of kerbs, bushes and trees in place of tyres; kerb colours mark the series.
    dirt: Object.freeze({
        trackColor: '#634833',
        patchColors: Object.freeze(['rgba(146, 112, 78, 0.1)', 'rgba(60, 42, 28, 0.14)']),
        patchAreaPerDot: 1400,
        speckleColors: Object.freeze(['#735a43', '#4f3a29', '#86694e']),
        speckleAreaPerDot: 200,
        showCurbs: false,
        bankColor: '#9c7b56',
        bankShadeColor: '#4a3422',
        bankLightColor: '#c2a077',
        // A sharp dark wall line and an even earth lip, so the road edge is clear.
        bankFootLineColor: 'rgba(38, 22, 10, 0.62)',
        bankFootLineWidth: 6,
        bankLipMaxRadius: 3,
        bankWidth: 18,
        showTireWalls: false,
        tracksideItems: Object.freeze([['bush', 3], ['tree', 2]]),
        // A finish line of chalk squares, with a hay bale and a flag at each end.
        finishLineStyle: 'painted',
        finishLineColor: 'rgba(241, 228, 204, 0.92)',
        finishLineAltColor: 'rgba(36, 22, 10, 0.45)',
        finishLineWidth: 14,
        finishMarker: 'hayBale',
        // A wall hit throws clods of the earth bank in place of sparks.
        scrapeDebris: Object.freeze({ color: '#9c7b56', shade: '#4a3422', light: '#c2a077' }),
        outerStrokeColor: '#f1e4cc',
        innerStrokeColor: '#d8c3a0',
        curbRed: '#b07a4c',
        curbWhite: '#f1e4cc',
        // A slide scrapes a wide smear of dark earth.
        skidColor: 'rgba(36, 20, 8, 0.4)',
        skidWidthScale: 1.5,
        // Shaded ruts under the rear tires, as wide as a Rally car tire.
        tyreTrackColor: 'rgba(40, 24, 12, 0.34)',
        tyreTrackShadeColor: 'rgba(24, 12, 4, 0.34)',
        markHalfWidth: 0.29,
        tyreTrackWidth: 6,
        tyreTrackIsTireWidth: true,
        // A flat cloud of dust behind the wheels, in one colour.
        sprayStyle: 'dust',
        sprayColor: '#b39570',
        carShadowColor: 'rgba(24, 14, 6, 0.55)',
        carShadowBlur: 6,
        carShadowOffsetX: 2,
        carShadowOffsetY: 3,
        schematicRoadColor: '#7a5c42',
        schematicEdgeColor: '#f1e4cc'
    }),
    // Snow: smooth road with ice, snow banks, and pines, snowmen and igloos; kerb colours mark the series.
    snow: Object.freeze({
        trackColor: '#b8c8d7',
        icePatchColor: 'rgba(190, 222, 246, 0.5)',
        icePatchGlintColor: '#ffffff',
        icePatchSpacing: 150,
        showCurbs: false,
        bankColor: '#e2ebf3',
        bankShadeColor: '#9db2c7',
        bankLightColor: '#fbfdff',
        bankShadowColor: 'rgba(84, 110, 140, 0.16)',
        bankWidth: 20,
        showTireWalls: false,
        tracksideItems: Object.freeze([['pine', 3], ['snowman', 1], ['igloo', 1]]),
        // A blue-dyed finish line with an ice block and flag at each end.
        finishLineStyle: 'painted',
        finishLineColor: '#2d5b8c',
        finishLineAltColor: '#eef4f9',
        finishLineWidth: 14,
        finishMarker: 'iceBlock',
        // A wall hit throws lumps of the snow bank in place of sparks.
        scrapeDebris: Object.freeze({ color: '#e2ebf3', shade: '#9db2c7', light: '#fbfdff' }),
        outerStrokeColor: '#f8fafc',
        innerStrokeColor: '#cfe0ee',
        curbRed: '#6fa8d6',
        curbWhite: '#f8fafc',
        // A slide scrapes a wide, soft smear.
        skidColor: 'rgba(92, 122, 156, 0.26)',
        skidWidthScale: 1.8,
        // Shaded grooves under the rear tires, as wide as a Snow car tire.
        tyreTrackColor: 'rgba(98, 126, 160, 0.34)',
        tyreTrackShadeColor: 'rgba(70, 98, 132, 0.3)',
        tyreTrackSeconds: 5,
        markHalfWidth: 0.29,
        tyreTrackWidth: 6,
        tyreTrackIsTireWidth: true,
        // Flat lumps of snow thrown from all four wheels, in one colour.
        sprayStyle: 'snow',
        sprayColor: '#eef4f9',
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
    }),
    // Water: blue channel, sand banks with foam, and palms, rocks and umbrellas; kerb colours mark the series.
    water: Object.freeze({
        trackColor: '#1f6fae',
        edgeBandColor: 'rgba(88, 196, 214, 0.3)',
        edgeBandWidth: 14,
        waveColor: 'rgba(214, 240, 255, 0.55)',
        waveAreaPerMark: 1100,
        showCurbs: false,
        bankColor: '#e6d3a3',
        bankShadeColor: '#b89d64',
        bankLightColor: '#f7eed3',
        bankWidth: 18,
        // A line of foam where the water meets the sand.
        bankLipColor: '#eef8ff',
        bankLipShadeColor: '#9ccbe8',
        showTireWalls: false,
        tracksideItems: Object.freeze([['palm', 3], ['rock', 2], ['umbrella', 1]]),
        outerStrokeColor: '#f7eed3',
        innerStrokeColor: '#e6d3a3',
        curbRed: '#2a8fd0',
        curbWhite: '#f7eed3',
        // A slide leaves a wide smear of white foam.
        skidColor: 'rgba(236, 248, 255, 0.4)',
        skidWidthScale: 1.6,
        // The wake: two lines of foam that open out behind the jet ski.
        tyreTrackColor: 'rgba(232, 246, 255, 0.6)',
        tyreTrackSeconds: 1.6,
        tyreTrackWidth: 3.5,
        tyreTrackSpread: 0.6,
        // Splashes of water thrown from the hull, in foam colours.
        sprayColor: '#e8f5ff',
        sprayShadeColor: '#8cc4e6',
        sprayLightColor: '#ffffff',
        carShadowColor: 'rgba(6, 36, 66, 0.35)',
        carShadowBlur: 3,
        carShadowOffsetX: 1.5,
        carShadowOffsetY: 2.5,
        schematicRoadColor: '#2a78b5',
        schematicEdgeColor: '#f7eed3'
    }),
    // Space: violet lane with a grid, light strips for kerbs, stars, and asteroids, planets and satellites.
    space: Object.freeze({
        trackColor: '#241d4f',
        infieldColor: 'transparent',
        backgroundStyle: 'space',
        starColors: Object.freeze(['#ffffff', '#c7d2fe', '#fde68a']),
        gridColor: 'rgba(132, 116, 240, 0.3)',
        gridSpacing: 48,
        showTireWalls: false,
        tracksideItems: Object.freeze([['asteroid', 3], ['planet', 1], ['satellite', 1]]),
        outerStrokeColor: '#3de8ff',
        innerStrokeColor: '#ff4fd8',
        curbRed: '#ff4fd8',
        curbWhite: '#3de8ff',
        skidColor: 'rgba(61, 232, 255, 0.3)',
        skidWidthScale: 1.4,
        // Two short trails behind the engines.
        tyreTrackColor: 'rgba(61, 232, 255, 0.5)',
        tyreTrackSeconds: 1,
        tyreTrackWidth: 3,
        // The ship floats above the lane, so its shadow falls far from it.
        carShadowColor: 'rgba(0, 0, 0, 0.5)',
        carShadowBlur: 6,
        carShadowOffsetX: 7,
        carShadowOffsetY: 10,
        schematicRoadColor: '#2c2560',
        schematicEdgeColor: '#3de8ff'
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
