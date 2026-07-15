import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('finish screen styles', () => {
    it('keeps the Improve button width rule separate from generic button declarations', () => {
        expect(styles).toMatch(
            /#modal\.modal--win #combined-restart-btn\s*\{\s*width:\s*100%;\s*\}/,
        );
        expect(styles).not.toMatch(
            /#modal\.modal--win #combined-restart-btn\s*,\s*\.combined-action-btn/,
        );
    });
});
