import { TRACK_MODE_DAILY_GP } from "../config.js?v=1.91";

const VERIFICATION_QUEUE_STORAGE_KEY = "VectorGpVerificationQueue";
const DEFAULT_RETRY_DELAY_MS = 30_000;

function createEmptyState() {
  return {
    scoreboard: {},
    daily: {},
  };
}

function readQueueState() {
  if (typeof window === "undefined" || !window.localStorage) {
    return createEmptyState();
  }

  try {
    const raw = window.localStorage.getItem(VERIFICATION_QUEUE_STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    return {
      scoreboard:
        parsed?.scoreboard && typeof parsed.scoreboard === "object"
          ? parsed.scoreboard
          : {},
      daily:
        parsed?.daily && typeof parsed.daily === "object" ? parsed.daily : {},
    };
  } catch (error) {
    console.error("Error reading verification queue:", error);
    return createEmptyState();
  }
}

function writeQueueState(queueState) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      VERIFICATION_QUEUE_STORAGE_KEY,
      JSON.stringify(queueState),
    );
  } catch (error) {
    console.error("Error writing verification queue:", error);
  }
}

function createScoreboardEntryKey(trackKey) {
  return `${trackKey}::${TRACK_MODE_DAILY_GP}`;
}

function normalizeNextAttemptAt(value) {
  const nextAttemptAt = Number(value);
  return Number.isFinite(nextAttemptAt) ? nextAttemptAt : Date.now();
}

function cloneEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    ...entry,
    replay:
      entry.replay && typeof entry.replay === "object"
        ? JSON.parse(JSON.stringify(entry.replay))
        : null,
  };
}

function isBetterDailyCandidate(nextEntry, previousEntry) {
  if (!previousEntry) return true;
  return Number(nextEntry.bestTime) < Number(previousEntry.bestTime);
}

function isBetterScoreboardCandidate(nextEntry, previousEntry) {
  if (!previousEntry) return true;
  return Number(nextEntry.bestTime) < Number(previousEntry.bestTime);
}

function updateScoreboardEntry(trackKey, updater) {
  const queueState = readQueueState();
  const entryKey = createScoreboardEntryKey(trackKey);
  const nextEntry = updater(queueState.scoreboard[entryKey] || null);

  if (nextEntry) {
    queueState.scoreboard[entryKey] = nextEntry;
  } else {
    delete queueState.scoreboard[entryKey];
  }

  writeQueueState(queueState);
  return cloneEntry(nextEntry);
}

function updateDailyEntry(challengeId, updater) {
  const queueState = readQueueState();
  const nextEntry = updater(queueState.daily[challengeId] || null);

  if (nextEntry) {
    queueState.daily[challengeId] = nextEntry;
  } else {
    delete queueState.daily[challengeId];
  }

  writeQueueState(queueState);
  return cloneEntry(nextEntry);
}

export function getVerificationRetryDelayMs() {
  return DEFAULT_RETRY_DELAY_MS;
}

export function getScoreboardVerificationEntry(
  trackKey
) {
  if (!trackKey) return null;
  const queueState = readQueueState();
  return cloneEntry(
    queueState.scoreboard[createScoreboardEntryKey(trackKey)] || null,
  );
}

export function getDailyChallengeVerificationEntry(challengeId) {
  if (!challengeId) return null;
  const queueState = readQueueState();
  return cloneEntry(queueState.daily[challengeId] || null);
}

export function getScoreboardVerificationState(
  trackKey
) {
  return (
    getScoreboardVerificationEntry(trackKey)?.verificationState || "none"
  );
}

export function getDailyChallengeVerificationState(challengeId) {
  return (
    getDailyChallengeVerificationEntry(challengeId)?.verificationState || "none"
  );
}

export function enqueueScoreboardVerification({
  trackKey,
  bestTime,
  replay,
} = {}) {
  if (
    typeof trackKey !== "string" ||
    !trackKey ||
    !Number.isFinite(bestTime) ||
    !replay
  ) {
    return { enqueued: false, entry: null };
  }

  const nextEntry = {
    trackKey,
    mode: TRACK_MODE_DAILY_GP,
    bestTime,
    replay,
    verificationState: "pending",
    nextAttemptAt: Date.now(),
    updatedAt: new Date().toISOString(),
  };

  let didEnqueue = false;
  const entry = updateScoreboardEntry(trackKey, (previousEntry) => {
    if (!isBetterScoreboardCandidate(nextEntry, previousEntry)) {
      return previousEntry;
    }
    didEnqueue = true;
    return nextEntry;
  });
  return {
    enqueued: didEnqueue,
    entry,
  };
}

export function enqueueDailyChallengeVerification({
  challengeId,
  bestTime,
  completedLaps = null,
  replay,
  checkpointTimesSec = null,
  objectiveType = null,
  challengeDate = null,
  trackKey = null,
} = {}) {
  if (
    typeof challengeId !== "string" ||
    !challengeId ||
    !Number.isFinite(bestTime) ||
    !replay
  ) {
    return { enqueued: false, entry: null };
  }

  const nextEntry = {
    challengeId,
    bestTime,
    completedLaps: Number.isFinite(completedLaps)
      ? Math.max(0, Math.trunc(completedLaps))
      : null,
    replay,
    checkpointTimesSec: Array.isArray(checkpointTimesSec)
      ? checkpointTimesSec.slice()
      : null,
    objectiveType: typeof objectiveType === "string" ? objectiveType : null,
    challengeDate: typeof challengeDate === "string" ? challengeDate : null,
    trackKey: typeof trackKey === "string" ? trackKey : null,
    verificationState: "pending",
    nextAttemptAt: Date.now(),
    updatedAt: new Date().toISOString(),
  };

  let didEnqueue = false;
  const entry = updateDailyEntry(challengeId, (previousEntry) => {
    if (!isBetterDailyCandidate(nextEntry, previousEntry)) {
      return previousEntry;
    }
    didEnqueue = true;
    return nextEntry;
  });
  return {
    enqueued: didEnqueue,
    entry,
  };
}

export function clearScoreboardVerification(
  trackKey
) {
  return updateScoreboardEntry(trackKey, () => null);
}

export function clearDailyChallengeVerification(challengeId) {
  return updateDailyEntry(challengeId, () => null);
}

export function markScoreboardVerificationPending(
  trackKey,
  nextAttemptAt = Date.now(),
) {
  return updateScoreboardEntry(trackKey, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "pending",
      nextAttemptAt: normalizeNextAttemptAt(nextAttemptAt),
      updatedAt: new Date().toISOString(),
    };
  });
}

export function markDailyChallengeVerificationPending(
  challengeId,
  nextAttemptAt = Date.now(),
) {
  return updateDailyEntry(challengeId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "pending",
      nextAttemptAt: normalizeNextAttemptAt(nextAttemptAt),
      updatedAt: new Date().toISOString(),
    };
  });
}

export function markScoreboardVerificationRejected(
  trackKey
) {
  return updateScoreboardEntry(trackKey, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "rejected",
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
  });
}

export function markDailyChallengeVerificationRejected(challengeId) {
  return updateDailyEntry(challengeId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "rejected",
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
  });
}

export function getDueScoreboardVerifications(now = Date.now()) {
  const queueState = readQueueState();
  return Object.values(queueState.scoreboard)
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        normalizeNextAttemptAt(entry.nextAttemptAt) <= now,
    )
    .map((entry) => cloneEntry(entry));
}

export function getDueDailyChallengeVerifications(now = Date.now()) {
  const queueState = readQueueState();
  return Object.values(queueState.daily)
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        normalizeNextAttemptAt(entry.nextAttemptAt) <= now,
    )
    .map((entry) => cloneEntry(entry));
}

export function getNextVerificationAttemptAt() {
  const queueState = readQueueState();
  const nextAttemptValues = [
    ...Object.values(queueState.scoreboard),
    ...Object.values(queueState.daily),
  ]
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        Number.isFinite(Number(entry.nextAttemptAt)),
    )
    .map((entry) => Number(entry.nextAttemptAt));

  if (!nextAttemptValues.length) return null;
  return Math.min(...nextAttemptValues);
}

export function resetVerificationQueueForTests() {
  writeQueueState(createEmptyState());
}



export function createVerificationSnapshot({
  statusText = "",
  verificationState = "pending",
  isLoading = true,
} = {}) {
  return {
    isLoading,
    verificationState,
    statusText,
  };
}

export const VERIFICATION_REJECTED_SNAPSHOT = createVerificationSnapshot({
  statusText: "Rejected",
  verificationState: "rejected",
  isLoading: false,
});

export const VERIFICATION_ACCEPTED_PENDING_SNAPSHOT =
  createVerificationSnapshot({
    statusText: "Pending verification",
    verificationState: "pending",
    isLoading: false,
  });

export function getVerificationSnapshotFromQueueEntry(entry) {
  if (!entry) return null;
  if (entry.verificationState === "rejected") {
    return VERIFICATION_REJECTED_SNAPSHOT;
  }
  return VERIFICATION_ACCEPTED_PENDING_SNAPSHOT;
}
