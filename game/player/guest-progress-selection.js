import { API_ROUTES, getGuestPlayerToken, getOrCreatePlayerId } from '../scoreboard/api-client.js';
import { presentPlayerChoiceOverlay } from './player-choice-overlay.js';

export const PROGRESS_SELECTION_TIMEOUT_MS = 15_000;

function nonNegativeInteger(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function summaryMetrics(summary) {
    const metrics = [];
    const dailySavedResults = nonNegativeInteger(summary?.dailySavedResults);
    const dailyPlaylistSize = nonNegativeInteger(summary?.dailyPlaylistSize);
    if (dailySavedResults !== null && dailyPlaylistSize !== null) {
        metrics.push({
            label: 'Daily',
            value: `${dailySavedResults}/${dailyPlaylistSize}`,
        });
    }

    const unlockedCampaign = nonNegativeInteger(summary?.campaignUnlockedTracks);
    const campaignTotalStages = nonNegativeInteger(summary?.campaignTotalStages);
    if (unlockedCampaign !== null && campaignTotalStages !== null) {
        metrics.push({
            label: 'Campaign',
            value: `${unlockedCampaign}/${campaignTotalStages}`,
        });
    }

    const carsUnlocked = nonNegativeInteger(summary?.carsUnlocked);
    const carsTotal = nonNegativeInteger(summary?.carsTotal);
    if (carsUnlocked !== null && carsTotal !== null) {
        metrics.push({
            label: 'Garage',
            value: `${carsUnlocked}/${carsTotal}`,
        });
    }

    return metrics;
}

function summaryBlock(summary) {
    const metrics = summaryMetrics(summary);
    const block = document.createElement('div');
    block.className = 'guest-progress-selection__source-summary';
    if (metrics.length === 0) {
        block.classList.add('guest-progress-selection__source-summary--empty');
        block.textContent = 'Progress details unavailable';
        return block;
    }
    for (const metric of metrics) {
        const item = document.createElement('span');
        item.className = 'guest-progress-selection__source-stat';
        const label = document.createElement('span');
        label.className = 'guest-progress-selection__source-stat-label';
        label.textContent = metric.label;
        const value = document.createElement('strong');
        value.className = 'guest-progress-selection__source-stat-value';
        value.textContent = metric.value;
        item.append(label, value);
        block.append(item);
    }
    return block;
}

function sourceBlock({ choice, label, summary }) {
    const source = document.createElement('label');
    source.className = 'guest-progress-selection__source';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'guest-progress-selection-choice';
    input.value = choice;
    input.dataset.choice = choice;
    input.className = 'guest-progress-selection__source-input';
    const content = document.createElement('span');
    content.className = 'guest-progress-selection__source-content';
    const heading = document.createElement('strong');
    heading.className = 'guest-progress-selection__source-label';
    heading.textContent = label;
    content.append(heading, summary);
    source.append(input, content);
    return { source, input };
}

async function postProgressSelection(body, controller = null) {
    const response = await fetch(API_ROUTES.playerProgressSelectionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(payload?.error || `Could not save your choice (${response.status}).`);
        error.status = response.status;
        error.reason = payload?.reason || null;
        error.transferId = typeof payload?.transferId === 'string' ? payload.transferId : null;
        throw error;
    }
    return payload;
}

const PROGRESS_SELECTION_CONTINUE_REASON = 'progress_selection_continue';
// A transfer with many Daily days answers "continue" after each share of the
// work. Each request gets its own wait; this bounds the number of requests.
const PROGRESS_SELECTION_MAX_REQUESTS = 200;

// Sends the choice (or a resume), then follows every "continue" answer by
// resuming the same transfer at once, until the transfer answers for good.
async function postProgressSelectionUntilDone(body, { onContinue = null } = {}) {
    let next = body;
    for (let request = 0; request < PROGRESS_SELECTION_MAX_REQUESTS; request += 1) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = controller
            ? setTimeout(() => controller.abort(), PROGRESS_SELECTION_TIMEOUT_MS)
            : null;
        try {
            return await postProgressSelection(next, controller);
        } catch (error) {
            if (error?.reason !== PROGRESS_SELECTION_CONTINUE_REASON || !error.transferId) throw error;
            onContinue?.();
            next = { action: 'resume', transferId: error.transferId };
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }
    throw new Error('Could not finish your transfer. Try again.');
}

async function readCompletedTransfer(transferId) {
    if (typeof transferId !== 'string' || !transferId) return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), PROGRESS_SELECTION_TIMEOUT_MS)
        : null;
    try {
        const payload = await postProgressSelection({ action: 'status', transferId }, controller);
        return payload?.progressSelection?.state === 'completed'
            && payload.progressSelection.transferId === transferId
            ? payload
            : null;
    } catch {
        return null;
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
    }
}

const interruptedTransferPromises = new Map();

function requestInterruptedTransfer(selection, { onBeforeSubmit = null } = {}) {
    const transferId = typeof selection?.transferId === 'string' ? selection.transferId : '';
    if (transferId && interruptedTransferPromises.has(transferId)) {
        return interruptedTransferPromises.get(transferId);
    }
    const promise = new Promise((resolve, reject) => {
        if (selection?.state === 'recovery_required') {
            presentPlayerChoiceOverlay({
                titleId: 'guest-progress-selection-title',
                title: 'Transfer Needs Repair',
                message: 'Your progress is protected. Support needs to review this transfer before leaderboard saving can continue.',
                actions: [],
            });
            reject(Object.assign(new Error('This transfer needs to be reviewed before it can continue.'), {
                transferRecovery: true,
                reason: 'guest_progress_recovery_required',
            }));
            return;
        }
        const overlay = presentPlayerChoiceOverlay({
            titleId: 'guest-progress-selection-title',
            title: 'Finish Transfer',
            message: 'Your earlier choice is saved. Finish the transfer before racing again.',
            actions: [{ label: 'RETRY TRANSFER', choice: 'resume', primary: true }],
        });
        let finished = false;
        let attemptInFlight = false;
        const retryDelays = [2000, 5000, 15000];
        let retryIndex = 0;
        let retryTimer = null;

        const succeed = (playerState) => {
            finished = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            overlay.remove();
            const completion = playerState?.progressSelection;
            resolve({
                choice: completion?.choice ?? selection?.choice,
                transferId: completion?.transferId ?? selection?.transferId,
                sourceGuestPlayerId: completion?.sourceGuestPlayerId ?? selection?.sourceGuestPlayerId,
                completedAt: completion?.completedAt ?? null,
                playerState,
            });
        };
        const stop = (error) => {
            finished = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            overlay.remove();
            reject(error);
        };

        const attempt = async () => {
            if (finished || attemptInFlight) return;
            attemptInFlight = true;
            overlay.setBusy(true);
            overlay.setStatus('Finishing your transfer…');
            try {
                await onBeforeSubmit?.(selection?.choice);
                succeed(await postProgressSelectionUntilDone({
                    action: 'resume',
                    transferId: selection?.transferId,
                }, { onContinue: () => overlay.setStatus('Moving your progress…') }));
            } catch (error) {
                if (error?.transferRecovery
                    || error?.reason === 'guest_progress_recovery_required'
                    || error?.status === 409) {
                    stop(error);
                    return;
                }
                if (error?.status === 401 || error?.status === 403) {
                    stop(error);
                    return;
                }
                const settled = await readCompletedTransfer(selection?.transferId);
                if (settled) {
                    succeed(settled);
                    return;
                }
                overlay.setBusy(false);
                const delay = retryDelays[retryIndex++];
                if (delay !== undefined) {
                    overlay.setStatus(`Transfer paused. Retrying in ${Math.round(delay / 1000)} seconds…`);
                    retryTimer = setTimeout(() => void attempt(), delay);
                } else {
                    overlay.setStatus(error?.name === 'AbortError'
                        ? 'Transfer took too long. Retry when ready.'
                        : error?.message || 'Could not finish your transfer. Try again.');
                }
            } finally {
                attemptInFlight = false;
            }
        };
        const retryButton = overlay.buttons.find((button) => button.dataset.choice === 'resume');
        retryButton?.addEventListener('click', () => {
            if (retryTimer !== null) clearTimeout(retryTimer);
            retryIndex = 0;
            void attempt();
        });
        void attempt();
    });
    if (transferId) {
        interruptedTransferPromises.set(transferId, promise);
        void promise.then(() => {
            if (interruptedTransferPromises.get(transferId) === promise) {
                interruptedTransferPromises.delete(transferId);
            }
        }, () => {
            if (interruptedTransferPromises.get(transferId) === promise) {
                interruptedTransferPromises.delete(transferId);
            }
        });
    }
    return promise;
}

export function requestGuestProgressSelection(selection, { onBeforeSubmit = null } = {}) {
    if (typeof document === 'undefined' || !document.body) {
        return Promise.reject(new Error('Guest progress selection requires the game document.'));
    }

    if (selection?.state === 'resume_required' || selection?.state === 'recovery_required') {
        return requestInterruptedTransfer(selection, { onBeforeSubmit });
    }

    return new Promise((resolve, reject) => {
        const sources = document.createElement('div');
        sources.className = 'guest-progress-selection__sources';
        const guestOption = sourceBlock({
            choice: 'guest',
            label: 'Guest',
            summary: summaryBlock(selection?.guestSummary),
        });
        const accountOption = sourceBlock({
            choice: 'account',
            label: 'Account',
            summary: selection?.accountHasProgress
                ? summaryBlock(selection?.accountSummary)
                : summaryBlock(null),
        });
        sources.append(guestOption.source, accountOption.source);

        const overlay = presentPlayerChoiceOverlay({
            titleId: 'guest-progress-selection-title',
            title: 'Keep Progress',
            message: 'Choose one save to keep.',
            extraNodes: [sources],
            actions: [{ label: 'CONTINUE WITH GUEST', choice: 'confirm', primary: true }],
        });

        const choiceInputs = [guestOption.input, accountOption.input];
        const continueButton = overlay.buttons[0];
        const guestShowsProgress = summaryMetrics(selection?.guestSummary).length > 0;
        const accountShowsProgress = !selection?.accountHasProgress
            || summaryMetrics(selection?.accountSummary).length > 0;
        let selectedChoice = guestShowsProgress && accountShowsProgress ? 'guest' : null;
        let choiceLocked = null;
        if (selectedChoice) {
            guestOption.input.checked = true;
            guestOption.source.classList.add('is-selected');
        } else if (continueButton) {
            continueButton.textContent = 'CHOOSE A SAVE';
            continueButton.disabled = true;
        }

        for (const input of choiceInputs) {
            input.addEventListener('change', () => {
                selectedChoice = input.value;
                if (continueButton) continueButton.disabled = false;
                for (const option of [guestOption.source, accountOption.source]) {
                    option.classList.toggle('is-selected', option.contains(input));
                }
                continueButton.textContent = `CONTINUE WITH ${input.value === 'guest' ? 'GUEST' : 'ACCOUNT'}`;
            });
        }

        const choose = async (choice) => {
            if (choice !== 'guest' && choice !== 'account') return;
            if (choiceLocked && choiceLocked !== choice) {
                overlay.setStatus(`Your ${choiceLocked === 'guest' ? 'Guest' : 'Account'} choice is already protected. Retry it to continue.`);
                return;
            }
            overlay.setBusy(true);
            for (const input of choiceInputs) input.disabled = true;
            overlay.setStatus('Saving your choice…');
            try {
                const prepared = await onBeforeSubmit?.(choice);
                if (prepared?.choiceLocked) {
                    throw Object.assign(new Error('This transfer already has a different saved choice.'), {
                        transferRecovery: true,
                        reason: 'guest_progress_recovery_required',
                    });
                }
                choiceLocked = choice;
                const body = await postProgressSelectionUntilDone({
                    playerId: getOrCreatePlayerId('guest progress selection'),
                    guestToken: getGuestPlayerToken(),
                    choice,
                }, { onContinue: () => overlay.setStatus('Moving your progress…') });
                overlay.remove();
                resolve({
                    choice,
                    transferId: body?.progressSelection?.transferId || null,
                    sourceGuestPlayerId: body?.progressSelection?.sourceGuestPlayerId || null,
                    playerState: body,
                });
            } catch (error) {
                if (error?.transferRecovery
                    || error?.reason === 'guest_progress_recovery_required'
                    || error?.status === 401
                    || error?.status === 403
                    || error?.status === 409) {
                    overlay.remove();
                    reject(error);
                    return;
                }
                overlay.setBusy(false);
                for (const input of choiceInputs) input.disabled = Boolean(choiceLocked);
                overlay.setStatus(error?.name === 'AbortError'
                    ? 'Saving took too long. Try again.'
                    : error?.message || 'Could not save your choice. Try again.');
            }
        };
        continueButton?.addEventListener('click', () => void choose(selectedChoice));
    });
}
