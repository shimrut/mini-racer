// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/web/client', () => ({
    requestExpandedMode: vi.fn(),
}));

import { openCreator } from '../pages/map-creator-launcher.js';

describe('Creator launcher', () => {
    it('opens the Creator full screen the same way a race opens', async () => {
        const requestExpanded = vi.fn();
        const event = new MouseEvent('click');
        expect(await openCreator(event, { requestExpanded })).toBe(true);
        expect(requestExpanded).toHaveBeenCalledWith(event, 'map-creator-editor');
    });

    it('says so when the full screen does not open', async () => {
        document.body.innerHTML = '<p id="creator-open-message" hidden></p>';
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const requestExpanded = vi.fn(() => { throw new Error('blocked'); });
        expect(await openCreator(new MouseEvent('click'), { requestExpanded })).toBe(false);
        const message = document.getElementById('creator-open-message');
        expect(message.hidden).toBe(false);
        expect(message.textContent).toContain('did not open');
    });
});
