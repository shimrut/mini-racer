import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { copyTextToClipboard } from '../game/ui/dom.js';

describe('copyTextToClipboard', () => {
    const originalDocument = global.document;
    afterEach(() => {
        global.document = originalDocument;
        vi.unstubAllGlobals();
    });

    function page() {
        const dom = new JSDOM('<button id="copy">Copy Link</button>', { url: 'http://localhost' });
        global.document = dom.window.document;
        dom.window.document.execCommand = vi.fn(() => true);
        return dom.window.document;
    }

    it('uses the Clipboard API when the browser allows it', async () => {
        const doc = page();
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await copyTextToClipboard('https://reddit.com/r/miniracer/comments/challenge1');

        expect(writeText).toHaveBeenCalledWith('https://reddit.com/r/miniracer/comments/challenge1');
        expect(doc.execCommand).not.toHaveBeenCalled();
    });

    it('copies from a hidden text field when the frame refuses the Clipboard API', async () => {
        const doc = page();
        const button = doc.getElementById('copy');
        button.focus();
        let copied = null;
        doc.execCommand = vi.fn(() => {
            copied = doc.querySelector('textarea')?.value ?? null;
            return true;
        });
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) },
        });

        await copyTextToClipboard('https://reddit.com/r/miniracer/comments/challenge1');

        expect(doc.execCommand).toHaveBeenCalledWith('copy');
        expect(copied).toBe('https://reddit.com/r/miniracer/comments/challenge1');
        expect(doc.querySelector('textarea')).toBe(null);
        expect(doc.activeElement).toBe(button);
    });

    it('fails when the browser refuses both ways to copy', async () => {
        const doc = page();
        doc.execCommand = vi.fn(() => false);
        vi.stubGlobal('navigator', {});

        await expect(copyTextToClipboard('link')).rejects.toThrow('The browser refused the copy.');
        expect(doc.querySelector('textarea')).toBe(null);
    });
});
