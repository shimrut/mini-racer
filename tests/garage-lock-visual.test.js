import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Garage locked-car visual contract', () => {
    it('uses a white lock and reveals the white progress arc only above zero', () => {
        const ui = readFileSync(
            new URL('../game/settings/garage-ui.js', import.meta.url),
            'utf8',
        );
        const css = readFileSync(
            new URL('../styles/lobby-and-garage.css', import.meta.url),
            'utf8',
        );

        expect(ui).toContain("path.setAttribute('fill', 'currentColor')");
        expect(ui).toContain(
            "lockIndicator.classList.toggle('has-progress', !unlocked && ratio > 0)",
        );
        expect(css).toMatch(
            /\.garage-skin-option__lock\s*\{[^}]*background:\s*rgba\(248,\s*250,\s*252,\s*\.06\);[^}]*color:\s*#fff;/s,
        );
        expect(css).toMatch(
            /\.garage-skin-option__progress\s*\{[^}]*opacity:\s*0;/s,
        );
        expect(css).toMatch(
            /\.garage-skin-option__lock\.has-progress \.garage-skin-option__progress\s*\{[^}]*opacity:\s*1;/s,
        );
        expect(css).toMatch(
            /\.garage-skin-option__progress-value\s*\{[^}]*stroke:\s*#fff;/s,
        );
    });
});
