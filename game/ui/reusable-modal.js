const ACTIVE_MODAL_SELECTOR = '.modal.active[data-reusable-modal]';
const CLOSE_SELECTOR = '[data-modal-close]';
const MODAL_CLOSE_ICON_HTML = `
<svg class="reusable-modal-close__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true">
    <path d="M320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C178.6 64 64 178.6 64 320C64 461.4 178.6 576 320 576zM231 231C240.4 221.6 255.6 221.6 264.9 231L319.9 286L374.9 231C384.3 221.6 399.5 221.6 408.8 231C418.1 240.4 418.2 255.6 408.8 264.9L353.8 319.9L408.8 374.9C418.2 384.3 418.2 399.5 408.8 408.8C399.4 418.1 384.2 418.2 374.9 408.8L319.9 353.8L264.9 408.8C255.5 418.2 240.3 418.2 231 408.8C221.7 399.4 221.6 384.2 231 374.9L286 319.9L231 264.9C221.6 255.5 221.6 240.3 231 231z"/>
</svg>`;

export function applyModalCloseButton(closeEl, ariaLabel = 'Close') {
    if (!closeEl) return;
    closeEl.setAttribute('aria-label', ariaLabel);
    if (!closeEl.querySelector('.reusable-modal-close__icon')) {
        closeEl.insertAdjacentHTML('beforeend', MODAL_CLOSE_ICON_HTML);
    }
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
