import {
  getActivePlayerOwnerId,
  getPlayerSessionId,
} from "../player/active-owner.js";

const VERIFICATION_QUEUE_STORAGE_KEY = "VectorGpVerificationQueue";
const DEFAULT_RETRY_DELAY_MS = 30_000;
const CHALLENGE_PLAYLIST_MS = 7 * 24 * 60 * 60 * 1000;
const COMPETITION_BUFFER_MS = 6 * 60 * 60 * 1000;
const CAMPAIGN_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const QUEUE_BUCKETS = ["daily", "campaign"];
const VERIFICATION_STAGE_SUBMITTING = "submitting";
const VERIFICATION_STAGE_VERIFYING = "verifying";
const VERIFICATION_STAGE_PENDING = "pending";
const VERIFICATION_STAGE_RETRYING = "retrying";
const VERIFICATION_STAGE_REJECTED = "rejected";
const VERIFICATION_STAGE_ERROR = "error";
const CAMPAIGN_EXPIRY_MESSAGE = "Result expired — race again.";
const CAMPAIGN_GHOST_RETRY_MESSAGE = "Saving ghost...";
const OWNER_KEY_SEPARATOR = "::";

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
      if (bucket === "campaign" && entry?.verificationState === "error") {
        continue;
      }
      if (
        bucket === "campaign"
        && expiresAt !== null
        && expiresAt <= now
        && typeof entry?.raceId === "string"
        && entry.raceId
      ) {
        queueState[bucket][entryId] = {
          ...entry,
          replay: null,
          verificationState: "error",
          submissionStage: VERIFICATION_STAGE_ERROR,
          statusText: CAMPAIGN_EXPIRY_MESSAGE,
          nextAttemptAt: null,
          expiredAt: new Date(now).toISOString(),
        };
        changed = true;
        continue;
      }
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
    return false;
  }

  try {
    window.localStorage.setItem(
      VERIFICATION_QUEUE_STORAGE_KEY,
      JSON.stringify(queueState),
    );
    return true;
  } catch (error) {
    console.error("Error writing verification queue:", error);
    return false;
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

/**
 * Two accounts can each hold a queued result for the same race on one browser, so entries are stored
 * per owner. A result raced before the account was known keeps the bare id until it is claimed.
 */
function ownedEntryKey(entryId, ownerPlayerId) {
  return ownerPlayerId ? `${ownerPlayerId}${OWNER_KEY_SEPARATOR}${entryId}` : entryId;
}

function resolveEntryKey(queueState, bucket, entryId) {
  const ownedKey = ownedEntryKey(entryId, getActivePlayerOwnerId());
  if (queueState[bucket][ownedKey]) return ownedKey;
  // A result raced before the account was known is still this session's until it is claimed.
  return queueState[bucket][entryId]?.ownerPlayerId ? ownedKey : entryId;
}

function updateEntry(bucket, entryId, updater) {
  const queueState = readQueueState();
  const previousKey = resolveEntryKey(queueState, bucket, entryId);
  const nextEntry = updater(queueState[bucket][previousKey] || null);

  delete queueState[bucket][previousKey];
  if (nextEntry) {
    queueState[bucket][ownedEntryKey(entryId, nextEntry.ownerPlayerId)] = nextEntry;
  }

  return {
    entry: cloneEntry(nextEntry),
    persisted: writeQueueState(queueState),
  };
}

export function getVerificationRetryDelayMs() {
  return DEFAULT_RETRY_DELAY_MS;
}

export function isRetryableVerificationFailure(result) {
  const status = Number(result?.status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Bucket field names persist in localStorage across deploys, and an unreadable entry is deleted — renaming one discards real queued runs. */
function getEntry(bucket, entryId) {
  if (!entryId) return null;
  const queueState = readQueueState();
  const entry = queueState[bucket][resolveEntryKey(queueState, bucket, entryId)] || null;
  // Another owner's queued result is theirs to see, not this account's.
  if (entry?.ownerPlayerId && !isOwnedByActivePlayer(entry)) return null;
  return cloneEntry(entry);
}

function getState(bucket, entryId) {
  return getEntry(bucket, entryId)?.verificationState || "none";
}

function clearEntry(bucket, entryId) {
  return updateEntry(bucket, entryId, () => null).entry;
}

function markPending(
  bucket,
  entryId,
  nextAttemptAt = Date.now(),
  {
    submissionStage = VERIFICATION_STAGE_PENDING,
    statusText = null,
    preserveUpdatedAt = false,
  } = {},
) {
  return updateEntry(bucket, entryId, (previousEntry) => {
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
  }).entry;
}

function markTerminal(bucket, entryId, verificationState, stage, statusText) {
  return updateEntry(bucket, entryId, (previousEntry) => {
    if (!previousEntry) return null;
    return {
      ...previousEntry,
      verificationState,
      submissionStage: stage,
      statusText: resolveVerificationStatusText(stage, statusText),
      nextAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
  }).entry;
}

/**
 * A queued result belongs to the account that raced it. Submitting one under whoever happens to be
 * signed in now credits the wrong player, so entries for another owner wait, and an entry no owner
 * can be named for never submits at all.
 */
function isOwnedByActivePlayer(entry) {
  const activeOwnerId = getActivePlayerOwnerId();
  if (!activeOwnerId) return false;
  return entry?.ownerPlayerId === activeOwnerId;
}

function getDue(bucket, now = Date.now()) {
  return Object.values(readQueueState()[bucket])
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        isOwnedByActivePlayer(entry) &&
        normalizeNextAttemptAt(entry.nextAttemptAt) <= now,
    )
    .map((entry) => cloneEntry(entry));
}

/**
 * The account is only named once the bootstrap answers, which can be after a race finishes. Results
 * queued in this session are claimed by that answer; anything older is from a session whose account
 * this one cannot vouch for.
 */
export function claimVerificationEntriesForOwner(ownerPlayerId) {
  const activeOwnerId = typeof ownerPlayerId === "string" && ownerPlayerId.trim()
    ? ownerPlayerId.trim()
    : null;
  if (!activeOwnerId) return { claimed: [], orphaned: [] };

  const queueState = readQueueState();
  const sessionId = getPlayerSessionId();
  const claimed = [];
  const orphaned = [];
  for (const bucket of QUEUE_BUCKETS) {
    for (const [entryKey, entry] of Object.entries(queueState[bucket])) {
      if (entry?.ownerPlayerId) continue;
      delete queueState[bucket][entryKey];
      if (entry?.sessionId === sessionId) {
        queueState[bucket][`${activeOwnerId}${OWNER_KEY_SEPARATOR}${entryKey}`] = {
          ...entry,
          ownerPlayerId: activeOwnerId,
        };
        claimed.push({ bucket, entryId: entryKey });
        continue;
      }
      orphaned.push({ bucket, entryId: entryKey, entry: cloneEntry(entry) });
    }
  }
  if (claimed.length || orphaned.length) writeQueueState(queueState);
  return { claimed, orphaned };
}

function enqueue(bucket, entryId, nextEntry, isBetterThan) {
  let didEnqueue = false;
  const { entry, persisted } = updateEntry(bucket, entryId, (previousEntry) => {
    if (!isBetterThan(nextEntry, previousEntry)) return previousEntry;
    didEnqueue = true;
    return nextEntry;
  });
  return { enqueued: didEnqueue && persisted, entry };
}

function pendingEntry(fields) {
  return {
    ...fields,
    ownerPlayerId: getActivePlayerOwnerId(),
    sessionId: getPlayerSessionId(),
    verificationState: "pending",
    submissionStage: VERIFICATION_STAGE_SUBMITTING,
    statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_SUBMITTING],
    nextAttemptAt: Date.now(),
    updatedAt: new Date().toISOString(),
  };
}

export function getDailyChallengeVerificationEntry(challengeId) {
  return getEntry("daily", challengeId);
}

export function getDailyChallengeVerificationState(challengeId) {
  return getState("daily", challengeId);
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

  return enqueue("daily", challengeId, pendingEntry({
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
    expiresAt: new Date(resolvedExpiresAt).toISOString(),
  }), isBetterDailyCandidate);
}

export function clearDailyChallengeVerification(challengeId) {
  return clearEntry("daily", challengeId);
}

export const MAX_TRACK_PB_RETRY_ATTEMPTS = 3;

/** The run is already accepted; only its ghost is missing, so the replay is kept for a bounded number of retries and then dropped. */
function markTrackPbRetry(bucket, entryId, nextAttemptAt, extraFields = {}) {
  let exhausted = false;
  const { entry } = updateEntry(bucket, entryId, (previousEntry) => {
    if (!previousEntry) return null;
    const attempts = Number.isInteger(previousEntry.trackPbRetryCount)
      ? previousEntry.trackPbRetryCount
      : 0;
    if (attempts >= MAX_TRACK_PB_RETRY_ATTEMPTS) {
      exhausted = true;
      return null;
    }
    return {
      ...previousEntry,
      trackPbRetryCount: attempts + 1,
      verificationState: "pending",
      submissionStage: VERIFICATION_STAGE_VERIFYING,
      statusText: VERIFICATION_STAGE_TEXT[VERIFICATION_STAGE_VERIFYING],
      nextAttemptAt: normalizeNextAttemptAt(nextAttemptAt),
      updatedAt: previousEntry.updatedAt,
      ...extraFields,
    };
  });
  return { exhausted, entry };
}

export function markDailyChallengeTrackPbRetry(challengeId, nextAttemptAt) {
  return markTrackPbRetry("daily", challengeId, nextAttemptAt);
}

export function markDailyChallengeVerificationPending(
  challengeId,
  nextAttemptAt = Date.now(),
  options = {},
) {
  return markPending("daily", challengeId, nextAttemptAt, options);
}

export function markDailyChallengeVerificationRejected(challengeId) {
  return markTerminal(
    "daily",
    challengeId,
    "rejected",
    VERIFICATION_STAGE_REJECTED,
    null,
  );
}

export function markDailyChallengeVerificationError(
  challengeId,
  errorMessage = null,
) {
  return markTerminal(
    "daily",
    challengeId,
    "error",
    VERIFICATION_STAGE_ERROR,
    errorMessage,
  );
}

export function getDueDailyChallengeVerifications(now = Date.now()) {
  return getDue("daily", now);
}

export function isDailyChallengeVerificationExpired(entry, now = Date.now()) {
  const expiresAt = resolveEntryExpiry(entry);
  return expiresAt === null || expiresAt <= now;
}

export function getCampaignVerificationEntry(raceId) {
  return getEntry("campaign", raceId);
}

export function getCampaignVerificationEntries() {
  const entries = Object.create(null);
  for (const entry of Object.values(readQueueState().campaign)) {
    if (entry?.ownerPlayerId && !isOwnedByActivePlayer(entry)) continue;
    const cloned = cloneEntry(entry);
    if (cloned?.raceId) entries[cloned.raceId] = cloned;
  }
  return entries;
}

function isBetterCampaignCandidate(nextEntry, previousEntry) {
  if (!previousEntry) return true;
  if (previousEntry.verificationState !== "pending") return true;
  return Number(previousEntry.bestTime) > Number(nextEntry.bestTime);
}

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

  return enqueue("campaign", raceId, pendingEntry({
    raceId,
    trackKey: typeof trackKey === "string" ? trackKey : null,
    bestTime,
    lapCount: Number.isFinite(lapCount) ? Math.max(1, Math.trunc(lapCount)) : null,
    rulesRevision: Number.isInteger(rulesRevision) ? rulesRevision : null,
    replay,
    expiresAt: new Date(resolvedExpiresAt).toISOString(),
  }), isBetterCampaignCandidate);
}

export function clearCampaignVerification(raceId) {
  return clearEntry("campaign", raceId);
}

export function markCampaignVerificationPending(
  raceId,
  nextAttemptAt = Date.now(),
  options = {},
) {
  return markPending("campaign", raceId, nextAttemptAt, options);
}

/** Campaign progress is already confirmed when this runs: the entry survives only to recover the ghost, so it must not read as unverified progress. */
export function markCampaignTrackPbRetry(raceId, nextAttemptAt) {
  return markTrackPbRetry("campaign", raceId, nextAttemptAt, {
    progressConfirmed: true,
    statusText: CAMPAIGN_GHOST_RETRY_MESSAGE,
  });
}

export function markCampaignVerificationError(raceId, errorMessage = null) {
  return markTerminal(
    "campaign",
    raceId,
    "error",
    VERIFICATION_STAGE_ERROR,
    errorMessage,
  );
}

export function getDueCampaignVerifications(now = Date.now()) {
  return getDue("campaign", now);
}

export function getNextVerificationAttemptAt() {
  const queueState = readQueueState();
  const nextAttemptValues = QUEUE_BUCKETS
    .flatMap((bucket) => Object.values(queueState[bucket]))
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        isOwnedByActivePlayer(entry) &&
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
