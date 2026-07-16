import { normalizeCheckpointTimesSec } from "../shared/checkpoint-times.js";

const DAILY_CHALLENGE_STORAGE_KEY = "VectorGpDailyChallengeData";
const MAX_STORED_DAILY_CHALLENGES = 7;

function readStoredCheckpointTimesSec(stored) {
  if (!stored || typeof stored !== "object") {
    return null;
  }
  const bestTime = Number(stored.bestTime);
  if (!Number.isFinite(bestTime)) {
    return null;
  }
  return normalizeCheckpointTimesSec(bestTime, stored.checkpointTimesSec);
}

function normalizeCompletedLaps(value) {
  return Math.max(0, Math.trunc(value || 0));
}

function isBetterStoredResult(challenge, nextResult, previous) {
  if (!Number.isFinite(nextResult?.bestTime)) return false;
  const previousBest = Number.isFinite(previous?.bestTime)
    ? previous.bestTime
    : null;
  return previousBest === null || nextResult.bestTime < previousBest;
}

function readDailyChallengeMap() {
  if (typeof window === "undefined" || !window.localStorage) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(DAILY_CHALLENGE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error("Error reading daily challenge storage:", error);
    return {};
  }
}

function writeDailyChallengeMap(challengeMap) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      DAILY_CHALLENGE_STORAGE_KEY,
      JSON.stringify(challengeMap),
    );
  } catch (error) {
    console.error("Error writing daily challenge storage:", error);
  }
}

function pruneDailyChallengeMap(challengeMap) {
  const entries = Object.entries(challengeMap);
  if (entries.length <= MAX_STORED_DAILY_CHALLENGES) return challengeMap;

  const sorted = entries.sort(([, a], [, b]) => {
    const aTime = Date.parse(a?.updatedAt || a?.challengeDate || "") || 0;
    const bTime = Date.parse(b?.updatedAt || b?.challengeDate || "") || 0;
    return bTime - aTime;
  });

  return Object.fromEntries(sorted.slice(0, MAX_STORED_DAILY_CHALLENGES));
}

export function hasAnyDailyChallengeStoredData() {
  const map = readDailyChallengeMap();
  return Object.keys(map).length > 0;
}

export function getDailyChallengeData(challengeId) {
  if (!challengeId) return null;
  const challengeMap = readDailyChallengeMap();
  const stored = challengeMap[challengeId];
  return stored && typeof stored === "object" ? { ...stored } : null;
}

export function saveDailyChallengeBestTime(
  challenge,
  bestTime,
  completedLaps = null,
  checkpointTimesSec = null,
) {
  if (!challenge?.id || !Number.isFinite(bestTime)) return null;

  const normalizedCheckpoints = normalizeCheckpointTimesSec(
    bestTime,
    checkpointTimesSec,
  );
  const challengeMap = readDailyChallengeMap();
  const previous =
    challengeMap[challenge.id] && typeof challengeMap[challenge.id] === "object"
      ? challengeMap[challenge.id]
      : {};
  const nextResult = isBetterStoredResult(
    challenge,
    { bestTime, completedLaps },
    previous,
  )
    ? {
        bestTime,
        completedLaps: Number.isFinite(completedLaps)
          ? normalizeCompletedLaps(completedLaps)
          : Number.isFinite(previous.completedLaps)
            ? normalizeCompletedLaps(previous.completedLaps)
            : null,
        checkpointTimesSec: normalizedCheckpoints,
      }
    : {
        bestTime: Number.isFinite(previous.bestTime)
          ? previous.bestTime
          : bestTime,
        completedLaps: Number.isFinite(previous.completedLaps)
          ? normalizeCompletedLaps(previous.completedLaps)
          : null,
        checkpointTimesSec: readStoredCheckpointTimesSec(previous),
      };
  const nextMap = pruneDailyChallengeMap({
    ...challengeMap,
    [challenge.id]: {
      ...previous,
      challengeDate: challenge.challengeDate || previous.challengeDate || null,
      trackKey: challenge.trackKey || previous.trackKey || null,
      objectiveType: challenge.objectiveType || previous.objectiveType || null,
      bestTime: nextResult.bestTime,
      completedLaps: nextResult.completedLaps,
      checkpointTimesSec: nextResult.checkpointTimesSec,
      updatedAt: new Date().toISOString(),
    },
  });
  writeDailyChallengeMap(nextMap);
  return getDailyChallengeData(challenge.id);
}

export function setDailyChallengeBestTime(
  challenge,
  bestTime,
  completedLaps = null,
  checkpointTimesSec = null,
) {
  if (!challenge?.id || !Number.isFinite(bestTime)) return null;

  const normalizedCheckpoints = normalizeCheckpointTimesSec(
    bestTime,
    checkpointTimesSec,
  );
  const challengeMap = readDailyChallengeMap();
  const previous =
    challengeMap[challenge.id] && typeof challengeMap[challenge.id] === "object"
      ? challengeMap[challenge.id]
      : {};
  const nextMap = pruneDailyChallengeMap({
    ...challengeMap,
    [challenge.id]: {
      ...previous,
      challengeDate: challenge.challengeDate || previous.challengeDate || null,
      trackKey: challenge.trackKey || previous.trackKey || null,
      objectiveType: challenge.objectiveType || previous.objectiveType || null,
      bestTime,
      completedLaps: Number.isFinite(completedLaps)
        ? normalizeCompletedLaps(completedLaps)
        : null,
      checkpointTimesSec: normalizedCheckpoints,
      updatedAt: new Date().toISOString(),
    },
  });
  writeDailyChallengeMap(nextMap);
  return getDailyChallengeData(challenge.id);
}

export function clearDailyChallengeBestTime(challengeId) {
  if (!challengeId) return null;
  const challengeMap = readDailyChallengeMap();
  if (!challengeMap[challengeId]) return null;
  const nextMap = { ...challengeMap };
  delete nextMap[challengeId];
  writeDailyChallengeMap(nextMap);
  return null;
}

export function restoreDailyChallengeBestAfterFailedSubmission(
  challenge,
  previousBest = null,
) {
  if (!challenge?.id) return null;
  if (Number.isFinite(previousBest?.bestTime)) {
    return setDailyChallengeBestTime(
      challenge,
      previousBest.bestTime,
      Number.isFinite(previousBest.completedLaps)
        ? previousBest.completedLaps
        : null,
      Array.isArray(previousBest.checkpointTimesSec)
        ? previousBest.checkpointTimesSec
        : null,
    );
  }
  return clearDailyChallengeBestTime(challenge.id);
}

export function rollbackDailyChallengeBestIfMatchesFailedSubmission(
  challenge,
  failedBestTime,
  previousBest = null,
) {
  const local = getDailyChallengeData(challenge?.id);
  if (
    !Number.isFinite(failedBestTime)
    || !Number.isFinite(local?.bestTime)
    || local.bestTime !== failedBestTime
  ) {
    return local;
  }
  return restoreDailyChallengeBestAfterFailedSubmission(challenge, previousBest);
}
