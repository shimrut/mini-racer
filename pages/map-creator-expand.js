// Full screen stays on this page; Open Creator asked for this page, and Reddit never showed it.

import { getWebViewMode, requestExpandedMode } from '@devvit/web/client';

export function bindCreatorFullscreen(
    documentRef = document,
    expand = requestExpandedMode,
    mode = getWebViewMode,
) {
    const button = documentRef.getElementById('creator-fullscreen-btn');
    if (!button || button.dataset.bound === '1') return button;
    button.dataset.bound = '1';
    try {
        if (mode() === 'expanded') button.hidden = true;
    } catch {
        button.hidden = true;
    }
    button.addEventListener('click', (event) => {
        try {
            expand(event);
        } catch (error) {
            console.error('Failed to make the Creator full screen:', error);
        }
    });
    return button;
}

if (typeof document !== 'undefined') {
    bindCreatorFullscreen();
}
