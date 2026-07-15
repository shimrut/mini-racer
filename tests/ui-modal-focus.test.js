import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../game/race/ui-modal-shell.js';

const {
    getModalPreferredFocusTarget,
    handleModalTrapKeydown,
    isPauseEscapeTarget,
    resumePauseFromKeyboard,
} = ModalShell.prototype;

function visibleButton(id) {
    return { id, offsetParent: {} };
}

function hiddenButton(id) {
    return { id, offsetParent: null };
}

describe('modal preferred focus', () => {
    it('focuses resume on pause', () => {
        const resume = visibleButton('resume');
        const context = {
            _modalKind: 'pause',
            modalResumeBtn: resume,
            combinedRestartBtn: visibleButton('restart'),
        };
        expect(getModalPreferredFocusTarget.call(context)).toBe(resume);
    });

    it('focuses improve on win', () => {
        const restart = visibleButton('combined-restart');
        const winContext = {
            _modalKind: 'win',
            modalResumeBtn: visibleButton('resume'),
            combinedRestartBtn: restart,
        };

        expect(getModalPreferredFocusTarget.call(winContext)).toBe(restart);
    });

    it('does not fall back to pause restart when combined restart is hidden', () => {
        const context = {
            _modalKind: 'win',
            modalResumeBtn: visibleButton('resume'),
            combinedRestartBtn: hiddenButton('combined-restart'),
        };
        expect(getModalPreferredFocusTarget.call(context)).toBe(null);
    });
});

describe('modal escape key', () => {
    it('detects the pause race modal as an escape target', () => {
        const modal = {
            id: 'modal',
            classList: { contains: (name) => name === 'active' },
        };
        const context = {
            _modalKind: 'pause',
            isModalActive: () => true,
        };

        expect(isPauseEscapeTarget.call(context, modal)).toBe(true);
        expect(isPauseEscapeTarget.call({ ...context, _modalKind: 'win' }, modal)).toBe(false);
    });

    it('resumes via the stored primary action', () => {
        const primaryAction = vi.fn();
        const context = {
            isPauseModalActive: () => true,
            _modalPrimaryAction: primaryAction,
        };

        expect(resumePauseFromKeyboard.call(context)).toBe(true);
        expect(primaryAction).toHaveBeenCalled();
    });

    it('resumes the race when pause modal is active', () => {
        const resumePauseFromKeyboard = vi.fn(() => true);
        const modal = { id: 'modal' };
        const context = {
            _activeTrapModal: modal,
            _modalKind: 'pause',
            isModalActive: () => true,
            isPauseEscapeTarget: function isPauseEscapeTarget(trapRoot) {
                return ModalShell.prototype.isPauseEscapeTarget.call(this, trapRoot);
            },
            resumePauseFromKeyboard,
            modalCombinedView: { classList: { contains: () => false } },
            modalRunsView: { classList: { contains: () => false } },
        };
        const event = {
            key: 'Escape',
            code: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        handleModalTrapKeydown.call(context, event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(resumePauseFromKeyboard).toHaveBeenCalled();
    });

    it('closes the garage modal on escape', () => {
        const closeBtn = { click: vi.fn() };
        const originalDocument = global.document;
        global.document = {
            getElementById: (id) => (id === 'garage-close-btn' ? closeBtn : null),
        };

        const event = {
            key: 'Escape',
            code: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        try {
            handleModalTrapKeydown.call({
                _activeTrapModal: { id: 'garage-modal' },
                isPauseEscapeTarget: () => false,
                modalCombinedView: { classList: { contains: () => false } },
                modalRunsView: { classList: { contains: () => false } },
            }, event);

            expect(event.preventDefault).toHaveBeenCalled();
            expect(closeBtn.click).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });
});
