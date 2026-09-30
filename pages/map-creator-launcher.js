// The Creator post shows this small card in the feed. The Creator itself needs
// the whole screen, so the button opens it in Reddit's full view.

export async function openCreator(event, {
    requestExpanded = null,
    documentRef = document,
} = {}) {
    try {
        const expand = requestExpanded
            || (await import('@devvit/web/client')).requestExpandedMode;
        await expand(event, 'map-creator-editor');
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
