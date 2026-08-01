import { createMedalIconSvg } from './medal-icon.js';
import {
    STANDARD_MEDAL_TIER_RANK,
    allStandardMedalsUnlocked,
    formatMedalLabel,
    formatMedalTargetsLine,
    getAuthorMedalSeconds,
    getCombinedMedalStackTiers,
    getMedalForLapTime,
    getMedalForRaceTime,
    getMedalRowSlots,
    getNextMedalTarget,
    getRaceMedalThresholds,
    getTimeToBeatSeconds,
    getTrackMedalThresholds,
    getWinOverlayAllMedalsUnlocked,
    isPersonalBestTimeImprovement,
    isStandardMedalTier,
    maxMedalTier,
    shouldShowPersonalBestMedalHero,
    TRACK_MEDAL_THRESHOLDS,
} from './medal-timing.js';

export {
    STANDARD_MEDAL_TIER_RANK,
    TRACK_MEDAL_THRESHOLDS,
    allStandardMedalsUnlocked,
    formatMedalLabel,
    formatMedalTargetsLine,
    getAuthorMedalSeconds,
    getCombinedMedalStackTiers,
    getMedalForLapTime,
    getMedalForRaceTime,
    getMedalRowSlots,
    getNextMedalTarget,
    getRaceMedalThresholds,
    getTimeToBeatSeconds,
    getTrackMedalThresholds,
    getWinOverlayAllMedalsUnlocked,
    isPersonalBestTimeImprovement,
    isStandardMedalTier,
    maxMedalTier,
    shouldShowPersonalBestMedalHero,
};

/** Hold time between first-unlock medal reveals when multiple tiers unlock in one run. */
export const FIRST_UNLOCK_MEDAL_HOLD_MS = 250;

/**
 * Entrance motion + unlock sound for a tier on this track. Standard medals only when newly earned vs stored best;
 * personal-best only when {@link shouldShowPersonalBestMedalHero} is true for this finish.
 * @param {string} tier
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} previousBestMedalOnTrack
 * @param {{ trackKey?: string|null, lapTimeSec?: number|null, previousPersonalBestSec?: number|null|undefined }} [context]
 */
export function shouldCelebrateMedalTier(tier, previousBestMedalOnTrack, context = {}) {
    if (tier === 'challenge') return true;
    if (tier === 'personal-best') {
        return shouldShowPersonalBestMedalHero(context.trackKey, context.lapTimeSec, {
            previousTrackMedal: previousBestMedalOnTrack,
            previousPersonalBestSec: context.previousPersonalBestSec,
        });
    }
    if (!isStandardMedalTier(tier)) return false;
    const prevRank = isStandardMedalTier(previousBestMedalOnTrack)
        ? STANDARD_MEDAL_TIER_RANK[previousBestMedalOnTrack]
        : -1;
    return STANDARD_MEDAL_TIER_RANK[tier] > prevRank;
}

function revealDeferredMedalIcon(
    icon,
    { delay = 0, reduced = false, celebrate = true, playUnlockSound = null } = {},
) {
    if (!icon) return;
    if (icon.classList.contains('medal-svg--row-placeholder')) return;
    const run = () => {
        const rowSlot = icon.parentElement?.classList?.contains('combined-medal-row-slot')
            ? icon.parentElement
            : null;
        icon.classList.remove('medal-pile-icon--deferred');
        if (!celebrate) return;
        const tier = icon.dataset?.tier;
        if (!reduced) {
            const animationTarget = rowSlot || icon;
            animationTarget.classList.add('medal-svg--medal-entrance');
            playUnlockSound?.(tier);
        } else {
            playUnlockSound?.(tier);
        }
    };
    if (delay > 0) {
        setTimeout(run, delay);
    } else {
        run();
    }
}

/**
 * Pile reveal timing: already-earned tiers show instantly (delay 0, no fanfare). Each first-unlock tier waits
 * {@link FIRST_UNLOCK_MEDAL_HOLD_MS} after the previous reveal — 250ms after a block of instant medals, then
 * +250ms between consecutive first-unlocks.
 * @param {string[]} tiersInOrder
 * @param {(tier: string) => boolean} shouldCelebrateTier
 * @param {number} [holdMs]
 * @returns {Array<{ tier: string, delayMs: number, celebrate: boolean }>}
 */
export function planFirstUnlockMedalRevealDelays(
    tiersInOrder,
    shouldCelebrateTier,
    holdMs = FIRST_UNLOCK_MEDAL_HOLD_MS,
) {
    let nextCelebrateAt = 0;
    let hadInstantSinceLastCelebrate = false;

    return tiersInOrder.map((tier) => {
        const celebrate = shouldCelebrateTier(tier);
        if (!celebrate) {
            hadInstantSinceLastCelebrate = true;
            return { tier, delayMs: 0, celebrate: false };
        }
        if (hadInstantSinceLastCelebrate && nextCelebrateAt === 0) {
            nextCelebrateAt = holdMs;
        }
        const delayMs = nextCelebrateAt;
        nextCelebrateAt += holdMs;
        hadInstantSinceLastCelebrate = false;
        return { tier, delayMs, celebrate: true };
    });
}

function revealMedalIconsInOrder(
    icons,
    { reduced = false, shouldCelebrateTier = null, playUnlockSound = null, firstUnlockHoldMs = FIRST_UNLOCK_MEDAL_HOLD_MS } = {},
) {
    const list = [...icons];
    const tiers = list.map((icon) => icon.dataset?.tier || '');
    const plan = typeof shouldCelebrateTier === 'function'
        ? planFirstUnlockMedalRevealDelays(tiers, shouldCelebrateTier, firstUnlockHoldMs)
        : list.map((icon, index) => ({
            tier: icon.dataset?.tier || '',
            delayMs: index > 0 ? index * firstUnlockHoldMs : 0,
            celebrate: true,
        }));

    for (let i = 0; i < list.length; i += 1) {
        const step = plan[i];
        if (step.celebrate) continue;
        revealDeferredMedalIcon(list[i], {
            delay: 0,
            reduced,
            celebrate: false,
            playUnlockSound,
        });
    }

    for (let i = 0; i < list.length; i += 1) {
        const step = plan[i];
        if (!step.celebrate) continue;
        revealDeferredMedalIcon(list[i], {
            delay: reduced ? 0 : step.delayMs,
            reduced,
            celebrate: true,
            playUnlockSound,
        });
    }
}

/**
 * @param {HTMLElement} parent
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} bestStoredMedal
 * @param {{ rowClass?: string, iconClass?: string, ariaLabel?: string }} [options]
 * @returns {HTMLDivElement}
 */
function appendMedalRowTo(parent, trackKey, bestStoredMedal, {
    rowClass = '',
    iconClass = 'medal-svg--hero medal-pile-icon--deferred',
    ariaLabel = 'Medals for this track',
    lapCount = 1,
} = {}) {
    const row = document.createElement('div');
    row.className = rowClass ? `combined-medal-row ${rowClass}` : 'combined-medal-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', ariaLabel);

    const slots = getMedalRowSlots(trackKey, bestStoredMedal, lapCount);
    if (slots.length === 0) {
        const slot = document.createElement('div');
        slot.className = 'combined-medal-row-slot combined-medal-row-slot--fallback';
        slot.appendChild(createMedalIconSvg('white', { className: iconClass }));
        row.appendChild(slot);
        parent.appendChild(row);
        return row;
    }

    for (const { tier, filled, thresholdSec } of slots) {
        const slot = document.createElement('div');
        slot.className = 'combined-medal-row-slot';
        slot.dataset.tier = tier;
        if (!filled) {
            slot.classList.add('combined-medal-row-slot--locked');
        }

        const centerText =
            !filled && thresholdSec != null && Number.isFinite(thresholdSec)
                ? `${thresholdSec.toFixed(3)}s`
                : null;

        const icon = createMedalIconSvg(tier, {
            className: filled
                ? iconClass
                : 'medal-svg--hero medal-svg--row-placeholder',
            outline: !filled,
            showEmblem: filled,
            centerText: null,
            rowPlaceholder: !filled,
        });
        if (!filled && centerText) {
            icon.setAttribute('aria-label', `${formatMedalLabel(tier)} locked, unlock at ${centerText}`);
        }
        slot.appendChild(icon);
        if (!filled && centerText) {
            const timeLabel = document.createElement('span');
            timeLabel.className = 'combined-medal-row-slot__time';
            timeLabel.textContent = centerText;
            slot.appendChild(timeLabel);
        }

        row.appendChild(slot);
    }

    parent.appendChild(row);
    return row;
}

/**
 * Challenge finish hero: pending placeholder, won medal, loss/tie label, or error.
 * @param {HTMLElement|null|undefined} overlayEl `#combined-hero-medal`
 * @param {{
 *   phase?: 'pending'|'won'|'lost'|'tie'|'error',
 *   statusText?: string|null,
 *   error?: string|null,
 * }} [params]
 */
export function renderChallengeFinishHero(
    overlayEl,
    {
        phase = 'pending',
        statusText = null,
        error = null,
    } = {},
) {
    if (!overlayEl) return;
    overlayEl.replaceChildren();

    const root = document.createElement('div');
    root.className = 'win-combined-medal-overlay win-combined-medal-overlay--challenge';
    root.dataset.challengePhase = phase;

    const centerWrap = document.createElement('div');
    centerWrap.className = 'win-combined-medal-overlay__center';

    const appendPlaceholderMedal = () => {
        const row = document.createElement('div');
        row.className = 'combined-medal-row win-combined-medal-overlay__row';
        const slot = document.createElement('div');
        slot.className = 'combined-medal-row-slot';
        slot.appendChild(createMedalIconSvg('white', {
            className: 'medal-svg--hero',
        }));
        row.appendChild(slot);
        centerWrap.appendChild(row);
    };

    const label = document.createElement('p');
    label.className = 'combined-medal-challenge-label';

    if (phase === 'won') {
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', 'Challenge beaten');

        const row = document.createElement('div');
        row.className = 'combined-medal-row win-combined-medal-overlay__row';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Challenge beaten');

        const slot = document.createElement('div');
        slot.className = 'combined-medal-row-slot';
        slot.dataset.tier = 'challenge';
        slot.appendChild(createMedalIconSvg('challenge', {
            className: 'medal-svg--hero medal-pile-icon--deferred',
        }));
        row.appendChild(slot);
        centerWrap.appendChild(row);

        label.textContent = 'Challenge beaten';
        label.classList.add('combined-medal-challenge-label--won');
    } else if (phase === 'pending') {
        const pendingLabel = statusText || 'Submitting...';
        root.setAttribute('role', 'status');
        root.setAttribute('aria-label', pendingLabel);
        root.setAttribute('aria-live', 'polite');
        appendPlaceholderMedal();
        label.textContent = pendingLabel;
        label.classList.add('combined-medal-challenge-label--pending');
    } else if (phase === 'lost' || phase === 'tie') {
        const outcomeLabel = phase === 'tie' ? 'Tie' : 'Challenge Lost';
        root.setAttribute('role', 'status');
        root.setAttribute('aria-label', outcomeLabel);
        appendPlaceholderMedal();
        label.textContent = outcomeLabel;
        label.classList.add('combined-medal-challenge-label--outcome');
    } else {
        const errorLabel = error || 'This run could not be verified.';
        root.setAttribute('role', 'alert');
        root.setAttribute('aria-label', errorLabel);
        appendPlaceholderMedal();
        label.textContent = errorLabel;
        label.classList.add('combined-medal-challenge-label--error');
    }

    centerWrap.appendChild(label);
    root.appendChild(centerWrap);
    overlayEl.appendChild(root);
}

/**
 * Win combined overlay: horizontal row of all medal tiers for this track.
 * Challenge finishes use {@link renderChallengeFinishHero} instead of the campaign stack.
 * @param {HTMLElement|null|undefined} overlayEl `#combined-hero-medal`
 * @param {{ trackKey?: string|null, lapTimeSec?: number|null, lapMedal?: 'author'|'gold'|'silver'|'bronze'|'challenge'|null, challengeFinish?: boolean, challengeConfirmPhase?: 'pending'|'won'|'lost'|'tie'|'error'|null, challengeConfirmStatus?: string|null, challengeConfirmError?: string|null, previousPersonalBestSec?: number|null, previousTrackMedal?: 'author'|'gold'|'silver'|'bronze'|null }} [params]
 */
export function renderWinCombinedMedalOverlay(
    overlayEl,
    {
        trackKey = null,
        lapMedal = null,
        challengeFinish = false,
        challengeConfirmPhase = null,
        challengeConfirmStatus = null,
        challengeConfirmError = null,
        previousTrackMedal = null,
        lapCount = 1,
    } = {},
) {
    if (!overlayEl) return;
    overlayEl.replaceChildren();

    if (challengeFinish || challengeConfirmPhase) {
        const phase = challengeConfirmPhase
            || (lapMedal === 'challenge' ? 'won' : 'pending');
        renderChallengeFinishHero(overlayEl, {
            phase,
            statusText: challengeConfirmStatus,
            error: challengeConfirmError,
        });
        return;
    }

    if (lapMedal === 'challenge') {
        renderChallengeFinishHero(overlayEl, { phase: 'won' });
        return;
    }

    const bestStoredMedal = maxMedalTier(
        isStandardMedalTier(previousTrackMedal) ? previousTrackMedal : null,
        isStandardMedalTier(lapMedal) ? lapMedal : null,
    );
    const allUnlocked = getWinOverlayAllMedalsUnlocked(trackKey, bestStoredMedal);

    const root = document.createElement('div');
    root.className = 'win-combined-medal-overlay';
    if (allUnlocked) {
        root.classList.add('win-combined-medal-overlay--complete');
    }
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Medals for this track');

    const centerWrap = document.createElement('div');
    centerWrap.className = 'win-combined-medal-overlay__center';
    appendMedalRowTo(centerWrap, trackKey, bestStoredMedal, {
        rowClass: 'win-combined-medal-overlay__row',
        ariaLabel: 'Medals earned on this track',
        lapCount,
    });
    root.appendChild(centerWrap);

    overlayEl.appendChild(root);
}

/**
 * Reveal combined-result medal row left to right (bronze → … → author).
 * @param {HTMLElement|null|undefined} rowEl `.combined-medal-row`
 * @param {{ baseDelayMs?: number, reduced?: boolean, playUnlockSound?: (tier: string) => void }} [options]
 */
export function playCombinedMedalRowEntrance(
    rowEl,
    { baseDelayMs = 0, reduced = false, shouldCelebrateTier = null, playUnlockSound = null, firstUnlockHoldMs = FIRST_UNLOCK_MEDAL_HOLD_MS } = {},
) {
    if (!rowEl) return;
    const icons = rowEl.querySelectorAll(
        ':scope > .combined-medal-row-slot:not(.combined-medal-row-slot--locked) > .medal-svg',
    );
    if (baseDelayMs > 0) {
        setTimeout(() => {
            revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
        }, baseDelayMs);
        return;
    }
    revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
}

function revealWinOverlayMedalRow(
    root,
    { reduced = false, shouldCelebrateTier = null, playUnlockSound = null } = {},
) {
    if (!root) return;
    const row = root.querySelector('.win-combined-medal-overlay__row, .combined-medal-row');
    if (row) {
        playCombinedMedalRowEntrance(row, { baseDelayMs: 0, reduced, shouldCelebrateTier, playUnlockSound });
    }
}

/**
 * Hero medal with the combined-results sheet intro; secondary medals stagger after.
 * @param {HTMLElement|null|undefined} combinedViewEl `#modal-combined-view`
 * @param {HTMLElement|null|undefined} winOverlayRoot `.win-combined-medal-overlay`
 * @param {{ secondaryStaggerMs?: number, secondaryBaseDelayMs?: number, reduced?: boolean, fallbackMs?: number, playUnlockSound?: (tier: string) => void }} [options]
 */
function scheduleWinOverlayMedalEntranceWithSheetIntro(
    _combinedViewEl,
    winOverlayRoot,
    {
        reduced = false,
        shouldCelebrateTier = null,
        playUnlockSound = null,
    } = {},
) {
    if (!winOverlayRoot) return;

    const reveal = () => {
        revealWinOverlayMedalRow(winOverlayRoot, {
            reduced,
            shouldCelebrateTier,
            playUnlockSound,
        });
    };

    if (reduced) {
        reveal();
        return;
    }

    // Reveal on next paint. Embedded WebViews (Reddit app) often skip fadeIn / animationstart.
    requestAnimationFrame(reveal);
}

/**
 * Plays the stacked medal entrance animation (call after modal intro).
 * @param {HTMLElement|null|undefined} stackEl
 * @param {{ staggerMs?: number, baseDelayMs?: number, playUnlockSound?: (tier: string) => void }} [options]
 */
export function playMedalStackEntrance(
    stackEl,
    { baseDelayMs = 0, shouldCelebrateTier = null, playUnlockSound = null, firstUnlockHoldMs = FIRST_UNLOCK_MEDAL_HOLD_MS } = {},
) {
    if (!stackEl) return;
    stackEl.classList.remove('combined-medal-stack--deferred');
    const icons = stackEl.querySelectorAll(':scope > .medal-svg');
    if (baseDelayMs > 0) {
        setTimeout(() => {
            revealMedalIconsInOrder(icons, { reduced: false, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
        }, baseDelayMs);
        return;
    }
    revealMedalIconsInOrder(icons, { reduced: false, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
}

/**
 * @param {HTMLElement|null|undefined} modalEl `#modal`
 * @param {HTMLElement|null|undefined} combinedViewEl `#modal-combined-view` when shown
 * @param {() => void} onReady
 */
function scheduleAfterModalCombinedIntro(modalEl, combinedViewEl, onReady) {
    let done = false;
    const go = () => {
        if (done) return;
        done = true;
        if (modalEl) modalEl.removeEventListener('transitionend', onModalTransitionEnd);
        if (combinedViewEl) combinedViewEl.removeEventListener('animationend', onCombinedAnimationEnd);
        clearTimeout(fallbackTimer);
        onReady();
    };

    const onModalTransitionEnd = (e) => {
        if (e.target !== modalEl) return;
        if (e.propertyName !== 'opacity') return;
        modalEl.removeEventListener('transitionend', onModalTransitionEnd);
        tickModal();
    };

    const onCombinedAnimationEnd = (e) => {
        if (e.target !== combinedViewEl) return;
        if (!String(e.animationName || '').includes('fadeIn')) return;
        combinedViewEl.removeEventListener('animationend', onCombinedAnimationEnd);
        tickView();
    };

    let modalReady = !modalEl;
    let viewReady = !combinedViewEl;

    const tryFinish = () => {
        if (modalReady && viewReady) go();
    };

    const tickModal = () => {
        modalReady = true;
        tryFinish();
    };

    const tickView = () => {
        viewReady = true;
        tryFinish();
    };

    const fallbackTimer = setTimeout(go, 520);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (modalEl) {
                const opacity = parseFloat(getComputedStyle(modalEl).opacity);
                if (opacity >= 0.999) {
                    tickModal();
                } else {
                    modalEl.addEventListener('transitionend', onModalTransitionEnd);
                }
            }
            if (combinedViewEl) {
                combinedViewEl.addEventListener('animationend', onCombinedAnimationEnd);
            }
            tryFinish();
        });
    });
}

/**
 * Win overlay: hero medal with the combined view `fadeIn` start; earned/next small medals stagger after.
 * In-sheet hero pile and optional stack still wait for the modal + combined intro to finish.
 * @param {HTMLElement|null|undefined} modalEl
 * @param {HTMLElement|null|undefined} combinedViewEl
 * @param {{ heroMedalEl?: HTMLElement | null, stackEl?: HTMLElement | null }} targets
 * @param {{ staggerMs?: number, stackAfterHeroMs?: number, winSecondaryBaseDelayMs?: number, playUnlockSound?: (tier: string) => void }} [options]
 */
export function scheduleCombinedMedalEntranceAfterModal(
    modalEl,
    combinedViewEl,
    { heroMedalEl = null, stackEl = null } = {},
    {
        staggerMs = 150,
        stackAfterHeroMs = 280,
        winSecondaryBaseDelayMs = 200,
        shouldCelebrateTier = null,
        playUnlockSound = null,
    } = {},
) {
    const winOverlayRoot = heroMedalEl?.querySelector?.(':scope > .win-combined-medal-overlay');
    const winOverlayRow = winOverlayRoot?.querySelector?.('.win-combined-medal-overlay__row, .combined-medal-row');
    const heroRow = heroMedalEl?.querySelector?.(':scope > .combined-medal-row');
    const hasStack = Boolean(stackEl && stackEl.childElementCount > 0);
    if (!heroRow && !hasStack && !winOverlayRoot) return;

    const reduced =
        typeof globalThis !== 'undefined'
        && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    const runEntrance = () => {
        if (heroRow && !winOverlayRow) {
            playCombinedMedalRowEntrance(heroRow, {
                baseDelayMs: 0,
                reduced,
                shouldCelebrateTier,
                playUnlockSound,
            });
        }

        const nextMedalSlot = combinedViewEl?.querySelector?.('#combined-next-medal-icon-slot');
        const nextIcon = nextMedalSlot?.querySelector('.medal-svg.medal-pile-icon--deferred');
        if (nextIcon) {
            nextIcon.classList.remove('medal-pile-icon--deferred');
        }

        if (hasStack) {
            const delay = reduced ? 0 : stackAfterHeroMs;
            setTimeout(() => {
                playMedalStackEntrance(stackEl, {
                    baseDelayMs: 0,
                    shouldCelebrateTier,
                    playUnlockSound,
                });
            }, delay);
        }
    };

    if (reduced) {
        if (winOverlayRoot) {
            scheduleWinOverlayMedalEntranceWithSheetIntro(combinedViewEl, winOverlayRoot, {
                reduced: true,
                shouldCelebrateTier,
                playUnlockSound
            });
        }
        runEntrance();
        return;
    }

    if (winOverlayRoot) {
        scheduleWinOverlayMedalEntranceWithSheetIntro(combinedViewEl, winOverlayRoot, {
            reduced: false,
            shouldCelebrateTier,
            playUnlockSound
        });
    }

    if ((heroRow && !winOverlayRow) || hasStack) {
        scheduleAfterModalCombinedIntro(modalEl, combinedViewEl, runEntrance);
    }
}
