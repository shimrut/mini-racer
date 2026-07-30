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

    it('keeps leaderboard action slots tight to their icon buttons', () => {
        expect(styles).toMatch(
            /\.leaderboard-row__action\s*\{[^}]*width:\s*1\.5rem;[^}]*justify-content:\s*flex-end;/s,
        );
        expect(styles).not.toMatch(
            /\.leaderboard-row__action\s*\{[^}]*width:\s*3rem;/s,
        );
    });
});
