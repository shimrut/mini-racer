import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Campaign locked-stage medal progress visual', () => {
    it('uses stateful medal placeholders for both unlock requirements', () => {
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

        expect(ui).toContain(
            'centerText: meter.remainingMedals',
        );
        expect(ui).toContain('function createRequirementMedalIcon(requirement)');
        expect(ui).toContain("'medal-svg--row-placeholder'");
        expect(ui).toContain("check.setAttribute('d', REQUIREMENT_CHECK_PATH)");
        expect(ui).toContain("check.setAttribute('fill', 'rgb(30, 48, 80)')");
        expect(ui).not.toContain('track-carousel__unlock-medal-progress');
        expect(ui).toContain("createLockIconSvg('track-carousel__preview-lock-icon')");
        expect(ui).toContain(
            "className: 'track-carousel__preview-lock-medal medal-svg--row-placeholder'",
        );
        expect(ui).toContain('previewLock.append(');
        expect(ui).toContain('gate.append(previewLock)');
        expect(ui).toContain('element.append(preview)');
        expect(ui).toContain('this.root.append(this._footParts.foot)');
        expect(ui).not.toContain('head.append(wordmark, billing)');
        expect(ui).toContain('requirement.append(requirementList)');
        expect(ui).not.toContain('Unlock requirements');
        expect(ui).not.toContain('requirement-label');
        expect(ui).toContain("status.className = 'track-carousel__requirement-medal'");
        expect(ui).toContain('status.append(createRequirementMedalIcon(requirement))');
        expect(ui).toContain('foot.append(requirement, meta, verificationError, medal)');
        expect(ui).not.toContain("status.textContent = requirement.satisfied ? '✓' : '•'");
        expect(ui).toContain('preview.append(previewArt, gate)');
        expect(ui).toContain('parts.gate.hidden = !Boolean(card.locked)');
        expect(ui).toContain('parts.meta.hidden = locked || Boolean(verificationError)');
        expect(ui).toContain('parts.medal.hidden = locked');
        expect(lockIcon).toContain("path.setAttribute('fill', 'currentColor')");
        expect(lockIcon).toContain("lock.setAttribute('viewBox', '0 -32 384 544')");
        expect(css).toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*width:\s*4rem;[^}]*height:\s*4rem;[^}]*opacity:\s*1;/s,
        );
        expect(css).toMatch(
            /\.track-carousel__preview-lock-medal\.medal-svg--outline \.medal-svg__shape\s*\{[^}]*fill:\s*#1e3050;[^}]*stroke:\s*#6f83a5;/s,
        );
        expect(css).not.toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*background:\s*rgba\(/s,
        );
        expect(css).not.toMatch(
            /\.track-carousel__preview-lock\s*\{[^}]*clip-path:/s,
        );
        expect(css).toContain('.track-carousel__preview-lock-medal');
        expect(css).toMatch(
            /\.track-carousel \.daily-playlist-entry--hero\.is-locked \.track-carousel__preview-art canvas\s*\{[^}]*opacity:\s*1;[^}]*filter:\s*saturate\(0\.55\)\s+brightness\(0\.78\);/s,
        );
        expect(css).not.toContain('.track-carousel__meter-fill');
        expect(css).toMatch(
            /\.track-carousel__requirement-medal-icon\.medal-svg--outline \.medal-svg__shape,[\s\S]*?stroke:\s*#6f83a5;/s,
        );
        expect(css).toMatch(
            /\.track-carousel__requirement-medal-icon\.is-satisfied \.medal-svg__shape\s*\{[^}]*stroke:\s*var\(--text-color\);[^}]*stroke-dasharray:\s*none;/s,
        );
        expect(css).toMatch(
            /\.track-carousel__requirement-medal-icon \.medal-svg__center-time,[\s\S]*?fill:\s*var\(--text-dim\);[^}]*font-size:\s*220px;/s,
        );
        expect(css).toContain('.track-carousel__requirement-check');
        expect(css).toContain('fill: rgb(30, 48, 80);');
        expect(css).not.toContain('-webkit-mask-image: linear-gradient(');
        expect(css).toMatch(
            /\.track-carousel__requirement-note\s*\{[^}]*color:\s*var\(--text-dim\);[^}]*font-size:\s*clamp\(/s,
        );
    });
});
