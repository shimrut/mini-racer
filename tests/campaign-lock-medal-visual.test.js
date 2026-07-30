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
        expect(ui).toContain('preview.append(previewArt, previewLock)');
        expect(ui).toContain('parts.previewLock.hidden = !card.locked');
        expect(lockIcon).toContain("path.setAttribute('fill', 'currentColor')");
        expect(lockIcon).toContain("lock.setAttribute('viewBox', '0 -32 384 544')");
        // Steel, at the size the puck was tuned to: the accent is what the lobby
        // spends on the track you can race and the button that starts it.
        expect(css).toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*width:\s*4\.5rem;[^}]*height:\s*4\.5rem;[^}]*background:\s*rgba\(15,\s*23,\s*42,\s*0\.92\);[^}]*color:\s*var\(--text-dim\);/s,
        );
        expect(css).not.toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*background:\s*var\(--accent-color\)/s,
        );
        expect(css).not.toContain('.track-carousel__meter-fill');
    });
});
