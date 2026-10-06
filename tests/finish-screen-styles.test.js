import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCssBundle } from './helpers/read-css-bundle.js';

const styles = readCssBundle(new URL('../pages/styles.css', import.meta.url));
const gameHtml = readFileSync(new URL('../pages/game.html', import.meta.url), 'utf8');

describe('finish screen styles', () => {
    it('lines stats up with finish buttons in the same padded column', () => {
        expect(styles).toMatch(
            /#modal-combined-view \.pause-header\s*\{[^}]*max-width:\s*320px;[^}]*padding:\s*0\.35rem;/s,
        );
        expect(styles).toMatch(
            /#modal-combined-view \.combined-actions\s*\{[^}]*max-width:\s*320px;[^}]*padding:\s*0\.35rem;/s,
        );
        expect(styles).toMatch(
            /\.combined-stats-grid\s*\{[^}]*margin-top:\s*2\.75rem;/s,
        );
    });

    it('keeps the Improve button width rule separate from generic button declarations', () => {
        expect(styles).toMatch(
            /#modal\.modal--win #combined-restart-btn\s*\{\s*width:\s*100%;\s*\}/,
        );
        expect(styles).not.toMatch(
            /#modal\.modal--win #combined-restart-btn\s*,\s*\.combined-action-btn/,
        );
    });

    it('splits the Home and Next row in half without touching the stacked buttons', () => {
        expect(styles).toMatch(
            /#modal-combined-view \.combined-actions--with-next\s*\{\s*flex-flow:\s*row wrap;\s*\}/,
        );
        expect(styles).toMatch(
            /#modal-combined-view \.combined-actions--with-next > \.combined-action-btn[^{]*\{\s*flex:\s*0 0 100%;\s*\}/,
        );
        expect(styles).toMatch(
            /#modal-combined-view \.combined-actions--with-next > #combined-menu-btn,\s*#modal-combined-view \.combined-actions--with-next > #combined-next-btn\s*\{[^}]*flex:\s*1 1 0;/s,
        );
    });

    it('paints every finish button but the accented one as the quiet option', () => {
        expect(styles).toMatch(
            /#modal-combined-view \.combined-action-btn:not\(\.combined-action-btn--primary\)\s*\{\s*background:\s*rgba\(51, 65, 85, 0\.8\);\s*\}/,
        );
        expect(styles).not.toMatch(
            /#modal-combined-view #combined-(next|menu|playlist)-btn[^{]*\{[^}]*background:/s,
        );
    });

    it('keeps leaderboard action slots tight to their icon buttons', () => {
        expect(styles).toMatch(
            /\.leaderboard-row__action\s*\{[^}]*width:\s*1\.5rem;[^}]*justify-content:\s*flex-end;/s,
        );
        expect(styles).not.toMatch(
            /\.leaderboard-row__action\s*\{[^}]*width:\s*3rem;/s,
        );
    });

    it('puts Daily and Campaign medals first, then opponent, VS PB, and RANK', () => {
        const start = gameHtml.indexOf('class="combined-stats-grid">');
        const actions = gameHtml.indexOf('class="combined-actions"', start);
        expect(start).toBeGreaterThan(-1);
        expect(actions).toBeGreaterThan(start);
        const ids = [...gameHtml.slice(start, actions).matchAll(/id="(combined-[^"]+)"/g)]
            .map((match) => match[1]);
        expect(ids).toEqual([
            'combined-medals-stat',
            'combined-medals-row',
            'combined-opponent-stat',
            'combined-opponent-delta',
            'combined-stat-label-2',
            'combined-best-lap',
            'combined-stats-right-group',
            'combined-rank-value',
            'combined-rank-total',
        ]);
    });

    it('puts Daily and Campaign medals in a compact right-side MEDALS row', () => {
        expect(styles).toMatch(
            /#combined-medals-row \.combined-medal-row-slot \.medal-svg--hero\s*\{[^}]*width:\s*1\.28rem;/s,
        );
        expect(styles).not.toMatch(
            /#combined-medals-row[^{]*medal-svg__shape\s*\{[^}]*stroke-dasharray:/s,
        );
        expect(styles).toMatch(
            /\.combined-hero-medal \.combined-medal-row-slot--locked \.medal-svg--outline \.medal-svg__shape\s*\{[^}]*stroke-dasharray:\s*12 34;/s,
        );
        expect(styles).toMatch(
            /\.medal-svg--outline \.medal-svg__shape\s*\{[^}]*stroke-width:\s*32;/s,
        );
        expect(styles).toMatch(
            /#modal-combined-view:not\(\.is-challenge-finish\) #combined-hero-medal\s*\{\s*display:\s*none;/,
        );
    });

    it('paints Daily and Campaign finish headings in medal, new-best, and finished colors', () => {
        expect(styles).toMatch(
            /#modal-combined-view:not\(\.is-challenge-finish\) \.combined-finish-heading\[data-kind="finished"\]\s*\{\s*color:\s*var\(--accent-color\);/,
        );
        expect(styles).toMatch(
            /#modal-combined-view:not\(\.is-challenge-finish\) \.combined-finish-heading\[data-kind="new-best"\]\s*\{\s*color:\s*var\(--success-bright\);/,
        );
        expect(styles).toMatch(
            /#modal-combined-view:not\(\.is-challenge-finish\) \.combined-finish-heading\[data-kind="gold"\]\s*\{\s*color:\s*var\(--medal-gold\);/,
        );
        expect(styles).toMatch(
            /#modal-combined-view\.is-challenge-finish \.combined-finish-heading\s*\{\s*display:\s*none;/,
        );
    });

    it('stacks medal times in the finish mini-modal', () => {
        expect(styles).toMatch(
            /\.combined-medal-times-row--medal\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*space-between;/,
        );
        expect(styles).toMatch(
            /\.combined-medal-times-row--medal \.medal-svg--popover\s*\{[^}]*width:\s*1\.75rem;/,
        );
        expect(styles).toMatch(
            /\.combined-medal-times-row--medal \.combined-medal-times-label\s*\{[^}]*flex:\s*1 1 auto;/,
        );
        expect(styles).toMatch(
            /\.combined-medal-times-row--medal \.combined-medal-times-time\s*\{[^}]*margin-left:\s*auto;[^}]*text-align:\s*right;/,
        );
    });
});
