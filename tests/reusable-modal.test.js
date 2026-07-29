import { describe, expect, it, vi } from 'vitest';
import {
    bindReusableModal,
    handleGlobalEscape,
} from '../game/ui/reusable-modal.js';

describe('reusable modal nested dialogs', () => {
    it('closes the nested dialog on Escape without closing its parent modal', () => {
        const nestedClose = { click: vi.fn() };
        const outerClose = {
            dataset: {},
            addEventListener: vi.fn(),
        };
        const modal = {
            dataset: {},
            querySelector: vi.fn((selector) => {
                if (selector === '[data-modal-close]') return outerClose;
                if (selector === '[data-nested-modal] [data-nested-modal-close]') {
                    return nestedClose;
                }
                return null;
            }),
        };
        const closeParent = vi.fn();
        bindReusableModal(modal, closeParent);

        const originalDocument = global.document;
        global.document = {
            querySelectorAll: vi.fn(() => [modal]),
        };
        const event = {
            key: 'Escape',
            code: 'Escape',
            preventDefault: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };

        handleGlobalEscape(event);

        expect(nestedClose.click).toHaveBeenCalledOnce();
        expect(closeParent).not.toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
        global.document = originalDocument;
    });
});
