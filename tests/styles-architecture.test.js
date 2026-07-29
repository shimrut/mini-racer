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

    it('keeps playlist card shadows out of the carousel rail', () => {
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*box-shadow:\s*none;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero:not\(\.is-carousel-selected\):hover\s*\{[^}]*box-shadow:\s*none;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\.is-carousel-selected:hover\s*\{[^}]*box-shadow:\s*none;/s,
        );
    });

    it('keeps carousel medals square and shrinkable inside short Reddit viewports', () => {
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__medal\s*\{[^}]*flex:\s*0 1 4rem;[^}]*min-height:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*4rem;[^}]*max-height:\s*4rem;[^}]*aspect-ratio:\s*1;/s,
        );
        expect(trackCarouselStyles.match(/\.track-carousel__medal\s*\{/g)).toHaveLength(1);
    });

});
