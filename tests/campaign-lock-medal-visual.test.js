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
        const lockIcon = readFileSync(
            new URL('../game/ui/lock-icon.js', import.meta.url),
            'utf8',
        );

        expect(ui).toContain("centerText: meter.value");
        expect(ui).toContain("icon.classList.toggle('is-complete', meter.ratio >= 1)");
        expect(ui).toContain("progress.setAttribute('pathLength', '100')");
        expect(ui).toContain(
            "progress.setAttribute('stroke-dashoffset', String(100 - (meter.ratio * 100)))",
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal-progress\s*\{[^}]*stroke:\s*rgba\(148,\s*163,\s*184,\s*0\.58\);/s,
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal \.medal-svg__center-time\s*\{[^}]*fill:\s*rgba\(148,\s*163,\s*184,\s*0\.72\);/s,
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal\.is-complete \.track-carousel__unlock-medal-progress\s*\{[^}]*stroke:\s*var\(--text-color\);/s,
        );
        expect(css).toMatch(
            /\.track-carousel__unlock-medal \.medal-svg__center-time\s*\{[^}]*font-family:\s*var\(--mono-font\);/s,
        );
        expect(ui).toContain("createLockIconSvg('track-carousel__preview-lock-icon')");
        expect(ui).toContain('preview.append(previewArt, medal, previewLock)');
        expect(ui).toContain('parts.previewLock.hidden = !card.locked');
        expect(lockIcon).toContain("path.setAttribute('fill', 'currentColor')");
        expect(css).toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*width:\s*4\.5rem;[^}]*height:\s*4\.5rem;[^}]*background:\s*rgba\(248,\s*250,\s*252,\s*\.06\);[^}]*color:\s*#fff;/s,
        );
        expect(css).not.toContain('.track-carousel__meter-fill');
    });
});
