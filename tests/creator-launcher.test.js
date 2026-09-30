// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { openCreator } from '../pages/map-creator-launcher.js';

describe('Creator launcher', () => {
    it('opens the Creator in Reddit\'s full view', async () => {
        const requestExpanded = vi.fn(async () => {});
        const event = new MouseEvent('click');
        expect(await openCreator(event, { requestExpanded })).toBe(true);
        expect(requestExpanded).toHaveBeenCalledWith(event, 'map-creator-editor');
    });

    it('says so when the full view does not open', async () => {
        document.body.innerHTML = '<p id="creator-open-message" hidden></p>';
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const requestExpanded = vi.fn(async () => { throw new Error('blocked'); });
        expect(await openCreator(new MouseEvent('click'), { requestExpanded })).toBe(false);
        const message = document.getElementById('creator-open-message');
        expect(message.hidden).toBe(false);
        expect(message.textContent).toContain('did not open');
    });
});
