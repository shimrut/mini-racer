import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartOverlay } from '../game/race/ui-start-overlay.js';

describe('ui start overlay helpers', () => {
    const originalRequestAnimationFrame = global.requestAnimationFrame;

    beforeEach(() => {
        global.requestAnimationFrame = (callback) => {
            callback();
            return 1;
        };
    });

    afterEach(() => {
        global.requestAnimationFrame = originalRequestAnimationFrame;
    });

    it('shows the daily challenge card and enables the start button when the challenge is ready', () => {
        const originalDocument = global.document;
        const bodyClasses = new Set();
        const labelSpan = { textContent: '', innerHTML: '', replaceChildren: vi.fn() };
        const startBtn = {
            style: { display: 'none' },
            disabled: true,
            textContent: '',
            querySelector: (selector) => selector === '.main-menu__label' ? labelSpan : null
        };
        const updateDailyTrackLabel = vi.fn();

        global.document = {
            body: {
                classList: {
                    toggle(className, force) {
                        if (force) bodyClasses.add(className);
                        else bodyClasses.delete(className);
                    }
                }
            },
            createElement: vi.fn(() => ({ className: '', textContent: '' }))
        };
        const dailyChallengeUi = {
            getSummary: vi.fn(() => ({ available: true, trackName: 'Desert Sprint' }))
        };
        const overlay = new StartOverlay({
            dailyChallengeUi,
            getLobbyUi: () => ({ updateDailyTrackLabel }),
        });
        Object.defineProperties(overlay, {
            startOverlay: { value: { style: { display: 'flex' } } },
            startBtn: { value: startBtn }
        });

        overlay.updateStartOverlayMode(false, false);

        expect(startBtn.style.display).toBe('inline-flex');
        expect(startBtn.disabled).toBe(false);
        expect(labelSpan.textContent).toBe('Start Race');
        expect(labelSpan.replaceChildren).not.toHaveBeenCalled();
        expect(updateDailyTrackLabel).toHaveBeenCalledWith('Desert Sprint');
        expect(bodyClasses.has('ftu-onboarding-active')).toBe(false);

        global.document = originalDocument;
    });

    it('shows the overlay container and refreshes its state in one step', () => {
        const originalDocument = global.document;
        const nodes = {
            'start-overlay': { style: { display: 'none' } },
            'start-group': { style: { display: 'none' } }
        };

        global.document = {
            body: {
                classList: { toggle: vi.fn() }
            },
            getElementById: (id) => nodes[id] || null
        };

        const context = {
            setStartSelectionMode: vi.fn()
        };
        const overlay = new StartOverlay(context);
        overlay.setInteractive(true);
        vi.spyOn(overlay, "setStartOverlayActive");
        vi.spyOn(overlay, "updateStartOverlayMode");
        const focusPrimaryAction = vi.fn();
        overlay.focusPrimaryAction = focusPrimaryAction;

        overlay.showStartOverlay(true, false);

        expect(overlay.setStartOverlayActive).toHaveBeenCalledWith(true);
        expect(overlay.updateStartOverlayMode).toHaveBeenCalledWith(true, false);
        expect(focusPrimaryAction).toHaveBeenCalled();

        global.document = originalDocument;
    });

    it('blocks start when no daily challenge exists', () => {
        const originalDocument = global.document;
        const labelSpan = { textContent: '', innerHTML: '' };
        const startBtn = {
            style: { display: 'none' },
            disabled: false,
            textContent: '',
            querySelector: (selector) => selector === '.main-menu__label' ? labelSpan : null
        };
        const updateDailyTrackLabel = vi.fn();

        global.document = {
            body: {
                classList: { toggle: vi.fn() }
            }
        };
        const overlay = new StartOverlay({
            dailyChallengeUi: {
                getSummary: vi.fn(() => null)
            },
            getLobbyUi: () => ({ updateDailyTrackLabel }),
        });
        Object.defineProperties(overlay, {
            startOverlay: { value: { style: { display: 'flex' } } },
            startBtn: { value: startBtn }
        });

        overlay.updateStartOverlayMode(true, true);

        expect(startBtn.disabled).toBe(true);
        expect(labelSpan.textContent).toBe('Challenge unavailable');
        expect(updateDailyTrackLabel).toHaveBeenCalledWith('');

        global.document = originalDocument;
    });

    it('reveals the lobby behind the loader without accepting starts until interactive', () => {
        const originalDocument = global.document;
        const classList = { toggle: vi.fn() };
        global.document = {
            getElementById: (id) => id === 'start-overlay' ? { classList } : null,
        };
        const start = vi.fn();
        const overlay = new StartOverlay();
        Object.defineProperty(overlay, 'startBtn', {
            value: { disabled: false },
        });
        overlay.focusPrimaryAction = vi.fn();

        overlay.setReady(true);
        expect(classList.toggle).toHaveBeenCalledWith('is-ready', true);

        overlay.handleStartAction(start);
        expect(start).not.toHaveBeenCalled();

        overlay.setInteractive(true);
        overlay.handleStartAction(start);
        expect(start).toHaveBeenCalledTimes(1);

        global.document = originalDocument;
    });

});
