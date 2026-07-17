export const MENU_SELECTED_CLASS = 'is-menu-selected';

function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (typeof Element !== 'undefined' && !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return Boolean(target.isContentEditable);
}

export function getMenuNavDelta(key) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return -1;
    if (key === 'ArrowDown' || key === 's' || key === 'S') return 1;
    return 0;
}

export function collectVisibleActionButtons(container, selector = ':scope > button') {
    if (!container?.querySelectorAll) return [];
    return Array.from(container.querySelectorAll(selector)).filter((button) => {
        if (!button || button.disabled || button.hidden) return false;
        if (button.getAttribute?.('aria-hidden') === 'true') return false;
        if (button.style?.display === 'none') return false;
        if (button.offsetParent === null) return false;
        return true;
    });
}

export function clearMenuSelection(buttons) {
    if (!buttons?.length) return;
    for (const button of buttons) {
        button.classList?.remove?.(MENU_SELECTED_CLASS);
    }
}

export function applyMenuSelection(buttons, index, { showCue = true } = {}) {
    if (!buttons?.length) return null;
    const safeIndex = ((index % buttons.length) + buttons.length) % buttons.length;
    for (let i = 0; i < buttons.length; i += 1) {
        buttons[i].classList?.toggle?.(MENU_SELECTED_CLASS, showCue && i === safeIndex);
    }
    const target = buttons[safeIndex];
    if (typeof target?.focus === 'function') {
        target.focus();
    }
    return target;
}

export function selectMenuButton(buttons, targetButton, state = null) {
    if (!buttons?.length || !targetButton) return null;
    const index = buttons.indexOf(targetButton);
    if (index < 0) return null;
    if (state) state.keyboardNavActive = true;
    return applyMenuSelection(buttons, index, { showCue: true });
}

/**
 * Vertical menu keyboard nav: Up/Down/W/S move, Enter activates.
 * @returns {boolean} true when the event was handled
 */
export function handleMenuListKeydown(event, {
    buttons,
    state,
    getActiveElement = () => (typeof document !== 'undefined' ? document.activeElement : null),
} = {}) {
    if (!event || !buttons?.length || !state) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (isEditableTarget(event.target)) return false;

    const key = event.key;
    const delta = getMenuNavDelta(key);

    if (delta !== 0) {
        event.preventDefault?.();
        event.stopPropagation?.();

        const activeElement = getActiveElement();
        let index = buttons.indexOf(activeElement);
        if (index < 0) {
            index = buttons.findIndex((button) => button.classList?.contains?.(MENU_SELECTED_CLASS));
        }

        if (index < 0) {
            index = delta > 0 ? 0 : buttons.length - 1;
        } else {
            index = (index + delta + buttons.length) % buttons.length;
        }

        state.keyboardNavActive = true;
        applyMenuSelection(buttons, index, { showCue: true });
        return true;
    }

    if (key === 'Enter') {
        const activeElement = getActiveElement();
        const selected = buttons.find((button) => button.classList?.contains?.(MENU_SELECTED_CLASS))
            || (buttons.includes(activeElement) ? activeElement : null);
        if (!selected || selected.disabled) return false;

        event.preventDefault?.();
        event.stopPropagation?.();
        selected.click?.();
        return true;
    }

    return false;
}

export function createMenuKeyboardState() {
    return { keyboardNavActive: false };
}

export function resetMenuKeyboardState(state, buttons = []) {
    if (state) state.keyboardNavActive = false;
    clearMenuSelection(buttons);
}
