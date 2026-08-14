import { API_ROUTES, getGuestPlayerToken, getOrCreatePlayerId } from '../scoreboard/api-client.js';

export const PROGRESS_SELECTION_TIMEOUT_MS = 15_000;

function summaryText(summary) {
    const campaign = Number(summary?.campaignResults) || 0;
    const daily = summary?.hasDailyResults ? 'Daily results saved' : 'No Daily results';
    const unlocks = summary?.unlocks ? 'Unlocks saved' : 'No unlocks saved';
    return `${daily} · ${campaign} Campaign result${campaign === 1 ? '' : 's'} · ${unlocks}`;
}

function optionButton(label, source) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `guest-progress-selection__button${source === 'guest' ? ' guest-progress-selection__button--primary' : ''}`;
    button.dataset.choice = source;
    button.textContent = label;
    return button;
}

export function requestGuestProgressSelection(selection) {
    if (typeof document === 'undefined' || !document.body) {
        return Promise.reject(new Error('Guest progress selection requires the game document.'));
    }

    return new Promise((resolve) => {
        const root = document.createElement('div');
        root.className = 'guest-progress-selection';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'guest-progress-selection-title');

        const card = document.createElement('section');
        card.className = 'guest-progress-selection__card';
        const title = document.createElement('h2');
        title.id = 'guest-progress-selection-title';
        title.textContent = 'CHOOSE YOUR PROGRESS';
        const message = document.createElement('p');
        message.className = 'guest-progress-selection__message';
        message.textContent = 'You signed in while this browser had guest progress. Choose which progress to keep.';

        const sources = document.createElement('div');
        sources.className = 'guest-progress-selection__sources';
        const guestSource = document.createElement('div');
        guestSource.className = 'guest-progress-selection__source';
        guestSource.innerHTML = '<strong>Guest progress</strong>';
        const guestSummary = document.createElement('span');
        guestSummary.textContent = summaryText(selection?.guestSummary);
        guestSource.appendChild(guestSummary);
        const accountSource = document.createElement('div');
        accountSource.className = 'guest-progress-selection__source';
        accountSource.innerHTML = '<strong>Saved account progress</strong>';
        const accountSummary = document.createElement('span');
        accountSummary.textContent = selection?.accountHasProgress
            ? summaryText(selection?.accountSummary)
            : 'No saved account progress';
        accountSource.appendChild(accountSummary);
        sources.append(guestSource, accountSource);

        const actions = document.createElement('div');
        actions.className = 'guest-progress-selection__actions';
        const guestButton = optionButton('USE GUEST PROGRESS', 'guest');
        const accountButton = optionButton(
            selection?.accountHasProgress ? 'USE SAVED PROGRESS' : 'START FRESH',
            'account',
        );
        actions.append(guestButton, accountButton);
        const status = document.createElement('p');
        status.className = 'guest-progress-selection__status';
        status.setAttribute('aria-live', 'polite');

        card.append(title, message, sources, actions, status);
        root.appendChild(card);
        document.body.appendChild(root);

        const choose = async (choice) => {
            guestButton.disabled = true;
            accountButton.disabled = true;
            status.textContent = 'Saving your choice…';
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
                root.remove();
                resolve({ choice, playerState: body });
            } catch (error) {
                guestButton.disabled = false;
                accountButton.disabled = false;
                status.textContent = error?.name === 'AbortError'
                    ? 'Saving took too long. Try again.'
                    : error?.message || 'Could not save your choice. Try again.';
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
            }
        };
        guestButton.addEventListener('click', () => void choose('guest'));
        accountButton.addEventListener('click', () => void choose('account'));
        guestButton.focus?.();
    });
}
