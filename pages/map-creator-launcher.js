// The post is a small card, like a race preview. Open Creator uses the same
// full-screen open as Race Now, onto the Creator page.

import { requestExpandedMode } from '@devvit/web/client';

export async function openCreator(event, {
    requestExpanded = requestExpandedMode,
    documentRef = document,
} = {}) {
    try {
        await requestExpanded(event, 'map-creator-editor');
        return true;
    } catch (error) {
        console.error('Failed to open the Mini Racer Creator:', error);
        const message = documentRef.getElementById('creator-open-message');
        if (message) {
            message.textContent = 'The Creator did not open. Try again.';
            message.hidden = false;
        }
        return false;
    }
}

if (typeof document !== 'undefined') {
    document.getElementById('creator-open-btn')?.addEventListener('click', (event) => {
        void openCreator(event);
    });
}
