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
        // One restrained scrim keeps the live track-of-the-day render
        // atmospheric without stacking multiple translucent backgrounds.
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
        // The wordmark and billing row are fixed header furniture, not card
        // content that can travel with a horizontal selection.
        expect(trackCarouselStyles).not.toContain('.track-carousel__card-head');
        expect(trackCarouselStyles).not.toContain('.track-carousel__wordmark');
        expect(trackCarouselStyles).not.toContain('.track-carousel__billing');
        expect(trackCarouselStyles).not.toContain('.daily-playlist-hero-title');
        expect(trackCarouselStyles).not.toContain('.track-carousel__title-lead');
        expect(trackCarouselStyles).not.toContain('.track-carousel__title-tail');
        // The schematic owns the first card row; header identity is outside it.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*position:\s*relative;[^}]*align-self:\s*center;[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
        );
        expect(trackCarouselStyles).not.toContain('mask-image: linear-gradient(');
        // The status footer is a seamless continuation of the track preview: a
        // locked card gets a readable two-item prerequisite checklist, while an
        // open card gets its compact scoreline.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*border-top:/s,
        );
        expect(lobbyModeStyles).toMatch(
            /body\[data-lobby-mode="daily"\] \.lobby-mode-selection,[\s\S]*body\[data-lobby-mode="campaign"\] \.lobby-mode-selection\s*\{[^}]*text-align:\s*right;[^}]*text-transform:\s*uppercase;/s,
        );
    });

    /**
     * The picker arrives with one short animation. The outgoing screen is
     * covered by the shared transition veil rather than kept in the layout.
     */
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
        // One cell, every pane in it. In a flex column the two panes stack end
        // to end and shove the layout down mid-slide; out of flow the leaving
        // one collapses off its `flex` and the carousel re-measures against it.
        expect(lobbyModeStyles).toMatch(
            /\.lobby-panes\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*1fr;[^}]*grid-template-columns:\s*1fr;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\s*\{[^}]*grid-row:\s*1;[^}]*grid-column:\s*1;/s,
        );
        expect(lobbyModeStyles).not.toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*position:\s*absolute;/s,
        );

        // Measured: without this the pane's travel hangs over the lane, counts
        // as scrollable content, and lifts the header 8px for exactly as long as
        // the entrance runs — the jump. `clip`, never `hidden`: a scroll
        // container here changes how the carousel measures itself.
        expect(lobbyModeStyles).toMatch(
            /\.lobby-panes\s*\{[^}]*overflow:\s*clip;/s,
        );

        expect(lobbyModeStyles).toMatch(
            /\.lobby-pane\[hidden\]\s*\{[^}]*pointer-events:\s*none;/s,
        );

        // The active pane owns the lane; hidden panes are removed instead of
        // relying on embedded-WebView support for discrete display transitions.
        expect(lobbyModeStyles).toMatch(/\.lobby-pane\s*\{[^}]*z-index:\s*1;/s);
        expect(lobbyModeStyles).toMatch(/\.lobby-pane\[hidden\]\s*\{[^}]*z-index:\s*0;/s);

        // The opaque veil is the single handoff surface. It covers the live
        // canvas, header swap and outgoing pane before the new mode is revealed.
        expect(raceControlStyles).toMatch(
            /#start-overlay::after\s*\{[\s\S]*background:\s*var\(--bg-color\);[\s\S]*opacity:\s*0;[\s\S]*transition:\s*opacity var\(--dur-base\) var\(--ease-standard\);/s,
        );
        expect(raceControlStyles).toMatch(
            /#start-overlay\.is-lobby-transitioning::after\s*\{[\s\S]*opacity:\s*1;[\s\S]*transition:\s*none;/s,
        );

        // The filling panes take the whole lane from the first frame, so the
        // poster never measures itself against a short box.
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*align-self:\s*stretch;/s,
        );

        // The rail's fade comes off its own contents, so there is no class to
        // stall mid-animation and replay the next time the lobby is shown.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__rail\s*\{[^}]*transition:\s*opacity var\(--dur-base\)/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__rail:not\(:has\(\.daily-playlist-entry--hero\)\)\s*\{[^}]*opacity:\s*0;/s,
        );
        expect(trackCarouselStyles).not.toContain('is-entering');

        // The race chrome crosses with the scrim rather than waiting for it,
        // read off the class the overlay already wears for its own fade.
        expect(foundationStyles).toMatch(
            /body\.start-overlay-active:not\(:has\(#start-overlay\.is-race-start-exiting\)\)/,
        );
        expect(foundationStyles).toMatch(
            /body:has\(#start-overlay\.is-race-start-exiting\) :is\([^)]*\)\s*\{[^}]*animation:\s*raceChromeIn/s,
        );
        expect(foundationStyles).not.toContain('body.race-start-exiting');
    });

    it('makes it structurally impossible for the card to reach Start Race', () => {
        // The runtime publishes the actually visible WebView height here. The
        // shell and capped full-screen panels share it instead of independently
        // trusting viewport units that Reddit's native chrome can obscure.
        expect(foundationStyles).toMatch(
            /--app-visible-height:\s*100vh;[\s\S]*--screen-fill-height:\s*min\(var\(--app-visible-height\), var\(--screen-height-cap\)\);/,
        );
        expect(foundationStyles).toMatch(
            /html,\s*body\s*\{[^}]*height:\s*var\(--app-visible-height\);[^}]*min-height:\s*0;/s,
        );
        expect(foundationStyles).not.toContain('min-height: -webkit-fill-available');
        // The overlay's content box is now the sole height owner. A second
        // screen-fill subtraction on the group recreates the WebView mismatch.
        expect(raceControlStyles).toMatch(
            /#start-group\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s,
        );
        expect(raceControlStyles).not.toMatch(
            /#start-group\s*\{[^}]*(?:height|max-height):[^}]*--screen-fill-height/s,
        );
        // Reddit's native header and footer sit outside the expanded WebView.
        // Do not guess at their height inside the app: doing so lifts Start Race
        // and takes the scoreline's space on the actual iOS surface.
        const lobbyModeStyles = readFileSync(
            new URL('../styles/lobby-modes.css', import.meta.url),
            'utf8',
        );
        expect(lobbyModeStyles).not.toContain('--reddit-native-bottom-clearance');
        expect(lobbyModeStyles).not.toMatch(
            /body\[data-lobby-mode="(?:daily|campaign)"\] #start-overlay\s*\{[^}]*--start-overlay-pad-bottom:/s,
        );
        // If a browser ever reports another impossible intermediate size, the
        // poster is clipped inside its lane; it cannot paint under the CTA.
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /#lobby-daily-pane\.lobby-pane,[\s\S]*#lobby-campaign-pane\.lobby-pane\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*stretch;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel\s*\{[^}]*overflow:\s*hidden;/s,
        );
        // The rail's lane is pinned to the carousel, not sized as a percentage
        // of it. A percentage here resolves through `#start-group` and the mode
        // pane — heights only settled by flexing — so in the Reddit WebView it
        // resolved against an indefinite height, the rail took the poster's
        // intrinsic height, and the clip above removed the scoreline.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__viewport\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__viewport\s*\{[^}]*(?:height|max-height):\s*100%;/s,
        );
        // The card is a two-band poster. Its preview owns the first row and is
        // clipped to the card, so it cannot reach the status or Start Race row.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 4rem;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*grid-area:\s*1 \/ 1;[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\.is-carousel-selected\s*\{[^}]*z-index:\s*2;/s,
        );
        // The footer is a fixed status row, not a floor. Open cards use it for
        // player figures; locked cards use it for the two unlock gates.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*grid-area:\s*2 \/ 1;[^}]*display:\s*grid;[^}]*height:\s*4rem;[^}]*overflow:\s*hidden;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*min-height:/s,
        );
        // The lock puck is the only overlay on the drawing; the instruction is
        // below it in the footer, so no text competes with the track geometry.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__gate\s*\{[^}]*overflow:\s*hidden;/s,
        );
    });

    it('keeps the selector inside the lobby shell instead of restating its width', () => {
        // The shell owns the width, the safe areas and every responsive step,
        // the same as on Home. This surface reads that measure off the viewport
        // (`--track-carousel-card-width`, published by the carousel) rather than
        // repeating it — a second copy here goes stale the moment
        // responsive-layout.css moves a breakpoint, and a full-bleed override
        // makes these two screens a different width from the rest of the lobby.
        expect(trackCarouselStyles).not.toMatch(/#start-group\s*\{/);
        // Type and gaps may scale with the viewport the way the rest of the
        // lobby's do; what may not is any box on this surface sizing itself off
        // the viewport instead of off the shell.
        expect(trackCarouselStyles).not.toMatch(
            /(?:^|[\s;{])(?:width|min-width|max-width|flex|flex-basis|inline-size):[^;}]*\dvw/m,
        );
        // The poster is the shell's measure less the room the run either side
        // peeks through — paid for out of the card, never by spilling past the
        // shell, which clips.
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
        // A percentage cannot do this job: the rail is an intrinsically sized
        // flex container, so `100%` on a card resolves against the rail's own
        // content width and the card grows to whatever it happened to measure.
        expect(ui).toMatch(/syncCardWidth\(\)\s*\{[\s\S]*--track-carousel-card-width/);
        expect(ui).toMatch(/render\([\s\S]*this\.syncCardWidth\(\);/);
    });

    it('fits each schematic to the measured hero row', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        // The preview bitmap is sized from its measured middle-row host.
        expect(ui).toContain('host.offsetWidth');
        expect(ui).toContain('host.offsetHeight');
        expect(ui).toContain('transparentBackground: true');
        expect(trackCarouselStyles).not.toContain('--plate-frame');
        expect(ui).not.toContain('paintTitle');
        expect(ui).not.toContain('daily-playlist-hero-title');
        expect(ui).not.toContain("wordmark.className = 'track-carousel__wordmark'");
        expect(ui).toMatch(/fitPreviews\(\)\s*\{\s*\/\/ Device resolution:/);
    });

    it('leaves the toolbar and Start Race to the styles the rest of the lobby uses', () => {
        // Both are shared lobby furniture. This surface changed how a track card
        // is composed, not how the lobby lays out its header or draws its
        // primary button — restyling them here is how Daily and Campaign drift
        // away from Home.
        expect(trackCarouselStyles).not.toMatch(/\.lobby-header\s*\{/);
        expect(trackCarouselStyles).not.toMatch(/\.main-menu__item/);

        // The action row is the one exception, and only for safe-area spacing.
        // Its intrinsic grid row cannot shrink or cover the poster, and nothing
        // about how the button looks belongs here.
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
        ).toHaveLength(2);
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
            /\.track-carousel__nav\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?height:\s*2\.75rem;/s,
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
        // The card contains only the plate and footer; identity is rendered by
        // the actual lobby header outside the horizontal rail.
        expect(ui).toContain('element.append(preview, foot)');
        expect(ui).not.toContain("wordmarkMini.textContent = 'MINI'");
        expect(ui).not.toContain("wordmarkRacer.textContent = 'RACER'");
        expect(ui).not.toContain('billing.append(mode, billingRule, billingLabel)');
        expect(ui).not.toContain('setText(parts.mode, card.modeLabel || \'\')');
        expect(ui).not.toContain('setText(parts.billingLabel, card.billingLabel || card.eyebrowLabel || \'\')');
        expect(ui).not.toContain('head.append(wordmark, billing)');
        // The plate carries the drawing and the lock puck. The footer carries
        // both availability readings without moving the fixed header.
        expect(ui).toContain('preview.append(previewArt, gate)');
        expect(ui).toContain('gate.append(previewLock)');
        expect(ui).toContain('requirement.append(requirementList)');
        expect(ui).toContain('foot.append(requirement, meta, medal)');
        // The scoreline is open-card context; a locked card hides it in favour
        // of the actionable prerequisite.
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

});
