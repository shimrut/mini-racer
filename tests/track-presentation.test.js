import { describe, expect, it } from 'vitest';
import {
    createDailyChallengePresentationEvent,
    getAvailableDailyChallengeSkins,
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES
} from '../game/track/presentation.js';
import {
    BIOME_CONFIGS,
    BIOME_NAMES,
    getBiomeConfig,
    getBiomePresentation,
    isBiomePainted
} from '../game/track/biomes.js';

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

        expect(presentation.key).toBe('track:kettleRun:biome:city');
    });

    it('lists only the supported daily challenge skins for Kettle Run', () => {
        expect(getAvailableDailyChallengeSkins('kettleRun')).toEqual([
            'default',
            'desert'
        ]);
    });

    it('uses the reference ground treatment for a non-Basalt catalog biome', () => {
        const presentation = resolveTrackPresentation('sunlitTemple', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.key).toBe('track:sunlitTemple:biome:forest');
        expect(presentation.backgroundStyle).toBe('biome');
        expect(presentation.infieldColor).toBe('transparent');
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
        expect(resolveTrackPresentation('kettleRun').key).toBe('track:kettleRun:biome:city');
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
        expect(presentation.key).toBe('track:kettleRun:biome:city');
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
        expect(presentation.key).toBe('track:kettleRun:biome:city');
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

describe('track presentation biomes', () => {
    it('paints the biome background on the track it is set on', () => {
        const presentation = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(presentation.key).toBe('track:circuit:biome:basalt');
        expect(presentation.backgroundStyle).toBe('biome');
        // The ground runs under the track, so the infield must not cover it.
        expect(presentation.infieldColor).toBe('transparent');
        expect(presentation.biomeConfig).toBe(BIOME_CONFIGS.mountains);
        expect(presentation.biomeGround).toBe('#080e1b');
        expect(presentation.biomeTerrainColors).toEqual([
            '#10192b',
            '#151f32',
            '#1b273d',
            '#222f46'
        ]);
    });

    it('leaves the track surface, curbs and finish line alone', () => {
        const biomeTrack = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });
        const flatTrack = resolveTrackPresentation('sunlitTemple', {
            surface: TRACK_PRESENTATION_SURFACES.RACE
        });

        expect(biomeTrack.trackColor).toBe(flatTrack.trackColor);
        expect(biomeTrack.curbRed).toBe(flatTrack.curbRed);
        expect(biomeTrack.curbWhite).toBe(flatTrack.curbWhite);
        expect(biomeTrack.showCurbs).toBe(true);
    });

    it('paints every known biome during a race', () => {
        BIOME_NAMES.forEach((biome) => {
            const presentation = resolveTrackPresentation('sunlitTemple', {
                surface: TRACK_PRESENTATION_SURFACES.RACE,
                biome
            });

            expect(isBiomePainted(biome)).toBe(true);
            expect(presentation.key).toBe(`track:sunlitTemple:biome:${biome}`);
            expect(presentation.backgroundStyle).toBe('biome');
            expect(presentation.biomeConfig).toBe(getBiomeConfig(biome));
            expect(presentation.biomeGround).toBe(getBiomeConfig(biome).groundColors[0]);
        });
    });

    it('keeps the stored biome order append-only while adding Mountains and Arctic', () => {
        expect(BIOME_NAMES).toEqual([
            'beach',
            'forest',
            'canyon',
            'basalt',
            'marsh',
            'city',
            'mountains',
            'arctic'
        ]);
    });

    it('defines the requested renderer inputs for every canonical biome', () => {
        Object.values(BIOME_CONFIGS).forEach((config) => {
            expect(config.groundColors.length).toBeGreaterThanOrEqual(3);
            expect(config.groundColors.length).toBeLessThanOrEqual(5);
            expect(config.runoffColor).toMatch(/^#/);
            expect(config.transitionColor).toMatch(/^#/);
            expect(config.contourCount).toBeGreaterThan(0);
            expect(config.contourScale).toBeGreaterThan(0);
            expect(config.propDensity).toBeGreaterThanOrEqual(0);
            expect(config.clustering).toBeGreaterThanOrEqual(0);
            expect(config.terrainStyle).toBeTruthy();
            expect(config.features.length).toBeGreaterThan(0);
            expect(config.props.length).toBeGreaterThan(0);
            expect(config.runoffWidth - config.runoffVariation + config.transitionWidth)
                .toBeGreaterThanOrEqual(60);
            expect(config.runoffWidth + config.runoffVariation + config.transitionWidth)
                .toBeLessThanOrEqual(100);
            const presentation = getBiomePresentation(config.id);
            expect(presentation.trackShadowBlur).toBeLessThanOrEqual(8);
            expect(presentation.trackShadowOffsetY).toBeLessThanOrEqual(2);
        });
    });

    it('declares the requested terrain features and props per biome', () => {
        expect(BIOME_CONFIGS.forest.props.map(({ type }) => type)).toEqual([
            'pine',
            'rock',
            'shrub'
        ]);
        expect(BIOME_CONFIGS.mountains.props.map(({ type }) => type)).toEqual([
            'rock-formation',
            'boulder',
            'pine'
        ]);
        expect(BIOME_CONFIGS.arctic.features.map(({ type }) => type)).toEqual([
            'snow-drifts',
            'frozen-ponds',
            'ice-cracks'
        ]);
        expect(BIOME_CONFIGS.arctic.props.map(({ type }) => type)).toContain('snowy-rock');
        expect(BIOME_CONFIGS.beach.features.map(({ type }) => type)).toEqual([
            'dunes',
            'shoreline',
            'water'
        ]);
        expect(BIOME_CONFIGS.beach.props.map(({ type }) => type)).toEqual([
            'rock',
            'pebble'
        ]);
    });

    it('maps legacy stored biome names to suitable canonical configs', () => {
        expect(getBiomeConfig('canyon')).toBe(BIOME_CONFIGS.mountains);
        expect(getBiomeConfig('basalt')).toBe(BIOME_CONFIGS.mountains);
        expect(getBiomeConfig('marsh')).toBe(BIOME_CONFIGS.forest);
        expect(getBiomeConfig('city')).toBe(BIOME_CONFIGS.mountains);
        expect(getBiomeConfig('unknown')).toBeNull();
    });

    it('keeps every non-race surface schematic for every biome', () => {
        const surfaces = [
            TRACK_PRESENTATION_SURFACES.TRACK_PICKER,
            TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            TRACK_PRESENTATION_SURFACES.SHARE
        ];

        BIOME_NAMES.forEach((biome) => {
            surfaces.forEach((surface) => {
                const presentation = resolveTrackPresentation('sunlitTemple', {
                    surface,
                    biome
                });

                expect(presentation.key).toBe('track:sunlitTemple:default');
                expect(presentation.backgroundStyle).toBe('flat');
            });
        });
    });

    it('lets a caller preview a biome the track has not been saved with', () => {
        const presentation = resolveTrackPresentation('sunlitTemple', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            biome: 'basalt'
        });

        expect(presentation.key).toBe('track:sunlitTemple:biome:basalt');
        expect(presentation.backgroundStyle).toBe('biome');
    });

    it('falls back to the plain background for a biome it does not know', () => {
        const presentation = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            biome: 'swamplands'
        });

        expect(presentation.key).toBe('track:circuit:default');
        expect(presentation.backgroundStyle).toBe('flat');
    });

    it('lets an event skin win over the biome underneath it', () => {
        const presentation = resolveTrackPresentation('circuit', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event: { key: 'daily-challenge', trackKey: 'circuit', skin: 'desert' },
            biome: 'basalt'
        });

        // Classic Circuit has no desert skin, so the biome still stands.
        expect(presentation.key).toBe('track:circuit:biome:basalt');

        const skinned = resolveTrackPresentation('kettleRun', {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            event: { key: 'daily-challenge', trackKey: 'kettleRun', skin: 'desert' },
            biome: 'basalt'
        });

        expect(skinned.key).toBe('event:daily-challenge:kettleRun:desert');
        expect(skinned.backgroundStyle).toBe('desert');
        expect(skinned.biomeConfig).toBe(getBiomeConfig('city'));
    });
});
