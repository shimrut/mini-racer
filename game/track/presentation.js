import { CONFIG } from '../config.js?v=1.91';

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
    tireWallTreadColor: 'rgba(248, 250, 252, 0.1)'
});

const TRACK_BASE_PRESENTATIONS = Object.freeze({});

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
            // Ignore malformed overrides and fall back to the first configured skin.
        }
    }

    const configuredSkins = EVENT_TRACK_PRESENTATION_OVERRIDES['daily-challenge']?.[trackKey];
    if (!configuredSkins) return 'default';
    const firstSkinKey = Object.keys(configuredSkins)[0];
    return firstSkinKey || 'default';
}

export function getAvailableDailyChallengeSkins(trackKey) {
    const configuredSkins = EVENT_TRACK_PRESENTATION_OVERRIDES['daily-challenge']?.[trackKey];
    return ['default', ...Object.keys(configuredSkins || {})];
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
    event = null
} = {}) {
    const baseOverride = trackKey ? TRACK_BASE_PRESENTATIONS[trackKey] : null;
    const basePresentation = {
        ...DEFAULT_TRACK_PRESENTATION,
        ...(baseOverride || {}),
        key: baseOverride?.key || getDefaultPresentationKey(trackKey || 'default')
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
