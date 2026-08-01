import { describe, expect, it } from 'vitest';
import { readCssBundle } from './helpers/read-css-bundle.js';

const styles = readCssBundle(new URL('../styles.css', import.meta.url));

describe('finish screen styles', () => {
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
            /#modal-combined-view \.combined-actions--with-next > \.combined-action-btn\s*\{\s*flex:\s*0 0 100%;\s*\}/,
        );
        expect(styles).toMatch(
            /#modal-combined-view \.combined-actions--with-next > #combined-menu-btn,\s*#modal-combined-view \.combined-actions--with-next > #combined-next-btn\s*\{[^}]*flex:\s*1 1 0;/s,
        );
    });

    it('paints every finish button but the accented one as the quiet option', () => {
        expect(styles).toMatch(
            /#modal-combined-view \.combined-action-btn:not\(\.combined-action-btn--primary\)\s*\{\s*background:\s*rgba\(51, 65, 85, 0\.8\);\s*\}/,
        );
        // A per-id background would outrank the accent and strand Next in grey.
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
});
