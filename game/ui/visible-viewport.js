const VISIBLE_HEIGHT_PROPERTY = '--app-visible-height';

function readPositiveHeight(value) {
    const height = Number(value);
    return Number.isFinite(height) && height > 0 ? height : null;
}

export function readVisibleViewportHeight(root = globalThis) {
    return readPositiveHeight(root?.visualViewport?.height)
        ?? readPositiveHeight(root?.innerHeight);
}

export function setupVisibleViewportHeight(root = window, documentRoot = document.documentElement) {
    const syncHeight = () => {
        const height = readVisibleViewportHeight(root);
        if (!height) return;
        documentRoot.style.setProperty(VISIBLE_HEIGHT_PROPERTY, `${Math.floor(height)}px`);
    };

    syncHeight();
    root.addEventListener?.('resize', syncHeight, { passive: true });
    root.visualViewport?.addEventListener?.('resize', syncHeight, { passive: true });

    return () => {
        root.removeEventListener?.('resize', syncHeight);
        root.visualViewport?.removeEventListener?.('resize', syncHeight);
    };
}
