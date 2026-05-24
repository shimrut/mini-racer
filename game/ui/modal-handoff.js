const INSTANT_MODAL_CLASS = 'modal--instant';

let modalHandoffDepth = 0;

function hasOtherActiveModal(modal) {
    if (typeof document === 'undefined' || !modal) return false;
    if (typeof document.querySelectorAll !== 'function') return false;

    return Array.from(document.querySelectorAll('.modal.active')).some((activeModal) => activeModal !== modal);
}

export function runModalHandoff(callback) {
    modalHandoffDepth += 1;
    const finishHandoff = () => {
        modalHandoffDepth = Math.max(0, modalHandoffDepth - 1);
    };

    try {
        return callback?.();
    } finally {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(finishHandoff);
        } else {
            finishHandoff();
        }
    }
}

export function openModalElement(modal, open) {
    if (!modal || typeof open !== 'function') return;

    const skipTransition = modalHandoffDepth > 0 || hasOtherActiveModal(modal);
    if (skipTransition) {
        modal.classList.add(INSTANT_MODAL_CLASS);
    }

    open();

    if (skipTransition) {
        modal.offsetHeight;
        modal.classList.remove(INSTANT_MODAL_CLASS);
    }
}

export function closeModalElement(modal, close) {
    if (!modal || typeof close !== 'function') return;

    runModalHandoff(close);
}
