import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCssBundle } from './helpers/read-css-bundle.js';

const manifestUrl = new URL('../styles.css', import.meta.url);
const manifest = readFileSync(manifestUrl, 'utf8');
const trackCarouselStyles = readFileSync(
    new URL('../styles/track-carousel.css', import.meta.url),
    'utf8',
);
const foundationStyles = readFileSync(
    new URL('../styles/foundation.css', import.meta.url),
    'utf8',
);
const raceControlStyles = readFileSync(
    new URL('../styles/race-controls-and-feedback.css', import.meta.url),
    'utf8',
);
const lobbyModeStyles = readFileSync(
    new URL('../styles/lobby-modes.css', import.meta.url),
    'utf8',
);
const standingsStyles = readFileSync(
    new URL('../styles/modal-components-and-standings.css', import.meta.url),
    'utf8',
);
const resultDetailStyles = readFileSync(
    new URL('../styles/result-details.css', import.meta.url),
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

    it('closes every block in every stylesheet', () => {
        const styles = readCssBundle(manifestUrl);
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

    it('uses one padded 320px finish column for Daily, Campaign, and Head to Head', () => {
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view \.pause-header\s*\{[^}]*align-items:\s*stretch;[^}]*max-width:\s*320px;[^}]*padding:\s*0\.35rem;/s,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view \.combined-actions\s*\{[^}]*max-width:\s*320px;[^}]*padding:\s*0\.35rem;/s,
        );
        expect(resultDetailStyles).toMatch(
            /\.combined-stats-grid\s*\{[^}]*flex-direction:\s*column;[^}]*margin-top:\s*2\.75rem;/s,
        );
        expect(resultDetailStyles).not.toMatch(
            /#modal-combined-view\.is-challenge-finish \.pause-header\s*\{[^}]*max-width:\s*320px;/s,
        );
    });

    it('keeps the challenge finish as a scoped responsive result lockup', () => {
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish \.challenge-result-lockup\s*\{[^}]*font-family:\s*var\(--header-font\);[^}]*font-style:\s*italic;[^}]*font-weight:\s*900;/s,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish \.combined-stats-grid\s*\{[^}]*order:\s*3;/s,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish \.challenge-result-lockup__outcome,\s*#modal-combined-view\.is-challenge-finish #combined-time\s*\{[^}]*font-size:\s*3\.5rem;/s,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish \.combined-hero-time-group\s*\{[^}]*text-align:\s*right;/s,
        );
        expect(resultDetailStyles).not.toMatch(
            /lockup__outcome--pending[\s\S]*font-size:\s*clamp/,
        );
        expect(resultDetailStyles).toContain('@media (max-height: 640px)');
    });

    it('does not scale or recolor the finish RANK row on hover', () => {
        expect(resultDetailStyles).toMatch(
            /\.combined-stats-right-group--interactive\s*\{[^}]*cursor:\s*pointer;/,
        );
        expect(resultDetailStyles).not.toContain('.combined-stats-right-group--interactive:hover');
        expect(resultDetailStyles).not.toContain('.combined-stats-right-group--interactive:active');
    });

    it('does not scale or recolor the finish MEDALS row on hover', () => {
        expect(resultDetailStyles).toMatch(
            /#combined-medals-stat\.combined-medals-stat--interactive\s*\{[^}]*cursor:\s*pointer;/,
        );
        expect(resultDetailStyles).not.toContain('.combined-medals-stat--interactive:hover');
        expect(resultDetailStyles).not.toContain('.combined-medals-stat--interactive:active');
    });

    it('covers the lobby with the shared medals overlay and no poster hover scale', () => {
        expect(resultDetailStyles).toMatch(
            /#start-overlay > \.combined-medal-times-overlay\s*\{[^}]*border-radius:\s*0;[^}]*z-index:\s*20;/,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-medal\s*\{[^}]*cursor:\s*pointer;/,
        );
        expect(trackCarouselStyles).not.toContain('.daily-playlist-hero-medal:hover');
        expect(trackCarouselStyles).not.toContain('.daily-playlist-hero-medal:active');
    });

    it('lays out Daily, Campaign, and Head to Head comparison stats as the same left-label rows', () => {
        expect(resultDetailStyles).toMatch(
            /\.combined-stats-grid\s*\{[^}]*flex-direction:\s*column;[^}]*margin-top:\s*2\.75rem;/s,
        );
        expect(resultDetailStyles).toMatch(
            /\.stat-floating-item\s*\{[^}]*flex-direction:\s*row;[^}]*justify-content:\s*space-between;/s,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view \.combined-stat-label,[\s\S]*#modal-combined-view \.combined-stat-value--pb-delta[\s\S]*font-size:\s*1rem;[\s\S]*font-style:\s*normal;/s,
        );
    });

    it('enters every finish heading like Mini Racer, 10ms after the modal, with no row stagger', () => {
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish\.active-view \.challenge-result-lockup,[\s\S]*#modal-combined-view:not\(\.is-challenge-finish\)\.active-view \.combined-finish-heading:not\(\[hidden\]\)\s*\{[^}]*animation:\s*slideInLeft 0\.5s var\(--ease-glide\) var\(--dur-finish-headline\) both;/,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish\.active-view #combined-time,[\s\S]*#modal-combined-view:not\(\.is-challenge-finish\)\.active-view #combined-time\s*\{[^}]*animation:\s*slideInRight 0\.6s var\(--ease-glide\) calc\(0\.1s \+ var\(--dur-finish-headline\)\) both;/,
        );
        expect(foundationStyles).toContain('--dur-finish-headline: 10ms;');
        expect(resultDetailStyles).not.toMatch(
            /is-challenge-finish\.active-view \.combined-stats-grid/,
        );
        expect(resultDetailStyles).not.toMatch(
            /is-challenge-finish\.active-view \.combined-actions/,
        );
        expect(resultDetailStyles).toMatch(
            /#modal-combined-view\.is-challenge-finish\.active-view \.challenge-result-lockup__outcome\.is-incoming\s*\{[^}]*animation:\s*challengeOutcomePushIn 0\.5s var\(--ease-glide\) both;/,
        );
        expect(resultDetailStyles).toMatch(
            /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*is-challenge-finish\.active-view[\s\S]*animation:\s*none;/,
        );
    });

    it('routes every sub-200ms duration through a token', () => {
        const styles = readCssBundle(manifestUrl);
        const strays = [];

        for (const [, value] of styles.matchAll(
            /\b(?:transition|animation)(?:-duration)?\s*:\s*([^;}]+)/g,
        )) {
            for (const segment of value.split(',')) {
                const duration = segment.match(/(\d*\.?\d+)(ms|s)\b/);
                if (!duration) continue;
                const ms = Number(duration[1]) * (duration[2] === 's' ? 1000 : 1);
                if (ms <= 200) strays.push(segment.trim());
            }
        }

        expect(strays).toEqual([]);
    });

    it('keeps seven standings page slots visible while Campaign can scroll all stages', () => {
        expect(standingsStyles).toMatch(
            /\.leaderboard-day-rail\s*\{[^}]*display:\s*grid;[^}]*grid-auto-flow:\s*column;[^}]*grid-template-columns:\s*repeat\(7,\s*calc\(14\.285714%\s*-\s*0\.2142857rem\)\);[^}]*grid-auto-columns:\s*calc\(14\.285714%\s*-\s*0\.2142857rem\);[^}]*gap:\s*0\.25rem;[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x;/s,
        );
        expect(standingsStyles).toMatch(
            /\.leaderboard-day-chip\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
        );
        expect(standingsStyles).toMatch(
            /\.modal-lap-times-container:has\(> \.leaderboard-day-rail\)\s*\{[^}]*touch-action:\s*auto;/s,
        );
    });

    it('sets the Daily and Campaign selector as a programme entry between two rules', () => {
        expect(trackCarouselStyles).toMatch(
            /body\[data-lobby-mode="daily"\] #start-overlay,[\s\S]*body\[data-lobby-mode="campaign"\] #start-overlay\s*\{[^}]*background:\s*rgba\(2,\s*6,\s*23,\s*0\.8\);[^}]*backdrop-filter:\s*blur\(4px\)\s+saturate\(0\.9\);/s,
        );
        const lobbyModeStyles = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-header,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;[^}]*display:\s*flex;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-toolbar,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-toolbar\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*width:\s*auto;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-subhead,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-subhead\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-title,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-title\s*\{[^}]*--lobby-title-cap:\s*clamp\(1\.5rem, 8\.5vw, 3rem\);[^}]*font-size:\s*min\(var\(--lobby-title-cap\), 8vh\);/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-label,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-label\s*\{[^}]*font-family:\s*var\(--mono-font\);[^}]*font-size:\s*0\.68rem;[^}]*font-style:\s*normal;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-panes,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-panes\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /body\[data-lobby-mode="daily"\] #start-overlay,[\s\S]*body\[data-lobby-mode="campaign"\] #start-overlay\s*\{[^}]*radial-gradient/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
        );
        expect(trackCarouselStyles).not.toContain('.track-carousel__card-head');
        expect(trackCarouselStyles).not.toContain('.track-carousel__wordmark');
        expect(trackCarouselStyles).not.toContain('.track-carousel__billing');
        expect(trackCarouselStyles).not.toContain('.daily-playlist-hero-title');
        expect(trackCarouselStyles).not.toContain('.track-carousel__title-lead');
        expect(trackCarouselStyles).not.toContain('.track-carousel__title-tail');
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*position:\s*relative;[^}]*align-self:\s*center;[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
        );
        expect(trackCarouselStyles).not.toContain('mask-image: linear-gradient(');
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*border-top:/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-selection,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-selection\s*\{[^}]*text-align:\s*right;[^}]*text-transform:\s*uppercase;/s,
        );
        // Track over laps: the stack has to keep its right edge on the rule.
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-selection,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-selection\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-end;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-mode-selection__laps\s*\{[^}]*color:\s*var\(--text-muted\);[^}]*font-size:\s*0\.6rem;/s,
        );
    });

    it('keeps the wordmark a real button without letting the UA restyle it', () => {
        const lobbyStyles = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );
        // The h1 stays untouchable so the hit area is the letters, not the header.
        expect(lobbyStyles).toMatch(/\.lobby-title\s*\{[^}]*pointer-events:\s*none;/s);
        const home = lobbyStyles.match(/\.lobby-title__home\s*\{[^}]*\}/s)?.[0];
        expect(home).toBeTruthy();
        for (const declaration of [
            'font: inherit;',
            'color: inherit;',
            'letter-spacing: inherit;',
            'line-height: inherit;',
            'text-align: left;',
            'text-transform: inherit;',
            'text-shadow: inherit;',
            'pointer-events: auto;',
            'cursor: pointer;',
        ]) {
            expect(home).toContain(declaration);
        }
        // Home disables it, and the UA's disabled grey must not reach "MINI".
        expect(lobbyStyles).toMatch(
            /\.lobby-title__home:disabled\s*\{[^}]*color:\s*inherit;[^}]*opacity:\s*1;[^}]*pointer-events:\s*none;/s,
        );
        expect(lobbyStyles).toMatch(
            /\.lobby-title__home:focus-visible\s*\{[^}]*outline:/s,
        );
    });

    it('slides the picker in and back out without a script to drive it', () => {
        const paneEntrance = lobbyModeStyles.match(/@keyframes lobbyPaneIn\s*\{[\s\S]*?\n\}/)?.[0];
        expect(paneEntrance).toMatch(/opacity:\s*0;[\s\S]*opacity:\s*1;/);
        expect(paneEntrance).toMatch(/translate:\s*0 var\(--lobby-pane-travel\);[\s\S]*translate:\s*0 0;/);

        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\s*\{[^}]*animation:\s*lobbyPaneIn var\(--dur-base\) var\(--ease-settle\) both;/s,
        );

        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*opacity:\s*0;[^}]*translate:\s*0 var\(--lobby-pane-travel\);/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*display:\s*none !important;[^}]*animation:\s*none;/s,
        );
        expect(lobbyModeStyles).not.toContain('allow-discrete');
    });

    it('covers the mode swap so it neither jumps nor shows the old screen', () => {
        expect(lobbyModeStyles).toMatch(
            /\.lobby-panes\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*1fr;[^}]*grid-template-columns:\s*1fr;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\s*\{[^}]*grid-row:\s*1;[^}]*grid-column:\s*1;/s,
        );
        expect(lobbyModeStyles).not.toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*position:\s*absolute;/s,
        );

        expect(lobbyModeStyles).toMatch(
            /\.lobby-panes\s*\{[^}]*overflow:\s*clip;/s,
        );

        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*pointer-events:\s*none;/s,
        );

        expect(lobbyModeStyles).toMatch(/\.lobby-pane\s*\{[^}]*z-index:\s*1;/s);
        expect(lobbyModeStyles).toMatch(/\.lobby-pane\[hidden\]\s*\{[^}]*z-index:\s*0;/s);

        expect(raceControlStyles).toMatch(
            /#start-overlay::after\s*\{[\s\S]*background:\s*var\(--bg-color\);[\s\S]*opacity:\s*0;[\s\S]*transition:\s*opacity var\(--dur-base\) var\(--ease-standard\);/s,
        );
        expect(raceControlStyles).toMatch(
            /#start-overlay\.is-lobby-transitioning::after\s*\{[\s\S]*opacity:\s*1;[\s\S]*transition:\s*none;/s,
        );

        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*align-self:\s*stretch;/s,
        );

        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__rail\s*\{[^}]*transition:\s*opacity var\(--dur-base\)/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__rail:not\(:has\(\.daily-playlist-entry--hero\)\)\s*\{[^}]*opacity:\s*0;/s,
        );
        expect(trackCarouselStyles).not.toContain('is-entering');

        expect(foundationStyles).toMatch(
            /body\.start-overlay-active:not\(:has\(#start-overlay\.is-race-start-exiting\)\)/,
        );
        expect(foundationStyles).toMatch(
            /body:has\(#start-overlay\.is-race-start-exiting\) :is\([^)]*\)\s*\{[^}]*animation:\s*raceChromeIn/s,
        );
        expect(foundationStyles).not.toContain('body.race-start-exiting');
    });

    it('makes it structurally impossible for the card to reach Start Race', () => {
        expect(foundationStyles).toMatch(
            /--app-visible-height:\s*100vh;[\s\S]*--screen-fill-height:\s*min\(var\(--app-visible-height\), var\(--screen-height-cap\)\);/,
        );
        expect(foundationStyles).toMatch(
            /html,\s*body\s*\{[^}]*height:\s*var\(--app-visible-height\);[^}]*min-height:\s*0;/s,
        );
        expect(foundationStyles).not.toContain('min-height: -webkit-fill-available');
        expect(raceControlStyles).toMatch(
            /#start-group\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s,
        );
        expect(raceControlStyles).not.toMatch(
            /#start-group\s*\{[^}]*(?:height|max-height):[^}]*--screen-fill-height/s,
        );
        const lobbyModeStyles = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );
        expect(lobbyModeStyles).not.toContain('--reddit-native-bottom-clearance');
        expect(lobbyModeStyles).not.toMatch(
            /body\[data-lobby-mode="(?:daily|campaign)"\] #start-overlay\s*\{[^}]*--start-overlay-pad-bottom:/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*stretch;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel\s*\{[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 4rem;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__viewport\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*min-height:\s*0;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__viewport\s*\{[^}]*(?:height|max-height):\s*100%;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\.is-carousel-selected\s*\{[^}]*z-index:\s*2;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*grid-area:\s*2 \/ 1;[^}]*display:\s*grid;[^}]*height:\s*4rem;[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*min-height:/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__gate\s*\{[^}]*overflow:\s*hidden;/s,
        );
    });

    it('keeps the selector inside the lobby shell instead of restating its width', () => {
        expect(trackCarouselStyles).not.toMatch(/#start-group\s*\{/);
        expect(trackCarouselStyles).not.toMatch(
            /(?:^|[\s;{])(?:width|min-width|max-width|flex|flex-basis|inline-size):[^;}]*\dvw/m,
        );
        expect(trackCarouselStyles).toMatch(
            /--poster-column:\s*calc\(\s*var\(--track-carousel-card-width, [^)]+\) - \(2 \* var\(--poster-peek\)\)\s*\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*flex:\s*0 0 var\(--poster-column\);/s,
        );

        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        expect(ui).toMatch(/syncCardWidth\(\)\s*\{[\s\S]*--track-carousel-card-width/);
        expect(ui).toMatch(/render\([\s\S]*this\.syncCardWidth\(\);/);
    });

    it('fits each schematic to the measured hero row', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        expect(ui).toContain('host.offsetWidth');
        expect(ui).toContain('host.offsetHeight');
        expect(ui).toContain('transparentBackground: true');
        expect(trackCarouselStyles).not.toContain('--plate-frame');
        expect(ui).not.toContain('paintTitle');
        expect(ui).not.toContain('daily-playlist-hero-title');
        expect(ui).not.toContain("wordmark.className = 'track-carousel__wordmark'");
        expect(ui).toMatch(/fitPreviews\(\)\s*\{\s*const scale = this\.previewPixelScale\(\);/);
    });

    it('leaves the toolbar and Start Race to the styles the rest of the lobby uses', () => {
        expect(trackCarouselStyles).not.toMatch(/\.lobby-header\s*\{/);
        expect(trackCarouselStyles).not.toMatch(/\.main-menu__item/);

        const actionRow = trackCarouselStyles.match(
            /#lobby-daily-pane \.lobby-primary-row--race,[\s\S]*?\{([^}]*)\}/,
        )?.[1];
        expect(actionRow).toBeTruthy();
        expect(actionRow).toMatch(/min-height:\s*0;/);
        expect(actionRow).not.toMatch(/(?:position|z-index)\s*:/);
        expect(actionRow).not.toMatch(
            /(?:^|[\s;])(?:background|border|border-radius|box-shadow|color|font|font-size|font-weight|letter-spacing|text-transform)\s*:/m,
        );
        expect(
            trackCarouselStyles.match(/\.lobby-primary-row/g),
        ).toHaveLength(3);
    });

    it('eases the shared Daily and Campaign lobby away over the exact race-start duration', () => {
        expect(readCssBundle(manifestUrl)).toMatch(
            /#start-overlay\.is-ready\.is-race-start-exiting\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transition-duration:\s*var\(--dur-race-start-exit\);/s,
        );
    });

    it('keeps carousel medals square and shrinkable inside short Reddit viewports', () => {
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__medal\s*\{[^}]*flex:\s*0 1 1\.45rem;[^}]*min-height:\s*0;[^}]*min-width:\s*0;[^}]*max-width:\s*1\.45rem;[^}]*max-height:\s*1\.45rem;[^}]*aspect-ratio:\s*1;/s,
        );
        expect(trackCarouselStyles.match(/\.track-carousel__medal\s*\{/g)).toHaveLength(1);
    });

    it('keeps poster context readable and controls comfortably tappable', () => {
        const lobbyModeStyles = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );

        expect(trackCarouselStyles).not.toContain('.track-carousel__format');
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec-label\s*\{[^}]*color:\s*var\(--text-dim\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec\s*\{[^}]*align-items:\s*center;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__meta\s*\{[^}]*align-items:\s*center;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec-icon\s*\{[^}]*width:\s*1rem;[^}]*height:\s*1rem;[^}]*color:\s*var\(--text-dim\);[^}]*fill:\s*currentColor;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec\.is-muted \.track-carousel__spec-value\s*\{[^}]*color:\s*var\(--text-dim\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__nav\s*\{[\s\S]*?width:\s*auto;[\s\S]*?height:\s*2\.75rem;/s,
        );
        // Schematic, then its place in the rail, then its record. Prev/Next
        // leaves the stack entirely and flanks the schematic in row 1.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 1\.25rem 4rem;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__navigation\s*\{[^}]*grid-area:\s*2 \/ 1;[^}]*display:\s*grid;/s,
        );
        // Daily adds a row of its own above the counter for the expiry, and
        // pushes the counter and the record down a row to make space.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby:has\(\.track-carousel__expiry\)\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 1\.1rem 1\.25rem 4rem;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__expiry\s*\{[^}]*grid-area:\s*2 \/ 1;[^}]*font-family:\s*var\(--mono-font\);[^}]*text-align:\s*center;[^}]*text-transform:\s*uppercase;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__expiry\s*\{[^}]*cursor:\s*pointer;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#daily-carousel-navigation,\s*#campaign-carousel-navigation\s*\{[^}]*cursor:\s*pointer;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby:has\(\.track-carousel__expiry\) \.track-carousel__navigation\s*\{[^}]*grid-area:\s*3 \/ 1;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby:has\(\.track-carousel__expiry\) \.track-carousel__card-foot\s*\{[^}]*grid-area:\s*4 \/ 1;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__card-foot\s*\{[^}]*grid-area:\s*3 \/ 1;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__nav\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*position:\s*static;[^}]*inset:\s*auto;[^}]*align-self:\s*center;[^}]*width:\s*2\.5rem;[^}]*height:\s*2\.5rem;[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__nav--prev\s*\{[^}]*justify-self:\s*start;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel--lobby \.track-carousel__nav--next\s*\{[^}]*justify-self:\s*end;/s,
        );
        expect(trackCarouselStyles).not.toContain('.track-carousel__nav-label');
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__count\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*text-align:\s*center;/s,
        );
        // Keyboard nav selects the whole carousel, so the counter carries the cue.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__count\s*\{[^}]*padding:\s*0\.2rem 0\.5rem;[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.track-carousel--lobby\.is-menu-selected \.track-carousel__count\s*\{[^}]*color:\s*var\(--text-color\);[^}]*box-shadow:\s*0 0 0 2px rgba\(255, 255, 255, 0\.92\);/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-mode-toolbar__action\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*width:\s*clamp\(2\.6rem,\s*10vw,\s*3rem\);[^}]*height:\s*clamp\(2\.6rem,\s*10vw,\s*3rem\);[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-mode-toolbar__action svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-mode-toolbar__back svg\s*\{[^}]*width:\s*clamp\(1\.5rem,\s*5vw,\s*1\.9rem\);[^}]*height:\s*clamp\(1\.5rem,\s*5vw,\s*1\.9rem\);/s,
        );
        expect(lobbyModeStyles).not.toContain('.lobby-mode-toolbar__label');
        expect(trackCarouselStyles).not.toMatch(
            /@media \(max-height:\s*500px\)\s*\{[\s\S]*\.track-carousel \.daily-playlist-hero-medal\s*\{[^}]*display:\s*none;/s,
        );
    });

    it('gives each band of the card one thing to say', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        expect(ui).toContain('element.append(preview)');
        expect(ui).toContain('this.root.append(this._footParts.foot)');
        expect(ui).not.toContain("wordmarkMini.textContent = 'MINI'");
        expect(ui).not.toContain("wordmarkRacer.textContent = 'RACER'");
        expect(ui).not.toContain('billing.append(mode, billingRule, billingLabel)');
        expect(ui).not.toContain('setText(parts.mode, card.modeLabel || \'\')');
        expect(ui).not.toContain('setText(parts.billingLabel, card.billingLabel || card.eyebrowLabel || \'\')');
        expect(ui).not.toContain('head.append(wordmark, billing)');
        expect(ui).toContain('preview.append(previewArt, gate)');
        expect(ui).toContain('gate.append(previewLock)');
        expect(ui).toContain('requirement.append(requirementList)');
        expect(ui).toContain('foot.append(requirement, meta, verificationError, medal)');
        expect(ui).toContain('meta.append(bestCell, rank)');
        expect(ui).toContain('createPersonalBestIcon');
        expect(ui).toContain("viewBox', '0 0 448 512'");
        expect(ui).toContain("setAttribute('width', '16')");
        expect(ui).toContain("setAttribute('height', '16')");
        expect(ui).toContain("aria-label', 'Personal best'");
        expect(ui).toContain('createStandingsIcon');
        expect(ui).toContain("viewBox', '0 0 640 640'");
        expect(ui).toContain('STANDINGS_ICON_PATH');
        expect(ui).toContain("createSpecCell(createStandingsIcon(), 'button')");
        expect(ui).toContain("setText(parts.rankValue, card.rankPending ? '···'");
        expect(ui).not.toContain("setText(parts.rankLabel, 'Rank')");
        expect(ui).toContain("status.className = 'track-carousel__requirement-medal'");
        expect(ui).toContain('status.append(createRequirementMedalIcon(requirement))');
    });

    it('lays the Tracks list as equal two-across tiles', () => {
        const trackShellStyles = readFileSync(
            new URL('../styles/settings-and-track-shells.css', import.meta.url),
            'utf8',
        );
        const garageStyles = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );
        expect(garageStyles).toMatch(
            /#garage-modal \.garage-skin-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-list\.daily-playlist-list\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-entry--hero\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*overflow:\s*visible;/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-hero-preview\s*\{[^}]*grid-column:\s*1 \/ -1;/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-hero-title\s*\{[^}]*min-height:\s*2\.4em;[^}]*text-align:\s*left;/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-hero-day\s*\{[^}]*text-align:\s*right;/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-hero-rank\s*\{[^}]*top:\s*0\.28rem;[^}]*right:\s*0\.28rem;/s,
        );
        expect(trackShellStyles).toMatch(
            /#daily-playlist-modal \.daily-playlist-entry--hero:hover\s*\{[^}]*transform:\s*none;[^}]*background:\s*#1e293b;[^}]*box-shadow:\s*none;/s,
        );
        expect(trackShellStyles).not.toContain('#daily-playlist-modal .daily-playlist-entry--hero.current {');
        expect(trackShellStyles).not.toContain('is-featured');
        expect(trackShellStyles).not.toContain('#daily-playlist-modal .daily-playlist-hero-lock');
    });

    it('paints settings on/off rows with the Daily/Campaign lobby pill', () => {
        const trackShellStyles = readFileSync(
            new URL('../styles/settings-and-track-shells.css', import.meta.url),
            'utf8',
        );
        expect(trackShellStyles).toMatch(
            /#settings-modal \.modal-sheet-settings-switch\s*\{[^}]*grid-template-columns:\s*1fr 1fr;[^}]*background:\s*rgba\(51, 65, 85, 0\.7\);[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(trackShellStyles).toMatch(
            /#settings-modal \.modal-sheet-settings-switch::before\s*\{[^}]*background-color:\s*var\(--accent-color\);[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(trackShellStyles).toMatch(
            /#settings-modal \.modal-sheet-settings-switch:has\(:checked\)::before\s*\{[^}]*transform:\s*translateX\(100%\);/s,
        );
    });

    it('paints garage Car/Trail with the Settings on/off pill', () => {
        const garageStyles = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );
        expect(garageStyles).toMatch(
            /\.garage-tabs\s*\{[^}]*grid-template-columns:\s*1fr 1fr;[^}]*background:\s*#1e293b;[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(garageStyles).toMatch(
            /\.garage-tabs::before\s*\{[^}]*background-color:\s*var\(--accent-color\);[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
        expect(garageStyles).toMatch(
            /\.garage-tabs:has\(#garage-tab-trails\[aria-selected="true"\]\)::before\s*\{[^}]*transform:\s*translateX\(100%\);/s,
        );
        expect(garageStyles).toMatch(
            /#garage-modal \.garage-tabs\s*\{[^}]*height:\s*2\.5rem;[^}]*border-radius:\s*var\(--radius-full\);/s,
        );
    });

});
