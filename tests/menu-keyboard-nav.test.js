import { describe, expect, it, vi } from 'vitest';
import {
    MENU_SELECTED_CLASS,
    applyMenuSelection,
    createMenuKeyboardState,
    getMenuNavDelta,
    handleMenuListKeydown,
    resetMenuKeyboardState,
    selectMenuButton,
} from '../game/ui/menu-keyboard-nav.js';

function makeButton(id, { disabled = false } = {}) {
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
        disabled,
        classList,
        focus: vi.fn(),
        click: vi.fn(),
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
    it('maps arrow and wasd keys to deltas', () => {
        expect(getMenuNavDelta('ArrowUp')).toBe(-1);
        expect(getMenuNavDelta('w')).toBe(-1);
        expect(getMenuNavDelta('W')).toBe(-1);
        expect(getMenuNavDelta('ArrowDown')).toBe(1);
        expect(getMenuNavDelta('s')).toBe(1);
        expect(getMenuNavDelta('S')).toBe(1);
        expect(getMenuNavDelta('Enter')).toBe(0);
    });

    it('selects the first item on first ArrowDown when nothing is focused', () => {
        const buttons = [makeButton('a'), makeButton('b'), makeButton('c')];
        const state = createMenuKeyboardState();
        const event = makeEvent('ArrowDown');

        expect(handleMenuListKeydown(event, {
            buttons,
            state,
            getActiveElement: () => null,
        })).toBe(true);

        expect(state.keyboardNavActive).toBe(true);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
        expect(buttons[0].focus).toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it('moves from the focused item and wraps around', () => {
        const buttons = [makeButton('a'), makeButton('b'), makeButton('c')];
        const state = createMenuKeyboardState();

        handleMenuListKeydown(makeEvent('ArrowDown'), {
            buttons,
            state,
            getActiveElement: () => buttons[2],
        });

        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
        expect(buttons[2].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('activates the selected item on Enter', () => {
        const buttons = [makeButton('a'), makeButton('b')];
        const state = createMenuKeyboardState();
        applyMenuSelection(buttons, 1, { showCue: true });
        const event = makeEvent('Enter');

        expect(handleMenuListKeydown(event, {
            buttons,
            state,
            getActiveElement: () => buttons[1],
        })).toBe(true);

        expect(buttons[1].click).toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it('selects a preferred default button with the cue visible', () => {
        const buttons = [makeButton('a'), makeButton('b'), makeButton('c')];
        const state = createMenuKeyboardState();

        selectMenuButton(buttons, buttons[1], state);

        expect(state.keyboardNavActive).toBe(true);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
        expect(buttons[1].focus).toHaveBeenCalled();
    });

    it('clears selection state on reset', () => {
        const buttons = [makeButton('a'), makeButton('b')];
        const state = createMenuKeyboardState();
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 0, { showCue: true });

        resetMenuKeyboardState(state, buttons);

        expect(state.keyboardNavActive).toBe(false);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });
});
