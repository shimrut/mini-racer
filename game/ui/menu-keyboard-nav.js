export const MENU_SELECTED_CLASS = 'is-menu-selected';
export const MENU_KEYBOARD_CUE_CLASS = 'has-keyboard-menu-cue';

function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (typeof Element !== 'undefined' && !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        const type = String(target.type || 'text').toLowerCase();
        // Checkboxes are settings toggles and must stay keyboard-navigable.
        if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') {
            return false;
        }
        return true;
    }
    return Boolean(target.isContentEditable);
}

export function filterVisibleMenuItems(nodes, { requireLaidOut = true } = {}) {
    if (!nodes?.length) return [];
    return Array.from(nodes).filter((node) => {
        if (!node || node.disabled || node.hidden) return false;
        if (node.getAttribute?.('aria-hidden') === 'true') return false;
        if (node.style?.display === 'none') return false;
        if (requireLaidOut && node.offsetParent === null) return false;
        return true;
    });
}

/** @returns {'up'|'down'|'left'|'right'|null} */
export function getMenuNavDirection(key) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return 'up';
    if (key === 'ArrowDown' || key === 's' || key === 'S') return 'down';
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') return 'left';
    if (key === 'ArrowRight' || key === 'd' || key === 'D') return 'right';
    return null;
}

/** @deprecated Use getMenuNavDirection. Kept for vertical-only callers/tests. */
export function getMenuNavDelta(key) {
    const direction = getMenuNavDirection(key);
    if (direction === 'up') return -1;
    if (direction === 'down') return 1;
    return 0;
}

export function collectVisibleActionButtons(container, selector = ':scope > button', {
    requireLaidOut = true,
} = {}) {
    if (!container?.querySelectorAll) return [];
    return filterVisibleMenuItems(container.querySelectorAll(selector), { requireLaidOut });
}

export function findPreferredMenuIndex(buttons) {
    if (!buttons?.length) return -1;
    const primaryIdx = buttons.findIndex((button) => (
        button.classList?.contains?.('main-menu__item--primary')
        || button.classList?.contains?.('combined-action-btn--primary')
    ));
    if (primaryIdx >= 0 && !buttons[primaryIdx].disabled) return primaryIdx;
    return buttons.findIndex((button) => !button.disabled);
}

function getItemCenter(item) {
    if (typeof item?.getBoundingClientRect !== 'function') {
        return null;
    }
    const rect = item.getBoundingClientRect();
    return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
    };
}

/**
 * Pick the nearest item in a screen direction.
 * Prefers items aligned on the cross-axis (same row/column), then closest ahead.
 * @returns {number} index or -1 when nothing lies in that direction
 */
export function findSpatialNeighborIndex(items, currentIndex, direction) {
    if (!items?.length || !direction) return -1;

    if (currentIndex < 0 || currentIndex >= items.length) {
        return direction === 'down' || direction === 'right' ? 0 : items.length - 1;
    }

    const current = getItemCenter(items[currentIndex]);
    if (!current) {
        // Fallback when layout metrics are unavailable (unit tests / detached nodes).
        if (direction === 'up' || direction === 'left') {
            return (currentIndex - 1 + items.length) % items.length;
        }
        if (direction === 'down' || direction === 'right') {
            return (currentIndex + 1) % items.length;
        }
        return -1;
    }

    let bestIndex = -1;
    let bestScore = Infinity;

    for (let i = 0; i < items.length; i += 1) {
        if (i === currentIndex) continue;
        const candidate = getItemCenter(items[i]);
        if (!candidate) continue;

        const dx = candidate.x - current.x;
        const dy = candidate.y - current.y;
        let primary = 0;
        let secondary = 0;
        let inDirection = false;

        if (direction === 'up') {
            inDirection = dy < -1;
            primary = -dy;
            secondary = Math.abs(dx);
        } else if (direction === 'down') {
            inDirection = dy > 1;
            primary = dy;
            secondary = Math.abs(dx);
        } else if (direction === 'left') {
            inDirection = dx < -1;
            primary = -dx;
            secondary = Math.abs(dy);
        } else if (direction === 'right') {
            inDirection = dx > 1;
            primary = dx;
            secondary = Math.abs(dy);
        }

        if (!inDirection) continue;

        // Prefer same row/column, then nearest ahead.
        const score = secondary * 1000 + primary;
        if (score < bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }

    return bestIndex;
}

export function clearMenuSelection(buttons, container = null) {
    if (buttons?.length) {
        for (const button of buttons) {
            button.classList?.remove?.(MENU_SELECTED_CLASS);
        }
    }
    container?.classList?.remove?.(MENU_KEYBOARD_CUE_CLASS);
}

/** Hide the keyboard selection outline after mouse movement. */
export function dismissMenuKeyboardCue(state, buttons = [], {
    container = null,
    preferredIndex = null,
} = {}) {
    if (!state?.keyboardNavActive) return false;
    clearMenuSelection(buttons, container);
    state.keyboardNavActive = false;
    state.selectedIndex = typeof preferredIndex === 'number' && preferredIndex >= 0
        ? preferredIndex
        : findPreferredMenuIndex(buttons);
    return true;
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
 * Directional menu keyboard nav: arrows + WASD move by screen position, Enter activates.
 * Selection cue appears only after the first move key.
 * If nothing lies in that direction, returns false so controls like sliders can handle Left/Right.
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
    const direction = getMenuNavDirection(key);

    if (direction) {
        let index = resolveSelectedIndex(buttons, state, getActiveElement);
        const nextIndex = findSpatialNeighborIndex(buttons, index, direction);
        if (nextIndex < 0) {
            return false;
        }

        event.preventDefault?.();
        event.stopPropagation?.();

        state.selectedIndex = nextIndex;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, nextIndex, { showCue: true, container });
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
