import { API_ROUTES, getGuestPlayerToken, getOrCreatePlayerId } from '../scoreboard/api-client.js';
import { presentPlayerChoiceOverlay } from './player-choice-overlay.js';

export const PROGRESS_SELECTION_TIMEOUT_MS = 15_000;

function summaryText(summary) {
    const campaign = Number(summary?.campaignResults) || 0;
    const daily = summary?.hasDailyResults ? 'Daily results saved' : 'No Daily results';
    const unlocks = summary?.unlocks ? 'Unlocks saved' : 'No unlocks saved';
    return `${daily} · ${campaign} Campaign result${campaign === 1 ? '' : 's'} · ${unlocks}`;
}

function sourceBlock(label, detail) {
    const source = document.createElement('div');
    source.className = 'guest-progress-selection__source';
    const heading = document.createElement('strong');
    heading.textContent = label;
    const summary = document.createElement('span');
    summary.textContent = detail;
    source.append(heading, summary);
    return source;
}

export function requestGuestProgressSelection(selection) {
    if (typeof document === 'undefined' || !document.body) {
        return Promise.reject(new Error('Guest progress selection requires the game document.'));
    }

    return new Promise((resolve) => {
        const sources = document.createElement('div');
        sources.className = 'guest-progress-selection__sources';
        sources.append(
            sourceBlock('Guest progress', summaryText(selection?.guestSummary)),
            sourceBlock(
                'Saved account progress',
                selection?.accountHasProgress
                    ? summaryText(selection?.accountSummary)
                    : 'No saved account progress',
            ),
        );

        const overlay = presentPlayerChoiceOverlay({
            titleId: 'guest-progress-selection-title',
            title: 'CHOOSE YOUR PROGRESS',
            message: 'You signed in while this browser had guest progress. Choose which progress to keep.',
            extraNodes: [sources],
            actions: [
                { label: 'USE GUEST PROGRESS', choice: 'guest', primary: true },
                {
                    label: selection?.accountHasProgress ? 'USE SAVED PROGRESS' : 'START FRESH',
                    choice: 'account',
                },
            ],
        });

        const guestButton = overlay.buttons.find((button) => button.dataset.choice === 'guest');
        const accountButton = overlay.buttons.find((button) => button.dataset.choice === 'account');

        const choose = async (choice) => {
            overlay.setBusy(true);
            overlay.setStatus('Saving your choice…');
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = controller
                ? setTimeout(() => controller.abort(), PROGRESS_SELECTION_TIMEOUT_MS)
                : null;
            try {
                const response = await fetch(API_ROUTES.playerProgressSelectionUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    ...(controller ? { signal: controller.signal } : {}),
                    body: JSON.stringify({
                        playerId: getOrCreatePlayerId('guest progress selection'),
                        guestToken: getGuestPlayerToken(),
                        choice,
                    }),
                });
                const body = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(body?.error || `Could not save your choice (${response.status}).`);
                }
                overlay.remove();
                resolve({ choice, playerState: body });
            } catch (error) {
                overlay.setBusy(false);
                overlay.setStatus(error?.name === 'AbortError'
                    ? 'Saving took too long. Try again.'
                    : error?.message || 'Could not save your choice. Try again.');
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
            }
        };
        guestButton?.addEventListener('click', () => void choose('guest'));
        accountButton?.addEventListener('click', () => void choose('account'));
    });
}
