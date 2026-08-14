import { presentPlayerChoiceOverlay } from './player-choice-overlay.js';

export async function requestServerSyncFailureChoice({ retry } = {}) {
    if (typeof document === 'undefined' || !document.body) {
        return { action: 'offline' };
    }

    return new Promise((resolve) => {
        const overlay = presentPlayerChoiceOverlay({
            titleId: 'server-sync-failure-title',
            title: 'SERVER SYNCHRONIZATION FAILED',
            message: 'Could not confirm who is signed in. Retry, or continue with the last saved account on this phone.',
            actions: [
                { label: 'RETRY SYNC', choice: 'retry', primary: true },
                { label: 'CONTINUE OFFLINE', choice: 'offline' },
            ],
        });
        overlay.root.classList.add('server-sync-failure');

        const finish = (decision) => {
            overlay.remove();
            resolve(decision);
        };

        const retryButton = overlay.buttons.find((button) => button.dataset.choice === 'retry');
        const offlineButton = overlay.buttons.find((button) => button.dataset.choice === 'offline');

        retryButton?.addEventListener('click', () => {
            void (async () => {
                if (typeof retry !== 'function') {
                    finish({ action: 'retry' });
                    return;
                }
                overlay.setBusy(true);
                overlay.setStatus('Retrying…');
                try {
                    const remoteState = await retry();
                    if (!remoteState) {
                        throw new Error('Player bootstrap returned no state.');
                    }
                    finish({ action: 'synced', remoteState });
                } catch {
                    overlay.setBusy(false);
                    overlay.setStatus('Still could not sync. Try again or continue offline.');
                    retryButton.focus?.();
                }
            })();
        });
        offlineButton?.addEventListener('click', () => finish({ action: 'offline' }));
    });
}
