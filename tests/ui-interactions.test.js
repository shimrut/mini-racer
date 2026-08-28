import { describe, expect, it, vi } from 'vitest';
import { InteractionsUi } from '../game/race/ui-interactions.js';
import { PAUSE_ON_TIMER_STORAGE_KEY } from '../game/settings/pause-on-timer-preference.js';

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

    it('pauses from the timer and ignores the speedo when pause-on-timer is on', () => {
        const originalWindow = globalThis.window;
        const store = new Map([[PAUSE_ON_TIMER_STORAGE_KEY, '1']]);
        globalThis.window = {
            localStorage: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => store.set(key, String(value)),
            },
        };
        const hudStatsBtn = createEventTarget();
        const speedometer = createEventTarget();
        const onPauseRun = vi.fn();

        InteractionsUi.prototype.bindPrimaryActions.call({
            hudStatsBtn,
            speedometer,
            onPauseRun,
        });

        hudStatsBtn.listeners.get('click')();
        speedometer.listeners.get('click')();

        expect(onPauseRun).toHaveBeenCalledTimes(1);
        globalThis.window = originalWindow;
    });

    it('pauses from the speedo and ignores the timer when pause-on-timer is off', () => {
        const originalWindow = globalThis.window;
        const store = new Map([[PAUSE_ON_TIMER_STORAGE_KEY, '0']]);
        globalThis.window = {
            localStorage: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => store.set(key, String(value)),
            },
        };
        const hudStatsBtn = createEventTarget();
        const speedometer = createEventTarget();
        const onPauseRun = vi.fn();

        InteractionsUi.prototype.bindPrimaryActions.call({
            hudStatsBtn,
            speedometer,
            onPauseRun,
        });

        hudStatsBtn.listeners.get('click')();
        speedometer.listeners.get('click')();

        expect(onPauseRun).toHaveBeenCalledTimes(1);
        globalThis.window = originalWindow;
    });


});
