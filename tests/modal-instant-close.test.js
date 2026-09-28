// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../game/race/ui-modal-shell.js';

const {
    closeModal,
    showPauseResults,
    isModalActive,
    isPauseModalActive,
    setQuickPauseEntrance,
} = ModalShell.prototype;

function createContext() {
    document.body.innerHTML = '<div id="modal" class="modal"><div id="pause-view"></div></div>';
    return {
        modal: document.getElementById('modal'),
        modalPauseView: document.getElementById('pause-view'),
        _modalKind: 'pause',
        isModalActive,
        isPauseModalActive,
        _closeSharePanel: vi.fn(),
        unbindLeaderboardPagination: vi.fn(),
        unbindLeaderboardDaySwipe: vi.fn(),
        cancelLeaderboardRequests: vi.fn(),
        cancelPendingModalClose: vi.fn(),
        _hidePauseTrackPreview: vi.fn(),
        _setActiveView: vi.fn(),
        getDefaultPrimaryAction: vi.fn(() => null),
        releaseModalFocusTrap: vi.fn(),
        _bindClickAction: vi.fn(),
        _syncGarageButtonToPanelState: vi.fn(),
        _syncPauseTrackPreview: vi.fn(),
        resetMenuKeyboardNav: vi.fn(),
        activateModalFocusTrap: vi.fn(),
    };
}

describe('pause menu for a quick restart', () => {
    let frames;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

    function flushFrames() {
        while (frames.length) frames.shift()();
    }

    beforeEach(() => {
        vi.useFakeTimers();
        frames = [];
        globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    });

    afterEach(() => {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('closes with no fade-out and cleans up at once', () => {
        const context = createContext();
        context.modal.classList.add('active', 'modal--pause');
        setQuickPauseEntrance.call(context, true);

        closeModal.call(context, { instant: true });

        expect(context.modal.classList.contains('active')).toBe(false);
        expect(context.modal.classList.contains('modal--instant')).toBe(false);
        expect(context.modal.classList.contains('modal--pause')).toBe(false);
        expect(context.modal.classList.contains('modal--quick-pause')).toBe(false);
        expect(context._modalKind).toBe(null);
        expect(context.releaseModalFocusTrap).toHaveBeenCalledWith(context.modal);
        expect(context._modalCloseFallbackTimer).toBeUndefined();
    });

    it('still waits for the fade-out on a normal close', () => {
        const context = createContext();
        context.modal.classList.add('active', 'modal--pause');

        closeModal.call(context);
        expect(context.modal.classList.contains('active')).toBe(false);
        expect(context.releaseModalFocusTrap).not.toHaveBeenCalled();

        vi.advanceTimersByTime(350);
        expect(context.releaseModalFocusTrap).toHaveBeenCalledWith(context.modal);
    });

    it('turns the quick entrance on and off', () => {
        const context = createContext();

        setQuickPauseEntrance.call(context, true);
        expect(context.modal.classList.contains('modal--quick-pause')).toBe(true);
        setQuickPauseEntrance.call(context, false);
        expect(context.modal.classList.contains('modal--quick-pause')).toBe(false);
    });

    it('traps focus in the pause menu after it paints', () => {
        const context = createContext();

        showPauseResults.call(context, { pauseTrackPreview: { trackKey: 'circuit' } });
        flushFrames();

        expect(context._syncPauseTrackPreview).toHaveBeenCalledTimes(1);
        expect(context.activateModalFocusTrap).toHaveBeenCalledWith(context.modal);
    });

    it('does not trap focus in a pause menu that closed before it painted', () => {
        const context = createContext();

        showPauseResults.call(context, { pauseTrackPreview: { trackKey: 'circuit' } });
        closeModal.call(context, { instant: true });
        flushFrames();

        expect(context._syncPauseTrackPreview).not.toHaveBeenCalled();
        expect(context.activateModalFocusTrap).not.toHaveBeenCalled();
    });
});
