// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/web/client', () => ({
    getWebViewMode: vi.fn(() => 'inline'),
    requestExpandedMode: vi.fn(),
}));

import { bindCreatorFullscreen } from '../pages/map-creator-expand.js';

describe('Creator full screen', () => {
    it('enlarges this page instead of opening another one', () => {
        document.body.innerHTML = '<button id="creator-fullscreen-btn" type="button">Full screen</button>';
        const expand = vi.fn();
        const button = bindCreatorFullscreen(document, expand, () => 'inline');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(expand).toHaveBeenCalledTimes(1);
        expect(expand.mock.calls[0]).toHaveLength(1);
    });

    it('hides the button when the Creator is already full screen', () => {
        document.body.innerHTML = '<button id="creator-fullscreen-btn" type="button">Full screen</button>';
        const button = bindCreatorFullscreen(document, vi.fn(), () => 'expanded');
        expect(button.hidden).toBe(true);
    });
});
