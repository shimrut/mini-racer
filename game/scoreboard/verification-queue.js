import {
  getActivePlayerOwnerId,
  getPlayerSessionId,
} from "../player/active-owner.js";
import { getPhoneGuestOwnerId } from "./player-identity.js";
import { readLastConfirmedProfileOwnerId } from "../player/profile-cache.js";

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
const TRANSFER_RECONCILIATIONS_KEY = "transferReconciliations";
const TRANSFER_BLOCKS_STORAGE_KEY = "VectorGpTransferBlocks";

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
    if (parsed?.[TRANSFER_RECONCILIATIONS_KEY]
      && typeof parsed[TRANSFER_RECONCILIATIONS_KEY] === "object") {
      queueState[TRANSFER_RECONCILIATIONS_KEY] = parsed[TRANSFER_RECONCILIATIONS_KEY];
    }
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

function ownedEntryKey(entryId, ownerPlayerId) {
  return ownerPlayerId ? `${ownerPlayerId}${OWNER_KEY_SEPARATOR}${entryId}` : entryId;
}

function rawEntryIdFromKey(entryKey, ownerPlayerId) {
  if (!ownerPlayerId) return entryKey;
  const prefix = `${ownerPlayerId}${OWNER_KEY_SEPARATOR}`;
  return entryKey.startsWith(prefix) ? entryKey.slice(prefix.length) : entryKey;
}

function readKnownPhoneOwnerId() {
  return readLastConfirmedProfileOwnerId() || getPhoneGuestOwnerId();
}

function resolveQueuedOwnerId() {
  return getActivePlayerOwnerId() || readKnownPhoneOwnerId();
}

function rekeyOwnedEntry(queueState, bucket, fromKey, entry, toOwnerId) {
  const rawId = rawEntryIdFromKey(fromKey, entry?.ownerPlayerId);
  delete queueState[bucket][fromKey];
  const next = { ...entry, ownerPlayerId: toOwnerId };
  const nextKey = ownedEntryKey(rawId, toOwnerId);
  queueState[bucket][nextKey] = next;
  return { nextKey, next, rawId };
}

function resolveEntryKey(queueState, bucket, entryId) {
  const activeOwnerId = getActivePlayerOwnerId();
  const ownedKey = ownedEntryKey(entryId, activeOwnerId);
  if (queueState[bucket][ownedKey]) return ownedKey;
  if (!activeOwnerId) {
    const knownKey = ownedEntryKey(entryId, readKnownPhoneOwnerId());
    if (queueState[bucket][knownKey]) return knownKey;
  }
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
  if (entry?.ownerPlayerId && !isVisibleQueueEntry(entry)) return null;
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
 * A queued result belongs to the account that raced it. Only the active owner's due entries are sent.
 */
function isOwnedByActivePlayer(entry) {
  const activeOwnerId = getActivePlayerOwnerId();
  if (!activeOwnerId) return false;
  return entry?.ownerPlayerId === activeOwnerId;
}

function isVisibleQueueEntry(entry) {
  if (!entry?.ownerPlayerId) return true;
  if (isOwnedByActivePlayer(entry)) return true;
  return !getActivePlayerOwnerId() && entry.ownerPlayerId === readKnownPhoneOwnerId();
}

function getDue(bucket, now = Date.now()) {
  const queueState = readQueueState();
  // Read the block from storage on every pass, so another tab's recovery cannot be missed and a
  // completion in this tab releases the queue only once it is durable.
  if (isBlockedByTransfer()) return [];
  return Object.values(queueState[bucket])
    .filter(
      (entry) =>
        entry?.verificationState === "pending" &&
        !entry?.transferRecoveryRequired &&
        isOwnedByActivePlayer(entry) &&
        normalizeNextAttemptAt(entry.nextAttemptAt) <= now,
    )
    .map((entry) => cloneEntry(entry));
}

function normalizedTransferValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Blocks live in their own storage key, not inside the queue. Every queue function is a
 * read-modify-write of the queue key, so a tab holding a stale copy would otherwise wipe a block
 * another tab had just written, and quietly release racing during an open transfer.
 */
/**
 * What this tab knows about open transfers, whether or not storage accepted it.
 *
 * Storage is the durable record, and it is the only one that survives a reload. It can also be
 * missing, full, or blocked by the browser, and a block that was never written is invisible to
 * the very check that decides whether racing may continue. This map holds the same blocks in
 * memory so a storage failure cannot quietly release the pause inside one session.
 *
 * `persisted` separates the two cases, and the difference matters when reading:
 *  - persisted: storage accepted it. If a later read no longer finds it, another tab finished
 *    the recovery and removed it, and this tab should let it go.
 *  - unpersisted: storage never accepted it. A read that does not find it proves nothing, so it
 *    is kept until this tab resolves it itself.
 *
 * The boundary this shares with `activePlayerOwnerId` in `game/player/active-owner.js`: both are
 * module state, so a reload starts with neither. A browser whose storage failed comes back
 * knowing nothing, and only the server can tell it about the transfer again. Missing durable
 * evidence plus unavailable storage therefore needs an online confirmation; cleared browser data
 * cannot be reconstructed from here.
 */
const knownTransferBlocks = new Map();

function readStoredTransferBlocks() {
  // No window at all is not a browser session, so there is no durable record to be missing and
  // nothing to be unsure about. A window whose storage is missing or refuses to be read is the
  // case that matters: this browser is playing, and it cannot say whether a transfer is open.
  if (typeof window === "undefined") return { ok: true, blocks: {} };
  try {
    // Reading the property is itself the throwing operation when a browser denies site data, so
    // it belongs inside the handler rather than in a guard in front of it.
    const storage = window.localStorage;
    if (!storage) return { ok: false, blocks: {} };
    const raw = storage.getItem(TRANSFER_BLOCKS_STORAGE_KEY);
    if (!raw) return { ok: true, blocks: {} };
    const parsed = JSON.parse(raw);
    return {
      ok: true,
      blocks: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
    };
  } catch (error) {
    console.error("Error reading transfer blocks:", error);
    return { ok: false, blocks: {} };
  }
}

/**
 * True once a bootstrap has confirmed, with the server, that this browser has nothing unresolved.
 * Until then an unreadable store means transfer safety is simply unknown.
 */
let transferSafetyConfirmed = false;

/** True when the last attempt to read the durable record failed rather than came back empty. */
let storageReadFailed = false;

/**
 * Every block this tab must honour: what storage holds, plus what it knows storage never took.
 *
 * A successful read is also adopted into memory. Without that a block only ever read back from
 * storage lives nowhere else, and the first failed read afterwards releases it.
 */
function readTransferBlocks() {
  const stored = readStoredTransferBlocks();
  storageReadFailed = !stored.ok;
  const merged = stored.ok ? { ...stored.blocks } : {};
  if (stored.ok) {
    for (const [accountPlayerId, block] of Object.entries(stored.blocks)) {
      const cached = knownTransferBlocks.get(accountPlayerId);
      // Refresh what storage already owns, rather than only adopting keys that are new. The same
      // account can be named with a different guest later, and a stale cached copy would restore
      // the older pairing on the next failed read, leaving the newer guest unblocked.
      // An unpersisted entry is left alone: storage never took it, so storage cannot replace it.
      if (!cached || cached.persisted) {
        knownTransferBlocks.set(accountPlayerId, { block, persisted: true });
      }
    }
  }
  for (const [accountPlayerId, entry] of knownTransferBlocks) {
    if (!entry) continue;
    if (entry.persisted && stored.ok) {
      // Storage had it and no longer does: another tab completed this recovery.
      if (!(accountPlayerId in stored.blocks)) {
        knownTransferBlocks.delete(accountPlayerId);
        continue;
      }
    }
    merged[accountPlayerId] ??= entry.block;
  }
  return merged;
}

/**
 * Records that the server answered for this account and left nothing unresolved.
 *
 * This is the only thing that can settle transfer safety for a browser whose storage cannot be
 * read. Without it a cold start with both storage and the server unavailable knows nothing, and
 * an unresolved transfer would be indistinguishable from a clean browser.
 */
export function confirmVerificationQueueTransferSafety() {
  transferSafetyConfirmed = true;
}

function writeTransferBlocks(blocks) {
  if (typeof window === "undefined") return false;
  try {
    // Same as the read: the property access can throw before any method is called.
    const storage = window.localStorage;
    if (!storage) return false;
    storage.setItem(TRANSFER_BLOCKS_STORAGE_KEY, JSON.stringify(blocks));
    return true;
  } catch (error) {
    console.error("Error writing transfer blocks:", error);
    return false;
  }
}

/**
 * A known transfer stops racing and submitting for the identity it names. Until a bootstrap has
 * confirmed who this browser is, any open transfer counts: guessing from a stale profile is how a
 * blocked player slips through the gate and is offered ordinary offline play. Once an owner is
 * confirmed, only a transfer naming that owner blocks, so signing into a different account
 * inherits nothing.
 */
function isBlockedByTransfer(ownerPlayerId) {
  const blocks = Object.values(readTransferBlocks());
  if (blocks.length === 0) {
    // Nothing is known, but nothing has been ruled out either. An unreadable store cannot say
    // whether a transfer is open, and the agreed answer to that is a server connection rather
    // than ordinary offline play.
    return storageReadFailed && !transferSafetyConfirmed;
  }
  const owner = ownerPlayerId === undefined ? getActivePlayerOwnerId() : ownerPlayerId;
  if (!owner) return true;
  return blocks.some((block) => (
    block?.accountPlayerId === owner || block?.guestPlayerId === owner
  ));
}

export function isVerificationQueueSubmissionBlocked(ownerPlayerId) {
  return isBlockedByTransfer(ownerPlayerId);
}

/** Records that this browser knows about an unresolved transfer. Survives a reload. */
export function recordVerificationQueueTransferBlock({
  transferId = null,
  guestPlayerId = null,
  accountPlayerId,
  state = "resume_required",
} = {}) {
  if (!normalizedTransferValue(accountPlayerId)) return false;
  const block = {
    transferId: normalizedTransferValue(transferId),
    guestPlayerId: normalizedTransferValue(guestPlayerId),
    accountPlayerId,
    state,
    updatedAt: new Date().toISOString(),
  };
  // Written down in memory before storage is asked. If the write fails this call still reports
  // failure, so the caller treats the transfer as unresolved, but the pause itself holds for the
  // guest, the account, and an identity this tab has not confirmed yet.
  knownTransferBlocks.set(accountPlayerId, { block, persisted: false });
  const persisted = writeTransferBlocks({ ...readTransferBlocks(), [accountPlayerId]: block });
  if (persisted) knownTransferBlocks.set(accountPlayerId, { block, persisted: true });
  return persisted;
}

/** Lifts the block for one account once its reconciliation is durable. */
export function clearVerificationQueueTransferBlock(accountPlayerId) {
  if (!normalizedTransferValue(accountPlayerId)) return false;
  const blocks = readTransferBlocks();
  if (!blocks[accountPlayerId]) {
    knownTransferBlocks.delete(accountPlayerId);
    return true;
  }
  const next = { ...blocks };
  delete next[accountPlayerId];
  // Only this account's block goes. Another account's pause is not this resolution's to lift.
  const removed = writeTransferBlocks(next);
  if (removed) knownTransferBlocks.delete(accountPlayerId);
  return removed;
}

export function readVerificationQueueTransferBlock(accountPlayerId) {
  return readTransferBlocks()[accountPlayerId] ?? null;
}

function transferReceiptKey({ transferId, guestPlayerId, accountPlayerId }) {
  return normalizedTransferValue(transferId)
    || `guest-progress:${guestPlayerId}->${accountPlayerId}`;
}

function transferEntrySnapshot(entryKey, entry) {
  return {
    entryKey,
    ownerPlayerId: entry?.ownerPlayerId ?? null,
    sessionId: entry?.sessionId ?? null,
    updatedAt: entry?.updatedAt ?? null,
    bestTime: Number.isFinite(entry?.bestTime) ? entry.bestTime : null,
    challengeId: entry?.challengeId ?? null,
    raceId: entry?.raceId ?? null,
  };
}

function matchesTransferEntrySnapshot(entry, snapshot) {
  return Boolean(entry)
    && (entry.ownerPlayerId ?? null) === snapshot.ownerPlayerId
    && (entry.sessionId ?? null) === snapshot.sessionId
    && (entry.updatedAt ?? null) === snapshot.updatedAt
    && (Number.isFinite(entry.bestTime) ? entry.bestTime : null) === snapshot.bestTime
    && (entry.challengeId ?? null) === snapshot.challengeId
    && (entry.raceId ?? null) === snapshot.raceId;
}

/**
 * An entry named by an unfinished reconciliation, or one already quarantined, is never claimed by
 * whoever signs in next. Ownership it cannot prove is not ownership.
 */
function isEntryProtectedByTransfer(queueState, bucket, entryKey) {
  if (queueState[bucket]?.[entryKey]?.transferRecoveryRequired) return true;
  return Object.values(queueState[TRANSFER_RECONCILIATIONS_KEY] || {}).some((receipt) => (
    !receipt?.completedAt
      && receipt.entries?.["guest"]?.some((snapshot) => snapshot.bucket === bucket && snapshot.entryKey === entryKey)
  ));
}

/** Marks entries this browser cannot prove ownership of, and keeps them out of every queue path. */
function quarantineEntries(queueState, entries) {
  for (const { bucket, entryKey, entry } of entries) {
    queueState[bucket][entryKey] = {
      ...entry,
      verificationState: "error",
      submissionStage: VERIFICATION_STAGE_ERROR,
      statusText: "Transfer needs review before this result can be saved.",
      nextAttemptAt: null,
      transferRecoveryRequired: true,
      updatedAt: entry.updatedAt,
    };
  }
}

/** Capture exact local entries before the server choice is sent. The first choice is immutable. */
export function prepareVerificationQueueGuestProgressReconciliation({
  transferId = null,
  guestPlayerId,
  accountPlayerId,
  choice,
} = {}) {
  if (!normalizedTransferValue(guestPlayerId)
    || !normalizedTransferValue(accountPlayerId)
    || (choice !== "guest" && choice !== "account")) {
    return { prepared: false };
  }
  const queueState = readQueueState();
  queueState[TRANSFER_RECONCILIATIONS_KEY] ??= {};
  const receiptKey = transferReceiptKey({ transferId, guestPlayerId, accountPlayerId });
  const existing = queueState[TRANSFER_RECONCILIATIONS_KEY][receiptKey];
  if (existing) {
    return existing.choice === choice
      ? { prepared: true, receiptKey }
      : { prepared: false, receiptKey, choiceLocked: true };
  }
  const entries = { guest: [], account: [] };
  for (const bucket of QUEUE_BUCKETS) {
    for (const [entryKey, entry] of Object.entries(queueState[bucket])) {
      if (entry?.ownerPlayerId === guestPlayerId) {
        entries.guest.push({ bucket, ...transferEntrySnapshot(entryKey, entry) });
      } else if (entry?.ownerPlayerId === accountPlayerId) {
        entries.account.push({ bucket, ...transferEntrySnapshot(entryKey, entry) });
      }
    }
  }
  queueState[TRANSFER_RECONCILIATIONS_KEY][receiptKey] = {
    guestPlayerId,
    accountPlayerId,
    choice,
    entries,
    createdAt: new Date().toISOString(),
  };
  const persisted = writeQueueState(queueState);
  return { prepared: persisted, receiptKey, persisted };
}

/**
 * True when this browser already finished reconciling that exact transfer. The server keeps
 * reporting a completion for a while after the fact, and repeating the work would clear local
 * caches and medals on every launch.
 */
export function isVerificationQueueGuestProgressReconciled({
  transferId = null,
  guestPlayerId,
  accountPlayerId,
  choice,
} = {}) {
  if (!normalizedTransferValue(guestPlayerId) || !normalizedTransferValue(accountPlayerId)) {
    return false;
  }
  const receipts = readQueueState()[TRANSFER_RECONCILIATIONS_KEY] ?? {};
  const fallbackKey = transferReceiptKey({ guestPlayerId, accountPlayerId });
  const keys = normalizedTransferValue(transferId)
    ? [transferReceiptKey({ transferId, guestPlayerId, accountPlayerId }), fallbackKey]
    : [fallbackKey];
  return keys.some((key) => {
    const receipt = receipts[key];
    return Boolean(receipt?.completedAt)
      && receipt.guestPlayerId === guestPlayerId
      && receipt.accountPlayerId === accountPlayerId
      && (!choice || receipt.choice === choice);
  });
}

/**
 * A finish before bootstrap answers is stamped with who this phone already is. This visit may attach
 * a first-time guest run to the named account. A later sign-in does not take another owner's run.
 * Leftover unnamed runs become this phone's guest id so they are never deleted.
 */
export function claimVerificationEntriesForOwner(ownerPlayerId) {
  const activeOwnerId = typeof ownerPlayerId === "string" && ownerPlayerId.trim()
    ? ownerPlayerId.trim()
    : null;
  if (!activeOwnerId) return { claimed: [] };

  const phoneGuestId = getPhoneGuestOwnerId();
  const sessionId = getPlayerSessionId();
  const queueState = readQueueState();
  const claimed = [];
  let changed = false;

  for (const bucket of QUEUE_BUCKETS) {
    for (const entryKey of Object.keys(queueState[bucket])) {
      const entry = queueState[bucket][entryKey];
      if (!entry) continue;
      if (isEntryProtectedByTransfer(queueState, bucket, entryKey)) continue;

      let currentKey = entryKey;
      let current = entry;
      if (!current.ownerPlayerId) {
        ({ nextKey: currentKey, next: current } = rekeyOwnedEntry(
          queueState,
          bucket,
          currentKey,
          current,
          phoneGuestId,
        ));
        changed = true;
      }

      const isThisSessionPhoneGuest = current.ownerPlayerId === phoneGuestId
        && current.sessionId === sessionId
        && phoneGuestId !== activeOwnerId;
      if (!isThisSessionPhoneGuest) continue;

      const { next, rawId } = rekeyOwnedEntry(
        queueState,
        bucket,
        currentKey,
        current,
        activeOwnerId,
      );
      claimed.push({
        bucket,
        entryId: next.challengeId || next.raceId || rawId,
      });
      changed = true;
    }
  }

  if (changed) writeQueueState(queueState);
  return { claimed };
}

/**
 * Resolves queued local runs when a Reddit sign-in chooses which progress source survives.
 * Pending replays are never merged across owners: choosing guest replaces the account queue,
 * while choosing account removes the guest/current-session queue.
 */
export function resolveVerificationQueueAfterGuestProgressSelection({
  transferId = null,
  completedAt = null,
  guestPlayerId,
  accountPlayerId,
  choice,
} = {}) {
  if (
    typeof guestPlayerId !== "string" || !guestPlayerId.trim()
    || typeof accountPlayerId !== "string" || !accountPlayerId.trim()
    || (choice !== "guest" && choice !== "account")
  ) {
    return { changed: false, removed: 0, moved: 0 };
  }
  const queueState = readQueueState();
  const receipts = queueState[TRANSFER_RECONCILIATIONS_KEY] ?? {};
  const matchesThisTransfer = (candidate) => Boolean(candidate)
    && candidate.guestPlayerId === guestPlayerId
    && candidate.accountPlayerId === accountPlayerId
    && candidate.choice === choice;
  // A receipt written before the server named the transfer is filed under the guest-and-account
  // fallback key. The same reconciliation now arrives carrying the server's id, so look under both
  // rather than treat this browser's own receipt as missing and quarantine everything it holds.
  const fallbackKey = transferReceiptKey({ guestPlayerId, accountPlayerId });
  const receiptKey = normalizedTransferValue(transferId)
    ? transferReceiptKey({ transferId, guestPlayerId, accountPlayerId })
    : fallbackKey;
  const receipt = [receipts[receiptKey], receipts[fallbackKey]].find(matchesThisTransfer) ?? null;
  if (!receipt) {
    const completedMs = parseTimestamp(completedAt);
    const ambiguous = [];
    for (const bucket of QUEUE_BUCKETS) {
      for (const [entryKey, entry] of Object.entries(queueState[bucket])) {
        // A Guest choice replaced the account's progress, so both sides are in doubt. An Account
        // choice discarded only guest data, so the account's own queued runs were never at risk.
        const inDoubt = entry?.ownerPlayerId === guestPlayerId
          || (choice === "guest" && entry?.ownerPlayerId === accountPlayerId);
        if (!inDoubt) continue;
        const updatedMs = parseTimestamp(entry.updatedAt);
        if (completedMs === null || updatedMs === null || updatedMs <= completedMs) {
          ambiguous.push({ bucket, entryKey, entry });
        }
      }
    }
    // Another device, or a browser that lost its receipt. This browser cannot prove which entries
    // the selection covered, so it invents no history: the ambiguous ones are quarantined, and the
    // decision itself is written down. Once that decision is durable, results raced from here on
    // save normally.
    quarantineEntries(queueState, ambiguous);
    queueState[TRANSFER_RECONCILIATIONS_KEY] ??= {};
    queueState[TRANSFER_RECONCILIATIONS_KEY][receiptKey] = {
      guestPlayerId,
      accountPlayerId,
      choice,
      entries: { guest: [], account: [] },
      quarantined: ambiguous.map(({ bucket, entryKey }) => ({ bucket, entryKey })),
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const persisted = writeQueueState(queueState);
    return {
      changed: false,
      removed: 0,
      moved: 0,
      preserved: 0,
      quarantined: ambiguous.length,
      missingReceipt: true,
      persisted,
      completed: persisted,
    };
  }
  if (receipt?.completedAt) {
    return { changed: false, removed: 0, moved: 0, preserved: 0, completed: true };
  }
  let removed = 0;
  let moved = 0;
  let preserved = 0;
  {
    if (choice === "guest") {
      for (const snapshot of receipt.entries.account) {
        const entry = queueState[snapshot.bucket]?.[snapshot.entryKey];
        if (!matchesTransferEntrySnapshot(entry, snapshot)) {
          if (entry) preserved += 1;
          continue;
        }
        delete queueState[snapshot.bucket][snapshot.entryKey];
        removed += 1;
      }
    }
    for (const snapshot of receipt.entries.guest) {
      const entry = queueState[snapshot.bucket]?.[snapshot.entryKey];
      if (!matchesTransferEntrySnapshot(entry, snapshot)) {
        if (entry) preserved += 1;
        continue;
      }
      if (choice === "account") {
        delete queueState[snapshot.bucket][snapshot.entryKey];
        removed += 1;
        continue;
      }
      const rawId = rawEntryIdFromKey(snapshot.entryKey, entry.ownerPlayerId);
      const destinationKey = ownedEntryKey(rawId, accountPlayerId);
      if (destinationKey !== snapshot.entryKey && queueState[snapshot.bucket][destinationKey]) {
        preserved += 1;
        continue;
      }
      rekeyOwnedEntry(queueState, snapshot.bucket, snapshot.entryKey, entry, accountPlayerId);
      moved += 1;
    }
    receipt.completedAt = new Date().toISOString();
    const persisted = writeQueueState(queueState);
    return {
      changed: (removed > 0 || moved > 0) && persisted,
      removed,
      moved,
      preserved,
      persisted,
      completed: persisted,
    };
  }
}

export function hasVerificationEntriesForOwner(ownerPlayerId) {
  if (typeof ownerPlayerId !== "string" || !ownerPlayerId.trim()) return false;
  return QUEUE_BUCKETS
    .map((bucket) => readQueueState()[bucket])
    .some((bucket) => Object.values(bucket).some((entry) => entry?.ownerPlayerId === ownerPlayerId));
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
    ownerPlayerId: resolveQueuedOwnerId(),
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
    if (entry?.ownerPlayerId && !isVisibleQueueEntry(entry)) continue;
    const cloned = cloneEntry(entry);
    if (cloned?.raceId) entries[cloned.raceId] = cloned;
  }
  return entries;
}

/**
 * Selection is shown while the active owner is deliberately cleared. Read the queue by its
 * stamped owner so a pending Campaign result can be described without making another owner's
 * result visible to the current session.
 */
export function getCampaignVerificationEntriesForOwner(ownerPlayerId) {
  if (typeof ownerPlayerId !== 'string' || !ownerPlayerId.trim()) {
    return Object.create(null);
  }
  const entries = Object.create(null);
  const phoneGuestOwnerId = getPhoneGuestOwnerId();
  const sessionId = getPlayerSessionId();
  for (const entry of Object.values(readQueueState().campaign)) {
    const isStampedOwner = entry?.ownerPlayerId === ownerPlayerId;
    const isCurrentUnownedGuestRun = ownerPlayerId === phoneGuestOwnerId
      && !entry?.ownerPlayerId
      && entry?.sessionId === sessionId;
    if (!isStampedOwner && !isCurrentUnownedGuestRun) continue;
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
  if (isBlockedByTransfer()) return null;
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
  writeTransferBlocks({});
  writeQueueState(createEmptyState());
}
