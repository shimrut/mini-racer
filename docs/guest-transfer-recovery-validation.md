# Guest transfer recovery — validation checklist

Records what was measured on `codex/guest-transfer-recovery-v2`. Local test success is not
publication approval. Commit, push, upload, publish, and live account repair stay separate
actions.

## Recorded baseline — commit `42bc88c`

Measured before implementation, in this worktree, with the working tree stashed.

- `npx vitest run` — **2701 tests, 2 failed**, 219 files.
- Both failures are in `tests/server-daily-gp-store.test.js`:
  - `marks and prepares only an exact compatible Daily opponent ghost without exposing identity`
  - `races a Daily ghost stored before the PB record shared the entry timestamp`
- `npm run build` — passes.

These two failures are the baseline. They are unrelated to the transfer. Judge every later run
against this named set, not against the count. Do not weaken a test to reach a passing result,
and do not import unrelated working-tree changes.

## Acceptance gates

| Gate | State |
|---|---|
| Focused transfer, lock, Campaign, Daily, Garage, queue, startup, and route tests pass | pass |
| Full suite matches the recorded baseline failure set | pass — 2837 tests, the same 2 baseline failures |
| Production build passes | pass |
| Diff carries no unrelated change | pass |
| No assertion relaxed to hide a regression | pass |
| Hosted validation on isolated test identities | **not run** |
| Documentation reports verified behavior and its limits | pass |

New tests: `server-guest-transfer-recovery` (44), `verification-queue-transfer-recovery` (20),
`race-blocked-by-transfer` (7), `guest-transfer-completed-startup` (3), and 4 added to
`server-analytics-routes`. The startup suite drives `getPlayerProgressState` against a real
bootstrap payload; all three of its tests were confirmed to fail with the fix reverted.

Added in the closing round: `guest-transfer-daily-validation` (15) and 4 added to
`server-head-to-head`. Eight were confirmed to fail with the source reverted to `aaa7f9e`, and a
ninth with only the Daily read fix below reverted. The rest are normal-behavior controls, which
pass on both sides by design.

### Two defects a review found in the closing round itself

| Defect | Effect if shipped |
|---|---|
| The Daily merge checked the frozen inventory and then read the source **again** to classify it. A row removed between those two reads passed the check, classified as absent, and under `replace` emptied the account's day while the transfer reported success. | The exact loss the round set out to close, moved one step later. The merge now classifies first and checks the inventory against the bytes it just read, so the check and the copy share one read. A whole-domain sweep runs once before the loop, because a day whose rows have gone entirely is skipped before any lock is taken and would otherwise never be reported. |
| A durable `recovery_required` record refuses every ordinary retry, but the runbook still told reviewers to ask the player to retry whenever the source matched. | A reviewer would have followed advice that cannot work, and read the refusal as a second fault. The runbook now states that the refusal is the design, separates a case that can still resume (`status: pending`) from one that cannot, and gives the two ways a repair takes the mark off. |

The per-day check also cut the Daily inventory reads. `verifyGuestSource` previously ran once per
day and read every recorded day on each call: 49 day-reads across a seven-day window. It is now
one sweep plus one read per day, or 14.

## Closing round

Four items, each closing a gap this document or an earlier review had left open.

| Item | What changed |
|---|---|
| The repair runbook | Step 3 no longer reads a missing checkpoint as proof the account is unchanged, and no longer tells a reviewer to overwrite an account from surviving guest data. It now requires reading the source and the destination together, for either choice, and copying only from the snapshot the frozen inventory names. Step 1 no longer claims nothing decays while a case waits: guest Daily rows leave on the ordinary Daily deadline. |
| Daily source validation | The Daily merge skipped a frozen day whenever its rows failed to parse. Because the same parsed read fed `hasGuestEvidence`, a damaged day looked exactly like a day never raced, and the domain checkpoint then claimed work it had not done. The pre-lock check now reads raw presence, and a replacement classifies each day under that day's locks before its first account write, then copies from what it judged. Damage stops the copy with nothing written and nothing deleted. Obsolete rows are not copied and leave on the ordinary deadline. |
| Pending-transfer gating | Head to Head had no pending-transfer check at all, and does not route through `competition-submit`. Creation and submission now refuse with the existing 503 `progress_transfer_pending`, ahead of the post, the unlock and the rate limit. The bootstrap unlock backfill now waits for an open transfer instead of writing onto a source the transfer is about to move. Reward preservation for already-accepted operations is unchanged. |
| A durable recovery phase | `recovery_required` was only ever derived from a record's shape, never written. A version-4 record with a valid inventory derived as resumable, so a case stopped for a changed source was retried, failed the same way, and was offered as resumable again on every reload. The coordinator now writes `status` and `phase` through the same protected transaction every other record write uses, keeping the choice, the checkpoints, the inventory and both markers. Both readers recognise it. Retryable and unclassified failures are deliberately not written, so an outage does not become a case that waits for a person. |

## Independent review

Two bounded reviews ran against the integrated branch: one on server integrity, one on client
ownership and queue correctness. Both were read-only. Eleven defects were confirmed and fixed;
each now has a test. The ones worth naming, because they were introduced by this work:

| Defect | Effect if shipped |
|---|---|
| The account marker was claimed by merely showing the chooser | A player who dismissed the chooser could never race ranked again. No server path cleared it. |
| Bootstrap skipped the guest branch whenever any completion existed | A second guest signing into that account was silently orphaned: no chooser, no retirement. |
| A completed selection re-normalized an already-normalized state | The account id became null, so reconciliation never ran, the block never lifted, and local Daily data and medals were wiped on every launch. |
| The receipt key differed between capture and completion | The normal Guest choice quarantined every queued result instead of moving it. |
| The race gate resolved the owner from a stale profile | Gates passed during a transfer, and Continue Offline was offered. |
| Blocks shared the queue's storage key | Any ordinary queue write from another tab dropped the block. |
| The status probe had no timeout | A hung probe left Retry disabled with no way forward, and stalled the finish handler behind it. |
| Older records with every copy checkpointed | Sent to reviewed repair instead of finishing proven cleanup, contrary to this document. |
| A Campaign stage-list change | Stranded every in-flight transfer permanently. |
| The no-receipt branch ignored the choice | Quarantined account results that an Account choice never put at risk. |
| The no-transferId branch deleted unowned entries | Removed results it could not prove ownership of. Branch removed. |

Two further points were accepted as correct rather than fixed: a guest cannot lift a block until
the account it names resolves, and a repeat completion is answered idempotently.

## Required regression scenarios

Each row must exercise the real failure path, not a stubbed result.

### Normal behavior
- [x] Guest choice and Account choice complete.
- [x] Empty source, Campaign-only source, Garage-only source.
- [x] Daily-only source — covered by the existing PB-only Daily cleanup test.
- [x] A signed-in player with no transfer is unaffected.
- [x] A guest player with no account is unaffected — existing startup test.

### Interrupted writes
- [x] Failure at each of the 7 transfer checkpoints, for both choices, each resuming to the same
  end state. Every destination write, cleanup step, and the final completion transaction sits
  between two of those checkpoints, so each is covered on both sides.
- [x] A checkpoint write that fails after its domain completed — existing test.

### Ownership
- [x] A competing transfer for the same account is refused as `progress_transfer_pending`.
- [x] A second, different choice is refused once one is recorded.
- [x] The account changes hands mid-transfer — existing coordinator-fencing test.
- [x] An occupied selection lock is retryable — existing test.
- [x] A Garage promotion pointing at another account is a 409, not a retry.
- [x] A thrown transaction conflict reports as retryable — existing test.
- [ ] A concurrent save during the transfer — not covered beyond the lock tests.
- [ ] A lease renewal race — not covered.

### Source integrity
- [x] Partial row loss: a Garage field added after preparation stops the replacement.
- [x] Expired guest progress: the Campaign row disappearing stops the replacement, and the
  account keeps what it had.
- [x] A malformed record is held for review, not guessed at.
- [x] Rows a parsed read would call empty — existing test.
- [x] PB-only data — existing Daily test.
- [x] A frozen Daily day whose entry cannot be read stops the copy, keeps the damaged row, and
  leaves the account's own day for that date alone.
- [x] A frozen Daily day whose personal best cannot be read stops the copy the same way.
- [x] A Daily day that expired before preparation froze the inventory completes normally: there is
  no recorded evidence to be missing.
- [x] A Daily day that expires after the inventory was frozen stops the copy, and the account
  keeps its own time rather than being emptied to match a source that is gone.
- [x] A Daily row removed between the inventory check and the copy cannot pass as absent: the
  check reads the bytes the copy uses, and the account keeps its own time.
- [ ] Ranking-only data — the inventory fingerprints the rank, but no test drives that case
  on its own.

### Completion
- [x] A lost successful response, retried, returns the same completion evidence.
- [x] A repeated POST is idempotent.
- [x] A missing guest token: the account resolves its own transfer without one.
- [x] Another device sees `resume_required` for a recorded choice.
- [x] A completed record with stale markers reports completion and clears only its own markers.
- [x] A later transfer does not hide an earlier completion.
- [x] A transfer id belonging to another account resolves to nothing.

### Queue durability
- [x] A missing receipt quarantines the ambiguous entries and records that decision.
- [x] A captured entry changed before completion is preserved, not moved.
- [x] Failed receipt persistence reports `persisted: false`, treated as unresolved.
- [x] Entries created after the selection keep their own owner.
- [x] An unrelated guest's queue is untouched.
- [x] Quarantined entries stay out of submission and out of owner claiming.
- [x] A newly created, correctly owned result saves once the quarantine decision is durable.
- [x] A cross-tab block written behind this tab's back is seen on the next check.
- [x] A repeated completion moves nothing twice.

### Race blocking
- [x] Campaign start, Daily start, Head to Head start, active-race retry, and the simulation
  gate itself.
- [x] Head to Head creation is refused while the account has a transfer open, and no post is made.
- [x] Head to Head submission is refused, and spends none of its rate limit.
- [x] Another account's open transfer blocks neither, and both work once no transfer is open.
- [x] The bootstrap unlock backfill is skipped while a transfer is open, and runs once it is not.

### Recovery survives a reload
- [x] A case stopped for review is written as `recovery_required`, keeping the choice, the domain
  checkpoints, the source inventory and both pending markers.
- [x] The account's next sign-in and the guest's next selection both report that case with its
  recorded choice, rather than offering a decision the player already made.
- [x] Reading the case again repeats no replacement and no cleanup.
- [x] A failed record write stays an ordinary retry: it does not become a repair case.
- [x] A marked record refuses an ordinary retry even when nothing is wrong with the source.
- [x] A repair that puts the record back to `pending` lets the transfer resume and complete, which
  is the hand-back the runbook describes.
- [x] A different account with no transfer is not stopped.
- [x] The block survives a reload, because it lives in storage.
- [x] The sync-failure prompt drops Continue Offline while a transfer is open.
- [x] A finish still records when identity recovery is stuck behind an unanswered overlay: the
  work runs on a bound rather than waiting forever.
- [ ] Recovery becoming known during an active race — the gate stops the next start, but no test
  drives a finish that lands mid-recovery.

### Legacy repair
- [x] A safe completed record clears only its own stale markers.
- [x] A recognized legacy Account-choice record resumes its discard.
- [x] An ambiguous legacy Guest-choice record stays a review case, and refuses to resume.
- [x] A record with out-of-order checkpoints stays a review case.
- [x] An unreadable record stays a review case.
- [x] Diagnostics denied to a non-moderator, reading no evidence at all.
- [x] A diagnostic failure keeps case evidence out of the log.
- [ ] Proven cleanup on an older record — no fixture drives a v2 record with every copy
  checkpointed.

## Limits this implementation does not remove

- It cannot recover a record that no longer exists.
- It does not repair a live account. Repair follows the runbook, by hand, per case.
- The measurements here are local mock runs. They are not hosted timings.
- **Hosted validation has not been run.** Transaction behavior, contention, interruption
  recovery, and an actual post-recovery leaderboard save have not been exercised against a real
  Redis on isolated test identities. Every claim above rests on the in-memory test double.
- The unchecked rows above are gaps, not passes. Read them as written.
- Commit, push, upload, publish, and live account repair remain separate decisions. Nothing here
  approves any of them.
