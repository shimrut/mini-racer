import { describe, expect, it, vi } from 'vitest';
import {
    readVisibleViewportHeight,
    setupVisibleViewportHeight,
} from '../game/ui/visible-viewport.js';

function createEventSource() {
    const listeners = new Map();
    return {
        addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
        removeEventListener: vi.fn((name, listener) => {
            if (listeners.get(name) === listener) listeners.delete(name);
        }),
        dispatch(name) {
            listeners.get(name)?.();
        },
    };
}

describe('visible viewport height', () => {
    it('prefers the visual viewport over the taller layout viewport', () => {
        expect(readVisibleViewportHeight({
            innerHeight: 596,
            visualViewport: { height: 430 },
        })).toBe(430);
    });

    it('falls back to innerHeight when visualViewport is unavailable', () => {
        expect(readVisibleViewportHeight({ innerHeight: 512 })).toBe(512);
        expect(readVisibleViewportHeight({ innerHeight: 0 })).toBeNull();
    });

    it('keeps the root height synchronized as embedded browser chrome changes', () => {
        const rootEvents = createEventSource();
        const visualEvents = createEventSource();
        const root = {
            ...rootEvents,
            innerHeight: 596,
            visualViewport: {
                ...visualEvents,
                height: 430.8,
            },
        };
        const documentRoot = {
            style: {
                setProperty: vi.fn(),
            },
        };

        const cleanup = setupVisibleViewportHeight(root, documentRoot);

        expect(documentRoot.style.setProperty).toHaveBeenLastCalledWith(
            '--app-visible-height',
            '430px',
        );

        root.visualViewport.height = 512.4;
        root.visualViewport.dispatch('resize');

        expect(documentRoot.style.setProperty).toHaveBeenLastCalledWith(
            '--app-visible-height',
            '512px',
        );

        cleanup();
        expect(root.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
        expect(root.visualViewport.removeEventListener).toHaveBeenCalledWith(
            'resize',
            expect.any(Function),
        );
    });
});
