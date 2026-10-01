export function setText(element, value) {
    if (element) element.textContent = value;
}

export function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}

// Copies the text to the clipboard. Inside the Reddit frame, the browser can
// refuse the Clipboard API. Then the copy uses a hidden text field. Call this
// directly from the click, before any await, so that the click still counts.
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

// Several screens set the state of one Start button. Each one blocks or frees
// it with its own reason, and the button is enabled only when no reason is
// left. So no screen can enable a Start that another screen still blocks.
const buttonBlocks = new WeakMap();

export function setButtonBlock(button, reason, blocked) {
    if (!button) return;
    const reasons = buttonBlocks.get(button) ?? new Set();
    if (blocked) reasons.add(reason);
    else reasons.delete(reason);
    buttonBlocks.set(button, reasons);
    button.disabled = reasons.size > 0;
}
