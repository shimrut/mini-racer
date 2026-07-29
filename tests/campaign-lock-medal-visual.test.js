import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Campaign locked-stage medal progress visual', () => {
    it('puts the count inside a medal and fills progress around its perimeter', () => {
        const ui = readFileSync(
            new URL('../game/ui/track-carousel.js', import.meta.url),
            'utf8',
        );
        const css = readFileSync(
            new URL('../styles/track-carousel.css', import.meta.url),
            'utf8',
        );

        expect(ui).toContain("centerText: meter.value");
        expect(ui).toContain("progress.setAttribute('pathLength', '100')");
        expect(ui).toContain(
            "progress.setAttribute('stroke-dashoffset', String(100 - (meter.ratio * 100)))",
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal-progress\s*\{[^}]*stroke:\s*var\(--text-color\);/s,
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal \.medal-svg__center-time\s*\{[^}]*font-family:\s*var\(--mono-font\);/s,
        );
        expect(css).not.toContain('.track-carousel__meter-fill');
    });
});
