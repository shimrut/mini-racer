import { describe, expect, it, vi } from 'vitest';
import {
    MENU_SELECTED_CLASS,
    applyMenuSelection,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    findSpatialMenuIndex,
    getMenuNavDirection,
    handleMenuListKeydown,
    isNativeActionTarget,
    resetMenuKeyboardState,
} from '../game/ui/menu-keyboard-nav.js';

function makeButton(id, {
    disabled = false,
    primary = false,
    rect = { left: 0, top: 0, width: 100, height: 40 },
} = {}) {
    const classNames = new Set(primary ? ['main-menu__item--primary'] : []);
    const classList = {
        values: classNames,
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
        disabled,
        classList,
        focus: vi.fn(),
        click: vi.fn(),
        getBoundingClientRect: () => rect,
    };
}

function makeEvent(key, extras = {}) {
    return {
        key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: null,
        ...extras,
    };
}

describe('menu keyboard nav helper', () => {
    it('maps arrow and WASD keys to spatial directions', () => {
        expect(getMenuNavDirection('ArrowUp')).toBe('up');
        expect(getMenuNavDirection('w')).toBe('up');
        expect(getMenuNavDirection('ArrowDown')).toBe('down');
        expect(getMenuNavDirection('S')).toBe('down');
        expect(getMenuNavDirection('ArrowLeft')).toBe('left');
        expect(getMenuNavDirection('a')).toBe('left');
        expect(getMenuNavDirection('ArrowRight')).toBe('right');
        expect(getMenuNavDirection('D')).toBe('right');
        expect(getMenuNavDirection('Enter')).toBe(null);
    });

    it('defaults to the preferred item for Enter without showing a cue', () => {
        const buttons = [
            makeButton('standings', { rect: { left: 0, top: 0, width: 100, height: 40 } }),
            makeButton('tracks', { rect: { left: 0, top: 50, width: 100, height: 40 } }),
            makeButton('race', {
                primary: true,
                rect: { left: 0, top: 100, width: 100, height: 40 },
            }),
        ];
        const state = createMenuKeyboardState();
        resetMenuKeyboardState(state, buttons, { preferredIndex: 2 });

        expect(state.keyboardNavActive).toBe(false);
        expect(state.selectedIndex).toBe(2);
        expect(buttons[2].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
        expect(buttons[2].focus).toHaveBeenCalled();

        const event = makeEvent('Enter');
        expect(handleMenuListKeydown(event, {
            buttons,
            state,
            getActiveElement: () => null,
        })).toBe(true);
        expect(buttons[2].click).toHaveBeenCalled();
        expect(buttons[2].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('shows the selection cue only after the first move key', () => {
        const buttons = [
            makeButton('standings', { rect: { left: 0, top: 0, width: 100, height: 40 } }),
            makeButton('tracks', { rect: { left: 0, top: 50, width: 100, height: 40 } }),
            makeButton('race', {
                primary: true,
                rect: { left: 0, top: 100, width: 100, height: 40 },
            }),
        ];
        const state = createMenuKeyboardState();
        const container = {
            classList: {
                values: new Set(),
                add(name) { this.values.add(name); },
                remove(name) { this.values.delete(name); },
                contains(name) { return this.values.has(name); },
                toggle(name, force) {
                    if (force) this.values.add(name);
                    else this.values.delete(name);
                    return force;
                },
            },
        };
        resetMenuKeyboardState(state, buttons, { preferredIndex: 2, container });

        handleMenuListKeydown(makeEvent('ArrowUp'), {
            buttons,
            state,
            container,
            getActiveElement: () => buttons[2],
        });

        expect(state.keyboardNavActive).toBe(true);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
        expect(buttons[2].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('does not wrap when there is no control in the pressed direction', () => {
        const buttons = [
            makeButton('a', { rect: { left: 0, top: 0, width: 100, height: 40 } }),
            makeButton('b', { rect: { left: 0, top: 50, width: 100, height: 40 } }),
            makeButton('c', { rect: { left: 0, top: 100, width: 100, height: 40 } }),
        ];
        const state = createMenuKeyboardState();
        state.selectedIndex = 2;
        state.keyboardNavActive = true;

        expect(handleMenuListKeydown(makeEvent('ArrowDown'), {
            buttons,
            state,
            getActiveElement: () => buttons[2],
        })).toBe(false);

        expect(state.selectedIndex).toBe(2);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('shows the current preferred control when navigation starts at an edge', () => {
        const start = makeButton('race', {
            primary: true,
            rect: { left: 0, top: 100, width: 300, height: 60 },
        });
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;

        expect(handleMenuListKeydown(makeEvent('ArrowDown'), {
            buttons: [start],
            state,
            getActiveElement: () => start,
        })).toBe(true);
        expect(start.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
    });

    it('moves through a grid using actual control positions', () => {
        const buttons = [
            makeButton('top-left', { rect: { left: 0, top: 0, width: 80, height: 40 } }),
            makeButton('top-right', { rect: { left: 100, top: 0, width: 80, height: 40 } }),
            makeButton('bottom-left', { rect: { left: 0, top: 60, width: 80, height: 40 } }),
            makeButton('bottom-right', { rect: { left: 100, top: 60, width: 80, height: 40 } }),
        ];

        expect(findSpatialMenuIndex(buttons, 0, 'right')).toBe(1);
        expect(findSpatialMenuIndex(buttons, 0, 'down')).toBe(2);
        expect(findSpatialMenuIndex(buttons, 3, 'left')).toBe(2);
        expect(findSpatialMenuIndex(buttons, 3, 'up')).toBe(1);
    });

    it('moves down to a wide button whose horizontal bounds overlap', () => {
        const buttons = [
            makeButton('settings', {
                rect: { left: 220, top: 0, width: 80, height: 40 },
            }),
            makeButton('race', {
                primary: true,
                rect: { left: 0, top: 70, width: 300, height: 60 },
            }),
        ];

        expect(findSpatialMenuIndex(buttons, 0, 'down')).toBe(1);
    });

    it('activates the cued item on Enter', () => {
        const buttons = [makeButton('a'), makeButton('b')];
        const state = createMenuKeyboardState();
        state.selectedIndex = 1;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 1);
        const event = makeEvent('Enter');

        expect(handleMenuListKeydown(event, {
            buttons,
            state,
            getActiveElement: () => buttons[1],
        })).toBe(true);

        expect(buttons[1].click).toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it.each([false, true])('activates native focus instead of the remembered item with cue=%s', (keyboardNavActive) => {
        const buttons = [makeButton('street'), makeButton('blue-paint')];
        const state = { keyboardNavActive, selectedIndex: 0 };
        if (keyboardNavActive) applyMenuSelection(buttons, 0);

        expect(handleMenuListKeydown(makeEvent('Enter', { target: buttons[1] }), {
            buttons, state, getActiveElement: () => buttons[1],
        })).toBe(true);

        expect(buttons[0].click).not.toHaveBeenCalled();
        expect(buttons[1].click).toHaveBeenCalledOnce();
        expect(state.selectedIndex).toBe(1);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(keyboardNavActive);
    });

    it.each([false, true])('moves from native focus instead of the remembered row with cue=%s', (keyboardNavActive) => {
        const buttons = [
            makeButton('street', { rect: { left: 0, top: 0, width: 40, height: 40 } }),
            makeButton('blue-paint', { rect: { left: 0, top: 80, width: 40, height: 40 } }),
            makeButton('next-paint', { rect: { left: 60, top: 80, width: 40, height: 40 } }),
            makeButton('circuit', { rect: { left: 60, top: 0, width: 40, height: 40 } }),
        ];
        const state = { keyboardNavActive, selectedIndex: 0 };
        if (keyboardNavActive) applyMenuSelection(buttons, 0);

        expect(handleMenuListKeydown(makeEvent('ArrowRight', { target: buttons[1] }), {
            buttons, state, getActiveElement: () => buttons[1],
        })).toBe(true);

        expect(state.selectedIndex).toBe(2);
        expect(buttons[2].focus).toHaveBeenCalledOnce();
        expect(buttons[3].focus).not.toHaveBeenCalled();
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('clears a previous arrow cue for native Tab without consuming Tab', () => {
        const buttons = [makeButton('street'), makeButton('blue-paint')];
        const state = { keyboardNavActive: true, selectedIndex: 0 };
        applyMenuSelection(buttons, 0);
        const event = makeEvent('Tab');

        expect(handleMenuListKeydown(event, {
            buttons, state, getActiveElement: () => buttons[0],
        })).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(state.keyboardNavActive).toBe(false);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);

        handleMenuListKeydown(makeEvent('Enter', { target: buttons[1] }), {
            buttons, state, getActiveElement: () => buttons[1],
        });
        expect(buttons[1].click).toHaveBeenCalledOnce();
        expect(buttons[0].click).not.toHaveBeenCalled();
    });

    it.each(['button', 'link'])('leaves a focused native %s outside the menu list to its own handler', (kind) => {
        const buttons = [makeButton('street')];
        const back = { matches: () => true, click: vi.fn(), tagName: kind === 'button' ? 'BUTTON' : 'A' };
        const state = { keyboardNavActive: false, selectedIndex: 0 };
        const event = makeEvent('Enter', { target: back });

        expect(handleMenuListKeydown(event, { buttons, state, getActiveElement: () => back })).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(buttons[0].click).not.toHaveBeenCalled();
        expect(back.click).not.toHaveBeenCalled();
    });

    it('does not assume a role-button element has native Enter activation', () => {
        const roleButton = { matches: (selector) => selector.includes('[role="button"]') };
        expect(isNativeActionTarget(roleButton)).toBe(false);
    });

    it('clears the cue on reset while keeping a preferred index', () => {
        const buttons = [makeButton('a'), makeButton('b', { primary: true })];
        const state = createMenuKeyboardState();
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 0);

        resetMenuKeyboardState(state, buttons, { preferredIndex: 1 });

        expect(state.keyboardNavActive).toBe(false);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('dismisses the cue on mouse movement and restores the preferred index', () => {
        const buttons = [
            makeButton('standings'),
            makeButton('race', { primary: true }),
        ];
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 0);

        dismissMenuKeyboardCue(state, buttons, { preferredIndex: 1 });

        expect(state.keyboardNavActive).toBe(false);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('allows navigating when a checkbox switch is focused', () => {
        const checkbox = makeButton('toggle', {
            rect: { left: 0, top: 0, width: 100, height: 40 },
        });
        checkbox.tagName = 'INPUT';
        checkbox.type = 'checkbox';
        const close = makeButton('close', {
            rect: { left: 0, top: 50, width: 100, height: 40 },
        });
        const buttons = [checkbox, close];
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;
        const event = makeEvent('ArrowDown', { target: checkbox });

        expect(handleMenuListKeydown(event, {
            buttons,
            state,
            getActiveElement: () => checkbox,
        })).toBe(true);
        expect(close.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
    });

    it('activates a checkbox with Enter', () => {
        const checkbox = makeButton('toggle');
        checkbox.tagName = 'INPUT';
        checkbox.type = 'checkbox';
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;
        const event = makeEvent('Enter', { target: checkbox });

        expect(handleMenuListKeydown(event, {
            buttons: [checkbox],
            state,
            getActiveElement: () => checkbox,
        })).toBe(true);
        expect(checkbox.click).toHaveBeenCalled();
    });
});
