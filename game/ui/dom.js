export function setText(element, value) {
    if (element) element.textContent = value;
}

export function scheduleAfterModalPaint(callback) {
    requestAnimationFrame(() => {
        requestAnimationFrame(callback);
    });
}
