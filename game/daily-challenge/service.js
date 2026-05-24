import { TRACKS } from '../track/tracks.js?v=1.91';
import { isLocalEnvironment } from '../track/environment.js?v=1.91';
import {
    buildServiceHeaders,
    clampRequestLimit,
    getBaseApiConfig,
    getOrCreatePlayerId,
} from '../scoreboard/api-client.js?v=1.92';
import {
    getLeaderboardIdentityPreference,
} from '../scoreboard/display-preference.js?v=1.91';

const MIN_DAILY_TIME = 2.0;
const MAX_DAILY_TIME = 60 * 60;
const DEFAULT_DAILY_LIMIT = 10;
const ACTIVE_DAILY_CACHE_KEY = 'VectorGpActiveDailyChallengeCache';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_PLAYLIST_DAYS = 7;
const DAILY_TRACK_STEP_SEED = 17;

function getMockDailyUrlParams() {
    if (typeof window === 'undefined' || !window.location?.search) return null;
    try {
        return new URLSearchParams(window.location.search);
    } catch {
        return null;
    }
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
        objectiveType: typeof raw.objectiveType === 'string' ? raw.objectiveType : 'single_lap_fastest',
        objectiveParams: raw.objectiveParams && typeof raw.objectiveParams === 'object'
            ? raw.objectiveParams
            : {},
        skin: typeof raw.skin === 'string' && raw.skin.trim() ? raw.skin.trim() : 'default'
    };
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
        topRows: Array.isArray(raw.topRows) ? raw.topRows : [],
        nearbyRows: Array.isArray(raw.nearbyRows) ? raw.nearbyRows : [],
        currentPlayerRow: raw.currentPlayerRow && typeof raw.currentPlayerRow === 'object'
            ? raw.currentPlayerRow
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

export function isCrashBudgetDailyChallenge(challenge) {
    return challenge?.objectiveType === 'finish_with_crash_budget';
}

export function getDailyChallengeTrackName(challenge) {
    return TRACKS[challenge?.trackKey]?.name || 'Unknown Track';
}

export function getDailyChallengeObjectiveLabel(challenge) {
    if (!challenge) return 'Daily Challenge';

    if (challenge.objectiveType === 'multi_lap_total') {
        return `${getObjectiveRequiredLaps(challenge)} laps`;
    }

    if (isCrashBudgetDailyChallenge(challenge)) {
        const maxCrashes = Math.max(0, Math.trunc(challenge.objectiveParams?.maxCrashes || 0));
        return `Most laps before ${maxCrashes} crash${maxCrashes === 1 ? '' : 'es'}`;
    }

    return '1 lap';
}

/** Short line for the mode-select daily challenge row (track name • …). */
export function getDailyChallengeModeSelectObjectiveLine(challenge) {
    return getDailyChallengeCopyLabels(challenge).modeSelectLine;
}

export function getDailyChallengeCopyLabels(challenge) {
    const objectiveType = challenge?.objectiveType || 'single_lap_fastest';

    if (objectiveType === 'finish_with_crash_budget') {
        return {
            hudPrimaryLabel: 'LAPS',
            primaryStatLabel: 'Laps',
            bestSummaryLabel: 'Best Laps',
            modeSelectLine: 'Most laps'
        };
    }

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
    if (isCrashBudgetDailyChallenge(challenge)) {
        const completedLaps = Math.max(0, Math.trunc(result?.completedLaps || 0));
        if (completedLaps <= 0) {
            return '--';
        }
        return `${completedLaps} lap${completedLaps === 1 ? '' : 's'}`;
    }

    return bestTime !== null ? `${bestTime.toFixed(2)}s` : '--';
}

export function formatDailyChallengeBestLabel(objectiveType, bestTime, completedLaps = null) {
    if (objectiveType === 'finish_with_crash_budget') {
        const laps = Math.max(0, Math.trunc(completedLaps || 0));
        return laps > 0 ? `${laps} lap${laps === 1 ? '' : 's'}` : '--';
    }

    return Number.isFinite(bestTime) ? `${Number(bestTime).toFixed(2)}s` : '--';
}

export function formatDailyChallengePlaylistAvailabilityLabel(challenge) {
    const until = challenge?.availableUntil;
    if (!until || typeof until !== 'string') return '';

    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return '';

    const remainingMs = untilMs - Date.now();
    if (remainingMs <= 0) return 'No longer available';

    if (remainingMs < DAY_MS) {
        const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        return `Leaves playlist in ${parts.join(' ')}`;
    }

    const untilDate = new Date(untilMs);
    const now = new Date();
    const options = { month: 'short', day: 'numeric' };
    if (untilDate.getFullYear() !== now.getFullYear()) {
        options.year = 'numeric';
    }
    return `Available until ${untilDate.toLocaleDateString(undefined, options)}`;
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

export function getDailyChallengeMaxCrashes(challenge) {
    if (challenge?.objectiveType !== 'finish_with_crash_budget') return null;
    return Math.max(0, Math.trunc(challenge.objectiveParams?.maxCrashes || 0));
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

export async function getDailyChallengePlaylist() {
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

export async function getDailyChallengeSnapshot({ challengeId, limit = DEFAULT_DAILY_LIMIT } = {}) {
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

export async function submitDailyChallengeBestTime({
    challengeId,
    bestTime,
    replay,
    checkpointTimesSec = null,
} = {}) {
    const config = getDailyChallengeConfig();
    if (!config || typeof fetch !== 'function') return null;
    if (
        typeof challengeId !== 'string'
        || !challengeId
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
