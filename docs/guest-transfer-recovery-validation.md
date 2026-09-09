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
| Full suite matches the recorded baseline failure set | pass — 2768 tests, the same 2 baseline failures |
| Production build passes | pass |
| Diff carries no unrelated change | pass |
| No assertion relaxed to hide a regression | pass |
| Hosted validation on isolated test identities | **not run** |
| Documentation reports verified behavior and its limits | pass |

New tests: `server-guest-transfer-recovery` (40), `verification-queue-transfer-recovery` (16),
`race-blocked-by-transfer` (7), and 4 added to `server-analytics-routes`.

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
- [x] A different account with no transfer is not stopped.
- [x] The block survives a reload, because it lives in storage.
- [x] The sync-failure prompt drops Continue Offline while a transfer is open.
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
