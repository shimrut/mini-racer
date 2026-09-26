import { describe, expect, it } from 'vitest';
import {
    createDailyChallengePresentationEvent,
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

    it('gives a dirt track its own look, earth banks and picture cache key', () => {
        const tarmac = resolveTrackPresentation('circuit');
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });

        expect(dirt.key).toBe('track:circuit:ground:dirt');
        expect(dirt.trackColor).not.toBe(tarmac.trackColor);
        expect(dirt.skidColor).not.toBe(tarmac.skidColor);
        expect(dirt.schematicRoadColor).not.toBe(tarmac.schematicRoadColor);
        // Banks of earth take the place of the kerbs. The series mark still
        // uses the dirt kerb colours.
        expect(dirt.showCurbs).toBe(false);
        expect(dirt.bankColor).toBeTruthy();
        expect(dirt.bankWidth).toBeGreaterThan(0);
        expect(tarmac.bankColor).toBeUndefined();
        expect(dirt.curbRed).not.toBe(tarmac.curbRed);
        // Bushes and trees take the place of the tyre stacks.
        expect(tarmac.showTireWalls).toBe(true);
        expect(dirt.showTireWalls).toBe(false);
        expect(dirt.tracksideItems.map(([name]) => name).sort()).toEqual(['bush', 'tree']);
        // A chalk finish line with a hay bale and a flag at each end.
        expect(dirt.finishLineStyle).toBe('painted');
        expect(dirt.finishMarker).toBe('hayBale');
        expect(tarmac.finishLineStyle).toBeUndefined();
        // A wall hit throws clods of the bank, and tarmac keeps its sparks.
        expect(dirt.scrapeDebris.color).toBe(dirt.bankColor);
        expect(tarmac.scrapeDebris).toBeUndefined();
        // A flat cloud of dust behind the wheels.
        expect(dirt.sprayStyle).toBe('dust');
        expect(dirt.curbWhite).not.toBe(tarmac.curbWhite);
        expect(dirt.speckleColors.length).toBeGreaterThan(0);
        expect(dirt.speckleAreaPerDot).toBeGreaterThan(0);
        expect(tarmac.speckleColors).toBeUndefined();
    });

    it('gives snow its own light road, snow banks, ice, spray and longer tyre tracks', () => {
        const tarmac = resolveTrackPresentation('circuit');
        const dirt = resolveTrackPresentation('circuit', { ground: 'dirt' });
        const snow = resolveTrackPresentation('circuit', { ground: 'snow' });

        expect(snow.key).toBe('track:circuit:ground:snow');
        expect(snow.trackColor).not.toBe(tarmac.trackColor);
        expect(snow.trackColor).not.toBe(dirt.trackColor);
        // Banks of snow take the place of the kerbs, and there are no specks.
        expect(snow.showCurbs).toBe(false);
        expect(snow.bankColor).toBeTruthy();
        expect(snow.bankWidth).toBeGreaterThan(0);
        expect(snow.speckleColors).toBeUndefined();
        expect(snow.icePatchColor).toBeTruthy();
        expect(snow.icePatchSpacing).toBeGreaterThan(0);
        expect(snow.bankColor).not.toBe(dirt.bankColor);
        // Pine trees, snowmen and igloos take the place of the tyre stacks.
        expect(snow.showTireWalls).toBe(false);
        expect(snow.tracksideItems.map(([name]) => name).sort()).toEqual(['igloo', 'pine', 'snowman']);
        // A finish line dyed in the snow with a block of ice and a flag at each end.
        expect(snow.finishLineStyle).toBe('painted');
        expect(snow.finishMarker).toBe('iceBlock');
        expect(snow.scrapeDebris.color).toBe(snow.bankColor);
        expect(dirt.icePatchColor).toBeUndefined();
        // The series mark still uses the snow kerb colours.
        expect(snow.curbRed).not.toBe(tarmac.curbRed);
        expect(snow.tyreTrackSeconds).toBeGreaterThan(3);
        // Lumps of snow, not the dirt dust.
        expect(snow.sprayColor).toBeTruthy();
        expect(snow.sprayStyle).not.toBe(dirt.sprayStyle);
    });

    it('gives grip a darker road, and keeps the tarmac kerbs', () => {
        const tarmac = resolveTrackPresentation('circuit');
        const grip = resolveTrackPresentation('circuit', { ground: 'grip' });

        expect(grip.key).toBe('track:circuit:ground:grip');
        expect(grip.trackColor).not.toBe(tarmac.trackColor);
        expect(grip.schematicRoadColor).not.toBe(tarmac.schematicRoadColor);
        expect(grip.curbRed).toBe(tarmac.curbRed);
    });

    it('keeps the default look for tarmac, a missing ground and an unknown ground', () => {
        const tarmac = resolveTrackPresentation('circuit');

        expect(resolveTrackPresentation('circuit', { ground: 'tarmac' })).toEqual(tarmac);
        expect(resolveTrackPresentation('circuit', { ground: 'lava' })).toEqual(tarmac);
        expect(tarmac.key).toBe('track:circuit:default');
    });

    it('lets an event look win over the ground look', () => {
        const presentation = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event: { key: 'daily-challenge', trackKey: 'kettleRun', skin: 'desert' },
            ground: 'dirt'
        });

        expect(presentation.key).toBe('event:daily-challenge:kettleRun:desert');
        expect(presentation.trackColor).toBe('#5b4127');
    });
});
