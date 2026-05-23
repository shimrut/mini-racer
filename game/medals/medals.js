import _medalTimesRaw from './medal-times.json' with { type: 'json' };
import { createMedalIconSvg } from './medal-icon.js?v=2.04';

/** Display / ordering rank for standard lap medals (bronze → author). */
const STANDARD_MEDAL_TIER_RANK = Object.freeze({ bronze: 0, silver: 1, gold: 2, author: 3 });

/** Hold time between first-unlock medal reveals when multiple tiers unlock in one run. */
export const FIRST_UNLOCK_MEDAL_HOLD_MS = 250;

export function isStandardMedalTier(v) {
    return typeof v === 'string' && Object.hasOwn(STANDARD_MEDAL_TIER_RANK, v);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, { gold: number, silver: number, bronze: number, author: number | null }>}
 */
function normalizeMedalTimes(raw) {
    const out = /** @type {Record<string, { gold: number, silver: number, bronze: number, author: number | null }>} */ ({});
    for (const [key, row] of Object.entries(raw)) {
        if (!row || typeof row !== 'object') continue;
        const r = /** @type {Record<string, unknown>} */ (row);
        const gold = Number(r.gold);
        if (!Number.isFinite(gold)) continue;
        let silver = Number(r.silver);
        let bronze = Number(r.bronze);
        if (!Number.isFinite(silver)) silver = gold + 0.01;
        if (!Number.isFinite(bronze)) bronze = silver + 0.01;
        if (gold > silver) silver = gold + 0.01;
        if (silver > bronze) bronze = silver + 0.01;
        const authRaw = r.author;
        const author =
            authRaw != null && Number.isFinite(Number(authRaw)) && Number(authRaw) > 0
                ? Number(authRaw)
                : null;
        out[key] = { gold, silver, bronze, author };
    }
    return Object.freeze(out);
}

const MEDAL_TIMES = normalizeMedalTimes(_medalTimesRaw);

/** Gold / silver / bronze only (for tests). All tiers + author live in `medal-times.json`. */
export const TRACK_MEDAL_THRESHOLDS = Object.freeze(
    Object.fromEntries(
        Object.entries(MEDAL_TIMES).map(([k, v]) => [k, { gold: v.gold, silver: v.silver, bronze: v.bronze }])
    )
);

/**
 * @param {string} trackKey
 * @returns {{ gold: number, silver: number, bronze: number } | null}
 */
export function getTrackMedalThresholds(trackKey) {
    const row = MEDAL_TIMES[trackKey];
    if (!row || !Number.isFinite(row.gold)) return null;
    return { gold: row.gold, silver: row.silver, bronze: row.bronze };
}

/**
 * Strictest Author time (seconds) for this track, or null if disabled / invalid.
 * `author` in JSON must be strictly faster (lower seconds) than `gold`, or it is ignored.
 * @param {string} trackKey
 * @returns {number | null}
 */
export function getAuthorMedalSeconds(trackKey) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return null;
    const raw = MEDAL_TIMES[trackKey]?.author;
    if (raw == null || !Number.isFinite(raw) || raw <= 0 || raw >= t.gold) return null;
    return raw;
}

/**
 * Best medal earned for a lap time (lower time = better).
 * @returns {'author' | 'gold' | 'silver' | 'bronze' | null}
 */
export function getMedalForLapTime(trackKey, lapTimeSec) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t || !Number.isFinite(lapTimeSec)) return null;
    const authorSec = getAuthorMedalSeconds(trackKey);
    if (authorSec != null && lapTimeSec <= authorSec) return 'author';
    if (lapTimeSec <= t.gold) return 'gold';
    if (lapTimeSec <= t.silver) return 'silver';
    if (lapTimeSec <= t.bronze) return 'bronze';
    return null;
}

export function maxMedalTier(a, b) {
    const ra = isStandardMedalTier(a) ? STANDARD_MEDAL_TIER_RANK[a] : -1;
    const rb = isStandardMedalTier(b) ? STANDARD_MEDAL_TIER_RANK[b] : -1;
    const m = Math.max(ra, rb);
    if (m < 0) return null;
    if (m === 0) return 'bronze';
    if (m === 1) return 'silver';
    if (m === 2) return 'gold';
    return 'author';
}

/**
 * Personal-best hero: creator already earned on this track before this run, lap beats creator time, and strictly
 * faster than the saved personal best (never on the same run as first creator unlock).
 * @param {string|null|undefined} trackKey
 * @param {number|null|undefined} lapTimeSec
 * @param {{ previousTrackMedal?: 'author'|'gold'|'silver'|'bronze'|null, previousPersonalBestSec?: number|null|undefined }} [options]
 */
export function shouldShowPersonalBestMedalHero(
    trackKey,
    lapTimeSec,
    { previousTrackMedal = null, previousPersonalBestSec = undefined } = {},
) {
    if (previousPersonalBestSec === undefined) return false;
    const authorSec = getAuthorMedalSeconds(trackKey);
    if (authorSec == null || !Number.isFinite(lapTimeSec)) return false;
    if (getMedalForLapTime(trackKey, lapTimeSec) !== 'author') return false;
    if (previousTrackMedal !== 'author') return false;
    const prevPb =
        previousPersonalBestSec !== null && Number.isFinite(Number(previousPersonalBestSec))
            ? Number(previousPersonalBestSec)
            : null;
    if (prevPb === null) return false;
    return lapTimeSec < prevPb;
}

/**
 * Entrance motion + unlock sound for a tier on this track. Standard medals only when newly earned vs stored best;
 * personal-best only when {@link shouldShowPersonalBestMedalHero} is true for this finish.
 * @param {string} tier
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} previousBestMedalOnTrack
 * @param {{ trackKey?: string|null, lapTimeSec?: number|null, previousPersonalBestSec?: number|null|undefined }} [context]
 */
export function shouldCelebrateMedalTier(tier, previousBestMedalOnTrack, context = {}) {
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
    const run = () => {
        icon.classList.remove('medal-pile-icon--deferred');
        if (!celebrate) return;
        const tier = icon.dataset?.tier;
        if (!reduced) {
            icon.classList.add('medal-svg--medal-entrance');
            icon.style.animationDelay = '0ms';
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
 * Win overlay: large = highest medal unlocked on this track (saved best); small row = every other unlocked tier;
 * next goal from that best tier.
 * @param {string|null|undefined} trackKey
 * @param {number|null|undefined} lapTimeSec
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} lapMedal
 * @param {{ previousPersonalBestSec?: number|null|undefined, previousTrackMedal?: 'author'|'gold'|'silver'|'bronze'|null }} [options]
 *   PB hero only when creator was already unlocked on this track and the lap strictly beats the saved PB
 *   ({@link shouldShowPersonalBestMedalHero}); never on the same run as first creator unlock.
 * @returns {{
 *   centerTier: 'white'|'personal-best'|'author'|'gold'|'silver'|'bronze',
 *   othersLeft: Array<'author'|'gold'|'silver'|'bronze'>,
 *   next: { tier: 'author'|'gold'|'silver'|'bronze', maxSeconds: number } | null,
 *   allUnlocked: boolean
 * }}
 */
export function getWinOverlayMedalLayout(
    trackKey,
    lapTimeSec,
    lapMedal,
    { previousPersonalBestSec, previousTrackMedal = null } = {},
) {
    const t = getTrackMedalThresholds(trackKey);
    const tierThisLap =
        t && Number.isFinite(lapTimeSec) ? getMedalForLapTime(trackKey, lapTimeSec) : null;
    const bestUnlocked = maxMedalTier(
        isStandardMedalTier(lapMedal) ? lapMedal : null,
        isStandardMedalTier(tierThisLap) ? tierThisLap : null,
    );
    let featuredTier = isStandardMedalTier(bestUnlocked) ? bestUnlocked : 'white';
    const stack = t ? getCombinedMedalStackTiers(trackKey, lapMedal) : [];
    const earned = stack.filter((x) => x.filled).map((x) => x.tier);
    const nextBasis =
        featuredTier !== 'white'
            ? featuredTier
            : maxMedalTier(
                t && Number.isFinite(lapTimeSec) ? getMedalForLapTime(trackKey, lapTimeSec) : null,
                lapMedal,
            );
    const next =
        t && nextBasis !== 'white' && nextBasis !== 'author'
            ? getNextMedalTarget(trackKey, nextBasis)
            : null;
    const allUnlocked = stack.length > 0 && stack.every((x) => x.filled);
    let othersLeft = earned
        .filter((tier) => tier !== featuredTier)
        .sort((a, b) => STANDARD_MEDAL_TIER_RANK[a] - STANDARD_MEDAL_TIER_RANK[b]);
    if (!allUnlocked && next) {
        othersLeft = othersLeft.filter((tier) => tier !== next.tier);
    }
    const nextOut = allUnlocked ? null : next;

    let centerTier = featuredTier;
    const showPbHero = shouldShowPersonalBestMedalHero(trackKey, lapTimeSec, {
        previousTrackMedal,
        previousPersonalBestSec,
    });
    if (showPbHero) {
        centerTier = 'personal-best';
        othersLeft = [...earned].sort((a, b) => STANDARD_MEDAL_TIER_RANK[a] - STANDARD_MEDAL_TIER_RANK[b]);
        if (!allUnlocked && nextOut) {
            othersLeft = othersLeft.filter((tier) => tier !== nextOut.tier);
        }
    }

    return { centerTier, othersLeft, next: nextOut, allUnlocked };
}

/**
 * Fastest lap-time ceiling still above the player's current medal (null = no medal yet).
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} currentMedal
 * @returns {{ tier: 'bronze'|'silver'|'gold'|'author', maxSeconds: number } | null} null at top tier or no thresholds
 */
export function getNextMedalTarget(trackKey, currentMedal) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return null;
    const authorSec = getAuthorMedalSeconds(trackKey);
    if (currentMedal === 'author') return null;
    if (currentMedal === 'gold') {
        if (authorSec != null) return { tier: 'author', maxSeconds: authorSec };
        return null;
    }
    if (currentMedal === 'silver') return { tier: 'gold', maxSeconds: t.gold };
    if (currentMedal === 'bronze') return { tier: 'silver', maxSeconds: t.silver };
    return { tier: 'bronze', maxSeconds: t.bronze };
}

/**
 * Lap-time ceiling for the player's current medal goal (UI "time to beat").
 * Uses best medal already earned on a best lap; null = working toward bronze.
 * If already at the best tier, returns that tier's ceiling.
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} bestEarnedMedal
 * @returns {number|null}
 */
export function getTimeToBeatSeconds(trackKey, bestEarnedMedal) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return null;
    const next = getNextMedalTarget(trackKey, bestEarnedMedal);
    if (next) return next.maxSeconds;
    if (bestEarnedMedal === 'author') {
        const a = getAuthorMedalSeconds(trackKey);
        return a != null ? a : t.gold;
    }
    return t.gold;
}

export function formatMedalLabel(medal) {
    if (medal === 'author') return 'Author';
    if (medal === 'gold') return 'Gold';
    if (medal === 'silver') return 'Silver';
    if (medal === 'bronze') return 'Bronze';
    if (medal === 'personal-best') return 'Personal best';
    return '—';
}

/**
 * Every standard tier on this track (bronze → gold, and author when configured) is already earned.
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} bestStoredMedal
 */
export function allStandardMedalsUnlocked(trackKey, bestStoredMedal) {
    const stack = getCombinedMedalStackTiers(trackKey, bestStoredMedal);
    return stack.length > 0 && stack.every((x) => x.filled);
}

/**
 * Stricter than daily "best result": only the lap clock improved vs the saved best time.
 * @param {number|null|undefined} finishTimeSec
 * @param {{ bestTime?: number|null }|null|undefined} previousBest
 */
export function isPersonalBestTimeImprovement(finishTimeSec, previousBest) {
    const ft = Number(finishTimeSec);
    if (!Number.isFinite(ft)) return false;
    const prevRaw = previousBest?.bestTime;
    const prev = prevRaw != null && Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : null;
    if (prev === null) return true;
    return ft < prev;
}

/** Display order for combined-results medal row (bronze → author). */
const COMBINED_MEDAL_TIER_ORDER = ['bronze', 'silver', 'gold', 'author'];

/**
 * Tiers to show after a lap (outline = not reached, filled = reached or beaten).
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} lapMedal
 * @returns {Array<{ tier: 'bronze'|'silver'|'gold'|'author', filled: boolean }>}
 */
export function getCombinedMedalStackTiers(trackKey, lapMedal) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return [];
    const hasAuthor = getAuthorMedalSeconds(trackKey) != null;
    const tiers = hasAuthor ? [...COMBINED_MEDAL_TIER_ORDER] : COMBINED_MEDAL_TIER_ORDER.slice(0, 3);
    const earnedRank = isStandardMedalTier(lapMedal) ? STANDARD_MEDAL_TIER_RANK[lapMedal] : -1;
    return tiers.map((tier) => ({
        tier,
        filled: earnedRank >= STANDARD_MEDAL_TIER_RANK[tier]
    }));
}

/**
 * Bronze → gold (→ author) icons: filled through earned tier, outline for the rest.
 * @param {HTMLElement|null|undefined} el
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} lapMedal
 * @param {{ iconClass?: string }} [options]
 */
export function renderMedalTierStack(el, trackKey, lapMedal, { iconClass = 'medal-svg--combined-stack' } = {}) {
    if (!el) return;
    el.replaceChildren();
    const stack = getCombinedMedalStackTiers(trackKey, lapMedal);
    for (const { tier, filled } of stack) {
        el.appendChild(createMedalIconSvg(tier, { className: iconClass, outline: !filled }));
    }
}

/**
 * Combined results: earned tiers only; each in a slot (offset + depth), best tier on top (z-index).
 * Icons start hidden for {@link playCombinedHeroPileEntrance}.
 * @param {HTMLElement|null|undefined} heroEl `#combined-hero-medal`
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} lapMedal
 */
export function renderCombinedHeroMedalPile(heroEl, trackKey, lapMedal) {
    if (!heroEl) return;
    heroEl.replaceChildren();
    const pile = document.createElement('div');
    pile.className = 'combined-hero-medal-pile';
    pile.setAttribute('role', 'group');
    pile.setAttribute('aria-label', 'Medals unlocked for this track');

    const appendOne = (tier) => {
        const slot = document.createElement('div');
        slot.className = 'combined-hero-medal-pile-slot';
        slot.style.setProperty('--stack-index', '0');
        const icon = createMedalIconSvg(tier, { className: 'medal-svg--hero medal-pile-icon--deferred' });
        slot.appendChild(icon);
        pile.appendChild(slot);
        pile.style.setProperty('--stack-total', '1');
    };

    const thresholds = trackKey ? getTrackMedalThresholds(trackKey) : null;
    if (!thresholds) {
        appendOne(lapMedal || 'white');
        heroEl.appendChild(pile);
        return;
    }

    const earned = getCombinedMedalStackTiers(trackKey, lapMedal).filter((x) => x.filled);
    if (earned.length === 0) {
        appendOne('white');
        heroEl.appendChild(pile);
        return;
    }

    let idx = 0;
    for (const { tier } of earned) {
        const slot = document.createElement('div');
        slot.className = 'combined-hero-medal-pile-slot';
        slot.style.setProperty('--stack-index', String(idx));
        const icon = createMedalIconSvg(tier, {
            className: 'medal-svg--hero medal-pile-icon--deferred',
        });
        slot.appendChild(icon);
        pile.appendChild(slot);
        idx += 1;
    }
    pile.style.setProperty('--stack-total', String(earned.length));
    heroEl.appendChild(pile);
}

/**
 * Win combined overlay: stacked earned medals (hero on top, others peeking behind); subrow shows next goal when applicable.
 * @param {HTMLElement|null|undefined} overlayEl `#combined-hero-medal`
 * @param {{ trackKey?: string|null, lapTimeSec?: number|null, lapMedal?: 'author'|'gold'|'silver'|'bronze'|null, previousPersonalBestSec?: number|null, previousTrackMedal?: 'author'|'gold'|'silver'|'bronze'|null }} [params]
 */
export function renderWinCombinedMedalOverlay(
    overlayEl,
    {
        trackKey = null,
        lapTimeSec = null,
        lapMedal = null,
        previousPersonalBestSec = undefined,
        previousTrackMedal = null,
    } = {},
) {
    if (!overlayEl) return;
    overlayEl.replaceChildren();
    const { centerTier, othersLeft, allUnlocked } = getWinOverlayMedalLayout(
        trackKey,
        lapTimeSec,
        lapMedal,
        { previousPersonalBestSec, previousTrackMedal },
    );

    const root = document.createElement('div');
    root.className = 'win-combined-medal-overlay';
    if (allUnlocked) {
        root.classList.add('win-combined-medal-overlay--complete');
    }
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Medals for this track');

    const centerWrap = document.createElement('div');
    centerWrap.className = 'win-combined-medal-overlay__center';
    const heroMedal = centerTier === 'white' ? 'white' : centerTier;
    const pile = document.createElement('div');
    pile.className = 'combined-hero-medal-pile win-combined-medal-overlay__pile';
    pile.setAttribute('role', 'group');
    pile.setAttribute('aria-label', 'Medals earned on this track');
    let idx = 0;
    for (const tier of othersLeft) {
        const slot = document.createElement('div');
        slot.className = 'combined-hero-medal-pile-slot';
        slot.style.setProperty('--stack-index', String(idx));
        slot.appendChild(
            createMedalIconSvg(tier, {
                className: 'medal-svg--hero medal-pile-icon--deferred',
            }),
        );
        pile.appendChild(slot);
        idx += 1;
    }
    const heroSlot = document.createElement('div');
    heroSlot.className = 'combined-hero-medal-pile-slot';
    heroSlot.style.setProperty('--stack-index', String(idx));
    heroSlot.appendChild(
        createMedalIconSvg(heroMedal, {
            className: 'medal-svg--hero win-combined-medal-overlay__hero medal-pile-icon--deferred',
        }),
    );
    pile.appendChild(heroSlot);
    pile.style.setProperty('--stack-total', String(idx + 1));
    centerWrap.appendChild(pile);
    root.appendChild(centerWrap);

    overlayEl.appendChild(root);
}

/**
 * Reveal combined-result pile medals one after another (bronze → … → best).
 * @param {HTMLElement|null|undefined} pileEl `.combined-hero-medal-pile`
 * @param {{ staggerMs?: number, baseDelayMs?: number, reduced?: boolean, playUnlockSound?: (tier: string) => void }} [options]
 */
/**
 * Crash combined view: impact slam on the hero crash medal (starts when the crash modal opens).
 * @param {HTMLElement|null|undefined} heroMedalEl `#combined-hero-medal`
 * @param {{ reduced?: boolean }} [options]
 */
export function playCrashMedalEntrance(heroMedalEl, { reduced = false } = {}) {
    const icon = heroMedalEl?.querySelector?.(':scope > .medal-svg--crash.medal-pile-icon--deferred');
    if (!icon) return;
    if (!reduced) {
        icon.classList.add('medal-svg--medal-crash-entrance');
    }
    icon.classList.remove('medal-pile-icon--deferred');
}

export function playCombinedHeroPileEntrance(
    pileEl,
    { baseDelayMs = 0, reduced = false, shouldCelebrateTier = null, playUnlockSound = null, firstUnlockHoldMs = FIRST_UNLOCK_MEDAL_HOLD_MS } = {},
) {
    if (!pileEl) return;
    const icons = pileEl.querySelectorAll(':scope > .combined-hero-medal-pile-slot > .medal-svg');
    if (baseDelayMs > 0) {
        setTimeout(() => {
            revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
        }, baseDelayMs);
        return;
    }
    revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound, firstUnlockHoldMs });
}

function revealWinOverlayHeroMedal(
    root,
    { reduced = false, shouldCelebrateTier = null, playUnlockSound = null } = {},
) {
    if (!root) return;
    const pile = root.querySelector('.win-combined-medal-overlay__pile');
    if (pile) {
        playCombinedHeroPileEntrance(pile, { baseDelayMs: 0, reduced, shouldCelebrateTier, playUnlockSound });
        return;
    }
    const hero = root.querySelector('.win-combined-medal-overlay__hero.medal-pile-icon--deferred');
    const tier = hero?.dataset?.tier;
    const celebrate = typeof shouldCelebrateTier === 'function'
        ? shouldCelebrateTier(tier)
        : true;
    revealDeferredMedalIcon(hero, { delay: 0, reduced, celebrate, playUnlockSound });
}

function revealWinOverlaySecondaryMedals(
    root,
    { baseDelayMs = 130, reduced = false, shouldCelebrateTier = null, playUnlockSound = null } = {},
) {
    if (!root) return;
    const icons = root.querySelectorAll('.win-combined-medal-overlay__medal-sm.medal-pile-icon--deferred');
    if (baseDelayMs > 0) {
        setTimeout(() => {
            revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound });
        }, baseDelayMs);
        return;
    }
    revealMedalIconsInOrder(icons, { reduced, shouldCelebrateTier, playUnlockSound });
}

/**
 * Win overlay: hero pops immediately; earned + next small medals stagger after `baseDelayMs`.
 * @param {HTMLElement|null|undefined} root `.win-combined-medal-overlay`
 * @param {{ staggerMs?: number, secondaryBaseDelayMs?: number, reduced?: boolean, playUnlockSound?: (tier: string) => void }} [options]
 */
export function playWinCombinedMedalOverlayEntrance(
    root,
    { secondaryBaseDelayMs = 130, reduced = false, shouldCelebrateTier = null, playUnlockSound = null } = {},
) {
    if (!root) return;
    revealWinOverlayHeroMedal(root, { reduced, shouldCelebrateTier, playUnlockSound });
    revealWinOverlaySecondaryMedals(root, {
        baseDelayMs: secondaryBaseDelayMs,
        reduced,
        shouldCelebrateTier,
        playUnlockSound
    });
}

/**
 * Hero medal with the combined-results sheet intro; secondary medals stagger after.
 * @param {HTMLElement|null|undefined} combinedViewEl `#modal-combined-view`
 * @param {HTMLElement|null|undefined} winOverlayRoot `.win-combined-medal-overlay`
 * @param {{ secondaryStaggerMs?: number, secondaryBaseDelayMs?: number, reduced?: boolean, fallbackMs?: number, playUnlockSound?: (tier: string) => void }} [options]
 */
function scheduleWinOverlayMedalEntranceWithSheetIntro(
    combinedViewEl,
    winOverlayRoot,
    {
        secondaryBaseDelayMs = 130,
        reduced = false,
        fallbackMs = 200,
        shouldCelebrateTier = null,
        playUnlockSound = null,
    } = {},
) {
    if (!winOverlayRoot) return;

    if (reduced) {
        revealWinOverlayHeroMedal(winOverlayRoot, { reduced: true, shouldCelebrateTier, playUnlockSound });
        revealWinOverlaySecondaryMedals(winOverlayRoot, {
            baseDelayMs: 0,
            reduced: true,
            shouldCelebrateTier,
            playUnlockSound
        });
        return;
    }

    let finished = false;
    const run = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallbackTimer);
        if (combinedViewEl) {
            combinedViewEl.removeEventListener('animationstart', onAnimationStart);
        }
        revealWinOverlayHeroMedal(winOverlayRoot, { reduced: false, shouldCelebrateTier, playUnlockSound });
        revealWinOverlaySecondaryMedals(winOverlayRoot, {
            baseDelayMs: secondaryBaseDelayMs,
            reduced: false,
            shouldCelebrateTier,
            playUnlockSound
        });
    };

    const onAnimationStart = (e) => {
        if (e.target !== combinedViewEl) return;
        if (!String(e.animationName || '').includes('fadeIn')) return;
        run();
    };

    const fallbackTimer = setTimeout(run, fallbackMs);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!combinedViewEl) {
                run();
                return;
            }
            combinedViewEl.addEventListener('animationstart', onAnimationStart);
            try {
                const anims = combinedViewEl.getAnimations?.({ subtree: false }) ?? [];
                const fade = anims.find((a) => String(a.animationName || '').includes('fadeIn'));
                if (fade && fade.playState === 'running') {
                    run();
                }
            } catch {
                /* getAnimations may be unavailable */
            }
        });
    });
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
 * Waits for modal overlay + combined view intro motion, then runs {@link playMedalStackEntrance}.
 * @param {HTMLElement|null|undefined} modalEl `#modal`
 * @param {HTMLElement|null|undefined} combinedViewEl `#modal-combined-view` when shown
 * @param {HTMLElement|null|undefined} stackEl optional row container for {@link playMedalStackEntrance}
 * @param {{ staggerMs?: number, playUnlockSound?: (tier: string) => void }} [options]
 */
export function scheduleMedalStackEntranceAfterModal(
    modalEl,
    combinedViewEl,
    stackEl,
    { staggerMs = 52, shouldCelebrateTier = null, playUnlockSound = null } = {},
) {
    if (!stackEl || stackEl.childElementCount === 0) return;
    const reduced =
        typeof globalThis !== 'undefined'
        && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduced) {
        playMedalStackEntrance(stackEl, { baseDelayMs: 0, shouldCelebrateTier, playUnlockSound });
        return;
    }
    scheduleAfterModalCombinedIntro(modalEl, combinedViewEl, () => {
        playMedalStackEntrance(stackEl, { baseDelayMs: 0, shouldCelebrateTier, playUnlockSound });
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
    const winOverlayPile = winOverlayRoot?.querySelector?.('.win-combined-medal-overlay__pile');
    const heroPile = heroMedalEl?.querySelector?.('.combined-hero-medal-pile');
    const crashHeroMedal = heroMedalEl?.querySelector?.(':scope > .medal-svg--crash.medal-pile-icon--deferred');
    const hasStack = Boolean(stackEl && stackEl.childElementCount > 0);
    if (!heroPile && !hasStack && !winOverlayRoot && !crashHeroMedal) return;

    const reduced =
        typeof globalThis !== 'undefined'
        && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    if (crashHeroMedal) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                playCrashMedalEntrance(heroMedalEl, { reduced });
            });
        });
    }

    const runEntrance = () => {
        if (heroPile && !winOverlayPile) {
            playCombinedHeroPileEntrance(heroPile, {
                baseDelayMs: 0,
                reduced,
                shouldCelebrateTier,
                playUnlockSound,
            });
        }

        const nextMedalSlot = combinedViewEl?.querySelector?.('#combined-next-medal-icon-slot');
        const nextIcon =
            combinedViewEl?.classList?.contains('is-crash')
                ? null
                : nextMedalSlot?.querySelector('.medal-svg.medal-pile-icon--deferred');
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
                secondaryBaseDelayMs: 0,
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
            secondaryBaseDelayMs: winSecondaryBaseDelayMs,
            reduced: false,
            shouldCelebrateTier,
            playUnlockSound
        });
    }

    if ((heroPile && !winOverlayPile) || hasStack) {
        scheduleAfterModalCombinedIntro(modalEl, combinedViewEl, runEntrance);
    }
}

/** One-line copy for UI: time ceilings for each medal tier. */
export function formatMedalTargetsLine(trackKey) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return null;
    const fmt = (s) => `${Number(s).toFixed(2)}s`;
    const authorSec = getAuthorMedalSeconds(trackKey);
    const authorPart = authorSec != null ? `Author ≤ ${fmt(authorSec)} · ` : '';
    return `${authorPart}Gold ≤ ${fmt(t.gold)} · Silver ≤ ${fmt(t.silver)} · Bronze ≤ ${fmt(t.bronze)}`;
}
