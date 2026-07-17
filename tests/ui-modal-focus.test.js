import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../game/race/ui-modal-shell.js';
import { MENU_SELECTED_CLASS } from '../game/ui/menu-keyboard-nav.js';

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

describe('modal pause/finish menu keyboard nav', () => {
    function makeMenuButton(id, {
        left = 0,
        top = 0,
        width = 100,
        height = 40,
    } = {}) {
        const classList = {
            values: new Set(),
            add(name) { this.values.add(name); },
            remove(name) { this.values.delete(name); },
            contains(name) { return this.values.has(name); },
            toggle(name, force) {
                if (force) this.values.add(name);
                else this.values.delete(name);
                return force;
            },
        };
        return {
            id,
            disabled: false,
            hidden: false,
            offsetParent: {},
            style: {},
            classList,
            focus: vi.fn(),
            click: vi.fn(),
            getAttribute: () => null,
            getBoundingClientRect: () => ({ left, top, width, height }),
        };
    }

    it('moves selection with ArrowDown on pause actions', () => {
        const resume = makeMenuButton('resume', { top: 0 });
        const restart = makeMenuButton('restart', { top: 60 });
        const home = makeMenuButton('home', { top: 120 });
        const buttons = [resume, restart, home];
        const actionsRoot = {
            querySelectorAll: () => buttons,
        };
        const pauseView = {
            classList: { contains: (name) => name === 'active-view' },
            querySelector: () => actionsRoot,
        };
        const state = { keyboardNavActive: false };
        const context = {
            _activeTrapModal: { id: 'modal' },
            _modalKind: 'pause',
            _menuKeyboardState: state,
            isModalActive: () => true,
            isPauseEscapeTarget: () => false,
            isSharePanelOpen: () => false,
            modalPauseView: pauseView,
            modalCombinedView: { classList: { contains: () => false } },
            modalRunsView: { classList: { contains: () => false } },
            getActiveMenuActionsRoot: ModalShell.prototype.getActiveMenuActionsRoot,
        };
        const event = {
            key: 'ArrowDown',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: resume };

        try {
            handleModalTrapKeydown.call(context, event);
            expect(event.preventDefault).toHaveBeenCalled();
            expect(restart.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(restart.focus).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('keeps keyboard nav on the share panel instead of finish actions underneath', () => {
        const closeBtn = makeMenuButton('close');
        const shareBtn = makeMenuButton('share');
        shareBtn.classList.add(MENU_SELECTED_CLASS);
        const finishRoot = {
            querySelectorAll: () => [shareBtn],
        };
        const shareActions = {
            querySelectorAll: (selector) => (selector === 'button' || selector === ':scope > button' ? [closeBtn] : []),
        };
        const sharePanel = {
            querySelector: (selector) => (selector === '.result-share-panel__actions' ? shareActions : null),
            querySelectorAll: (selector) => (selector === 'button' ? [closeBtn] : []),
        };
        const closeSharePanel = vi.fn();
        const shareState = { keyboardNavActive: false, selectedIndex: 0 };
        const finishState = { keyboardNavActive: true, selectedIndex: 0 };
        const context = {
            _activeTrapModal: { id: 'modal' },
            _modalKind: 'win',
            _menuKeyboardState: finishState,
            _shareMenuKeyboardState: shareState,
            isSharePanelOpen: () => true,
            isPauseEscapeTarget: () => false,
            getSharePanelRoot: () => sharePanel,
            getSharePanelButtons: () => [closeBtn],
            getSharePanelActionsContainer: () => shareActions,
            getActiveMenuActionsRoot: () => finishRoot,
            _closeSharePanel: closeSharePanel,
            getFocusables: () => [closeBtn],
        };

        const arrowEvent = {
            key: 'ArrowDown',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: closeBtn };

        try {
            handleModalTrapKeydown.call(context, arrowEvent);
            expect(closeBtn.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(shareBtn.classList.contains(MENU_SELECTED_CLASS)).toBe(true);

            const escapeEvent = {
                key: 'Escape',
                code: 'Escape',
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            };
            handleModalTrapKeydown.call(context, escapeEvent);
            expect(closeSharePanel).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('navigates garage items without touching finish actions', () => {
        const tab = makeMenuButton('tab-skin', { top: 0 });
        const option = makeMenuButton('skin-option', { top: 60 });
        const close = makeMenuButton('close', { top: 120 });
        const garageItems = [tab, option, close];
        const finishShare = makeMenuButton('finish-share');
        finishShare.classList.add(MENU_SELECTED_CLASS);
        const garageState = { keyboardNavActive: false, selectedIndex: 0 };
        const finishState = { keyboardNavActive: true, selectedIndex: 0 };

        const context = {
            _activeTrapModal: { id: 'garage-modal' },
            _garageMenuKeyboardState: garageState,
            _menuKeyboardState: finishState,
            isSharePanelOpen: () => false,
            isPauseEscapeTarget: () => false,
            getGarageMenuItems: () => garageItems,
            getGarageMenuContainer: () => ({ classList: { toggle: vi.fn(), remove: vi.fn() } }),
            getActiveMenuActionsRoot: () => ({ querySelectorAll: () => [finishShare] }),
        };
        const event = {
            key: 'ArrowDown',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: tab };

        try {
            handleModalTrapKeydown.call(context, event);
            expect(option.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(finishShare.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    it('navigates settings items when the settings modal is trapped', () => {
        const switchEl = makeMenuButton('switch', { top: 0 });
        const meter = makeMenuButton('meter', { top: 60 });
        const close = makeMenuButton('close', { top: 120 });
        const settingsItems = [switchEl, meter, close];
        const settingsState = { keyboardNavActive: false, selectedIndex: 0 };
        const context = {
            _activeTrapModal: { id: 'settings-modal' },
            _settingsMenuKeyboardState: settingsState,
            isSharePanelOpen: () => false,
            isPauseEscapeTarget: () => false,
            getSettingsMenuItems: () => settingsItems,
            getSettingsMenuContainer: () => ({ classList: { toggle: vi.fn(), remove: vi.fn() } }),
        };
        const event = {
            key: 'ArrowDown',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: switchEl };

        try {
            handleModalTrapKeydown.call(context, event);
            expect(meter.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(settingsState.keyboardNavActive).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    it('excludes modal dismiss buttons and the settings meter from navigation', () => {
        const skinTab = makeMenuButton('garage-tab-skin');
        const trailsTab = makeMenuButton('garage-tab-trails');
        const skinOption = makeMenuButton('skin-option');
        const garageBack = makeMenuButton('garage-close-btn');
        const skinPanel = {
            hidden: false,
            querySelectorAll: () => [skinOption],
        };
        const trailsPanel = { hidden: true };

        const settingSwitch = makeMenuButton('settings-car-audio-switch');
        const minus = makeMenuButton('settings-collision-restart-delay-minus');
        const meter = makeMenuButton('settings-collision-restart-delay-meter');
        const plus = makeMenuButton('settings-collision-restart-delay-plus');
        const settingsBack = makeMenuButton('settings-back-btn');
        const elements = new Map([
            ['garage-tab-skin', skinTab],
            ['garage-tab-trails', trailsTab],
            ['garage-close-btn', garageBack],
            ['garage-panel-skin', skinPanel],
            ['garage-panel-trails', trailsPanel],
            ['settings-car-audio-switch', settingSwitch],
            ['settings-collision-restart-delay-minus', minus],
            ['settings-collision-restart-delay-meter', meter],
            ['settings-collision-restart-delay-plus', plus],
            ['settings-back-btn', settingsBack],
        ]);
        const originalDocument = global.document;
        global.document = {
            getElementById: (id) => elements.get(id) || null,
        };

        try {
            const garageItems = ModalShell.prototype.getGarageMenuItems.call({});
            expect(garageItems).toEqual([skinTab, trailsTab, skinOption]);
            expect(garageItems).not.toContain(garageBack);

            const settingsItems = ModalShell.prototype.getSettingsMenuItems.call({});
            expect(settingsItems).toEqual([settingSwitch, minus, plus]);
            expect(settingsItems).not.toContain(meter);
            expect(settingsItems).not.toContain(settingsBack);
        } finally {
            global.document = originalDocument;
        }
    });
});
