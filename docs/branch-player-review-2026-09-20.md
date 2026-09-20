# Player regression review — 2026-09-20

Reviewed the uncommitted implementation on `remove-unneeded-deletes` against
`62322ed`, the commit from which this branch was created (confirmed by its
reflog). This is not a fresh audit of all inherited changes since `main`.
Included the new `src/server/user-comment-submit.ts`. Source and existing tests
were left unchanged. The latest working tree was checked again before recording
the results; the earlier uncommitted Head-to-Head client retry changes were no
longer present in that tree.

The focus was regular Daily, Campaign, and Head-to-Head play, result saving,
sharing, and Garage rewards. No repeatable regression was found on the normal
successful paths examined. Two recovery issues were reproduced. Neither requires
an elaborate race between requests, but both require an earlier service failure.
Production occurrence rates are unknown; the labels below describe the triggering
conditions, not measured percentages. Hosted Redis/Reddit behavior was not tested.

## Findings

### P2 — The UI prevents the retry it asks the player to perform

**Frequency: intermittent, service-failure dependent; repeatable whenever the
comment response is `comment_unconfirmed`. Not an every-race problem.**

At `game/race/ui-modal-shell.js:1019–1034`, the new uncertain-result branch removes
the confirmation button and makes Close only dismiss the panel. The original
Share/Brag/Comment button remains disabled. For Head-to-Head, it also records
`unconfirmed` as spent, so a later finish repaint keeps the action disabled.

The server explicitly says “Try again to check” / “Share again to check” in
`head-to-head-share.ts:269–270` and `daily-gp-share.ts:622–623`. Its result record
allows that retry to reconcile an existing comment or safely proceed under the
result lock. The screen gives the player no way to invoke that recovery for this
finish. The comment may already exist, or may never have posted; the player
cannot settle that uncertainty through the offered flow. Daily standings may
provide another entry point, but the current finish's action is blocked.

Reproduced with the real `ModalShell` in JSDOM for Brag, Challenge Comment, and
Daily finish sharing: return a ready preview, confirm with `comment_unconfirmed`,
observe the retry instruction, close the panel, and inspect the disabled trigger.
All three cases reproduced. The existing UI test also asserts this disabled
state, so the passing suite does not establish that recovery is usable.

Suggested correction: expose a check/retry action that uses the existing guarded
server confirmation path. Reserve the permanently spent button state for a
confirmed publication.

### P3 — Startup returns Garage progress from before it repairs rewards

**Frequency: intermittent, after a reward write failed; repeatable on the next
successful startup with an owed reward. Cosmetic/availability delay, not reward
data loss.**

`src/server/daily-gp-store.ts:3395–3417` reads `carUnlocks`, then calls
`settleOwedRewards`, then uses and returns the earlier snapshot. A successfully
recovered Head-to-Head win or posted-track reward is therefore absent from that
startup response. At an unlock threshold, the Garage can still show the earned
car as locked until another request supplies a fresh snapshot or the player
reloads again.

Reproduced with the existing in-memory Redis harness and the actual bootstrap
and reward settlement functions: seed one owed Head-to-Head win, bootstrap,
confirm that the win is stored and the owed field is removed, then inspect the
response. The first bootstrap reports zero wins; the second reports one.

Suggested correction: settle owed rewards before producing the returned Garage
snapshot, or refresh that snapshot after settlement changes rewards.

## Validation

- Current full suite: 2,916 passing tests; 29 route tests initially blocked by
  sandbox `listen EPERM` in four files. All 29 subsequently passed with loopback
  access (19 in the first rerun, 10 analytics tests in the second). All 2,945
  existing tests are accounted for as passing across these runs.
- Four additional temporary reproduction checks passed by asserting the two
  problematic behaviors above. Temporary test files were removed afterward;
  no permanent tests were changed.
- Production build passed on the latest reviewed tree.
- Typecheck reports 23 errors. Running the same check against an extracted
  `62322ed` snapshot produced identical diagnostics after normalizing source line
  numbers. These are pre-existing, not new errors from this change.
- `git diff --check` passed.
- The earlier automatic approval failure for the remaining route tests was
  resolved on continuation; it leaves no outstanding local test limitation.

Review output: this document only. No fixes, commit, push, or deployment performed.
