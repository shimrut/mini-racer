import { describe, expect, it, vi } from 'vitest';
import { InteractionsUi } from '../game/race/ui-interactions.js';
import { PAUSE_PLACEMENT_STORAGE_KEY } from '../game/settings/pause-placement-preference.js';

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener: vi.fn((eventName, handler) => {
            listeners.set(eventName, handler);
        })
    };
}

function withPausePlacement(placement, run) {
    const originalWindow = globalThis.window;
    const store = new Map([[PAUSE_PLACEMENT_STORAGE_KEY, placement]]);
    globalThis.window = {
        localStorage: {
            getItem: (key) => store.get(key) ?? null,
            setItem: (key, value) => store.set(key, String(value)),
        },
    };
    try {
        run();
    } finally {
        globalThis.window = originalWindow;
    }
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

    it('pauses from the timer and ignores the speedo when pause is on the timer', () => {
        withPausePlacement('timer', () => {
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
        });
    });

    it('pauses from the speedo and ignores the timer when pause is on the speedo', () => {
        withPausePlacement('speedo', () => {
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
        });
    });

    it('ignores timer and speedo taps when pause is separate', () => {
        withPausePlacement('separate', () => {
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

            expect(onPauseRun).not.toHaveBeenCalled();
        });
    });
});

function createSteeringButton() {
    const button = createEventTarget();
    const classes = new Set();
    button.classList = {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
    };
    button.setPointerCapture = vi.fn();
    button.hasPointerCapture = vi.fn(() => false);
    return button;
}

function withSteering({ touchEvents = true } = {}, run) {
    const originalWindow = globalThis.window;
    const page = createEventTarget();
    page.PointerEvent = function PointerEvent() {};
    if (touchEvents) page.ontouchstart = null;
    globalThis.window = page;
    try {
        const left = createSteeringButton();
        const right = createSteeringButton();
        const ui = Object.create(InteractionsUi.prototype, {
            leftTouchBtn: { value: left },
            rightTouchBtn: { value: right },
        });
        const steer = { left: false, right: false };
        ui.bindSteeringControls({
            onLeftDown: () => { steer.left = true; },
            onLeftUp: () => { steer.left = false; },
            onRightDown: () => { steer.right = true; },
            onRightUp: () => { steer.right = false; },
        });
        // Touch events go to the first-touched element, then the page; `down` is the browser's fingers after it.
        const touch = (button, type, id, down) => {
            const event = {
                changedTouches: [{ identifier: id }],
                touches: down.map((identifier) => ({ identifier })),
                cancelable: true,
                preventDefault: vi.fn(),
            };
            button?.listeners.get(type)?.(event);
            page.listeners.get(type)(event);
        };
        const pointer = (button, type, pointerType) => {
            button.listeners.get(type)({
                pointerType,
                pointerId: 1,
                button: 0,
                preventDefault: vi.fn(),
            });
        };
        run({ ui, left, right, steer, touch, pointer });
    } finally {
        globalThis.window = originalWindow;
    }
}

describe('steering controls', () => {
    it('turns while a finger is down on a side', () => {
        withSteering({}, ({ left, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            expect(steer.left).toBe(true);
            expect(left.classList.contains('active')).toBe(true);

            touch(left, 'touchend', 1, []);
            expect(steer.left).toBe(false);
            expect(left.classList.contains('active')).toBe(false);
        });
    });

    it('stops a turn at the next touch in the page when the browser drops a lost lift', () => {
        withSteering({}, ({ left, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            // The lift of finger 1 is lost, and the browser does not list it.
            touch(null, 'touchstart', 2, [2]);

            expect(steer.left).toBe(false);
        });
    });

    it('stops a turn at the next touch on the other side when the browser drops a lost lift', () => {
        withSteering({}, ({ left, right, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            touch(right, 'touchstart', 2, [2]);

            expect(steer.left).toBe(false);
            expect(steer.right).toBe(true);
        });
    });

    it('stops a turn at the next lift on that side when the browser still lists a lost finger', () => {
        withSteering({}, ({ left, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            touch(left, 'touchstart', 2, [1, 2]);
            expect(steer.left).toBe(true);

            touch(left, 'touchend', 2, [1]);
            expect(steer.left).toBe(false);
        });
    });

    it('keeps turning when the first of two fingers on a side lifts', () => {
        withSteering({}, ({ left, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            touch(left, 'touchstart', 2, [1, 2]);
            touch(left, 'touchend', 1, [2]);
            expect(steer.left).toBe(true);

            touch(left, 'touchend', 2, []);
            expect(steer.left).toBe(false);
        });
    });

    it('does not steer from a finger held through a clear, but steers from a new finger', () => {
        withSteering({}, ({ ui, left, steer, touch }) => {
            touch(left, 'touchstart', 1, [1]);
            // The engine clears its own steering, then the controls.
            steer.left = false;
            ui.resetTouchControls();
            expect(left.classList.contains('active')).toBe(false);

            touch(left, 'touchmove', 1, [1]);
            expect(steer.left).toBe(false);

            touch(left, 'touchstart', 2, [1, 2]);
            expect(steer.left).toBe(true);

            touch(left, 'touchend', 1, [2]);
            expect(steer.left).toBe(true);

            touch(left, 'touchend', 2, []);
            expect(steer.left).toBe(false);
        });
    });

    it('steers from a mouse, but not from the pointer events of a finger', () => {
        withSteering({}, ({ left, steer, pointer }) => {
            pointer(left, 'pointerdown', 'touch');
            expect(steer.left).toBe(false);

            pointer(left, 'pointerdown', 'mouse');
            expect(steer.left).toBe(true);

            pointer(left, 'pointerup', 'mouse');
            expect(steer.left).toBe(false);
        });
    });

    it('steers fingers from pointer events when the browser has no touch events', () => {
        withSteering({ touchEvents: false }, ({ left, steer, pointer }) => {
            pointer(left, 'pointerdown', 'touch');
            expect(steer.left).toBe(true);

            pointer(left, 'pointerup', 'touch');
            expect(steer.left).toBe(false);
        });
    });
});
