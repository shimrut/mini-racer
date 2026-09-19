# Guest transfer recovery — implementation specification

This document records the contract that the guest progress transfer must keep. It describes
built behavior. It does not approve deployment.

Baseline commit: `42bc88c`. Branch: `codex/guest-transfer-recovery-v2`.

## 1. Outcome

A player signs in while a guest identity holds progress. The player chooses which progress to
keep. The transfer must:

- Keep the chosen progress.
- Survive an interrupted request, a lost response, a reload, and a device change.
- Never resume a destructive step from evidence it cannot verify.
- Leave an unsafe case protected for a reviewed repair.

While a transfer is unresolved, the player cannot race and cannot submit results. There is no
offline bypass for a transfer the browser knows about. A player with no transfer keeps the
existing sign-in, racing, offline, and submission behavior.

## 2. Durable record

The coordinator writes one **version-4** record for each transfer. Version 2 and version 3
records are earlier formats. The server reads them for compatibility. It never writes them.

| Field | Meaning |
|---|---|
| `version` | Always `4` for records this code writes. |
| `transferId` | Stable id, derived from the guest and the account, and stored in the record. |
| `guestPlayerId` | The source guest. |
| `redditPlayerId` | The destination account. |
| `choice` | `guest` or `account`. The first choice is immutable. |
| `phase` | `preparing`, `copying`, `cleaning`, `completed`, or `recovery_required`. |
| `status` | Legacy state, written beside `phase` so older readers stay correct. |
| `completedDomains` | Ordered domain checkpoints for copy or discard. |
| `cleanedDomains` | Ordered domain checkpoints for cleanup. |
| `dailyChallengeIds` | The frozen Daily window. |
| `dailyChallengeSpecs` | The identifiers cleanup needs, without challenge history. |
| `sourceInventory` | Exact source evidence, captured before any replacement. |
| `completedAt` | Set once, when the transfer completes. |

A transfer id names a record. It never authorizes access. Every lookup and every mutation
checks the authenticated destination account.

### Phases

`preparing` permits no destination replacement. Preparation may repeat safely, so a record in
this phase may capture its inventory again. Once the phase reaches `copying`, the inventory is
frozen. The server never manufactures new evidence from whatever survived.

### Keys

- `guest-progress-selection:v1:<guest,account>` — the record.
- `guest-progress-selection-pending:v1:<guest>` — the existing guest marker.
- `guest-progress-selection-account-pending:v1:<account>` — the existing account marker.
- `guest-progress-transfer-receipt:v1:<transferId>` — the durable completion receipt.
- `guest-progress-transfer-index:v1:<account>` — the account's transfer ids, oldest first.

The index lets the server find a pending or completed transfer without the original guest
token. A later transfer appends to the index, which holds the most recent twenty ids. An
unqualified lookup answers with the most recent completion, so a later transfer does hide an
earlier one from that question. The receipts themselves are permanent and are not indexed by
account, so a browser holding a transfer id always reads its own completion whatever its age.

## 3. Source inventory

Before any account replacement, the server captures the exact source evidence for Campaign,
Daily, and Garage. The inventory records presence and a content fingerprint for:

- Raw Campaign progress, per-stage leaderboard entries, PB records, and ranking scores.
- Per-challenge Daily entries, PB records, and ranking scores, over the frozen window.
- Every Garage unlock field and its exact value.

An absent value, an empty value, and a malformed value produce different fingerprints. A
Campaign stage that unlocks automatically is not saved progress, so it contributes no evidence.

A malformed or incompatible source record stops the transfer before replacement begins. The
record moves to `recovery_required`.

## 4. Copy and cleanup

Each domain validates its own inventory **while it holds its own domain locks**, and copies
from the payload it validated. There is no unverified read between the check and the write.
Holding the domain locks also drains the outstanding writes for that domain.

- Every destination write is fenced by the coordinator locks and the domain locks, through the
  existing watched transactions.
- A missing or changed source stops the replacement. Partial loss counts as loss, even when
  other rows survive.
- Campaign and Daily sources stay in place until their copies are checkpointed. Repeating a
  copy from an unchanged source is safe, so a lost checkpoint response costs nothing.
- Garage accepts an already-committed promotion only when its destination matches this
  transfer. A promotion to another account is a conflict.
- Cleanup runs after the completion checkpoint. It is idempotent and scoped to the exact guest.
- Daily cleanup derives its keys from the frozen specs. It needs no challenge history, no track
  definition, and no PB parsing. An already-expired key counts as cleaned.
- The Account choice only discards guest data. It never replaces account data, and it never
  needs a historical replay definition.
- Completion writes the record, the receipt, the index entry, and the marker clears in one
  fenced transaction. A failed lock release never turns a committed success into a failure.

## 5. Player API

Bootstrap checks the account transfer state **before** guest promotion, guest retirement, and
authoritative profile application.

| State | Behavior |
|---|---|
| `choice_required` | Show the existing Guest/Account chooser. |
| `resume_required` | Resume the recorded choice. There is no second choice. |
| `recovery_required` | Preserve the records and show the reviewed-repair status. |
| `completed` | Return the completion evidence so the browser can reconcile. |

`POST /api/player/progress-selection` accepts `action: "resume"` with a `transferId`. The
server derives the source, the destination, and the choice from its own record. Repeating a
completed request returns the same completion evidence, including after the pending markers
are gone. An authenticated browser may look up a transfer by id when it holds an unfinished
local receipt.

Errors keep their existing shapes. Retryable contention is `503 progress_selection_retryable`.
An unsafe case is `409 guest_progress_recovery_required`.

A new transfer is checked under the transfer locks before anything is written. A retry and a
repeated completion have a record, so this check does not apply to them.

- A guest with nothing to carry is refused with `409 guest_progress_transfer_not_needed`. A
  Guest choice would only empty the account. A row the server cannot parse counts as something.
- A guest joined to this account with no record was retired empty. It is refused the same way.
- A guest joined to another account is `409 guest_progress_recovery_required`. No Campaign or
  Daily copy runs first.

Bootstrap sets `guestJoinedAccount` when it finds, or makes, an empty guest joined to this
account. The browser then moves that guest's unsent runs to the account. Where the account
already has an unsent run for the same race, the faster run stays. The browser does not open the
chooser for a guest that the server retired.

### Older records

- A valid completed record may clear only its own stale markers, under the locks.
- A valid older record with every copy checkpointed may finish its proven cleanup.
- An older Guest-choice record without adequate source evidence stays a reviewed-recovery case.
- A recognized legacy Account-choice record may resume its discard only after strict identity,
  schema, and promotion checks.
- A malformed record, an inconsistent checkpoint, or a conflicting marker never enters a
  permissive fallback.
- There is no bulk migration, no generic "clear pending" action, and no automatic conversion of
  an uncertain record.

## 6. Client

Recovery and queue reconciliation are one operation. Startup, foreground, reconnect, and
race-finish triggers share one in-flight operation and one overlay.

- A resumable transfer is attempted immediately, then retried after 2, 5, and 15 seconds.
  Manual retry stays available afterward.
- Before it retries an uncertain response, the browser asks whether the transfer completed.
- Automatic retries stop on an authentication change and on a reviewed-recovery response.
- Once a submission's outcome is uncertain, its choice stays fixed until the server resolves it.
- A durable local marker records a known unresolved transfer, so a reload followed by a network
  failure cannot enter ordinary offline mode.
- Local blocking is scoped to the affected owner. Signing into another account does not inherit
  the first account's transfer state.
- Every race entry path is gated: start, retry, Campaign next stage, keyboard shortcuts, and
  direct start calls. The gate is checked again after asynchronous preparation and immediately
  before the simulation starts.
- A race already running keeps its finish under its original owner. Later starts are blocked.

### Local receipts

Before a fresh submission and before a resume, the browser records, in the same queue record as
the queued results: the transfer id, the actual source guest the server named, the destination
account, the fixed choice, the exact identities and versions of the affected entries, and the
reconciliation status. The source guest comes from the server. Unowned entries are never
assumed to belong to it.

On completion the browser removes or moves only entries proven to belong to the captured
selection. It preserves entries created or changed afterward, except where one of them wants a slot
a selected entry is moving into: two runs cannot share a key, so the faster one wins, by the same
rule that decides any two runs competing for one slot. It preserves ambiguous entries in
an explicit quarantine, excluded from submission and from automatic owner claiming. Other
owners' queues are untouched. Reconciliation is persisted before authoritative profile state is
applied and before submissions resume. A storage failure is an unresolved recovery, not a
success. Repeated completion handling is idempotent.

Without an original receipt — a different device, or a legacy case — the browser does not invent
history. It records a quarantine decision for the ambiguous existing entries. Once that decision
is durable, newly created and correctly owned results save normally.

Local transfer state is rechecked before each submission, so another tab's recovery or
completion cannot release stale queued work.

## 7. Reviewed repair

A read-only moderator diagnostic reports, for one account or transfer id: the raw record, the
pending markers, the promotion pointers, the domain checkpoints, the surviving source and
destination evidence, the relevant expiry and race-compatibility information, a consistent
evidence fingerprint, and the reason automatic recovery stopped.

Sensitive evidence appears only in that authorized response. Guest credentials, replays, and
raw player records never reach ordinary logs. There is no general repair UI and no unrestricted
mutation endpoint.

The repair runbook is `docs/guest-transfer-recovery-runbook.md`.

## 8. Logging

One line per transfer outcome. It separates a retry, a completed transfer, and a
reviewed-recovery case. It carries durations and the phase only. It carries no identifier, no
token, and nothing about who the player is.
