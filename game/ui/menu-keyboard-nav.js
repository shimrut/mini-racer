export const MENU_SELECTED_CLASS = 'is-menu-selected';
export const MENU_KEYBOARD_CUE_CLASS = 'has-keyboard-menu-cue';

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

export function collectVisibleActionButtons(container, selector = ':scope > button', {
    requireLaidOut = true,
} = {}) {
    if (!container?.querySelectorAll) return [];
    return Array.from(container.querySelectorAll(selector)).filter((button) => {
        if (!button || button.disabled || button.hidden) return false;
        if (button.getAttribute?.('aria-hidden') === 'true') return false;
        if (button.style?.display === 'none') return false;
        if (requireLaidOut && button.offsetParent === null) return false;
        return true;
    });
}

export function findPreferredMenuIndex(buttons) {
    if (!buttons?.length) return -1;
    const primaryIdx = buttons.findIndex((button) => (
        button.classList?.contains?.('main-menu__item--primary')
        || button.classList?.contains?.('combined-action-btn--primary')
        || button.classList?.contains?.('result-share-panel__button--primary')
    ));
    if (primaryIdx >= 0 && !buttons[primaryIdx].disabled) return primaryIdx;
    return buttons.findIndex((button) => !button.disabled);
}

export function clearMenuSelection(buttons, container = null) {
    if (buttons?.length) {
        for (const button of buttons) {
            button.classList?.remove?.(MENU_SELECTED_CLASS);
        }
    }
    container?.classList?.remove?.(MENU_KEYBOARD_CUE_CLASS);
}

export function applyMenuSelection(buttons, index, {
    showCue = true,
    container = null,
} = {}) {
    if (!buttons?.length) return null;
    const safeIndex = ((index % buttons.length) + buttons.length) % buttons.length;
    for (let i = 0; i < buttons.length; i += 1) {
        buttons[i].classList?.toggle?.(MENU_SELECTED_CLASS, showCue && i === safeIndex);
    }
    container?.classList?.toggle?.(MENU_KEYBOARD_CUE_CLASS, Boolean(showCue));
    const target = buttons[safeIndex];
    if (typeof target?.focus === 'function') {
        target.focus();
    }
    return target;
}

function resolveSelectedIndex(buttons, state, getActiveElement) {
    if (
        typeof state?.selectedIndex === 'number'
        && state.selectedIndex >= 0
        && state.selectedIndex < buttons.length
    ) {
        return state.selectedIndex;
    }

    const activeElement = getActiveElement();
    const activeIndex = buttons.indexOf(activeElement);
    if (activeIndex >= 0) return activeIndex;

    const markedIndex = buttons.findIndex((button) => (
        button.classList?.contains?.(MENU_SELECTED_CLASS)
    ));
    if (markedIndex >= 0) return markedIndex;

    return findPreferredMenuIndex(buttons);
}

/**
 * Vertical menu keyboard nav: Up/Down/W/S move, Enter activates.
 * Selection cue appears only after the first move key.
 * @returns {boolean} true when the event was handled
 */
export function handleMenuListKeydown(event, {
    buttons,
    state,
    container = null,
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

        let index = resolveSelectedIndex(buttons, state, getActiveElement);
        if (index < 0) {
            index = delta > 0 ? 0 : buttons.length - 1;
        } else {
            index = (index + delta + buttons.length) % buttons.length;
        }

        state.selectedIndex = index;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, index, { showCue: true, container });
        return true;
    }

    if (key === 'Enter') {
        const index = resolveSelectedIndex(buttons, state, getActiveElement);
        const selected = index >= 0 ? buttons[index] : null;
        if (!selected || selected.disabled) return false;

        event.preventDefault?.();
        event.stopPropagation?.();
        selected.click?.();
        return true;
    }

    return false;
}

export function createMenuKeyboardState() {
    return {
        keyboardNavActive: false,
        selectedIndex: -1,
    };
}

export function resetMenuKeyboardState(state, buttons = [], {
    preferredIndex = null,
    container = null,
    focusPreferred = true,
} = {}) {
    clearMenuSelection(buttons, container);
    if (!state) return -1;

    state.keyboardNavActive = false;
    const resolved = typeof preferredIndex === 'number' && preferredIndex >= 0
        ? preferredIndex
        : findPreferredMenuIndex(buttons);
    state.selectedIndex = resolved;

    if (focusPreferred && resolved >= 0 && typeof buttons[resolved]?.focus === 'function') {
        buttons[resolved].focus();
    }

    return resolved;
}
