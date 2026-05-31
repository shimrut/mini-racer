const ACTIVE_MODAL_SELECTOR = '.modal.active[data-reusable-modal]';
const CLOSE_SELECTOR = '[data-modal-close]';
const MODAL_CLOSE_LABEL_CLASS = 'reusable-modal-close__label';

export function applyModalCloseButton(closeEl, ariaLabel = 'Close') {
    if (!closeEl) return;
    closeEl.setAttribute('aria-label', ariaLabel);
    const label = document.createElement('span');
    label.className = MODAL_CLOSE_LABEL_CLASS;
    label.textContent = ariaLabel;
    closeEl.replaceChildren(label);
}

const closeHandlers = new WeakMap();

function getTopActiveModal() {
    if (typeof document === 'undefined') return null;
    if (typeof document.querySelectorAll !== 'function') return null;
    const activeModals = Array.from(document.querySelectorAll(ACTIVE_MODAL_SELECTOR));
    return activeModals.at(-1) || null;
}

function handleGlobalEscape(event) {
    if (event.key !== 'Escape' && event.code !== 'Escape') return;

    const modal = getTopActiveModal();
    if (!modal) return;

    const close = closeHandlers.get(modal);
    if (typeof close !== 'function') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    close();
}

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', handleGlobalEscape, true);
}

export function configureReusableModal(root, {
    title = '',
    subtitle = '',
    closeLabel = 'Close',
} = {}) {
    if (!root) return;

    const titleEl = root.querySelector('[data-modal-title]');
    const subtitleEl = root.querySelector('[data-modal-subtitle]');
    const closeEl = root.querySelector(CLOSE_SELECTOR);

    if (titleEl) {
        titleEl.textContent = title;
    }

    if (subtitleEl) {
        subtitleEl.textContent = subtitle;
        subtitleEl.hidden = !subtitle;
    }

    if (closeEl) {
        applyModalCloseButton(closeEl, closeLabel);
    }
}

export function bindReusableModal(modal, onClose) {
    if (!modal || typeof onClose !== 'function') return;

    modal.dataset.reusableModal = '';
    closeHandlers.set(modal, onClose);

    const closeEl = modal.querySelector(CLOSE_SELECTOR);
    if (!closeEl || closeEl.dataset.modalCloseBound === '1') return;

    closeEl.dataset.modalCloseBound = '1';
    closeEl.addEventListener('click', () => {
        const close = closeHandlers.get(modal);
        close?.();
    });
}
