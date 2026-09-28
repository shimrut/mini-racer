// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import {
    QUICK_RESTART_CLICK_DROP_MS,
    QUICK_RESTART_TAP_RADIUS_PX,
    QUICK_RESTART_TAP_WINDOW_MS,
} from '../game/race/engine-methods.js';

const ENGINE_METHODS = [
    'handlePauseTap',
    'pauseActiveRun',
    'isQuickRestartPauseOpen',
    'openQuickRestartTapWindow',
    'endQuickRestartTapWindow',
    'closeQuickRestartTapWindow',
    'restartFromQuickRestartTap',
    'dropQuickRestartClick',
];

const TAP = { x: 200, y: 520 };

function createEngine({ quickRestartEnabled }) {
    const engine = {
        status: 'playing',
        quickRestartEnabled,
        pauseTapTimer: null,
        quickRestartTapListener: null,
        modal: { active: false, kind: null, quickEntrance: false },
        journeys: { interaction: vi.fn() },
        clearSteeringInput: vi.fn(),
        showPauseModal: vi.fn(),
        restartCurrentRunAfterCollision: vi.fn(),
    };
    for (const name of ENGINE_METHODS) engine[name] = RealTimeRacer.prototype[name];
    engine.modal.isModalActive = () => engine.modal.active;
    engine.modal.isPauseModalActive = () => engine.modal.active && engine.modal.kind === 'pause';
    engine.modal.setQuickPauseEntrance = vi.fn((enabled) => {
        engine.modal.quickEntrance = enabled;
    });
    engine.modal.closeModal = vi.fn(() => {
        engine.modal.active = false;
        engine.modal.kind = null;
    });
    engine.showPauseModal.mockImplementation(() => {
        engine.modal.active = true;
        engine.modal.kind = 'pause';
    });
    engine.restartCurrentRunAfterCollision.mockImplementation(() => {
        engine.status = 'playing';
    });
    return engine;
}

// The pause control, and a pause menu button that the menu puts over it.
function mountButtons(engine) {
    document.body.innerHTML = '<button id="pause"></button><button id="menu-resume"></button>';
    const pause = document.getElementById('pause');
    const resume = document.getElementById('menu-resume');
    const onResume = vi.fn();
    pause.addEventListener('click', (event) => engine.handlePauseTap(event));
    resume.addEventListener('click', onResume);
    return { pause, resume, onResume };
}

function tapClick(target, point = TAP, detail = 1) {
    target.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, detail,
    }));
}

function touch(target, point = TAP) {
    const event = new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
    });
    target.dispatchEvent(event);
    return event;
}

describe('pause tap with quick restart', () => {
    let engines;

    function engineWith(options) {
        const engine = createEngine(options);
        engines.push(engine);
        return engine;
    }

    beforeEach(() => {
        vi.useFakeTimers();
        engines = [];
    });

    afterEach(() => {
        for (const engine of engines) engine.closeQuickRestartTapWindow();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('pauses at once and restarts nothing when quick restart is off', () => {
        const engine = engineWith({ quickRestartEnabled: false });
        const { pause } = mountButtons(engine);

        tapClick(pause);
        expect(engine.status).toBe('paused');
        expect(engine.showPauseModal).toHaveBeenCalledTimes(1);
        expect(engine.modal.setQuickPauseEntrance).not.toHaveBeenCalled();

        touch(document.body);
        vi.advanceTimersByTime(QUICK_RESTART_TAP_WINDOW_MS);
        expect(engine.restartCurrentRunAfterCollision).not.toHaveBeenCalled();
    });

    it('pauses at once and opens the menu with the quick entrance', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause } = mountButtons(engine);

        tapClick(pause);
        expect(engine.status).toBe('paused');
        expect(engine.clearSteeringInput).toHaveBeenCalledTimes(1);
        expect(engine.modal.setQuickPauseEntrance).toHaveBeenCalledWith(true);
        expect(engine.showPauseModal).toHaveBeenCalledTimes(1);
        expect(engine.journeys.interaction).not.toHaveBeenCalled();

        vi.advanceTimersByTime(QUICK_RESTART_TAP_WINDOW_MS);
        expect(engine.modal.quickEntrance).toBe(false);
        expect(engine.journeys.interaction).toHaveBeenCalledWith('pause');
        expect(engine.restartCurrentRunAfterCollision).not.toHaveBeenCalled();
        expect(engine.quickRestartTapListener).toBe(null);
    });

    it('restarts at once when the second touch lands near the first tap, and cuts the menu', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause, resume } = mountButtons(engine);

        tapClick(pause);
        vi.advanceTimersByTime(QUICK_RESTART_TAP_WINDOW_MS - 1);
        const second = touch(resume, { x: TAP.x + 20, y: TAP.y - 20 });

        expect(second.defaultPrevented).toBe(true);
        expect(engine.restartCurrentRunAfterCollision).toHaveBeenCalledTimes(1);
        expect(engine.modal.closeModal).toHaveBeenCalledWith({ instant: true });
        expect(engine.modal.quickEntrance).toBe(false);
        expect(engine.status).toBe('playing');

        vi.advanceTimersByTime(QUICK_RESTART_TAP_WINDOW_MS);
        expect(engine.journeys.interaction).not.toHaveBeenCalled();
    });

    it('drops the click of the restarting touch, so it does not pause the new run', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause, resume, onResume } = mountButtons(engine);

        tapClick(pause);
        touch(pause);
        tapClick(pause);
        expect(engine.status).toBe('playing');
        expect(engine.showPauseModal).toHaveBeenCalledTimes(1);

        tapClick(resume);
        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('stops dropping clicks after a short time when no click follows', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause } = mountButtons(engine);

        tapClick(pause);
        touch(pause);
        vi.advanceTimersByTime(QUICK_RESTART_CLICK_DROP_MS);
        tapClick(pause);

        expect(engine.status).toBe('paused');
        expect(engine.showPauseModal).toHaveBeenCalledTimes(2);
    });

    it('does not restart on a touch far from the first tap, such as a steering thumb', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause } = mountButtons(engine);

        tapClick(pause);
        const far = touch(document.body, { x: TAP.x + QUICK_RESTART_TAP_RADIUS_PX + 1, y: TAP.y });

        expect(far.defaultPrevented).toBe(false);
        expect(engine.restartCurrentRunAfterCollision).not.toHaveBeenCalled();
        expect(engine.status).toBe('paused');
    });

    it('lets the menu work after the window', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause, resume, onResume } = mountButtons(engine);

        tapClick(pause);
        vi.advanceTimersByTime(QUICK_RESTART_TAP_WINDOW_MS);
        touch(resume);
        tapClick(resume);

        expect(onResume).toHaveBeenCalledTimes(1);
        expect(engine.restartCurrentRunAfterCollision).not.toHaveBeenCalled();
    });

    it('lets a touch through when the run left the pause in the window', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause } = mountButtons(engine);

        tapClick(pause);
        engine.status = 'countdown';
        const second = touch(pause);

        expect(second.defaultPrevented).toBe(false);
        expect(engine.restartCurrentRunAfterCollision).not.toHaveBeenCalled();
        expect(engine.quickRestartTapListener).toBe(null);
    });

    it('takes a second touch anywhere after a pause from the keyboard', () => {
        const engine = engineWith({ quickRestartEnabled: true });
        const { pause } = mountButtons(engine);

        tapClick(pause, { x: 0, y: 0 }, 0);
        touch(document.body, { x: 700, y: 40 });

        expect(engine.restartCurrentRunAfterCollision).toHaveBeenCalledTimes(1);
    });

    it('gives the second touch as long as the quick pause menu entrance', () => {
        const foundation = readFileSync(join(process.cwd(), 'styles/foundation.css'), 'utf8');
        const modalStyles = readFileSync(join(process.cwd(), 'styles/modal-and-result-shell.css'), 'utf8');
        const rule = /^#modal\.modal--quick-pause:not\(\.modal--instant\) \{[^}]*\}/m.exec(modalStyles)?.[0] ?? '';

        expect(rule).toContain('transition: opacity var(--dur-quick-pause) ');
        expect(Number(/--dur-quick-pause:\s*(\d+)ms;/.exec(foundation)?.[1])).toBe(QUICK_RESTART_TAP_WINDOW_MS);
    });
});
