import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPopoverOverlayEscapeDismiss } from '../game/race/ui-modal-content.js';

describe('medal targets overlay', () => {
    const originalDocument = global.document;
    let listeners = [];

    beforeEach(() => {
        listeners = [];
        global.document = {
            addEventListener(type, handler, capture) {
                listeners.push({ type, handler, capture });
            },
            removeEventListener(type, handler, capture) {
                listeners = listeners.filter(
                    (entry) => entry.handler !== handler || entry.capture !== capture,
                );
            },
        };
    });

    afterEach(() => {
        global.document = originalDocument;
    });

    it('dismisses on escape and unbinds the listener', () => {
        const onDismiss = vi.fn();
        const unbind = bindPopoverOverlayEscapeDismiss(onDismiss);

        expect(listeners).toHaveLength(1);
        expect(listeners[0].capture).toBe(true);

        const event = {
            key: 'Escape',
            code: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        listeners[0].handler(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(onDismiss).toHaveBeenCalled();
        expect(listeners).toHaveLength(0);

        unbind();
    });
});
