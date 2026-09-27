import _medalTimesRaw from './medal-times.json' with { type: 'json' };

export const STANDARD_MEDAL_TIER_RANK = Object.freeze({ bronze: 0, silver: 1, gold: 2, author: 3 });

export function isStandardMedalTier(v) {
    return typeof v === 'string' && Object.hasOwn(STANDARD_MEDAL_TIER_RANK, v);
}

function normalizeMedalTimes(raw) {
    const out = {};
    for (const [key, row] of Object.entries(raw)) {
        if (!row || typeof row !== 'object') continue;
        const r = row;
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

export function getTrackMedalThresholds(trackKey) {
    const row = MEDAL_TIMES[trackKey];
    if (!row || !Number.isFinite(row.gold)) return null;
    return { gold: row.gold, silver: row.silver, bronze: row.bronze };
}

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

export function getMedalForRaceTime(trackKey, elapsedSec, lapCount = 1) {
    const thresholds = getRaceMedalThresholds(trackKey, lapCount);
    if (!thresholds || !Number.isFinite(elapsedSec)) return null;
    if (thresholds.author != null && elapsedSec <= thresholds.author) return 'author';
    if (elapsedSec <= thresholds.gold) return 'gold';
    if (elapsedSec <= thresholds.silver) return 'silver';
    if (elapsedSec <= thresholds.bronze) return 'bronze';
    return null;
}

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

export function formatMedalLabel(medal) {
    if (medal === 'author') return 'Author';
    if (medal === 'gold') return 'Gold';
    if (medal === 'silver') return 'Silver';
    if (medal === 'bronze') return 'Bronze';
    if (medal === 'personal-best') return 'Personal best';
    if (medal === 'challenge') return 'Challenge beaten';
    return '—';
}

const COMBINED_MEDAL_TIER_ORDER = ['bronze', 'silver', 'gold', 'author'];

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

function getTierThresholdSeconds(trackKey, tier, lapCount = 1) {
    const t = getRaceMedalThresholds(trackKey, lapCount);
    if (!t) return null;
    if (tier === 'author') return t.author;
    if (tier === 'bronze') return t.bronze;
    if (tier === 'silver') return t.silver;
    if (tier === 'gold') return t.gold;
    return null;
}

export function getMedalRowSlots(trackKey, bestStoredMedal, lapCount = 1) {
    const stack = getCombinedMedalStackTiers(trackKey, bestStoredMedal);
    return stack.map(({ tier, filled }) => ({
        tier,
        filled,
        thresholdSec: getTierThresholdSeconds(trackKey, tier, lapCount),
    }));
}

export function getWinOverlayAllMedalsUnlocked(trackKey, bestStoredMedal) {
    const slots = getMedalRowSlots(trackKey, bestStoredMedal);
    return slots.length > 0 && slots.every((s) => s.filled);
}

export function isPersonalBestTimeImprovement(finishTimeSec, previousBest) {
    const ft = Number(finishTimeSec);
    if (!Number.isFinite(ft)) return false;
    const prevRaw = previousBest?.bestTime;
    const prev = prevRaw != null && Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : null;
    if (prev === null) return true;
    return ft < prev;
}
