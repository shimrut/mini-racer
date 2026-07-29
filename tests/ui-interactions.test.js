import { describe, expect, it, vi } from 'vitest';
import { InteractionsUi } from '../game/race/ui-interactions.js';

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener: vi.fn((eventName, handler) => {
            listeners.set(eventName, handler);
        })
    };
}

describe('ui interaction helpers', () => {
    it('routes the start button through the overlay handler', () => {
        const startBtn = createEventTarget();
        const handleStartAction = vi.fn();
        const ctx = {
            startBtn,
            startOverlay: { handleStartAction },
            onStartDailyChallenge: vi.fn()
        };

        InteractionsUi.prototype.bindPrimaryActions.call(ctx);

        expect(startBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        startBtn.listeners.get('click')();
        expect(handleStartAction).toHaveBeenCalledWith(ctx.onStartDailyChallenge);
    });

    it('routes mobile taps through pointer events when available', () => {
        const originalWindow = global.window;
        const element = createEventTarget();
        const onTap = vi.fn();
        global.window = {
            PointerEvent: class PointerEvent {}
        };

        InteractionsUi.prototype.bindTapAction.call({}, element, onTap);

        const preventDefault = vi.fn();
        element.listeners.get('pointerup')({
            button: 0,
            preventDefault
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onTap).toHaveBeenCalledTimes(1);

        global.window = originalWindow;
    });

    it('closes an open modal when the garage action is used', () => {
        const garageBtn = createEventTarget();
        const closeModal = vi.fn();
        const ctx = {
            menuGarageBtn: garageBtn,
            modal: {
                isModalActive: vi.fn(() => true),
                closeModal
            }
        };

        InteractionsUi.prototype.bindPrimaryActions.call(ctx);

        garageBtn.listeners.get('click')();

        expect(closeModal).toHaveBeenCalledTimes(1);
    });


});
