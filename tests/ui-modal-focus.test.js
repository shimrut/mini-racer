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

    it('falls back to a visible finish action when Improve is gone', () => {
        const daily = visibleButton('combined-more');
        const context = {
            _modalKind: 'win',
            modalResumeBtn: visibleButton('resume'),
            combinedRestartBtn: hiddenButton('combined-restart'),
            combinedPlaylistBtn: { ...visibleButton('combined-playlist'), disabled: true },
            combinedMoreBtn: daily,
            combinedMenuBtn: visibleButton('combined-menu'),
        };
        expect(getModalPreferredFocusTarget.call(context)).toBe(daily);
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

    it('closes the Garage unlock details before its parent on escape', () => {
        const closeDetails = { click: vi.fn() };
        const closeGarage = { click: vi.fn() };
        const originalDocument = global.document;
        global.document = {
            querySelector: () => ({ querySelector: () => closeDetails }),
            getElementById: () => closeGarage,
        };
        const event = {
            key: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        try {
            handleModalTrapKeydown.call({
                _activeTrapModal: { id: 'garage-modal' },
                isPauseEscapeTarget: () => false,
            }, event);

            expect(closeDetails.click).toHaveBeenCalledOnce();
            expect(closeGarage.click).not.toHaveBeenCalled();
            expect(event.preventDefault).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });
});

describe('modal activation key', () => {
    it('consumes Enter when the active modal has no selected action', () => {
        const event = {
            key: 'Enter',
            code: 'Enter',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        handleModalTrapKeydown.call({
            _activeTrapModal: { id: 'modal-without-actions' },
            getActiveMenuActionsRoot: () => null,
        }, event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
    });

    it.each(['button', 'link'])('allows native Enter on a focused %s outside the Garage menu list', (kind) => {
        const street = { click: vi.fn() };
        const back = { matches: () => true, disabled: false, tagName: kind === 'button' ? 'BUTTON' : 'A' };
        const event = { key: 'Enter', target: back, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        const originalDocument = global.document;
        global.document = { activeElement: back, querySelector: () => null };
        try {
            handleModalTrapKeydown.call({
                _activeTrapModal: { id: 'garage-modal', contains: (node) => node === back },
                _garageMenuKeyboardState: { keyboardNavActive: false, selectedIndex: 0 },
                getGarageMenuItems: () => [street],
                getGarageMenuContainer: () => null,
                getActiveMenuActionsRoot: () => null,
            }, event);
            expect(street.click).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it.each(['disabled', 'outside'])('consumes Enter for a focused action that is %s', (reason) => {
        const focused = { matches: () => true, disabled: reason === 'disabled' };
        const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() };
        const originalDocument = global.document;
        global.document = { activeElement: focused };
        try {
            handleModalTrapKeydown.call({
                _activeTrapModal: { id: 'modal-without-actions', contains: () => reason !== 'outside' },
                getActiveMenuActionsRoot: () => null,
            }, event);
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopPropagation).toHaveBeenCalledOnce();
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
        const plus = makeMenuButton('plus', { top: 60 });
        const close = makeMenuButton('close', { top: 120 });
        const settingsItems = [switchEl, plus, close];
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
            expect(plus.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(settingsState.keyboardNavActive).toBe(true);
        } finally {
            global.document = originalDocument;
        }
    });

    it('navigates track cards in the Tracks modal', () => {
        const firstTrack = makeMenuButton('first-track', { top: 0 });
        const secondTrack = makeMenuButton('second-track', { top: 60 });
        const tracksState = { keyboardNavActive: false, selectedIndex: 0 };
        const context = {
            _activeTrapModal: { id: 'daily-playlist-modal' },
            _tracksMenuKeyboardState: tracksState,
            isSharePanelOpen: () => false,
            isPauseEscapeTarget: () => false,
            getTracksMenuItems: () => [firstTrack, secondTrack],
            getTracksMenuContainer: () => ({
                classList: { toggle: vi.fn(), remove: vi.fn() },
            }),
        };
        const event = {
            key: 's',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: firstTrack };

        try {
            handleModalTrapKeydown.call(context, event);
            expect(secondTrack.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(secondTrack.focus).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('navigates day chips in the Standings modal', () => {
        const firstDay = makeMenuButton('first-day', { left: 0 });
        const secondDay = makeMenuButton('second-day', { left: 120 });
        const standingsState = { keyboardNavActive: false, selectedIndex: 0 };
        const context = {
            _activeTrapModal: { id: 'modal' },
            _standingsMenuKeyboardState: standingsState,
            modalRunsView: { classList: { contains: (name) => name === 'active-view' } },
            isSharePanelOpen: () => false,
            isPauseEscapeTarget: () => false,
            getStandingsMenuItems: () => [firstDay, secondDay],
            getStandingsMenuContainer: () => ({
                classList: { toggle: vi.fn(), remove: vi.fn() },
            }),
        };
        const event = {
            key: 'd',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            target: null,
        };
        const originalDocument = global.document;
        global.document = { activeElement: firstDay };

        try {
            handleModalTrapKeydown.call(context, event);
            expect(secondDay.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(secondDay.focus).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('excludes modal dismiss buttons and the settings meter from navigation', () => {
        const streetTab = makeMenuButton('garage-tab-street');
        const legacyTab = makeMenuButton('garage-tab-legacy');
        const skinOption = makeMenuButton('skin-option');
        const garageBack = makeMenuButton('garage-close-btn');
        const garagePanel = {
            querySelectorAll: () => [streetTab, legacyTab, skinOption, garageBack],
        };

        const settingSwitch = makeMenuButton('settings-car-audio-switch');
        const minus = makeMenuButton('settings-collision-restart-delay-minus');
        const meter = makeMenuButton('settings-collision-restart-delay-meter');
        const plus = makeMenuButton('settings-collision-restart-delay-plus');
        const settingsBack = makeMenuButton('settings-back-btn');
        const elements = new Map([
            ['garage-panel', garagePanel],
            ['garage-close-btn', garageBack],
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
            expect(garageItems).toEqual([streetTab, legacyTab, skinOption]);
            expect(garageItems).not.toContain(garageBack);

            const settingsItems = ModalShell.prototype.getSettingsMenuItems.call({});
            expect(settingsItems).toEqual([settingSwitch, minus, plus]);
            expect(settingsItems).not.toContain(meter);
            expect(settingsItems).not.toContain(settingsBack);
        } finally {
            global.document = originalDocument;
        }
    });

    it('includes car types, preview, paints and shared trails from only the visible Garage panels', () => {
        const tabs = ['street', 'circuit', 'dirt', 'snow', 'water', 'space', 'legacy']
            .map((type) => makeMenuButton(`garage-tab-${type}`));
        const carSelect = makeMenuButton('select-car');
        carSelect.classList.add('garage-car-select');
        const paint = makeMenuButton('body-red');
        const disabledPaint = makeMenuButton('body-disabled');
        disabledPaint.disabled = true;
        const legacyCar = makeMenuButton('legacy-car');
        legacyCar.classList.add('garage-skin-option');
        const trail = makeMenuButton('trail-red');
        trail.classList.add('garage-trail-option');
        const back = makeMenuButton('garage-close-btn');
        const customPanel = { hidden: false };
        const legacyPanel = { hidden: true };
        const customControls = [carSelect, paint, disabledPaint];
        for (const control of customControls) {
            control.closest = () => customPanel.hidden ? customPanel : null;
        }
        legacyCar.closest = () => legacyPanel.hidden ? legacyPanel : null;
        const panel = {
            classList: { add: vi.fn(), remove: vi.fn() },
            querySelectorAll: () => [...tabs, ...customControls, legacyCar, trail, back],
        };
        const originalDocument = global.document;
        global.document = {
            getElementById: (id) => id === 'garage-panel' ? panel : null,
        };

        try {
            const context = {
                _garageMenuKeyboardState: { keyboardNavActive: true, selectedIndex: 0 },
                getGarageMenuItems: ModalShell.prototype.getGarageMenuItems,
                getGarageMenuContainer: ModalShell.prototype.getGarageMenuContainer,
            };
            expect(context.getGarageMenuItems()).toEqual([
                ...tabs, carSelect, paint, trail,
            ]);
            ModalShell.prototype.resetGarageMenuKeyboardNav.call(context, { keepCue: true });
            expect(carSelect.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(carSelect.focus).toHaveBeenCalled();

            customPanel.hidden = true;
            legacyPanel.hidden = false;
            expect(context.getGarageMenuItems()).toEqual([...tabs, legacyCar, trail]);
            ModalShell.prototype.resetGarageMenuKeyboardNav.call(context, { keepCue: true });
            expect(legacyCar.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
            expect(legacyCar.focus).toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it.each([false, true])('keeps the selected Garage tab focused on refresh with cue=%s', (keyboardNavActive) => {
        const street = makeMenuButton('garage-tab-street');
        const space = makeMenuButton('garage-tab-space');
        const carSelect = makeMenuButton('select-car');
        carSelect.classList.add('garage-car-select');
        const state = { keyboardNavActive, selectedIndex: 0 };
        const context = {
            _garageMenuKeyboardState: state,
            getGarageMenuItems: () => [street, space, carSelect],
            getGarageMenuContainer: () => null,
            resetGarageMenuKeyboardNav: ModalShell.prototype.resetGarageMenuKeyboardNav,
        };
        const originalDocument = global.document;
        global.document = { activeElement: space };

        try {
            ModalShell.prototype.onGarageTabChangedForKeyboardNav.call(context);
            expect(state.selectedIndex).toBe(1);
            expect(state.keyboardNavActive).toBe(keyboardNavActive);
            expect(space.focus).toHaveBeenCalledOnce();
            expect(street.focus).not.toHaveBeenCalled();
            expect(carSelect.focus).not.toHaveBeenCalled();
            expect(space.classList.contains(MENU_SELECTED_CLASS)).toBe(keyboardNavActive);
        } finally {
            global.document = originalDocument;
        }
    });

    it('restricts Garage navigation to the nested unlock panel while it is open', () => {
        const closeDetails = makeMenuButton('unlock-details-back');
        const panel = {
            querySelectorAll: () => [closeDetails],
        };
        const originalDocument = global.document;
        global.document = {
            querySelector: () => panel,
            getElementById: vi.fn(),
        };

        try {
            expect(ModalShell.prototype.getGarageMenuItems.call({})).toEqual([closeDetails]);
            expect(ModalShell.prototype.getGarageMenuContainer.call({})).toBe(panel);
            expect(global.document.getElementById).not.toHaveBeenCalled();
        } finally {
            global.document = originalDocument;
        }
    });

    it('keeps the Tracks tabs in keyboard navigation with only the active panel cards', () => {
        const dailyTab = makeMenuButton('tracks-tab-daily');
        const campaignTab = makeMenuButton('tracks-tab-campaign');
        const dailyTrack = makeMenuButton('daily-track');
        const campaignTrack = makeMenuButton('campaign-track');
        const dailyPanel = {
            hidden: false,
            querySelectorAll: () => [dailyTrack],
        };
        const campaignPanel = {
            hidden: true,
            querySelectorAll: () => [campaignTrack],
        };
        const elements = new Map([
            ['tracks-tab-daily', dailyTab],
            ['tracks-tab-campaign', campaignTab],
            ['daily-playlist-list', dailyPanel],
            ['campaign-playlist-list', campaignPanel],
        ]);
        const originalDocument = global.document;
        global.document = {
            getElementById: (id) => elements.get(id) || null,
        };

        try {
            const context = {
                getTracksMenuContainer: ModalShell.prototype.getTracksMenuContainer,
            };
            expect(ModalShell.prototype.getTracksMenuItems.call(context)).toEqual([
                dailyTab,
                campaignTab,
                dailyTrack,
            ]);

            dailyPanel.hidden = true;
            campaignPanel.hidden = false;
            expect(ModalShell.prototype.getTracksMenuItems.call(context)).toEqual([
                dailyTab,
                campaignTab,
                campaignTrack,
            ]);
        } finally {
            global.document = originalDocument;
        }
    });
});
