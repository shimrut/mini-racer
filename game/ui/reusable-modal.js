const ACTIVE_MODAL_SELECTOR = '.modal.active[data-reusable-modal]';
const CLOSE_SELECTOR = '[data-modal-close]';
const MODAL_CLOSE_ICON_CLASS = 'reusable-modal-close__icon';
const BACK_ICON_PATH = 'M576 320C576 178.6 461.4 64 320 64C178.6 64 64 178.6 64 320C64 461.4 178.6 576 320 576C461.4 576 576 461.4 576 320zM188.7 308.7L292.7 204.7C297.3 200.1 304.2 198.8 310.1 201.2C316 203.6 320 209.5 320 216L320 272L416 272C433.7 272 448 286.3 448 304L448 336C448 353.7 433.7 368 416 368L320 368L320 424C320 430.5 316.1 436.3 310.1 438.8C304.1 441.3 297.2 439.9 292.7 435.3L188.7 331.3C182.5 325.1 182.5 314.9 188.7 308.7z';

export function applyModalCloseButton(closeEl, ariaLabel = 'Close') {
    if (!closeEl) return;
    closeEl.setAttribute('aria-label', ariaLabel);

    if (closeEl.classList.contains('combined-action-btn')) {
        const span = document.createElement('span');
        span.classList.add('combined-action-btn-label');
        span.textContent = ariaLabel;
        closeEl.replaceChildren(span);
        return;
    }

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add(MODAL_CLOSE_ICON_CLASS);
    icon.setAttribute('viewBox', '0 0 640 640');
    icon.setAttribute('fill', 'currentColor');
    icon.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', BACK_ICON_PATH);
    icon.appendChild(path);

    closeEl.replaceChildren(icon);
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
