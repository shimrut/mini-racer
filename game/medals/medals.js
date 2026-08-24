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

export const FIRST_UNLOCK_MEDAL_HOLD_MS = 250;

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

function isCombinedFinishNewPersonalBest(lapTimeSec, previousPersonalBestSec, deltaToPersonalBest) {
    if (!Number.isFinite(Number(lapTimeSec))) return false;
    if (Number.isFinite(deltaToPersonalBest)) return deltaToPersonalBest < 0;
    if (previousPersonalBestSec === undefined || previousPersonalBestSec === null) {
        return true;
    }
    return isPersonalBestTimeImprovement(lapTimeSec, { bestTime: previousPersonalBestSec });
}

export function resolveCombinedFinishHeadline({
    lapMedal = null,
    previousTrackMedal = null,
    lapTimeSec,
    previousPersonalBestSec = undefined,
    deltaToPersonalBest = undefined,
} = {}) {
    if (isStandardMedalTier(lapMedal) && shouldCelebrateMedalTier(lapMedal, previousTrackMedal)) {
        return { kind: lapMedal, text: lapMedal };
    }
    if (isCombinedFinishNewPersonalBest(lapTimeSec, previousPersonalBestSec, deltaToPersonalBest)) {
        return { kind: 'new-best', text: 'new best' };
    }
    return { kind: 'finished', text: 'finished' };
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

    const outcomeByPhase = {
        won: 'YOU WON',
        lost: 'YOU LOST',
        tie: 'YOU TIED',
        pending: 'VERIFYING',
        error: 'UNVERIFIED',
    };
    const outcome = outcomeByPhase[phase] || 'UNVERIFIED';
    const accessibleLabel = phase === 'error'
        ? (error || 'This run could not be verified.')
        : (phase === 'pending' ? (statusText || 'Verifying challenge result') : outcome);

    root.setAttribute('role', phase === 'error' ? 'alert' : 'status');
    root.setAttribute('aria-label', accessibleLabel);
    if (phase === 'pending') root.setAttribute('aria-live', 'polite');

    const lockup = document.createElement('p');
    lockup.className = 'challenge-result-lockup';

    const result = document.createElement('span');
    result.className = `challenge-result-lockup__outcome challenge-result-lockup__outcome--${phase}`;
    result.textContent = outcome;

    lockup.appendChild(result);
    root.appendChild(lockup);

    if (phase === 'pending' || phase === 'error' || !outcomeByPhase[phase]) {
        const detail = document.createElement('span');
        detail.className = 'challenge-result-lockup__status';
        detail.textContent = accessibleLabel;
        root.appendChild(detail);
    }

    overlayEl.appendChild(root);
}

export function renderWinCombinedMedalOverlay(
    overlayEl,
    {
        trackKey = null,
        lapMedal = null,
        challengeFinish = false,
        challengeConfirmPhase = null,
        challengeConfirmStatus = null,
        challengeConfirmError = null,
        challengeViewerAvatarUrl = null,
        challengeVerdict = null,
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
            avatarUrl: challengeViewerAvatarUrl,
            verdict: challengeVerdict,
        });
        return;
    }

    if (lapMedal === 'challenge') {
        renderChallengeFinishHero(overlayEl, {
            phase: 'won',
            avatarUrl: challengeViewerAvatarUrl,
            verdict: challengeVerdict,
        });
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

export function playCombinedMedalRowEntrance(
    rowEl,
    { baseDelayMs = 0, reduced = false, shouldCelebrateTier = null, playUnlockSound = null, firstUnlockHoldMs = FIRST_UNLOCK_MEDAL_HOLD_MS } = {},
) {
    if (!rowEl) return;
    const icons = rowEl.querySelectorAll(
        ':scope > .combined-medal-row-slot:not(.combined-medal-row-slot--locked) .medal-svg',
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
