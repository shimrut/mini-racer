import { describe, expect, it } from 'vitest';
import {
    createDailyChallengePresentationEvent,
    getAvailableDailyChallengeSkins,
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES
} from '../game/track/presentation.js';

describe('track presentation resolver', () => {
    it('supports a local query override so event skins can be tested without changing server rotation', () => {
        const originalWindow = global.window;
        global.window = {
            location: {
                search: '?eventSkinTrack=kettleRun'
            }
        };

        const event = createDailyChallengePresentationEvent({ trackKey: 'circuit' });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(event).toEqual({
            key: 'daily-challenge',
            trackKey: 'kettleRun',
            skin: 'space'
        });
        expect(presentation.key).toBe('event:daily-challenge:kettleRun:space');

        global.window = originalWindow;
    });

    it('keeps the default skin for Kettle Run outside the daily challenge event context', () => {
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('lists desert as an extra daily challenge skin for Kettle Run', () => {
        expect(getAvailableDailyChallengeSkins('kettleRun')).toEqual([
            'default',
            'space',
            'desert',
            'meadow',
            'forest',
            'prairie',
            'hills'
        ]);
    });

    it('uses the same base color for the infield and outer runoff on regular tracks', () => {
        const presentation = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.infieldColor).toBe(presentation.offTrackColor);
    });

    it('activates the Kettle Run event skin for race rendering during its daily challenge', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'space'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(presentation.key).toBe('event:daily-challenge:kettleRun:space');
        expect(presentation.offTrackColor).not.toBe(resolveTrackPresentation('kettleRun').offTrackColor);
        expect(presentation.offTrackColor).toBe('#01030a');
        expect(presentation.curbRed).toBe('#c64545');
        expect(presentation.curbWhite).toBe('#8fd3ff');
        expect(presentation.backgroundStyle).toBe('space');
        expect(presentation.trackStyle).toBe('rails');
        expect(presentation.showCurbs).toBe(false);
        expect(presentation.showTireWalls).toBe(false);
        expect(presentation.trackColor).toBe('transparent');
        expect(presentation.infieldColor).toBe('transparent');
        expect(presentation.innerStrokeColor).toBe(presentation.outerStrokeColor);
        expect(presentation.debrisStyle).toBe('outer-drift');
        expect(presentation.debrisColor).toBe('rgba(191, 219, 254, 0.7)');
        expect(presentation.debrisAccentColor).toBe('rgba(125, 211, 252, 0.18)');
        expect(presentation.debrisMinRadius).toBe(4);
        expect(presentation.debrisMaxRadius).toBe(11);
        expect(presentation.debrisStrokeWidth).toBe(0.9);
        expect(presentation.debrisSidesMin).toBe(3);
        expect(presentation.debrisSidesMax).toBe(4);
        expect(presentation.debrisStretchMin).toBe(1.45);
        expect(presentation.debrisStretchMax).toBe(2.35);
        expect(presentation.debrisFillProbability).toBe(0.32);
        expect(presentation.railBandColor).toBe('rgba(96, 165, 250, 0.1)');
        expect(presentation.railBandWidth).toBe(14);
        expect(presentation.railMidColor).toBe('rgba(147, 197, 253, 0.16)');
        expect(presentation.railMidWidth).toBe(8);
        expect(presentation.railCoreWidth).toBe(2);
        expect(Array.isArray(presentation.railVaporLayers)).toBe(true);
        expect(presentation.railVaporLayers).toHaveLength(3);
        expect(presentation.railVaporLayers[0]).toMatchObject({
            width: 64,
            blur: 34
        });
        expect(presentation.railCoreColor).toBe('rgba(224, 242, 254, 0.58)');
        expect(presentation.finishLineStyle).toBe('neon-gate');
        expect(presentation.backgroundParallaxFactor).toBeLessThan(1);
        expect(presentation.finishLineColor).toBe('#e0f2fe');
        expect(presentation.finishLineAltColor).toBe('rgba(125, 211, 252, 0.92)');
        expect(presentation.finishLineGlowColor).toBe('rgba(56, 189, 248, 0.32)');
        expect(presentation.finishLineBeaconColor).toBe('rgba(224, 242, 254, 0.9)');
    });

    it('activates the Kettle Run event skin for the daily challenge preview only on the matching track', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'space'
        });
        const matchingPresentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event
        });
        const nonMatchingPresentation = resolveTrackPresentation('cedarRidgeCircuit', {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event
        });

        expect(matchingPresentation.key).toBe('event:daily-challenge:kettleRun:space');
        expect(nonMatchingPresentation.key).toBe('track:cedarRidgeCircuit:default');
    });

    it('activates the desert event skin for Kettle Run without changing the base track', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'desert'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(presentation.key).toBe('event:daily-challenge:kettleRun:desert');
        expect(presentation.backgroundStyle).toBe('desert');
        expect(presentation.trackStyle).toBe('canyon');
        expect(presentation.offTrackColor).toBe('#8d6a3b');
        expect(presentation.trackColor).toBe('#5b4127');
        expect(presentation.infieldColor).toBe('transparent');
        expect(presentation.outerStrokeColor).toBe('#d7b07a');
        expect(presentation.innerStrokeColor).toBe('#6f4a2b');
        expect(presentation.showCurbs).toBe(false);
        expect(presentation.showTireWalls).toBe(false);
        expect(presentation.debrisStyle).toBe('outer-drift');
        expect(presentation.debrisColor).toBe('rgba(84, 54, 26, 0.72)');
        expect(presentation.debrisAccentColor).toBe('rgba(156, 113, 67, 0.24)');
        expect(presentation.debrisMinRadius).toBe(6);
        expect(presentation.debrisMaxRadius).toBe(15);
        expect(presentation.debrisStrokeWidth).toBe(1.4);
        expect(presentation.debrisSidesMin).toBe(6);
        expect(presentation.debrisSidesMax).toBe(8);
        expect(presentation.debrisStretchMin).toBe(1);
        expect(presentation.debrisStretchMax).toBe(1.35);
        expect(presentation.debrisFillProbability).toBe(0.72);
        expect(presentation.finishLineColor).toBe('#f6e7c5');
        expect(presentation.finishLineAltColor).toBe('#5b4127');
        expect(resolveTrackPresentation('kettleRun').key).toBe('track:kettleRun:default');
    });

    it('ignores unknown daily challenge skin names for Kettle Run', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'rails-v5'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(event).toEqual({
            key: 'daily-challenge',
            trackKey: 'kettleRun',
            skin: 'rails-v5'
        });
        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('does not leak the daily event skin into the normal track picker preview', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'space'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.TRACK_PICKER,
            event
        });

        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('keeps the default presentation when the selected daily skin is default', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'default'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(event).toEqual({
            key: 'daily-challenge',
            trackKey: 'kettleRun',
            skin: 'default'
        });
        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('does not leak the daily event skin into generic share rendering', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'space'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.SHARE,
            event
        });

        expect(presentation.key).toBe('track:kettleRun:default');
    });
});
