import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCssBundle } from './helpers/read-css-bundle.js';

const manifestUrl = new URL('../styles.css', import.meta.url);
const manifest = readFileSync(manifestUrl, 'utf8');
const trackCarouselStyles = readFileSync(
    new URL('../styles/track-carousel.css', import.meta.url),
    'utf8',
);

const expectedImports = [
    './fonts.css',
    './styles/foundation.css',
            './styles/race-hud-and-medals.css',
            './styles/lobby-and-garage.css',
            './styles/lobby-modes.css',
            './styles/track-carousel.css',
            './styles/race-controls-and-feedback.css',
    './styles/modal-and-result-shell.css',
    './styles/settings-and-track-shells.css',
    './styles/modal-components-and-standings.css',
    './styles/responsive-layout.css',
    './styles/results.css',
    './styles/loading.css',
    './styles/result-details.css',
    './styles/tracks-and-small-screens.css',
    './styles/standings-and-sharing.css',
];

describe('game stylesheet architecture', () => {
    it('keeps the cascade manifest in its documented order', () => {
        const imports = Array.from(
            manifest.matchAll(/@import\s+url\(["']([^"']+)["']\);/g),
            match => match[1],
        );

        expect(imports).toEqual(expectedImports);
        expect(new Set(imports).size).toBe(imports.length);
    });

    it('resolves every local import into the complete game stylesheet', () => {
        const styles = readCssBundle(manifestUrl);

        expect(styles).toContain(':root {');
        expect(styles).toContain('#game-container {');
        expect(styles).toContain('#modal-combined-view .modal-card-section {');
        expect(styles).toContain('.result-share-panel {');
        expect(styles).not.toContain('@import');
    });

    /**
     * The bundle is concatenated, not parsed, so a stylesheet left with a
     * dangling block still reads fine here and only fails at build time.
     */
    it('closes every block in every stylesheet', () => {
        const styles = readCssBundle(manifestUrl);
        // Braces inside strings/urls would skew the count; none are used today.
        expect(styles).not.toMatch(/["'][^"'\n]*[{}][^"'\n]*["']/);

        let depth = 0;
        for (const character of styles) {
            if (character === '{') depth += 1;
            if (character === '}') depth -= 1;
            expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
    });

    it('defines the motion tokens every stylesheet transitions against', () => {
        const styles = readCssBundle(manifestUrl);

        for (const token of [
            '--dur-fast: 120ms;',
            '--dur-base: 160ms;',
            '--dur-slow: 200ms;',
            '--dur-race-start-exit: 100ms;',
            '--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);',
            '--ease-settle: cubic-bezier(0.22, 1, 0.36, 1);',
            '--ease-glide: cubic-bezier(0.16, 1, 0.3, 1);',
            '--ease-back: cubic-bezier(0.34, 1.56, 0.64, 1);',
        ]) {
            expect(styles).toContain(token);
        }
    });

    /**
     * The three duration tokens are the whole micro band, so a literal under
     * 200ms means a fourth timing has been typed in by hand and the band has
     * started drifting again. Longer values stay literal: those are deliberate
     * moments, not state changes, and each one owns its own number.
     */
    it('routes every sub-200ms duration through a token', () => {
        const styles = readCssBundle(manifestUrl);
        const strays = [];

        for (const [, value] of styles.matchAll(
            /\b(?:transition|animation)(?:-duration)?\s*:\s*([^;}]+)/g,
        )) {
            for (const segment of value.split(',')) {
                // First time in a segment is the duration; a second one is the
                // delay, which is free to be as short as it likes.
                const duration = segment.match(/(\d*\.?\d+)(ms|s)\b/);
                if (!duration) continue;
                const ms = Number(duration[1]) * (duration[2] === 's' ? 1000 : 1);
                if (ms <= 200) strays.push(segment.trim());
            }
        }

        expect(strays).toEqual([]);
    });

    it('turns the Daily and Campaign selector into a full-surface poster', () => {
        expect(trackCarouselStyles).toMatch(
            /body\[data-lobby-mode="daily"\] #start-overlay,[\s\S]*body\[data-lobby-mode="campaign"\] #start-overlay\s*\{[^}]*--start-overlay-pad-top:\s*0px;[^}]*--start-overlay-pad-bottom:\s*0px;[^}]*backdrop-filter:\s*none;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel\s*\{[^}]*--track-card-width:\s*min\(72vw,\s*36rem\);[^}]*width:\s*100vw;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*position:\s*absolute;[^}]*padding:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane \.track-carousel \.daily-playlist-hero-content,[\s\S]*#lobby-campaign-pane \.track-carousel \.daily-playlist-hero-content\s*\{[^}]*justify-content:\s*flex-start;/s,
        );
    });

    it('keeps the toolbar and Start Race above the full-surface selector', () => {
        expect(trackCarouselStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-header,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane \.lobby-primary-row--race,[\s\S]*#lobby-campaign-pane \.lobby-primary-row--race\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;[^}]*width:\s*min\(84vw,\s*30rem\);/s,
        );
    });

    it('eases the shared Daily and Campaign lobby away over the exact race-start duration', () => {
        expect(readCssBundle(manifestUrl)).toMatch(
            /#start-overlay\.is-ready\.is-race-start-exiting\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transition-duration:\s*var\(--dur-race-start-exit\);/s,
        );
    });

    it('keeps carousel medals square and shrinkable inside short Reddit viewports', () => {
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__medal\s*\{[^}]*flex:\s*0 1 1\.7rem;[^}]*min-height:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*1\.7rem;[^}]*max-height:\s*1\.7rem;[^}]*aspect-ratio:\s*1;/s,
        );
        expect(trackCarouselStyles.match(/\.track-carousel__medal\s*\{/g)).toHaveLength(1);
    });

    it('leaves the track drawing the whole plate to itself', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        // The medal ladder reads left to right under the plate; anything else in
        // the preview box takes width from the one drawing that names the track.
        expect(ui).toContain('preview.append(previewArt, previewLock)');
        expect(ui).toContain('head.append(eyebrow, medal)');
    });

});
