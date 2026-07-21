import {
    DEFAULT_TRACK_KEY,
    getTrackName,
    hasTrack,
} from '../track/catalog.js';
import { isLocalEnvironment } from '../track/environment.js';
import {
    API_ROUTES,
    clampRequestLimit,
} from '../scoreboard/api-client.js';
import {
    getGuestPlayerToken,
    getOrCreatePlayerId,
} from '../scoreboard/player-identity.js';
import {
    getLeaderboardIdentityPreference,
} from '../scoreboard/display-preference.js';
import {
    cloneScoreboardSnapshot,
    normalizeScoreboardSnapshot,
} from '../scoreboard/snapshot.js';
import {
    getDailyChallengeData,
    setDailyChallengeBestTime,
} from './storage.js';

export {
    formatDailyChallengeBestLabel,
    formatDailyChallengePlaylistAvailabilityLabel,
    formatDailyChallengeRemainingDuration,
    formatDailyChallengeResultLabel,
    formatDailyChallengeStatusDate,
    getDailyChallengeCardStatus,
    getDailyChallengeCopyLabels,
    getDailyChallengeModeSelectObjectiveLine,
    getDailyChallengeModifierBadges,
    getDailyChallengeModifierLabel,
    getDailyChallengeObjectiveLabel,
    getDailyChallengeRequiredLaps,
    getObjectiveRequiredLaps,
} from './labels.js';

const MIN_DAILY_TIME = 2.0;
const MAX_DAILY_TIME = 60 * 60;
const DEFAULT_DAILY_LIMIT = 10;
const ACTIVE_DAILY_CACHE_KEY = 'VectorGpActiveDailyChallengeCache';
const DAILY_PLAYLIST_CACHE_KEY = 'VectorGpDailyChallengePlaylistCache';
const DAILY_SNAPSHOT_CACHE_KEY = 'VectorGpDailyChallengeSnapshotCache';
const DAILY_START_OVERRIDE_KEY = 'VectorGpDailyStartOverride';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_PLAYLIST_DAYS = 7;
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

/** Standalone local preview card (`preview.html`) — use mock data only outside Reddit hosting. */
export function isPreviewPage() {
    if (typeof window === 'undefined') return false;
    const path = window.location?.pathname || '';
    return /(?:^|\/)preview\.html$/i.test(path);
}

/** mockDaily=true → random track; mockDaily=<trackKey> → that track only */
export function resolveMockDailyTrackKey(params) {
    if (!params) return null;

    const mockDaily = params.get('mockDaily');
    if (mockDaily && mockDaily !== 'true' && hasTrack(mockDaily)) {
        return mockDaily;
    }

    const mockTrack = params.get('mockTrack');
    if (mockTrack && hasTrack(mockTrack)) {
        return mockTrack;
    }

    return null;
}

function shouldUseMockDailyChallenge() {
    const params = getMockDailyUrlParams();
    if (params) {
        const mockDaily = params.get('mockDaily');
        if (mockDaily === 'true' || (mockDaily && hasTrack(mockDaily))) {
            return true;
        }
        if (params.get('localDev') === 'true') {
            return true;
        }
    }
    return isPreviewPage() && !readDevvitPostData();
}

function getMockDailyChallenge() {
    const params = getMockDailyUrlParams();
    const fixedTrackKey = resolveMockDailyTrackKey(params);
    const trackKey = fixedTrackKey || DEFAULT_TRACK_KEY;
    if (!trackKey) {
        return null;
    }
    const now = Date.now();
    return normalizeDailyChallenge({
        id: 'mock-daily-challenge-local',
        trackKey,
        objectiveType: 'single_lap_fastest',
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + DAY_MS).toISOString(),
        availableUntil: new Date(now + DAILY_PLAYLIST_DAYS * DAY_MS).toISOString(),
        status: 'active',
        objectiveParams: {},
        skin: 'default'
    });
}

function getMockDailyChallengeSnapshot() {
    return normalizeScoreboardSnapshot({
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

export function toCachedActiveChallenge(challenge) {
    if (!challenge || typeof challenge !== 'object') return null;
    if (typeof challenge.id !== 'string' || !challenge.id) return null;
    if (typeof challenge.trackKey !== 'string' || !hasTrack(challenge.trackKey)) return null;

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

function readDevvitPostData() {
    const postData = globalThis?.devvit?.context?.postData;
    return postData && typeof postData === 'object' ? postData : null;
}

function getPostBoundDailyChallengeFromContext() {
    const postData = readDevvitPostData();
    if (!postData) return null;

    const challenge = normalizeDailyChallenge(postData.challenge);
    if (challenge) return challenge;

    return null;
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

export function isCachedActiveChallengeStillCurrent(challenge) {
    if (!challenge?.endsAt || typeof challenge.endsAt !== 'string') return false;
    const endsMs = Date.parse(challenge.endsAt);
    if (!Number.isFinite(endsMs)) return false;
    return Date.now() < endsMs;
}

function getValidCachedActiveDailyChallenge() {
    const stored = readActiveDailyCacheStorable();
    if (!stored?.challenge || typeof stored.challenge !== 'object') return null;
    const challenge = normalizeDailyChallenge(stored.challenge);
    if (!challenge || !isCachedActiveChallengeStillCurrent(challenge)) return null;
    if (!isChallengeTrackCurrentForSchedule(challenge)) return null;
    return challenge;
}

function readDailyStartOverride() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(DAILY_START_OVERRIDE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (Number.isFinite(parsed.expiresAt) && Date.now() > parsed.expiresAt) {
            window.localStorage.removeItem(DAILY_START_OVERRIDE_KEY);
            return null;
        }
        return parsed;
    } catch (error) {
        console.error('Error reading daily start override:', error);
        return null;
    }
}

function clearDailyStartOverride() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.removeItem(DAILY_START_OVERRIDE_KEY);
    } catch (error) {
        console.error('Error clearing daily start override:', error);
    }
}

export function requestFeaturedDailyChallengeStart() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(
            DAILY_START_OVERRIDE_KEY,
            JSON.stringify({
                mode: 'featured',
                expiresAt: Date.now() + 5 * 60 * 1000
            })
        );
    } catch (error) {
        console.error('Error writing daily start override:', error);
    }
}

function normalizeObjectiveType(value) {
    return value === 'multi_lap_total' ? 'multi_lap_total' : 'single_lap_fastest';
}

export function normalizeDailyChallenge(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.trackKey !== 'string' || !hasTrack(raw.trackKey)) return null;

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

function isChallengeTrackCurrentForSchedule(challenge) {
    return hasTrack(challenge?.trackKey);
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
        if (!isChallengeTrackCurrentForSchedule(challenge)) continue;
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

export function resolveDailyPlaylistCacheExpiresAt(challenges, nowMs = Date.now()) {
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
                snapshot: cloneScoreboardSnapshot(entry.snapshot),
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
            snapshot: cloneScoreboardSnapshot(entry.snapshot),
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
    return cloneScoreboardSnapshot(entry.snapshot);
}

function writeCachedDailySnapshot(challengeId, snapshot) {
    if (!challengeId || !snapshot) return;
    hydrateDailySnapshotCache();
    dailySnapshotCache.set(challengeId, {
        snapshot: cloneScoreboardSnapshot(snapshot),
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

export function getCachedDailyChallengeSnapshot(challengeId) {
    return readCachedDailySnapshot(challengeId);
}

export function getMissingDailyChallengeSnapshotIds(challengeIds = []) {
    return [...new Set(
        (Array.isArray(challengeIds) ? challengeIds : [])
            .filter((challengeId) => typeof challengeId === 'string' && challengeId)
    )].filter((challengeId) => !readCachedDailySnapshot(challengeId));
}

export function getDailyChallengeTrackName(challenge) {
    return getTrackName(challenge?.trackKey, 'Unknown Track');
}

export async function getActiveDailyChallenge({ allowExpiredPost = false } = {}) {
    const startOverride = readDailyStartOverride();
    if (startOverride?.mode === 'featured') {
        clearDailyStartOverride();
    }

    const postChallenge = getPostBoundDailyChallengeFromContext();
    if (postChallenge) {
        cacheDailyChallengePlaylist([postChallenge]);
        if (allowExpiredPost || isChallengeStillUsable(postChallenge)) {
            return postChallenge;
        }
    }

    const config = API_ROUTES;
    const cachedChallenge = getValidCachedActiveDailyChallenge();

    if (config && typeof fetch === 'function') {
        try {
            const response = await fetch(config.dailyActiveUrl, { method: 'GET' });

            if (response.ok) {
                const payload = await response.json();
                const challenge = normalizeDailyChallenge(payload);
                if (challenge) {
                    writeActiveDailyCacheStorable(challenge);
                    return challenge;
                }
            } else {
                throw new Error(`Server returned status ${response.status}`);
            }
        } catch (error) {
            console.warn('Failed to fetch active daily challenge from server, trying fallbacks:', error);
            if (!shouldUseMockDailyChallenge()) {
                if (cachedChallenge) {
                    return cachedChallenge;
                }
                throw error;
            }
        }
    }

    if (cachedChallenge) {
        return cachedChallenge;
    }

    return getMockDailyChallenge();
}

async function loadDailyChallengePlaylist() {
    const config = API_ROUTES;
    if (config && typeof fetch === 'function') {
        try {
            const response = await fetch(config.dailyPlaylistUrl, { method: 'GET' });

            if (response.ok) {
                const payload = await response.json();
                const rawChallenges = Array.isArray(payload)
                    ? payload
                    : Array.isArray(payload?.challenges)
                        ? payload.challenges
                        : [];
                const parsed = rawChallenges
                    .map((challenge) => normalizeDailyChallenge(challenge))
                    .filter(Boolean);
                if (parsed.length > 0) {
                    return parsed;
                }
            } else {
                throw new Error(`Server returned status ${response.status}`);
            }
        } catch (error) {
            console.warn('Failed to fetch daily challenge playlist from server, trying fallbacks:', error);
            if (!shouldUseMockDailyChallenge()) {
                throw error;
            }
        }
    }

    return [getMockDailyChallenge()].filter(Boolean);
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

async function loadDailyChallengeSnapshot({
    challengeId,
    limit = DEFAULT_DAILY_LIMIT,
    offset = 0,
} = {}) {
    const config = API_ROUTES;
    if (config && typeof fetch === 'function' && challengeId) {
        try {
            const safeLimit = clampRequestLimit(limit, { defaultLimit: DEFAULT_DAILY_LIMIT });
            const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
            const origin = typeof window !== 'undefined' && window.location?.origin
                ? window.location.origin
                : 'http://localhost';
            const url = new URL(config.dailySnapshotUrl, origin);
            url.searchParams.set('challengeId', challengeId);
            url.searchParams.set('playerId', getOrCreatePlayerId('daily challenge'));
            const guestToken = getGuestPlayerToken();
            if (guestToken) {
                url.searchParams.set('guestToken', guestToken);
            }
            url.searchParams.set('limit', safeLimit.toString());
            url.searchParams.set('offset', safeOffset.toString());

            const response = await fetch(url.toString(), { method: 'GET' });

            if (response.ok) {
                const payload = await response.json();
                return normalizeScoreboardSnapshot(payload);
            } else {
                throw new Error(`Server returned status ${response.status}`);
            }
        } catch (error) {
            console.warn('Failed to fetch daily challenge snapshot from server, trying fallbacks:', error);
            if (!shouldUseMockDailyChallenge() && !isLocalEnvironment()) {
                throw error;
            }
        }
    }

    return getMockDailyChallengeSnapshot();
}

export async function getDailyChallengeSnapshot({
    challengeId,
    limit = DEFAULT_DAILY_LIMIT,
    offset = 0,
    forceRefresh = false
} = {}) {
    if (!challengeId) {
        return normalizeScoreboardSnapshot(null);
    }

    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const safeLimit = clampRequestLimit(limit, { defaultLimit: DEFAULT_DAILY_LIMIT });
    const requestKey = `${challengeId}:${safeOffset}:${safeLimit}`;
    const isFirstPage = safeOffset === 0;

    if (!forceRefresh && isFirstPage) {
        const cachedSnapshot = readCachedDailySnapshot(challengeId);
        if (cachedSnapshot) {
            return cachedSnapshot;
        }
        const inflight = dailySnapshotInflight.get(requestKey);
        if (inflight) {
            return cloneScoreboardSnapshot(await inflight);
        }
    }

    const requestPromise = loadDailyChallengeSnapshot({
        challengeId,
        limit: safeLimit,
        offset: safeOffset,
    })
        .then((snapshot) => {
            if (isFirstPage) {
                writeCachedDailySnapshot(challengeId, snapshot);
            }
            return snapshot;
        })
        .catch((error) => {
            dailySnapshotInflight.delete(requestKey);
            throw error;
        });

    dailySnapshotInflight.set(requestKey, requestPromise);
    try {
        return cloneScoreboardSnapshot(await requestPromise);
    } finally {
        if (dailySnapshotInflight.get(requestKey) === requestPromise) {
            dailySnapshotInflight.delete(requestKey);
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
    const config = API_ROUTES;
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
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            playerId: getOrCreatePlayerId('daily challenge'),
            guestToken: getGuestPlayerToken(),
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

async function postDailyShareRequest(url, body) {
    if (isLocalEnvironment()) {
        return {
            ok: false,
            status: 403,
            body: { status: 'unavailable_locally', error: 'Reddit sharing is only available in the hosted game.' }
        };
    }
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
    };
}

export function previewDailyChallengeShare(payload = {}) {
    return postDailyShareRequest(API_ROUTES.dailySharePreviewUrl, payload);
}

export function confirmDailyChallengeShare(shareToken) {
    return postDailyShareRequest(API_ROUTES.dailyShareConfirmUrl, { shareToken });
}
