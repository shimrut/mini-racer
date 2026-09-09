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
| Focused transfer, lock, Campaign, Daily, Garage, queue, startup, and route tests pass | pending |
| Full suite matches the recorded baseline failure set | pending |
| Production build passes | pending |
| Diff carries no unrelated change | pending |
| No assertion relaxed to hide a regression | pending |
| Hosted validation on isolated test identities | not run |
| Documentation reports verified behavior and its limits | pending |

## Required regression scenarios

Each row must exercise the real failure path, not a stubbed result.

### Normal behavior
- [ ] Guest choice and Account choice complete.
- [ ] Empty source, Daily-only source, Campaign-only source, Garage-only source.
- [ ] A signed-in player with no transfer is unaffected.
- [ ] A guest player with no account is unaffected.

### Interrupted writes
- [ ] Failure before and after each destination write.
- [ ] Failure before and after each domain checkpoint.
- [ ] Failure before and after each cleanup step.
- [ ] Failure before and after the final completion transaction.

### Ownership
- [ ] A concurrent save during the transfer.
- [ ] A competing transfer for the same account.
- [ ] An expired lock.
- [ ] A lease renewal race.
- [ ] The account changes hands mid-transfer.
- [ ] A Garage promotion pointing at another account.

### Source integrity
- [ ] Partial row loss, with other rows surviving.
- [ ] Expired guest progress.
- [ ] A malformed raw record.
- [ ] An empty raw record.
- [ ] Ranking-only data.
- [ ] PB-only data.

### Completion
- [ ] A lost successful response, retried.
- [ ] A repeated POST.
- [ ] A reload.
- [ ] A missing guest token.
- [ ] Another device.
- [ ] A completed record with stale markers.
- [ ] A later transfer does not hide an earlier completion.

### Queue durability
- [ ] A missing receipt.
- [ ] A mismatched receipt.
- [ ] Failed receipt persistence.
- [ ] Entries created after the selection.
- [ ] An unrelated guest's entries.
- [ ] Quarantined entries stay out of submission and out of owner claiming.
- [ ] A cross-tab queue write during reconciliation.

### Race blocking
- [ ] Every start path and every retry path.
- [ ] Recovery becoming known during an active race.
- [ ] A reload during an outage.
- [ ] Ordinary offline behavior for an unaffected player.

### Legacy repair
- [ ] A safe completed record.
- [ ] Proven cleanup on an older record.
- [ ] A recognized legacy Account discard.
- [ ] An ambiguous legacy Guest record stays protected.
- [ ] Diagnostics denied to a non-moderator.

## Limits this implementation does not remove

- It cannot recover a record that no longer exists.
- It does not repair a live account. Repair follows the runbook, by hand, per case.
- The measurements here are local mock runs. They are not hosted timings.
