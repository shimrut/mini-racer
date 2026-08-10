export const MENU_SELECTED_CLASS = 'is-menu-selected';
export const MENU_KEYBOARD_CUE_CLASS = 'has-keyboard-menu-cue';

function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (typeof Element !== 'undefined' && !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        const type = String(target.type || 'text').toLowerCase();
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

export function getMenuNavDirection(key) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return 'up';
    if (key === 'ArrowDown' || key === 's' || key === 'S') return 'down';
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') return 'left';
    if (key === 'ArrowRight' || key === 'd' || key === 'D') return 'right';
    return null;
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

export function clearMenuSelection(buttons, container = null) {
    if (buttons?.length) {
        for (const button of buttons) {
            button.classList?.remove?.(MENU_SELECTED_CLASS);
        }
    }
    container?.classList?.remove?.(MENU_KEYBOARD_CUE_CLASS);
}

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
    container = null,
} = {}) {
    if (!buttons?.length) return null;
    const safeIndex = ((index % buttons.length) + buttons.length) % buttons.length;
    for (let i = 0; i < buttons.length; i += 1) {
        buttons[i].classList?.toggle?.(MENU_SELECTED_CLASS, i === safeIndex);
    }
    container?.classList?.add?.(MENU_KEYBOARD_CUE_CLASS);
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

function getItemRect(item) {
    const rect = item?.getBoundingClientRect?.();
    if (!rect) return null;
    const width = Number(rect.width);
    const height = Number(rect.height);
    const left = Number(rect.left);
    const top = Number(rect.top);
    if (![width, height, left, top].every(Number.isFinite)) return null;
    return {
        left,
        right: left + width,
        top,
        bottom: top + height,
        centerX: left + (width / 2),
        centerY: top + (height / 2),
    };
}

function getDirectionalDistance(from, to, direction) {
    const dx = to.centerX - from.centerX;
    const dy = to.centerY - from.centerY;
    const primaryCenterDistance = direction === 'left'
        ? -dx
        : direction === 'right'
            ? dx
            : direction === 'up'
                ? -dy
                : dy;
    const isHorizontal = direction === 'left' || direction === 'right';
    const perpendicularGap = isHorizontal
        ? Math.max(0, from.top - to.bottom, to.top - from.bottom)
        : Math.max(0, from.left - to.right, to.left - from.right);
    const primaryEdgeGap = direction === 'left'
        ? Math.max(0, from.left - to.right)
        : direction === 'right'
            ? Math.max(0, to.left - from.right)
            : direction === 'up'
                ? Math.max(0, from.top - to.bottom)
                : Math.max(0, to.top - from.bottom);

    // Overlapping edges count as aligned, so a wide button below a narrow right-aligned item stays a valid "down" target.
    if (primaryCenterDistance <= 0 || primaryCenterDistance < perpendicularGap) return null;
    return primaryEdgeGap + (perpendicularGap * 2) + (primaryCenterDistance * 0.01);
}

export function findSpatialMenuIndex(items, currentIndex, direction) {
    if (!items?.length || currentIndex < 0 || currentIndex >= items.length) return -1;
    const origin = getItemRect(items[currentIndex]);
    if (!origin) return -1;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < items.length; index += 1) {
        if (index === currentIndex) continue;
        const rect = getItemRect(items[index]);
        if (!rect) continue;
        const distance = getDirectionalDistance(origin, rect, direction);
        if (distance !== null && distance < bestDistance) {
            bestIndex = index;
            bestDistance = distance;
        }
    }
    return bestIndex;
}

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
        const currentIndex = resolveSelectedIndex(buttons, state, getActiveElement);
        const nextIndex = findSpatialMenuIndex(buttons, currentIndex, direction);
        if (nextIndex < 0) {
            if (state.keyboardNavActive || currentIndex < 0) return false;
            event.preventDefault?.();
            event.stopPropagation?.();
            state.keyboardNavActive = true;
            applyMenuSelection(buttons, currentIndex, { container });
            return true;
        }

        event.preventDefault?.();
        event.stopPropagation?.();
        state.selectedIndex = nextIndex;
        state.keyboardNavActive = true;
        applyMenuSelection(buttons, nextIndex, { container });
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
