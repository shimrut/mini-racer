const VERIFICATION_QUEUE_STORAGE_KEY = "VectorGpVerificationQueue";
const DEFAULT_RETRY_DELAY_MS = 30_000;
const CHALLENGE_PLAYLIST_MS = 7 * 24 * 60 * 60 * 1000;
const COMPETITION_BUFFER_MS = 6 * 60 * 60 * 1000;
/**
 * Campaign progression is permanent, so a queued Campaign run has no
 * competition deadline to expire against. The queue still needs an upper
 * bound so abandoned entries cannot accumulate forever.
 */
const CAMPAIGN_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const QUEUE_BUCKETS = ["daily", "campaign"];
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
    campaign: {},
  };
}

function parseTimestamp(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function deriveLegacyExpiry(entry) {
  const challengeDate = typeof entry?.challengeDate === "string"
    ? entry.challengeDate
    : /^daily-gp-(\d{4}-\d{2}-\d{2})$/.exec(entry?.challengeId || "")?.[1];
  const startsAt = challengeDate
    ? Date.parse(`${challengeDate}T00:00:00.000Z`)
    : Number.NaN;
  return Number.isFinite(startsAt)
    ? startsAt + CHALLENGE_PLAYLIST_MS + COMPETITION_BUFFER_MS
    : null;
}

function resolveEntryExpiry(entry) {
  return parseTimestamp(entry?.expiresAt) ?? deriveLegacyExpiry(entry);
}

function purgeExpiredQueueState(queueState, now = Date.now()) {
  let changed = false;
  for (const bucket of QUEUE_BUCKETS) {
    for (const [entryId, entry] of Object.entries(queueState[bucket])) {
      const expiresAt = resolveEntryExpiry(entry);
      if (expiresAt === null || expiresAt <= now) {
        delete queueState[bucket][entryId];
        changed = true;
        continue;
      }
      const normalizedExpiresAt = new Date(expiresAt).toISOString();
      if (entry.expiresAt !== normalizedExpiresAt) {
        entry.expiresAt = normalizedExpiresAt;
        changed = true;
      }
    }
  }
  return changed;
}

function readQueueState() {
  if (typeof window === "undefined" || !window.localStorage) {
    return createEmptyState();
  }

  try {
    const raw = window.localStorage.getItem(VERIFICATION_QUEUE_STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    const queueState = {
      daily:
        parsed?.daily && typeof parsed.daily === "object" ? parsed.daily : {},
      campaign:
        parsed?.campaign && typeof parsed.campaign === "object"
          ? parsed.campaign
          : {},
    };
    if (purgeExpiredQueueState(queueState)) {
      window.localStorage.setItem(
        VERIFICATION_QUEUE_STORAGE_KEY,
        JSON.stringify(queueState),
      );
    }
    return queueState;
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

function updateEntry(bucket, entryId, updater) {
  const queueState = readQueueState();
  const nextEntry = updater(queueState[bucket][entryId] || null);

  if (nextEntry) {
    queueState[bucket][entryId] = nextEntry;
  } else {
    delete queueState[bucket][entryId];
  }

  writeQueueState(queueState);
  return cloneEntry(nextEntry);
}

function updateDailyEntry(challengeId, updater) {
  return updateEntry("daily", challengeId, updater);
}

function updateCampaignEntry(raceId, updater) {
  return updateEntry("campaign", raceId, updater);
}

export function getVerificationRetryDelayMs() {
  return DEFAULT_RETRY_DELAY_MS;
}

/**
 * A submission is worth retrying when the failure looks transient. An
 * unreachable server (no status) counts, because the run is otherwise lost.
 */
export function isRetryableVerificationFailure(result) {
  const status = Number(result?.status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
  previousBestTime = null,
  previousCompletedLaps = null,
  previousCheckpointTimesSec = null,
  expiresAt = null,
} = {}) {
  if (
    typeof challengeId !== "string" ||
    !challengeId ||
    !Number.isFinite(bestTime) ||
    !replay
  ) {
    return { enqueued: false, entry: null };
  }

  const resolvedExpiresAt = parseTimestamp(expiresAt)
    ?? deriveLegacyExpiry({ challengeId, challengeDate })
    ?? (Date.now() + CHALLENGE_PLAYLIST_MS + COMPETITION_BUFFER_MS);
  if (resolvedExpiresAt <= Date.now()) {
    clearDailyChallengeVerification(challengeId);
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
    previousBestTime: Number.isFinite(previousBestTime)
      ? previousBestTime
      : null,
    previousCompletedLaps: Number.isFinite(previousCompletedLaps)
      ? Math.max(0, Math.trunc(previousCompletedLaps))
      : null,
    previousCheckpointTimesSec: Array.isArray(previousCheckpointTimesSec)
      ? previousCheckpointTimesSec.slice()
      : null,
    verificationState: "pending",
    submissionStage: VERIFICATION_STAGE_SUBMITTING,
    statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_SUBMITTING],
    nextAttemptAt: Date.now(),
    expiresAt: new Date(resolvedExpiresAt).toISOString(),
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

export function isDailyChallengeVerificationExpired(entry, now = Date.now()) {
  const expiresAt = resolveEntryExpiry(entry);
  return expiresAt === null || expiresAt <= now;
}

export function getNextVerificationAttemptAt() {
  const queueState = readQueueState();
  const nextAttemptValues = QUEUE_BUCKETS
    .flatMap((bucket) => Object.values(queueState[bucket]))
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        Number.isFinite(Number(entry.nextAttemptAt)),
    )
    .map((entry) => Number(entry.nextAttemptAt));

  if (!nextAttemptValues.length) return null;
  return Math.min(...nextAttemptValues);
}

export function getCampaignVerificationEntry(raceId) {
  if (!raceId) return null;
  const queueState = readQueueState();
  return cloneEntry(queueState.campaign[raceId] || null);
}

export function getCampaignVerificationState(raceId) {
  return getCampaignVerificationEntry(raceId)?.verificationState || "none";
}

/**
 * Queues a verified-by-the-server-later Campaign run. Unlike Daily, a slower
 * run never replaces a queued faster one, because Campaign keeps the best
 * time per race and the server rejects regressions anyway.
 */
export function enqueueCampaignVerification({
  raceId,
  trackKey = null,
  bestTime,
  lapCount = null,
  rulesRevision = null,
  replay,
  expiresAt = null,
} = {}) {
  if (
    typeof raceId !== "string" ||
    !raceId ||
    !Number.isFinite(bestTime) ||
    !replay
  ) {
    return { enqueued: false, entry: null };
  }

  const resolvedExpiresAt = parseTimestamp(expiresAt)
    ?? (Date.now() + CAMPAIGN_QUEUE_TTL_MS);
  if (resolvedExpiresAt <= Date.now()) {
    clearCampaignVerification(raceId);
    return { enqueued: false, entry: null };
  }

  const nextEntry = {
    raceId,
    trackKey: typeof trackKey === "string" ? trackKey : null,
    bestTime,
    lapCount: Number.isFinite(lapCount) ? Math.max(1, Math.trunc(lapCount)) : null,
    rulesRevision: Number.isInteger(rulesRevision) ? rulesRevision : null,
    replay,
    verificationState: "pending",
    submissionStage: VERIFICATION_STAGE_SUBMITTING,
    statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_SUBMITTING],
    nextAttemptAt: Date.now(),
    expiresAt: new Date(resolvedExpiresAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let didEnqueue = false;
  const entry = updateCampaignEntry(raceId, (previousEntry) => {
    if (previousEntry && Number(previousEntry.bestTime) <= Number(bestTime)) {
      return previousEntry;
    }
    didEnqueue = true;
    return nextEntry;
  });
  return { enqueued: didEnqueue, entry };
}

export function clearCampaignVerification(raceId) {
  return updateCampaignEntry(raceId, () => null);
}

export function markCampaignVerificationPending(
  raceId,
  nextAttemptAt = Date.now(),
  { submissionStage = VERIFICATION_STAGE_PENDING, statusText = null } = {},
) {
  return updateCampaignEntry(raceId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState: "pending",
      submissionStage: normalizeVerificationStage(submissionStage, "pending"),
      statusText: resolveVerificationStatusText(submissionStage, statusText),
      nextAttemptAt: normalizeNextAttemptAt(nextAttemptAt),
    };
  });
}

export function markCampaignVerificationError(raceId, errorMessage = null) {
  return updateCampaignEntry(raceId, (previousEntry) => {
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
    };
  });
}

export function getDueCampaignVerifications(now = Date.now()) {
  const queueState = readQueueState();
  return Object.values(queueState.campaign)
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        normalizeNextAttemptAt(entry.nextAttemptAt) <= now,
    )
    .map((entry) => cloneEntry(entry));
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
