export function setText(element, value) {
    if (element) element.textContent = value;
}

export function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}

// Falls back to a hidden field when the Reddit frame blocks the Clipboard API; call before any await.
export async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // Use the text field below.
    }
    const focused = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, text.length);
    try {
        if (!document.execCommand('copy')) throw new Error('The browser refused the copy.');
    } finally {
        field.remove();
        focused?.focus?.();
    }
}

// Each screen blocks Start with its own reason; Start is enabled only when none remain.
const buttonBlocks = new WeakMap();

export function setButtonBlock(button, reason, blocked) {
    if (!button) return;
    const reasons = buttonBlocks.get(button) ?? new Set();
    if (blocked) reasons.add(reason);
    else reasons.delete(reason);
    buttonBlocks.set(button, reasons);
    button.disabled = reasons.size > 0;
}
