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

    it('sets the Daily and Campaign selector as a programme entry between two rules', () => {
        // Translucent, not opaque: the live track-of-the-day render behind the
        // overlay is the lobby's moving background in every mode.
        expect(trackCarouselStyles).toMatch(
            /body\[data-lobby-mode="daily"\] #start-overlay,[\s\S]*body\[data-lobby-mode="campaign"\] #start-overlay\s*\{[^}]*backdrop-filter:\s*blur\(/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
        );
        // Ranged left, both bands, which is what makes this a printed bill
        // rather than a card floating on a page. A centred stack here is the
        // single change that undoes the whole direction.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-head\s*\{[^}]*align-items:\s*flex-start;[^}]*text-align:\s*left;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-title\s*\{[^}]*text-align:\s*left;/s,
        );
        // The billing is a hairline with a reading at each end. Without the rule
        // the format floats out on the right with nothing holding it to the run,
        // and the band reads as a header row rather than as part of the card.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__billing-rule\s*\{[^}]*flex:\s*1 1 auto;[^}]*height:\s*1px;[^}]*background:\s*var\(--border-default\);/s,
        );
        // The schematic is capped at the height the drawing can use, so a wide
        // circuit is drawn wide and a tall one tall rather than both being
        // letterboxed into the same rectangle.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-preview\s*\{[^}]*align-self:\s*center;[^}]*max-height:\s*calc\(\s*\(var\(--poster-column\) \/ var\(--track-plate-aspect, 1\.4\)\)[^}]*width:\s*var\(--plate-frame\);/s,
        );
        // The scoreline closes the entry over the second rule: the figures from
        // the left edge, the ladder they add up to from the right.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*justify-content:\s*space-between;[^}]*border-top:\s*1px solid var\(--border-subtle\);/s,
        );
        // The name is set the way the lobby sets MINI over RACER: two rows on
        // every card, the first word white and smaller, the last word red and
        // full size. Both rows are sized against their own word, and the band
        // is hung from the rule above so the name sits on its drawing.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-hero-title\s*\{[^}]*align-content:\s*end;[^}]*var\(--title-tail-length, 8\)[^}]*var\(--title-lead-length, 8\)/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__title-lead\s*\{[^}]*font-size:\s*calc\(1em \* var\(--title-lead-scale\)\);[^}]*color:\s*var\(--text-color\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__title-tail\s*\{[^}]*color:\s*var\(--accent-color\);/s,
        );
        // The two rows survive the short-landscape step: it takes the headline
        // scale down, it does not collapse the name back onto one line.
        expect(trackCarouselStyles).toMatch(
            /@media \(max-height:\s*500px\)\s*\{[\s\S]*\.track-carousel \.daily-playlist-hero-title\s*\{[^}]*--title-cap:/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel \.daily-playlist-hero-title\s*\{[^}]*white-space:\s*nowrap;/s,
        );
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
        // The scoreline owns a fixed row, the drawing is the only row that can
        // be taken, and `minmax(0, 1fr)` lets it be taken all the way to
        // nothing. WebKit cannot resolve the figures as overflow below the card.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) 2\.6rem;/s,
        );
        // The backstop for the window too short even for the two type rows: the
        // card loses the bottom of its own scoreline rather than painting it
        // over Start Race.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\s*\{[^}]*overflow:\s*hidden;/s,
        );
        // One line, on every card and in every state — a fixed height, not a
        // floor, so no reading on this band can ever grow the band. The gated
        // stage that used to state its requirement here in words is the card
        // that broke the promise, and it states it on the plate now.
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*height:\s*2\.6rem;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /\.track-carousel__card-foot\s*\{[^}]*min-height:/s,
        );
        // Centred content overflows its box in both directions once it stops
        // fitting, and above the gate is the track name while below it is the
        // scoreline's rule.
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

    it('sizes the plate frame from the track the card is showing', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        // CSS can cap the plate against the column, but only a measurement can
        // close the frame in on a drawing that ran out of height first.
        expect(ui).toContain('--track-plate-aspect');
        expect(ui).toContain('--plate-frame-width');
        expect(ui).toContain('--title-lead-length');
        expect(ui).toContain('--title-tail-length');
        expect(ui).toMatch(/fitPreviews\(\)\s*\{\s*this\.fitPlateFrames\(\);/);
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

        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__format\s*\{[^}]*color:\s*var\(--text-dim\);[^}]*font-size:\s*0\.68rem;/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec-label\s*\{[^}]*color:\s*var\(--text-dim\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__spec\.is-muted \.track-carousel__spec-value\s*\{[^}]*color:\s*var\(--text-dim\);/s,
        );
        expect(trackCarouselStyles).toMatch(
            /\.track-carousel__nav\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?height:\s*2\.75rem;/s,
        );
        expect(lobbyModeStyles).toMatch(
            /\.lobby-mode-toolbar \.lobby-header-action\s*\{[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/s,
        );
        expect(trackCarouselStyles).not.toMatch(
            /@media \(max-height:\s*500px\)\s*\{[\s\S]*\.track-carousel \.daily-playlist-hero-medal\s*\{[^}]*display:\s*none;/s,
        );
    });

    it('gives each band of the card one thing to say', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        // Three bands: what the run is, the drawing of it, how the player stands
        // on it. Nothing crosses between them, so they never contend for the
        // same pixels and a short window can take the drawing on its own.
        expect(ui).toContain('element.append(head, preview, foot)');
        // The billing is a hairline with a reading at each end — the run at one,
        // how long it is at the other. Moving the lap count up here is what left
        // the scoreline below room for the ladder.
        expect(ui).toContain('billing.append(eyebrow, billingRule, format)');
        expect(ui).toContain('head.append(billing, title)');
        // The plate carries the drawing and, on a stage out of reach, the gate.
        // The requirement runs to a sentence, and the plate is the one band that
        // can wrap or be clipped without moving anything else — which is exactly
        // what it could not do on the scoreline.
        expect(ui).toContain('preview.append(previewArt, gate)');
        expect(ui).toContain('gate.append(previewLock, gateNote)');
        // The scoreline: the player's own figures from the left, the ladder they
        // add up to from the right. The ladder rode on the billing for one
        // revision, where it had nothing to do with either reading on that line.
        expect(ui).toContain('meta.append(rankMedal, bestCell, rank)');
        expect(ui).toContain('foot.append(meta, medal)');
    });

});
