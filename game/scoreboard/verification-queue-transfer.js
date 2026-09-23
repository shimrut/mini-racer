import { getPlayerSessionId } from "../player/active-owner.js";
import { getPhoneGuestOwnerId } from "./player-identity.js";
import {
  BUCKET_CANDIDATE_RULE,
  QUEUE_BUCKETS,
  TRANSFER_RECONCILIATIONS_KEY,
  VERIFICATION_STAGE_ERROR,
  normalizedTransferValue,
  ownedEntryKey,
  parseTimestamp,
  rawEntryIdFromKey,
  readQueueState,
  rekeyOwnedEntry,
  writeQueueState,
} from "./verification-queue.js";

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

function isEntryProtectedByTransfer(queueState, bucket, entryKey) {
  if (queueState[bucket]?.[entryKey]?.transferRecoveryRequired) return true;
  return Object.values(queueState[TRANSFER_RECONCILIATIONS_KEY] || {}).some((receipt) => (
    !receipt?.completedAt
      && receipt.entries?.["guest"]?.some((snapshot) => snapshot.bucket === bucket && snapshot.entryKey === entryKey)
  ));
}

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
        const inDoubt = entry?.ownerPlayerId === guestPlayerId
          || (choice === "guest" && entry?.ownerPlayerId === accountPlayerId);
        if (!inDoubt) continue;
        const updatedMs = parseTimestamp(entry.updatedAt);
        if (completedMs === null || updatedMs === null || updatedMs <= completedMs) {
          ambiguous.push({ bucket, entryKey, entry });
        }
      }
    }
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
      const occupant = destinationKey !== snapshot.entryKey
        ? queueState[snapshot.bucket][destinationKey]
        : null;
      if (occupant) {
        const isBetter = BUCKET_CANDIDATE_RULE[snapshot.bucket];
        if (!isBetter?.(entry, occupant)) {
          delete queueState[snapshot.bucket][snapshot.entryKey];
          removed += 1;
          continue;
        }
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

export function moveVerificationEntriesToOwner(fromOwnerId, toOwnerId) {
  const from = normalizedTransferValue(fromOwnerId);
  const to = normalizedTransferValue(toOwnerId);
  if (!from || !to || from === to) return { moved: 0, removed: 0, persisted: true };
  const queueState = readQueueState();
  let moved = 0;
  let removed = 0;
  for (const bucket of QUEUE_BUCKETS) {
    for (const [entryKey, entry] of Object.entries(queueState[bucket])) {
      if (entry?.ownerPlayerId !== from) continue;
      if (isEntryProtectedByTransfer(queueState, bucket, entryKey)) continue;
      const occupant = queueState[bucket][ownedEntryKey(rawEntryIdFromKey(entryKey, from), to)];
      if (occupant && !BUCKET_CANDIDATE_RULE[bucket]?.(entry, occupant)) {
        delete queueState[bucket][entryKey];
        removed += 1;
        continue;
      }
      rekeyOwnedEntry(queueState, bucket, entryKey, entry, to);
      moved += 1;
    }
  }
  if (moved === 0 && removed === 0) return { moved, removed, persisted: true };
  return { moved, removed, persisted: writeQueueState(queueState) };
}

export function hasVerificationEntriesForOwner(ownerPlayerId) {
  if (typeof ownerPlayerId !== "string" || !ownerPlayerId.trim()) return false;
  return QUEUE_BUCKETS
    .map((bucket) => readQueueState()[bucket])
    .some((bucket) => Object.values(bucket).some((entry) => entry?.ownerPlayerId === ownerPlayerId));
}
