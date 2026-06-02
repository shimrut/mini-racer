import { TRACKS } from '../track/tracks.js?v=2.09';
import { isLocalEnvironment } from '../track/environment.js?v=2.09';
import {
    buildServiceHeaders,
    clampRequestLimit,
    getBaseApiConfig,
    getOrCreatePlayerId,
} from '../scoreboard/api-client.js?v=2.09';
import {
    getLeaderboardIdentityPreference,
} from '../scoreboard/display-preference.js?v=2.09';
import {
    getDailyChallengeData,
    setDailyChallengeBestTime,
} from './storage.js?v=2.09';

const MIN_DAILY_TIME = 2.0;
const MAX_DAILY_TIME = 60 * 60;
const DEFAULT_DAILY_LIMIT = 10;
const ACTIVE_DAILY_CACHE_KEY = 'VectorGpActiveDailyChallengeCache';
const DAILY_PLAYLIST_CACHE_KEY = 'VectorGpDailyChallengePlaylistCache';
const DAILY_SNAPSHOT_CACHE_KEY = 'VectorGpDailyChallengeSnapshotCache';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_PLAYLIST_DAYS = 7;
const DAILY_TRACK_STEP_SEED = 17;
let dailyPlaylistCache = {
    challenges: null,
    expiresAt: 0,
    promise: null
};
const dailySnapshotCache = new Map();
const dailySnapshotInflight = new Map();
let dailyPlaylistStorageHydrated = false;
let dailySnapshotStorageHydrated = false;

function getMockDailyUrlParams() {
    if (typeof window === 'undefined' || !window.location?.search) return null;
    try {
        return new URLSearchParams(window.location.search);
    } catch {
        return null;
    }
}

/** Standalone post preview card (`preview.html`) — always use local/mock daily data. */
export function isPreviewPage() {
    if (typeof window === 'undefined') return false;
    const path = window.location?.pathname || '';
    return /(?:^|\/)preview\.html$/i.test(path);
}

/** mockDaily=true → random track; mockDaily=<trackKey> → that track only */
function resolveMockDailyTrackKey(params) {
    if (!params) return null;

    const mockDaily = params.get('mockDaily');
    if (mockDaily && mockDaily !== 'true' && TRACKS[mockDaily]) {
        return mockDaily;
    }

    const mockTrack = params.get('mockTrack');
    if (mockTrack && TRACKS[mockTrack]) {
        return mockTrack;
    }

    return null;
}

function shouldUseMockDailyChallenge() {
    if (isPreviewPage()) {
        return true;
    }

    const params = getMockDailyUrlParams();
    if (params) {
        const mockDaily = params.get('mockDaily');
        if (mockDaily === 'true' || (mockDaily && TRACKS[mockDaily])) {
            return true;
        }
        if (params.get('localDev') === 'true') {
            return true;
        }
    }
    return isLocalEnvironment();
}

function getMockDailyChallenge() {
    const params = getMockDailyUrlParams();
    const fixedTrackKey = resolveMockDailyTrackKey(params);
    if (fixedTrackKey) {
        const now = Date.now();
        return normalizeDailyChallenge({
            id: 'mock-daily-challenge-local',
            trackKey: fixedTrackKey,
            objectiveType: 'single_lap_fastest',
            startsAt: new Date(now).toISOString(),
            endsAt: new Date(now + DAY_MS).toISOString(),
            availableUntil: new Date(now + DAILY_PLAYLIST_DAYS * DAY_MS).toISOString(),
            status: 'active',
            objectiveParams: {},
            skin: 'default'
        });
    }
    return buildLocalDailyChallenge(new Date());
}

function getMockDailyChallengeSnapshot() {
    return normalizeSnapshot({
        topRows: [],
        nearbyRows: [],
        currentPlayerRow: null,
        totalCount: 0,
        leaderboardEntryCount: 0,
        objectiveType: 'single_lap_fastest',
        playerRank: null,
        playerRankLabel: '--'
    });
}

function toCachedActiveChallenge(challenge) {
    if (!challenge || typeof challenge !== 'object') return null;
    if (typeof challenge.id !== 'string' || !challenge.id) return null;
    if (typeof challenge.trackKey !== 'string' || !TRACKS[challenge.trackKey]) return null;

    return {
        id: challenge.id,
        trackKey: challenge.trackKey,
        objectiveType: typeof challenge.objectiveType === 'string' ? challenge.objectiveType : 'single_lap_fastest',
        endsAt: typeof challenge.endsAt === 'string' ? challenge.endsAt : null,
        availableUntil: typeof challenge.availableUntil === 'string' ? challenge.availableUntil : null,
        skin: typeof challenge.skin === 'string' && challenge.skin.trim() ? challenge.skin.trim() : 'default'
    };
}

function getUtcDayIndex(date = new Date()) {
    return Math.floor(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ) / DAY_MS);
}

function getUtcDayStart(dayIndex) {
    return new Date(dayIndex * DAY_MS);
}

function getNextUtcDayStartMs(date = new Date()) {
    return getUtcDayStart(getUtcDayIndex(date) + 1).getTime();
}

function formatUtcChallengeDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getStepForTrackCount(trackCount) {
    if (trackCount <= 1) return 1;
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    let step = Math.min(DAILY_TRACK_STEP_SEED, trackCount - 1);
    while (step > 1 && gcd(step, trackCount) !== 1) {
        step -= 1;
    }
    return Math.max(1, step);
}

function getDailyTrackKeyForDayIndex(dayIndex) {
    const trackKeys = Object.keys(TRACKS);
    const step = getStepForTrackCount(trackKeys.length);
    const index = Math.abs(dayIndex * step) % trackKeys.length;
    return trackKeys[index] || 'circuit';
}

function buildLocalDailyChallenge(date = new Date()) {
    const dayIndex = getUtcDayIndex(date);
    const startsAt = getUtcDayStart(dayIndex);
    const challengeDate = formatUtcChallengeDate(startsAt);
    return normalizeDailyChallenge({
        id: `daily-gp-${challengeDate}`,
        challengeDate,
        trackKey: getDailyTrackKeyForDayIndex(dayIndex),
        objectiveType: 'single_lap_fastest',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + DAY_MS).toISOString(),
        availableUntil: new Date(startsAt.getTime() + DAILY_PLAYLIST_DAYS * DAY_MS).toISOString(),
        status: 'active',
        objectiveParams: {},
        skin: 'default'
    });
}

function getLocalDailyPlaylist(now = new Date()) {
    const todayIndex = getUtcDayIndex(now);
    return Array.from({ length: DAILY_PLAYLIST_DAYS }, (_, index) => {
        return buildLocalDailyChallenge(getUtcDayStart(todayIndex - index));
    }).filter(Boolean);
}

function readActiveDailyCacheStorable() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(ACTIVE_DAILY_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error('Error reading active daily challenge cache:', error);
        return null;
    }
}

function clearActiveDailyCacheStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.removeItem(ACTIVE_DAILY_CACHE_KEY);
    } catch (error) {
        console.error('Error clearing active daily challenge cache:', error);
    }
}

function writeActiveDailyCacheStorable(challenge) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const cachedChallenge = toCachedActiveChallenge(challenge);
        if (!cachedChallenge) {
            clearActiveDailyCacheStorage();
            return;
        }
        window.localStorage.setItem(
            ACTIVE_DAILY_CACHE_KEY,
            JSON.stringify({ challenge: cachedChallenge })
        );
    } catch (error) {
        console.error('Error writing active daily challenge cache:', error);
    }
}

function isCachedChallengeStillActive(challenge) {
    if (!challenge?.endsAt || typeof challenge.endsAt !== 'string') return false;
    const endsMs = Date.parse(challenge.endsAt);
    if (!Number.isFinite(endsMs)) return false;
    return Date.now() < endsMs;
}

function getValidCachedActiveDailyChallenge() {
    const stored = readActiveDailyCacheStorable();
    if (!stored?.challenge || typeof stored.challenge !== 'object') return null;
    const challenge = normalizeDailyChallenge(stored.challenge);
    if (!challenge || !isCachedChallengeStillActive(challenge)) return null;
    return challenge;
}

function getDailyChallengeConfig() {
    return getBaseApiConfig();
}

function normalizeObjectiveType(value) {
    return value === 'multi_lap_total' ? 'multi_lap_total' : 'single_lap_fastest';
}

function normalizeDailyChallenge(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.trackKey !== 'string' || !TRACKS[raw.trackKey]) return null;

    return {
        id: raw.id,
        challengeDate: typeof raw.challengeDate === 'string' ? raw.challengeDate : null,
        trackKey: raw.trackKey,
        startsAt: typeof raw.startsAt === 'string' ? raw.startsAt : null,
        endsAt: typeof raw.endsAt === 'string' ? raw.endsAt : null,
        availableUntil: typeof raw.availableUntil === 'string' ? raw.availableUntil : null,
        status: typeof raw.status === 'string' ? raw.status : 'active',
        objectiveType: normalizeObjectiveType(raw.objectiveType),
        objectiveParams: raw.objectiveParams && typeof raw.objectiveParams === 'object'
            ? raw.objectiveParams
            : {},
        skin: typeof raw.skin === 'string' && raw.skin.trim() ? raw.skin.trim() : 'default'
    };
}

function cloneDailyChallenge(challenge) {
    if (!challenge || typeof challenge !== 'object') return null;
    return {
        ...challenge,
        objectiveParams: challenge.objectiveParams && typeof challenge.objectiveParams === 'object'
            ? { ...challenge.objectiveParams }
            : {}
    };
}

function cloneDailyPlaylist(challenges) {
    return Array.isArray(challenges)
        ? challenges.map((challenge) => cloneDailyChallenge(challenge)).filter(Boolean)
        : [];
}

function getChallengeTimeMs(challenge, field) {
    const value = challenge?.[field];
    if (typeof value !== 'string') return NaN;
    return Date.parse(value);
}

function isChallengeStillUsable(challenge, nowMs = Date.now()) {
    const availableUntilMs = getChallengeTimeMs(challenge, 'availableUntil');
    if (Number.isFinite(availableUntilMs)) {
        return availableUntilMs > nowMs;
    }
    const endsAtMs = getChallengeTimeMs(challenge, 'endsAt');
    return Number.isFinite(endsAtMs) ? endsAtMs > nowMs : true;
}

function sortDailyPlaylist(challenges) {
    return cloneDailyPlaylist(challenges)
        .sort((a, b) => {
            const aStart = getChallengeTimeMs(a, 'startsAt');
            const bStart = getChallengeTimeMs(b, 'startsAt');
            if (Number.isFinite(aStart) && Number.isFinite(bStart) && aStart !== bStart) {
                return bStart - aStart;
            }
            return String(b.id).localeCompare(String(a.id));
        });
}

function normalizeDailyPlaylistForCache(challenges, nowMs = Date.now()) {
    const byId = new Map();
    for (const challenge of cloneDailyPlaylist(challenges)) {
        if (!isChallengeStillUsable(challenge, nowMs)) continue;
        byId.set(challenge.id, challenge);
    }
    return sortDailyPlaylist([...byId.values()]).slice(0, DAILY_PLAYLIST_DAYS);
}

function readDailyPlaylistCacheStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(DAILY_PLAYLIST_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error('Error reading daily playlist cache:', error);
        return null;
    }
}

function writeDailyPlaylistCacheStorage(challenges) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(
            DAILY_PLAYLIST_CACHE_KEY,
            JSON.stringify({ challenges: cloneDailyPlaylist(challenges) })
        );
    } catch (error) {
        console.error('Error writing daily playlist cache:', error);
    }
}

function hydrateDailyPlaylistCache() {
    if (dailyPlaylistStorageHydrated) return;
    dailyPlaylistStorageHydrated = true;
    const stored = readDailyPlaylistCacheStorage();
    const challenges = normalizeDailyPlaylistForCache(stored?.challenges);
    if (!challenges.length) return;
    dailyPlaylistCache = {
        challenges,
        expiresAt: resolveDailyPlaylistCacheExpiresAt(challenges),
        promise: dailyPlaylistCache.promise
    };
}

function getUsableCachedDailyPlaylist(nowMs = Date.now()) {
    hydrateDailyPlaylistCache();
    const challenges = normalizeDailyPlaylistForCache(dailyPlaylistCache.challenges, nowMs);
    if (
        dailyPlaylistCache.challenges
        && challenges.length !== dailyPlaylistCache.challenges.length
    ) {
        dailyPlaylistCache = {
            ...dailyPlaylistCache,
            challenges,
            expiresAt: resolveDailyPlaylistCacheExpiresAt(challenges, nowMs),
        };
        writeDailyPlaylistCacheStorage(challenges);
    }
    return challenges;
}

export function cacheDailyChallengePlaylist(challenges = []) {
    hydrateDailyPlaylistCache();
    const merged = normalizeDailyPlaylistForCache([
        ...cloneDailyPlaylist(dailyPlaylistCache.challenges),
        ...cloneDailyPlaylist(challenges),
    ]);
    dailyPlaylistCache = {
        challenges: merged,
        expiresAt: resolveDailyPlaylistCacheExpiresAt(merged),
        promise: dailyPlaylistCache.promise
    };
    writeDailyPlaylistCacheStorage(merged);
    return cloneDailyPlaylist(merged);
}

function resolveDailyPlaylistCacheExpiresAt(challenges, nowMs = Date.now()) {
    const nextKnownChange = cloneDailyPlaylist(challenges)
        .flatMap((challenge) => [
            challenge.startsAt,
            challenge.endsAt,
            challenge.availableUntil
        ])
        .map((value) => (typeof value === 'string' ? Date.parse(value) : NaN))
        .filter((time) => Number.isFinite(time) && time > nowMs + 1000)
        .sort((a, b) => a - b)[0];

    return Number.isFinite(nextKnownChange)
        ? nextKnownChange
        : getNextUtcDayStartMs(new Date(nowMs));
}

function cloneSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return normalizeSnapshot(null);
    return {
        ...snapshot,
        topRows: Array.isArray(snapshot.topRows) ? snapshot.topRows.slice() : [],
        nearbyRows: Array.isArray(snapshot.nearbyRows) ? snapshot.nearbyRows.slice() : [],
        currentPlayerRow: snapshot.currentPlayerRow && typeof snapshot.currentPlayerRow === 'object'
            ? { ...snapshot.currentPlayerRow }
            : null
    };
}

function normalizeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeBestTimeSec(row) {
    if (!row || typeof row !== 'object') return null;
    const bestTime = normalizeNumber(row.bestTime);
    if (bestTime !== null) return bestTime;
    const bestTimeSec = normalizeNumber(row.bestTimeSec);
    if (bestTimeSec !== null) return bestTimeSec;
    const bestTimeMs = normalizeNumber(row.bestTimeMs);
    return bestTimeMs !== null ? bestTimeMs / 1000 : null;
}

function normalizeCompletedLaps(value) {
    const laps = Number(value);
    return Number.isFinite(laps) ? Math.max(0, Math.trunc(laps)) : null;
}

function normalizeSnapshotRow(row) {
    if (!row || typeof row !== 'object') return null;
    const normalized = { ...row };
    const bestTime = normalizeBestTimeSec(row);
    if (bestTime !== null) {
        normalized.bestTime = bestTime;
    }
    const completedLaps = normalizeCompletedLaps(row.completedLaps);
    if (completedLaps !== null) {
        normalized.completedLaps = completedLaps;
    }
    return normalized;
}

export function isDailyChallengeStoredResultForChallenge(challenge, result) {
    if (!challenge || !result || typeof result !== 'object') return false;
    if (!Number.isFinite(Number(result.bestTime))) return false;
    if (
        typeof result.trackKey === 'string'
        && result.trackKey
        && result.trackKey !== challenge.trackKey
    ) {
        return false;
    }
    if (
        typeof result.objectiveType === 'string'
        && result.objectiveType
        && result.objectiveType !== challenge.objectiveType
    ) {
        return false;
    }
    return true;
}

function toDailyChallengeResultFromRow(row) {
    if (!row || !Number.isFinite(row.bestTime)) return null;
    return {
        bestTime: row.bestTime,
        completedLaps: Number.isFinite(row.completedLaps) ? row.completedLaps : null,
        checkpointTimesSec: Array.isArray(row.checkpointTimesSec)
            ? row.checkpointTimesSec
            : null,
    };
}

function findCachedPlaylistChallenge(challengeId) {
    if (!challengeId || !Array.isArray(dailyPlaylistCache.challenges)) return null;
    return dailyPlaylistCache.challenges.find((challenge) => challenge?.id === challengeId) || null;
}

function resolveDailySnapshotCacheExpiresAt(challengeId, nowMs = Date.now()) {
    const challenge = findCachedPlaylistChallenge(challengeId);
    if (challenge) {
        return resolveDailyPlaylistCacheExpiresAt([challenge], nowMs);
    }
    return getNextUtcDayStartMs(new Date(nowMs));
}

function readDailySnapshotCacheStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(DAILY_SNAPSHOT_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error('Error reading daily snapshot cache:', error);
        return null;
    }
}

function writeDailySnapshotCacheStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const nowMs = Date.now();
        const entries = {};
        for (const [challengeId, entry] of dailySnapshotCache.entries()) {
            if (!entry || entry.expiresAt <= nowMs) continue;
            entries[challengeId] = {
                snapshot: cloneSnapshot(entry.snapshot),
                expiresAt: entry.expiresAt,
            };
        }
        window.localStorage.setItem(DAILY_SNAPSHOT_CACHE_KEY, JSON.stringify({ entries }));
    } catch (error) {
        console.error('Error writing daily snapshot cache:', error);
    }
}

function hydrateDailySnapshotCache() {
    if (dailySnapshotStorageHydrated) return;
    dailySnapshotStorageHydrated = true;
    const stored = readDailySnapshotCacheStorage();
    const entries = stored?.entries && typeof stored.entries === 'object'
        ? stored.entries
        : {};
    const nowMs = Date.now();
    for (const [challengeId, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const expiresAt = Number(entry.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) continue;
        dailySnapshotCache.set(challengeId, {
            snapshot: cloneSnapshot(entry.snapshot),
            expiresAt,
        });
    }
}

function readCachedDailySnapshot(challengeId) {
    if (!challengeId) return null;
    hydrateDailySnapshotCache();
    const entry = dailySnapshotCache.get(challengeId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        dailySnapshotCache.delete(challengeId);
        writeDailySnapshotCacheStorage();
        return null;
    }
    return cloneSnapshot(entry.snapshot);
}

function writeCachedDailySnapshot(challengeId, snapshot) {
    if (!challengeId || !snapshot) return;
    hydrateDailySnapshotCache();
    dailySnapshotCache.set(challengeId, {
        snapshot: cloneSnapshot(snapshot),
        expiresAt: resolveDailySnapshotCacheExpiresAt(challengeId)
    });
    writeDailySnapshotCacheStorage();
    syncDailyChallengeStoredBestFromSnapshot(challengeId, snapshot);
}

function syncDailyChallengeStoredBestFromSnapshot(challengeId, snapshot) {
    const row = snapshot?.currentPlayerRow;
    if (!row || !Number.isFinite(row.bestTime)) return;

    const challenge = findCachedPlaylistChallenge(challengeId);
    if (!challenge) return;

    setDailyChallengeBestTime(
        challenge,
        row.bestTime,
        Number.isFinite(row.completedLaps) ? row.completedLaps : null,
        Array.isArray(row.checkpointTimesSec) ? row.checkpointTimesSec : null,
    );
}

function mergeDailyChallengeBestResult(challenge) {
    const storedLocal = getDailyChallengeData(challenge?.id);
    const local = isDailyChallengeStoredResultForChallenge(challenge, storedLocal)
        ? storedLocal
        : null;
    const row = readCachedDailySnapshot(challenge?.id)?.currentPlayerRow;

    if (!row || !Number.isFinite(row.bestTime)) {
        return local;
    }
    if (!local || !Number.isFinite(local.bestTime)) {
        return toDailyChallengeResultFromRow(row);
    }

    return row.bestTime < local.bestTime
        ? {
            ...toDailyChallengeResultFromRow(row),
            completedLaps: Number.isFinite(row.completedLaps)
                ? row.completedLaps
                : local.completedLaps,
        }
        : local;
}

export function getDailyChallengeBestResult(challenge) {
    const result = mergeDailyChallengeBestResult(challenge);
    return result && typeof result === 'object' ? { ...result } : null;
}

export function getDailyChallengeBestDisplay(challenge) {
    if (!challenge) return '--';
    const merged = getDailyChallengeBestResult(challenge);
    return formatDailyChallengeBestLabel(
        challenge.objectiveType,
        merged?.bestTime,
        merged?.completedLaps,
    );
}

export function getCachedDailyChallengeSnapshot(challengeId) {
    return readCachedDailySnapshot(challengeId);
}

export function getMissingDailyChallengeSnapshotIds(challengeIds = []) {
    return [...new Set(
        (Array.isArray(challengeIds) ? challengeIds : [])
            .filter((challengeId) => typeof challengeId === 'string' && challengeId)
    )].filter((challengeId) => !readCachedDailySnapshot(challengeId));
}

export function invalidateDailyChallengeSnapshot(challengeId) {
    if (!challengeId) return;
    hydrateDailySnapshotCache();
    dailySnapshotCache.delete(challengeId);
    dailySnapshotInflight.delete(challengeId);
    writeDailySnapshotCacheStorage();
}

function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            topRows: [],
            nearbyRows: [],
            currentPlayerRow: null,
            totalCount: 0,
            leaderboardEntryCount: 0,
            objectiveType: null,
            playerRank: null,
            playerRankLabel: null
        };
    }

    const totalCount = Number(raw.totalCount) || 0;
    const rawEntryCount = raw.leaderboardEntryCount;
    const leaderboardEntryCount = rawEntryCount != null && Number.isFinite(Number(rawEntryCount))
        ? Math.max(0, Math.trunc(Number(rawEntryCount)))
        : totalCount;

    return {
        topRows: Array.isArray(raw.topRows) ? raw.topRows.map(normalizeSnapshotRow).filter(Boolean) : [],
        nearbyRows: Array.isArray(raw.nearbyRows) ? raw.nearbyRows.map(normalizeSnapshotRow).filter(Boolean) : [],
        currentPlayerRow: raw.currentPlayerRow && typeof raw.currentPlayerRow === 'object'
            ? normalizeSnapshotRow(raw.currentPlayerRow)
            : null,
        totalCount,
        leaderboardEntryCount,
        objectiveType: typeof raw.objectiveType === 'string' ? raw.objectiveType : null,
        playerRank: raw.playerRank != null && Number.isFinite(Number(raw.playerRank))
            ? Number(raw.playerRank)
            : null,
        playerRankLabel: raw.playerRankLabel != null ? String(raw.playerRankLabel) : null
    };
}

function getObjectiveRequiredLaps(challenge) {
    if (challenge?.objectiveType === 'multi_lap_total') {
        return Math.max(2, Math.trunc(challenge.objectiveParams?.lapCount || 2));
    }
    return 1;
}

export function getDailyChallengeTrackName(challenge) {
    return TRACKS[challenge?.trackKey]?.name || 'Unknown Track';
}

export function getDailyChallengeObjectiveLabel(challenge) {
    if (!challenge) return 'Daily Challenge';

    if (challenge.objectiveType === 'multi_lap_total') {
        return `${getObjectiveRequiredLaps(challenge)} laps`;
    }

    return '1 lap';
}

/** Short line for the mode-select daily challenge row (track name • …). */
export function getDailyChallengeModeSelectObjectiveLine(challenge) {
    return getDailyChallengeCopyLabels(challenge).modeSelectLine;
}

export function getDailyChallengeCopyLabels(challenge) {
    const objectiveType = challenge?.objectiveType || 'single_lap_fastest';

    if (objectiveType === 'multi_lap_total') {
        return {
            hudPrimaryLabel: 'RACE',
            primaryStatLabel: 'Race Time',
            bestSummaryLabel: 'Best Race',
            modeSelectLine: 'Best race time'
        };
    }

    return {
        hudPrimaryLabel: 'LAP',
        primaryStatLabel: 'Lap Time',
        bestSummaryLabel: 'Best Lap',
        modeSelectLine: 'Best lap time'
    };
}

export function formatDailyChallengeResultLabel(challenge, result) {
    if (!result || typeof result !== 'object') {
        return '--';
    }
    const bestTime = Number.isFinite(result?.bestTime) ? Number(result.bestTime) : null;
    return bestTime !== null ? `${bestTime.toFixed(2)}s` : '--';
}

export function formatDailyChallengeBestLabel(objectiveType, bestTime, completedLaps = null) {
    return Number.isFinite(bestTime) ? `${Number(bestTime).toFixed(2)}s` : '--';
}

function formatDailyChallengeStatusDate(isoString) {
    const timeMs = Date.parse(isoString);
    if (!Number.isFinite(timeMs)) return '';

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: '2-digit',
        timeZone: 'UTC'
    }).format(new Date(timeMs));
}

export function getDailyChallengeCardStatus(challenge, nowMs = Date.now()) {
    const endsAtMs = getChallengeTimeMs(challenge, 'endsAt');
    const availableUntilMs = getChallengeTimeMs(challenge, 'availableUntil');

    if (Number.isFinite(endsAtMs) && nowMs < endsAtMs) {
        return {
            key: 'featured',
            label: 'Featured',
        };
    }

    if (Number.isFinite(availableUntilMs) && nowMs < availableUntilMs) {
        const formattedDate = formatDailyChallengeStatusDate(challenge?.availableUntil);
        return {
            key: 'available',
            label: formattedDate ? `Available until ${formattedDate}` : 'Available',
        };
    }

    return {
        key: 'expired',
        label: 'Expired',
    };
}

export function formatDailyChallengePlaylistAvailabilityLabel(challenge) {
    const until = challenge?.availableUntil;
    if (!until || typeof until !== 'string') return '';

    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return '';

    const remainingMs = untilMs - Date.now();
    if (remainingMs <= 0) return 'Expired';

    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) {
        const minutes = totalMinutes % 60;
        return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
    }

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function getDailyChallengeModifierBadges(challenge) {
    return challenge ? [] : [];
}

export function getDailyChallengeModifierLabel(challenge) {
    return getDailyChallengeModifierBadges(challenge).join(' • ');
}

export function getDailyChallengeRequiredLaps(challenge) {
    return getObjectiveRequiredLaps(challenge);
}

export async function getActiveDailyChallenge() {
    if (shouldUseMockDailyChallenge()) {
        console.log('Using mock daily challenge for local development');
        return getMockDailyChallenge();
    }

    const cachedChallenge = getValidCachedActiveDailyChallenge();

    const config = getDailyChallengeConfig();
    if (!config || typeof fetch !== 'function') return cachedChallenge;

    try {
        const response = await fetch(config.dailyActiveUrl, {
            method: 'GET',
            headers: buildServiceHeaders(config),
        });

        if (!response.ok) {
            throw new Error(`Active daily challenge fetch failed: ${response.status}`);
        }

        const payload = await response.json();
        const challenge = normalizeDailyChallenge(payload);
        if (challenge) {
            writeActiveDailyCacheStorable(challenge);
        } else {
            clearActiveDailyCacheStorage();
        }

        return challenge;
    } catch (error) {
        if (cachedChallenge) {
            return cachedChallenge;
        }
        throw error;
    }
}

async function loadDailyChallengePlaylist() {
    if (shouldUseMockDailyChallenge()) {
        return getLocalDailyPlaylist();
    }

    const config = getDailyChallengeConfig();
    if (!config || typeof fetch !== 'function') {
        return getLocalDailyPlaylist();
    }

    const response = await fetch(config.dailyPlaylistUrl, {
        method: 'GET',
        headers: buildServiceHeaders(config),
    });

    if (!response.ok) {
        throw new Error(`Daily challenge playlist fetch failed: ${response.status}`);
    }

    const payload = await response.json();
    const rawChallenges = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.challenges)
            ? payload.challenges
            : [];
    return rawChallenges
        .map((challenge) => normalizeDailyChallenge(challenge))
        .filter(Boolean);
}

export async function getDailyChallengePlaylist({ forceRefresh = false } = {}) {
    const nowMs = Date.now();
    if (!forceRefresh) {
        const cachedChallenges = getUsableCachedDailyPlaylist(nowMs);
        if (cachedChallenges.length >= DAILY_PLAYLIST_DAYS) {
            return cachedChallenges;
        }
        if (dailyPlaylistCache.promise) {
            return cloneDailyPlaylist(await dailyPlaylistCache.promise);
        }
    }

    const requestPromise = loadDailyChallengePlaylist()
        .then((challenges) => {
            const fetchedChallenges = cloneDailyPlaylist(challenges);
            cacheDailyChallengePlaylist(fetchedChallenges);
            dailyPlaylistCache.promise = null;
            return fetchedChallenges;
        })
        .catch((error) => {
            dailyPlaylistCache.promise = null;
            throw error;
        });

    dailyPlaylistCache.promise = requestPromise;
    return cloneDailyPlaylist(await requestPromise);
}

export function getCachedDailyChallengePlaylist() {
    return getUsableCachedDailyPlaylist();
}

async function loadDailyChallengeSnapshot({ challengeId, limit = DEFAULT_DAILY_LIMIT } = {}) {
    if (shouldUseMockDailyChallenge() || isLocalEnvironment()) {
        console.log('Using mock daily challenge snapshot for local development');
        return getMockDailyChallengeSnapshot();
    }

    const config = getDailyChallengeConfig();
    if (!config || typeof fetch !== 'function' || !challengeId) {
        return normalizeSnapshot(null);
    }

    const safeLimit = clampRequestLimit(limit, { defaultLimit: DEFAULT_DAILY_LIMIT });
    const origin = typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://localhost';
    const url = new URL(config.dailySnapshotUrl, origin);
    url.searchParams.set('challengeId', challengeId);
    url.searchParams.set('playerId', getOrCreatePlayerId('daily challenge'));
    url.searchParams.set('leaderboardIdentity', getLeaderboardIdentityPreference());
    url.searchParams.set('limit', safeLimit.toString());

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: buildServiceHeaders(config),
    });

    if (!response.ok) {
        throw new Error(`Daily challenge snapshot fetch failed: ${response.status}`);
    }

    const payload = await response.json();
    return normalizeSnapshot(payload);
}

export async function getDailyChallengeSnapshot({
    challengeId,
    limit = DEFAULT_DAILY_LIMIT,
    forceRefresh = false
} = {}) {
    if (!challengeId) {
        return normalizeSnapshot(null);
    }

    if (!forceRefresh) {
        const cachedSnapshot = readCachedDailySnapshot(challengeId);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }
        const inflight = dailySnapshotInflight.get(challengeId);
        if (inflight) {
            return cloneSnapshot(await inflight);
        }
    } else {
        invalidateDailyChallengeSnapshot(challengeId);
    }

    const requestPromise = loadDailyChallengeSnapshot({ challengeId, limit })
        .then((snapshot) => {
            writeCachedDailySnapshot(challengeId, snapshot);
            return snapshot;
        })
        .catch((error) => {
            dailySnapshotInflight.delete(challengeId);
            throw error;
        });

    dailySnapshotInflight.set(challengeId, requestPromise);
    try {
        return cloneSnapshot(await requestPromise);
    } finally {
        if (dailySnapshotInflight.get(challengeId) === requestPromise) {
            dailySnapshotInflight.delete(challengeId);
        }
    }
}

export async function prefetchDailyChallengeSnapshots(challengeIds = []) {
    const uniqueIds = getMissingDailyChallengeSnapshotIds(challengeIds);

    if (!uniqueIds.length) return;

    await Promise.allSettled(
        uniqueIds.map((challengeId) => getDailyChallengeSnapshot({ challengeId }))
    );
}

export async function submitDailyChallengeBestTime({
    challengeId,
    trackKey = null,
    bestTime,
    replay,
    checkpointTimesSec = null,
} = {}) {
    const config = getDailyChallengeConfig();
    if (!config || typeof fetch !== 'function') return null;
    if (
        typeof challengeId !== 'string'
        || !challengeId
        || typeof trackKey !== 'string'
        || !trackKey
        || !Number.isFinite(bestTime)
        || bestTime < MIN_DAILY_TIME
        || bestTime > MAX_DAILY_TIME
        || !replay
    ) {
        return null;
    }

    if (isLocalEnvironment()) {
        return {
            ok: false,
            status: 403,
            body: { error: 'Writing to the scoreboard is prohibited from localhost.' }
        };
    }

    const response = await fetch(config.dailySubmitUrl, {
        method: 'POST',
        headers: {
            ...buildServiceHeaders(config),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            playerId: getOrCreatePlayerId('daily challenge'),
            challengeId,
            trackKey,
            leaderboardIdentity: getLeaderboardIdentityPreference(),
            bestTime,
            replay,
            checkpointTimesSec: Array.isArray(checkpointTimesSec) ? checkpointTimesSec : null,
        })
    });

    return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null)
    };
}
