import { describe, expect, it, vi } from 'vitest';
import {
    MENU_SELECTED_CLASS,
    applyMenuSelection,
    createMenuKeyboardState,
    getMenuNavDelta,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../game/ui/menu-keyboard-nav.js';

function makeButton(id, { disabled = false, primary = false } = {}) {
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

    it('defaults to the preferred item for Enter without showing a cue', () => {
        const buttons = [
            makeButton('standings'),
            makeButton('tracks'),
            makeButton('race', { primary: true }),
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
            makeButton('standings'),
            makeButton('tracks'),
            makeButton('race', { primary: true }),
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
        expect(container.classList.contains('has-keyboard-menu-cue')).toBe(true);
    });

    it('wraps from the last item to the first on ArrowDown', () => {
        const buttons = [makeButton('a'), makeButton('b'), makeButton('c')];
        const state = createMenuKeyboardState();
        state.selectedIndex = 2;

        handleMenuListKeydown(makeEvent('ArrowDown'), {
            buttons,
            state,
            getActiveElement: () => buttons[2],
        });

        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
    });

    it('activates the cued item on Enter', () => {
        const buttons = [makeButton('a'), makeButton('b')];
        const state = createMenuKeyboardState();
        state.selectedIndex = 1;
        state.keyboardNavActive = true;
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

    it('clears the cue on reset while keeping a preferred index', () => {
        const buttons = [makeButton('a'), makeButton('b', { primary: true })];
        const state = createMenuKeyboardState();
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 0, { showCue: true });

        resetMenuKeyboardState(state, buttons, { preferredIndex: 1 });

        expect(state.keyboardNavActive).toBe(false);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });
});
