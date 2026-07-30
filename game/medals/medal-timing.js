/** Pure medal timing rules (no DOM / SVG). Safe for server and tools. */

import _medalTimesRaw from './medal-times.json' with { type: 'json' };

/** Display / ordering rank for standard lap medals (bronze → author). */
export const STANDARD_MEDAL_TIER_RANK = Object.freeze({ bronze: 0, silver: 1, gold: 2, author: 3 });

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

function normalizeRaceLapCount(lapCount) {
    return Number.isInteger(lapCount) && lapCount >= 1 && lapCount <= 3
        ? lapCount
        : 1;
}

/**
 * Medal thresholds for a complete race. One-lap APIs remain the source data;
 * multi-lap races scale every available tier by the validated lap count.
 * Invalid lap counts deliberately fall back to one lap.
 * @param {string} trackKey
 * @param {number} lapCount
 * @returns {{ author: number | null, gold: number, silver: number, bronze: number } | null}
 */
export function getRaceMedalThresholds(trackKey, lapCount = 1) {
    const oneLap = getTrackMedalThresholds(trackKey);
    if (!oneLap) return null;
    const requiredLaps = normalizeRaceLapCount(lapCount);
    const author = getAuthorMedalSeconds(trackKey);
    return {
        author: author == null ? null : author * requiredLaps,
        gold: oneLap.gold * requiredLaps,
        silver: oneLap.silver * requiredLaps,
        bronze: oneLap.bronze * requiredLaps,
    };
}

/**
 * Best medal earned for a race time (lower time = better).
 * @returns {'author' | 'gold' | 'silver' | 'bronze' | null}
 */
export function getMedalForRaceTime(trackKey, elapsedSec, lapCount = 1) {
    const thresholds = getRaceMedalThresholds(trackKey, lapCount);
    if (!thresholds || !Number.isFinite(elapsedSec)) return null;
    if (thresholds.author != null && elapsedSec <= thresholds.author) return 'author';
    if (elapsedSec <= thresholds.gold) return 'gold';
    if (elapsedSec <= thresholds.silver) return 'silver';
    if (elapsedSec <= thresholds.bronze) return 'bronze';
    return null;
}

/**
 * Best medal earned for a lap time (lower time = better).
 * @returns {'author' | 'gold' | 'silver' | 'bronze' | null}
 */
export function getMedalForLapTime(trackKey, lapTimeSec) {
    return getMedalForRaceTime(trackKey, lapTimeSec, 1);
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
    if (medal === 'challenge') return 'Challenge beaten';
    return '—';
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
 * Lap-time ceiling (seconds) to earn a standard tier on this track.
 * @param {string|null|undefined} trackKey
 * @param {'bronze'|'silver'|'gold'|'author'} tier
 * @returns {number|null}
 */
function getTierThresholdSeconds(trackKey, tier, lapCount = 1) {
    const t = getRaceMedalThresholds(trackKey, lapCount);
    if (!t) return null;
    if (tier === 'author') return t.author;
    if (tier === 'bronze') return t.bronze;
    if (tier === 'silver') return t.silver;
    if (tier === 'gold') return t.gold;
    return null;
}

/**
 * Horizontal medal row slots (bronze → author): filled state + target time for locked tiers.
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} bestStoredMedal
 * @returns {Array<{ tier: 'bronze'|'silver'|'gold'|'author', filled: boolean, thresholdSec: number|null }>}
 */
export function getMedalRowSlots(trackKey, bestStoredMedal, lapCount = 1) {
    const stack = getCombinedMedalStackTiers(trackKey, bestStoredMedal);
    return stack.map(({ tier, filled }) => ({
        tier,
        filled,
        thresholdSec: getTierThresholdSeconds(trackKey, tier, lapCount),
    }));
}

/**
 * Whether every standard tier on this track is unlocked for the stored best medal.
 * @param {string|null|undefined} trackKey
 * @param {'author'|'gold'|'silver'|'bronze'|null|undefined} bestStoredMedal
 * @returns {boolean}
 */
export function getWinOverlayAllMedalsUnlocked(trackKey, bestStoredMedal) {
    const slots = getMedalRowSlots(trackKey, bestStoredMedal);
    return slots.length > 0 && slots.every((s) => s.filled);
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

/** One-line copy for UI: time ceilings for each medal tier. */
export function formatMedalTargetsLine(trackKey) {
    const t = getTrackMedalThresholds(trackKey);
    if (!t) return null;
    const fmt = (s) => `${Number(s).toFixed(3)}s`;
    const authorSec = getAuthorMedalSeconds(trackKey);
    const authorPart = authorSec != null ? `Author ≤ ${fmt(authorSec)} · ` : '';
    return `${authorPart}Gold ≤ ${fmt(t.gold)} · Silver ≤ ${fmt(t.silver)} · Bronze ≤ ${fmt(t.bronze)}`;
}
