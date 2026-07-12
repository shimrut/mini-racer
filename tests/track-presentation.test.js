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
            skin: 'desert'
        });
        expect(presentation.key).toBe('event:daily-challenge:kettleRun:desert');

        global.window = originalWindow;
    });

    it('keeps the default skin for Kettle Run outside the daily challenge event context', () => {
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('lists only the supported daily challenge skins for Kettle Run', () => {
        expect(getAvailableDailyChallengeSkins('kettleRun')).toEqual([
            'default',
            'desert'
        ]);
    });

    it('uses the same base color for the infield and outer runoff on regular tracks', () => {
        const presentation = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.infieldColor).toBe(presentation.offTrackColor);
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

    it('activates the Kettle Run event skin for the daily challenge preview only on the matching track', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'desert'
        });
        const matchingPresentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event
        });
        const nonMatchingPresentation = resolveTrackPresentation('cedarRidgeCircuit', {
            surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            event
        });

        expect(matchingPresentation.key).toBe('event:daily-challenge:kettleRun:desert');
        expect(nonMatchingPresentation.key).toBe('track:cedarRidgeCircuit:default');
    });

    it('ignores unknown daily challenge skin names for Kettle Run', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'unknown'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event
        });

        expect(event).toEqual({
            key: 'daily-challenge',
            trackKey: 'kettleRun',
            skin: 'unknown'
        });
        expect(presentation.key).toBe('track:kettleRun:default');
    });

    it('does not leak the daily event skin into the normal track picker preview', () => {
        const event = createDailyChallengePresentationEvent({
            trackKey: 'kettleRun',
            skin: 'desert'
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
            skin: 'desert'
        });
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.SHARE,
            event
        });

        expect(presentation.key).toBe('track:kettleRun:default');
    });
});
