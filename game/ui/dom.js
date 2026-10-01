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
