const VERIFICATION_QUEUE_STORAGE_KEY = "VectorGpVerificationQueue";
const DEFAULT_RETRY_DELAY_MS = 30_000;
const VERIFICATION_STAGE_SUBMITTING = "submitting";
const VERIFICATION_STAGE_VERIFYING = "verifying";
const VERIFICATION_STAGE_PENDING = "pending";
const VERIFICATION_STAGE_RETRYING = "retrying";
const VERIFICATION_STAGE_REJECTED = "rejected";
const VERIFICATION_STAGE_ERROR = "error";

const VERIFICATION_STAGE_TEXT = {
  [VERIFICATION_STAGE_SUBMITTING]: "Submitting...",
  [VERIFICATION_STAGE_VERIFYING]: "Verifying...",
  [VERIFICATION_STAGE_PENDING]: "Pending",
  [VERIFICATION_STAGE_RETRYING]: "Retrying...",
  [VERIFICATION_STAGE_REJECTED]: "Rejected",
  [VERIFICATION_STAGE_ERROR]: "Submission failed",
};

function createEmptyState() {
  return {
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

function normalizeNextAttemptAt(value) {
  const nextAttemptAt = Number(value);
  return Number.isFinite(nextAttemptAt) ? nextAttemptAt : Date.now();
}

function normalizeVerificationState(value) {
  if (value === "rejected" || value === "error") return value;
  return "pending";
}

function normalizeVerificationStage(value, verificationState = "pending") {
  if (
    value === VERIFICATION_STAGE_SUBMITTING ||
    value === VERIFICATION_STAGE_VERIFYING ||
    value === VERIFICATION_STAGE_PENDING ||
    value === VERIFICATION_STAGE_RETRYING ||
    value === VERIFICATION_STAGE_REJECTED ||
    value === VERIFICATION_STAGE_ERROR
  ) {
    return value;
  }

  if (verificationState === "rejected") return VERIFICATION_STAGE_REJECTED;
  if (verificationState === "error") return VERIFICATION_STAGE_ERROR;
  return VERIFICATION_STAGE_PENDING;
}

function resolveVerificationStatusText(stage, fallback = "") {
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return VERIFICATION_STAGE_TEXT[stage] || "";
}

function cloneEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const verificationState = normalizeVerificationState(entry.verificationState);
  const submissionStage = normalizeVerificationStage(
    entry.submissionStage,
    verificationState,
  );
  return {
    ...entry,
    verificationState,
    submissionStage,
    statusText: resolveVerificationStatusText(submissionStage, entry.statusText),
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

export function getDailyChallengeVerificationEntry(challengeId) {
  if (!challengeId) return null;
  const queueState = readQueueState();
  return cloneEntry(queueState.daily[challengeId] || null);
}

export function getDailyChallengeVerificationState(challengeId) {
  return (
    getDailyChallengeVerificationEntry(challengeId)?.verificationState || "none"
  );
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
    submissionStage: VERIFICATION_STAGE_SUBMITTING,
    statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_SUBMITTING],
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

export function clearDailyChallengeVerification(challengeId) {
  return updateDailyEntry(challengeId, () => null);
}

export function markDailyChallengeVerificationPending(
  challengeId,
  nextAttemptAt = Date.now(),
  {
    submissionStage = VERIFICATION_STAGE_PENDING,
    statusText = null,
    preserveUpdatedAt = false,
  } = {},
) {
  return updateDailyEntry(challengeId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "pending",
      submissionStage: normalizeVerificationStage(submissionStage, "pending"),
      statusText: resolveVerificationStatusText(submissionStage, statusText),
      nextAttemptAt: normalizeNextAttemptAt(nextAttemptAt),
      updatedAt: preserveUpdatedAt
        ? previousEntry.updatedAt
        : new Date().toISOString(),
    };
  });
}

export function markDailyChallengeVerificationRejected(challengeId) {
  return updateDailyEntry(challengeId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "rejected",
      submissionStage: VERIFICATION_STAGE_REJECTED,
      statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_REJECTED],
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
  });
}

export function markDailyChallengeVerificationError(
  challengeId,
  errorMessage = null,
) {
  return updateDailyEntry(challengeId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "error",
      submissionStage: VERIFICATION_STAGE_ERROR,
      statusText: resolveVerificationStatusText(
        VERIFICATION_STAGE_ERROR,
        errorMessage,
      ),
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
  });
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
  const nextAttemptValues = Object.values(queueState.daily)
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        Number.isFinite(Number(entry.nextAttemptAt)),
    )
    .map((entry) => Number(entry.nextAttemptAt));

  if (!nextAttemptValues.length) return null;
  return Math.min(...nextAttemptValues);
}

export function createVerificationSnapshot({
  statusText = "",
  verificationState = "pending",
  isLoading = true,
  submissionStage = null,
} = {}) {
  const normalizedVerificationState = normalizeVerificationState(verificationState);
  const normalizedSubmissionStage = normalizeVerificationStage(
    submissionStage,
    normalizedVerificationState,
  );
  return {
    isLoading,
    verificationState: normalizedVerificationState,
    submissionStage: normalizedSubmissionStage,
    statusText: resolveVerificationStatusText(
      normalizedSubmissionStage,
      statusText,
    ),
  };
}

export function getVerificationSnapshotFromQueueEntry(entry) {
    if (!entry) return null;
    return createVerificationSnapshot({
        statusText: entry.statusText,
        verificationState: entry.verificationState,
        isLoading: entry.verificationState !== "error" && entry.verificationState !== "rejected",
        submissionStage: entry.submissionStage,
    });
}

export function resetVerificationQueueForTests() {
    writeQueueState(createEmptyState());
}
