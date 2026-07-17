import { describe, expect, it, vi } from 'vitest';
import {
    MENU_SELECTED_CLASS,
    applyMenuSelection,
    createMenuKeyboardState,
    dismissMenuKeyboardCue,
    findSpatialNeighborIndex,
    getMenuNavDirection,
    handleMenuListKeydown,
    resetMenuKeyboardState,
} from '../game/ui/menu-keyboard-nav.js';

function makeButton(id, { disabled = false, primary = false, rect = null } = {}) {
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
    const button = {
        id,
        disabled,
        classList,
        focus: vi.fn(),
        click: vi.fn(),
    };
    if (rect) {
        button.getBoundingClientRect = () => ({
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            right: rect.x + rect.w,
            bottom: rect.y + rect.h,
        });
    }
    return button;
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
    it('maps arrows and wasd to directions', () => {
        expect(getMenuNavDirection('ArrowUp')).toBe('up');
        expect(getMenuNavDirection('w')).toBe('up');
        expect(getMenuNavDirection('ArrowDown')).toBe('down');
        expect(getMenuNavDirection('s')).toBe('down');
        expect(getMenuNavDirection('ArrowLeft')).toBe('left');
        expect(getMenuNavDirection('a')).toBe('left');
        expect(getMenuNavDirection('ArrowRight')).toBe('right');
        expect(getMenuNavDirection('d')).toBe('right');
        expect(getMenuNavDirection('Enter')).toBe(null);
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

    it('moves with ArrowDown/S and shows the selection cue', () => {
        const buttons = [
            makeButton('standings'),
            makeButton('tracks'),
            makeButton('race', { primary: true }),
        ];
        const state = createMenuKeyboardState();
        resetMenuKeyboardState(state, buttons, { preferredIndex: 2 });

        handleMenuListKeydown(makeEvent('ArrowUp'), {
            buttons,
            state,
            getActiveElement: () => buttons[2],
        });

        expect(state.keyboardNavActive).toBe(true);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[1].classList.contains(MENU_SELECTED_CLASS)).toBe(true);
    });

    it('picks spatial neighbors in a grid with left/right', () => {
        const a = makeButton('a', { rect: { x: 0, y: 0, w: 40, h: 40 } });
        const b = makeButton('b', { rect: { x: 60, y: 0, w: 40, h: 40 } });
        const c = makeButton('c', { rect: { x: 0, y: 60, w: 40, h: 40 } });
        const d = makeButton('d', { rect: { x: 60, y: 60, w: 40, h: 40 } });
        const items = [a, b, c, d];

        expect(findSpatialNeighborIndex(items, 0, 'right')).toBe(1);
        expect(findSpatialNeighborIndex(items, 0, 'down')).toBe(2);
        expect(findSpatialNeighborIndex(items, 1, 'left')).toBe(0);
        expect(findSpatialNeighborIndex(items, 2, 'right')).toBe(3);
        expect(findSpatialNeighborIndex(items, 0, 'left')).toBe(-1);
    });

    it('moves right with D in a laid-out grid', () => {
        const a = makeButton('a', { rect: { x: 0, y: 0, w: 40, h: 40 } });
        const b = makeButton('b', { rect: { x: 60, y: 0, w: 40, h: 40 } });
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;

        expect(handleMenuListKeydown(makeEvent('d'), {
            buttons: [a, b],
            state,
            getActiveElement: () => a,
        })).toBe(true);
        expect(state.selectedIndex).toBe(1);
        expect(b.classList.contains(MENU_SELECTED_CLASS)).toBe(true);
    });

    it('leaves Left/Right unhandled when nothing is beside the current item', () => {
        const top = makeButton('top', { rect: { x: 0, y: 0, w: 40, h: 40 } });
        const bottom = makeButton('bottom', { rect: { x: 0, y: 80, w: 40, h: 40 } });
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;
        const event = makeEvent('ArrowRight');

        expect(handleMenuListKeydown(event, {
            buttons: [top, bottom],
            state,
            getActiveElement: () => top,
        })).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
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

    it('dismisses the cue on mouse movement and restores the preferred index', () => {
        const buttons = [
            makeButton('standings'),
            makeButton('race', { primary: true }),
        ];
        const state = createMenuKeyboardState();
        state.selectedIndex = 0;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, 0, { showCue: true });

        dismissMenuKeyboardCue(state, buttons, { preferredIndex: 1 });

        expect(state.keyboardNavActive).toBe(false);
        expect(state.selectedIndex).toBe(1);
        expect(buttons[0].classList.contains(MENU_SELECTED_CLASS)).toBe(false);
    });

    it('allows navigating when a checkbox switch is focused', () => {
        const checkbox = makeButton('toggle');
        checkbox.tagName = 'INPUT';
        checkbox.type = 'checkbox';
        const close = makeButton('close');
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
