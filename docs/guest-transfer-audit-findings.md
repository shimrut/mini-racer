# Guest transfer audit — findings

All ten findings are now fixed on this branch, plus two more (11 and 12) found while scoping
finding 10. Each fix carries a regression test that fails without it. See the fix log at the end.

- Branch: `codex/guest-transfer-safety-fixes`
- Range: `42bc88c..f85324f`
- Scope: **22 source files** changed (11 under `game/`, 11 under `src/server/`), plus 3 docs
- Tests: **9 new files** — 8 suites totalling 2,630 lines, plus a 288-line Redis helper
  (`tests/redis-test-double.js`). Across all 13 changed test files: **+3,101 / −290**
- Date: 18 Sep 2026. **Revision 3**, after two reviews.

## Revision note

**Revision 2** corrected revision 1, which had overstated four findings and got one wrong:

| # | Change in revision 2 |
|---|---|
| 1 | Downgraded. The button and inputs *are* re-enabled; a retry succeeds if storage recovers. |
| 3 | **Downgraded to defensive coverage.** Not a confirmed product bug — see the finding. |
| 5 | Second scenario removed. The "dismissed the connection dialog" path does not exist. |
| 6 | Impact corrected. The board TTL is 365 days, not the 7-day playlist window. |
| 9 | **Raised.** There is no time comparison; the *faster* run can be the one stranded. |
| 10 | Evidence rewritten. Vite does parse and transpile the TypeScript; only the semantic check is missing. |
| — | Scope metadata corrected (was "15 source files", "2,900+ lines, 7 files"). |

**Revision 3** fixes five remaining precision errors. None changes a severity:

| # | Change in revision 3 |
|---|---|
| 1 | Trigger narrowed. Wholly blocked storage fails *earlier*, before the dialog opens. |
| 2 | Split. A failed *baseline* delete and a failed *journal* delete have different consequences. |
| 4 | Trigger narrowed. The second log needs a legacy **Guest-choice** replacement with no baseline. |
| 6 | Window widened. It spans the processing of every earlier Daily day, not a millisecond. |
| 10 | Count corrected: 18,450 lines across 68 files, not "~6,000". |

Revision 1 quoted probe output from files that were deleted, so it was not reproducible from the
repository. Every probe below is described well enough to rebuild, and findings 2 and 9 were
re-run against `f85324f`.

---

# Fix and keep an exact regression test

## 1. The Keep Progress dialog traps a player while storage keeps failing

**Severity: fix before ship.** Availability, not data loss.

Where:
- `game/player/guest-progress-selection.js:341` — the catch in `choose()`
- `game/player/guest-progress-selection.js:146` — the resume path, which does it correctly
- `game/storage.js:290` — the caller that throws

The first-choice dialog calls `onBeforeSubmit` before it sends the choice. That call throws
whenever the browser cannot save the local transfer receipt. The catch writes a status line and
stops there. It never resolves and never rejects its promise, so `getPlayerProgressState` keeps
waiting behind it.

The resume dialog rejects in exactly this situation, on purpose, so that startup does not wait
behind it. The first-choice dialog is missing that rejection.

**Correction to revision 1.** The catch does re-enable the controls: `overlay.setBusy(false)` and
`input.disabled = Boolean(choiceLocked)`, where `choiceLocked` is still `null` at that point. So
the player can press Continue again, and the attempt succeeds the moment storage recovers. The
trap is real but it is confined to *persistent* failure, and revision 1's "for good" and "pressing
again cannot help" were both wrong.

**Correction to revision 2 — the trigger is narrower than "storage is full or blocked."** Two
different storage keys are written, in order, and wholly unavailable storage fails at the first
one, before the dialog ever opens:

1. `game/storage.js:225` writes the transfer block to `VectorGpTransferBlocks` (small). A failure
   here returns `false` and `:231` throws. The dialog never appears, and the player gets the
   connection dialog instead. **This is the correct behaviour.**
2. `game/storage.js:284` writes the queue receipt to `VectorGpVerificationQueue` (large — it holds
   replays). A failure here throws inside `onBeforeSubmit`, and that is the hang.

So the hang needs the **small write to succeed and the large one to fail**: quota exhaustion, not a
browser blocking site data. Given that the queue key carries replay payloads, that is a realistic
split rather than a contrived one.

Probe: stub `window`/`document` with jsdom, call `requestGuestProgressSelection` with an
`onBeforeSubmit` that always throws, click Continue twice. Observed: the promise stays pending
after both clicks, the overlay stays in the document, and `fetch` is never called.

**Effect.** A player near their storage quota sees the dialog, presses Continue, gets an error
line, and startup never finishes. A reload repeats both writes, so it lands in the same place for
as long as that quota split holds.

---

## 2. A failed Garage cleanup is never retried, and it comes back later

**Severity: fix before ship.** Confirmed by review.

Where:
- `src/server/car-unlock-store.ts:355` — the early return on the promotion pointer
- `src/server/car-unlock-store.ts:434` — the swallowed `clearGuestTransferGarageEvidence`
- `src/server/car-unlock-store.ts:174` — the write-once baseline capture

`mergeGuestCarUnlockProgress` clears its transfer evidence after the copy commits, but that clear
is best-effort: a failure is logged and swallowed. A retry of the same domain returns early at the
promotion pointer check, before it reaches the clear. Nothing ever retries it.

**The two failure modes are different.** `clearGuestTransferGarageEvidence` (`:201`) deletes the
baseline and the journal in two sequential `await`s, so which one fails decides what is left:

| What fails | What survives | Consequence for the next transfer |
|---|---|---|
| The **baseline** delete | Both keys — the journal delete never runs | `captureGuestTransferGarageBaseline` returns `false` and the **stale baseline is reused** |
| The **journal** delete only | The journal | A **fresh baseline is captured**, but the stale journal fields are still preserved |

Revision 2 described only the first row as if it were the whole finding. Both preserve too much,
but only the first reuses the wrong snapshot. While a baseline exists, it also keeps
`journalAcceptedTransferEvent` live, so every Garage write for that account pays extra Redis calls.

Probe: in-memory Redis double; capture a baseline, make `del` throw for the baseline key, run the
merge, then run it again. Observed at `f85324f` (the first row):

```
baseline after failed cleanup = true
baseline after retry          = true
journal live afterwards       = true
recapture returns             = false   (stale baseline kept)
```

**Effect.** The next Guest-choice transfer preserves more than it should, so the account retains
Garage unlocks the player chose to replace. Nothing is destroyed. Blast radius is that one
account, and only after a cleanup failure followed by another transfer.

---

## 4. Two server logs print the player's Reddit name

**Severity: fix before ship.** Confirmed by review.

Where:
- `src/server/car-unlock-store.ts:136`
- `src/server/car-unlock-store.ts:383`

`docs/guest-transfer-recovery-spec.md` §8 says the transfer's logging carries no identifier and
nothing about who the player is. The timing line honours that. These two do not:

```js
console.error('Guest transfer reward journal is full:', accountPlayerId);

console.error(
    'Guest transfer Garage baseline missing; keeping the account Garage:',
    redditPlayerId,
);
```

Both print `reddit:<username>`.

**Correction to revision 2.** The second does *not* run for every legacy transfer. Its `if (!baseline)`
branch sits inside `if (replace)`, and `replace: true` is passed from exactly one place —
`daily-gp-store.ts:2686`, the Guest branch. So it needs a **Guest-choice** transfer whose Garage
replacement finds no baseline: a transfer recorded before baselines existed, or one whose baseline
was lost. An Account-choice legacy transfer never reaches it. That is still a normal path rather
than a rare fault, so it will fire for real players — just fewer of them than revision 2 implied.

**Effect.** Ordinary application logs name players who ran a transfer. The moderator diagnostic
endpoint exists precisely so that this evidence stays behind a moderator check.

---

## 5. A player left paused is told nothing at all

**Severity: fix before ship.** Confirmed by review, with one scenario removed.

Where:
- `game/storage.js:332` and `:359` — where the pause removal can fail
- `game/storage.js:161`, `:367`, `:393` — where the flags are set
- Gates: `game/engine.js:907`, `game/race/engine-methods.js:331`,
  `game/campaign/engine-methods.js:644`, `game/modes/engine-methods.js:78`,
  `game/daily-challenge/engine-methods.js:859`, `game/head-to-head/engine-methods.js:279`

Every race entry point checks the pause and returns silently. That is correct as a gate. Two flags
carry the reason out of startup — `progressTransferBlocked` and `transferPauseReleaseFailed` — and
a grep over `game/` and `src/` finds no reader outside `game/storage.js`. No screen shows either.

**Correction to revision 1.** The claimed second scenario does not exist. When a transfer is
unresolved, `requestServerSyncFailureChoice` is called with `allowOffline: false`, which renders a
single RETRY SYNC action and no dismissal
(`game/player/server-sync-failure.js:22`). The player cannot reach the lobby that way.

The reachable case is the one that remains: the transfer resolves, `clearVerificationQueueTransferBlock`
fails, the bootstrap still returns authoritative state, and `setActivePlayerOwnerId` runs.

**Effect.** The player reaches the lobby with no dialog. Start, Retry, and the next Campaign stage
all do nothing, with no message and no explanation.

---

## 7. Garage lock contention is reported as an unknown failure

**Severity: fix before ship.** Confirmed by review.

Where:
- `src/server/car-unlock-store.ts:46` — `acquirePromotionLock` throws `CarUnlockProgressBusyError`
- `src/server/daily-gp-store.ts:2559` — a caller that does not translate it

`mergeGuestCarUnlockProgress` (`:346`) and `discardGuestCarUnlockProgress` (`:499`) translate that
busy error into `GuestProgressSelectionRetryableError`. Three callers do not:
`captureGuestTransferGarageBaseline`, `cleanupGuestCarUnlockProgress`, and
`retireEmptyGuestIdentity`.

**Effect.** Ordinary contention answers 500 with a stack trace in the log, instead of the
contracted 503 `progress_selection_retryable`. No data loss; the transfer can retry.

---

## 9. A stranded queue entry can be the faster run

**Severity: fix before ship.** Raised from revision 1, which understated it.

Where: `game/scoreboard/verification-queue.js:849` — the collision branch in
`resolveVerificationQueueAfterGuestProgressSelection`

```js
const destinationKey = ownedEntryKey(rawId, accountPlayerId);
if (destinationKey !== snapshot.entryKey && queueState[snapshot.bucket][destinationKey]) {
  preserved += 1;
  continue;
}
```

There is no comparison of `bestTime`. Whichever entry already occupies the destination key wins,
and the guest's run is left under the guest id. The guest identity rotates straight after the
transfer, so `claimVerificationEntriesForOwner` no longer recognises it. The run is never
submitted and never seen again.

**Correction to revision 1.** Revision 1 said "the account keeps the better time it already had".
That is false — nothing here looks at the times.

**The exact reachable path**, which a regression test must reproduce: a simple two-entry setup does
*not* hit this branch, because for a Guest choice the account's snapshotted entries are deleted
first (`:828`), freeing the destination. The branch is reached when the account races that same
challenge again *between* the receipt capture and the completion. Its entry then no longer matches
its snapshot, so it is preserved rather than deleted, and the guest entry collides with it.
Reproduced at `f85324f`:

```
result   = {"changed":false,"removed":0,"moved":0,"preserved":2,"persisted":true,"completed":true}
account keeps bestTime = 11.5
guest stranded         = true   bestTime 10
```

**Effect.** The player's faster run is silently discarded in favour of a slower one.

---

# Lower priority

## 11. `verifyGuestSource` was typed to take no arguments

**Severity: low.** Found by the typecheck in finding 10. Fixed.

`src/server/daily-gp-store.ts` declared `verifyGuestSource?: () => void | Promise<void>` and called
it with one argument. The Campaign equivalent (`src/server/campaign-store.ts:1065`) declares its
parameter correctly.

**Effect.** The per-day Daily check's contract was invisible to any caller reading the type. A
caller supplying a conforming zero-argument callback would silently lose that check and fall back to
the whole-domain re-read — the unverified read between check and write the design forbids.

## 12. The cleaning-phase guard was dead

**Severity: low.** Found by the typecheck in finding 10. Fixed.

`src/server/daily-gp-store.ts` set `record.phase = 'copying'` unconditionally, so the
`record.phase !== 'cleaning'` guard below it was always true.

**Effect.** A transfer resumed in the cleaning phase was written back to `copying` and then forward
to `cleaning` again: two redundant record writes, and the guard never did its job.

## 6. A Daily day can slip out between the sweep and the copy

**Severity: low.** Retention-boundary correctness. Technically confirmed; revision 1 overstated it.

Where:
- `src/server/daily-gp-store.ts:1370` — the whole-window sweep, outside the locks
- `src/server/daily-gp-store.ts:1389` — the per-day presence check

`mergeGuestDailyProgress` checks the whole frozen window once before the loop, outside the locks.
The loop then reads each day again and skips a day that holds nothing on either identity
(`if (!guestHoldsRows && !accountHoldsRows) continue;`). A day whose guest rows expire between
those two reads is skipped in silence, and the domain is checkpointed as copied.

**Correction to revision 1.** Revision 1 implied a day near the 7-day playlist edge. Wrong: the
board's Redis TTL is `DAILY_GP_REDIS_TTL_SECONDS = 365 * 24 * 60 * 60` from `startsAt`
(`src/server/daily-gp-model.ts:26`, `:240`). The expiry has to land at a *one-year* boundary, with
both identities already empty for that day.

**Correction to revision 2 — the window is not millisecond-wide.** The sweep runs once, before the
loop. The loop then handles days in order, and each one acquires locks, reads, writes, and
releases. So for a day late in the playlist, the gap between the sweep and its own presence check
spans the entire processing of every earlier day. That is Redis round trips and lock acquisitions,
not a millisecond. The narrowness comes from the one-year boundary, not from the width of the gap.

**Correction back to the review.** A resume is not required. The sweep-then-loop shape is the same
on a first attempt (`:1370` runs unconditionally).

**Effect.** The transfer-specific fault is a false success where it should have been
`recovery_required`. The board itself is expiring on schedule for everyone.

## 8. The account index does hide an earlier completion

**Severity: documentation.**

Where:
- `src/server/daily-gp-store.ts:2393` — `.slice(-ACCOUNT_TRANSFER_INDEX_LIMIT)`, limit 20
- `src/server/daily-gp-store.ts:1946` — the backwards walk, which returns the newest receipt only
- `docs/guest-transfer-recovery-spec.md:60`

The spec says the index "never hides an earlier completion". It keeps the last twenty ids, and an
unqualified lookup answers with the newest readable receipt.

A client holding a transfer id can still read its permanent receipt, so the capability exists — but
that is an API capability, not a demonstrated automatic client recovery path. Correct the spec, or
correct the code.

## 10. There is no semantic TypeScript check

**Severity: build hygiene.**

Where: no `tsconfig.json` exists anywhere in the repository.

**Correction to revision 1.** Vite does parse and transpile the TypeScript — esbuild strips the
annotations — so "no tool reads it as TypeScript" was wrong. What is missing is the *semantic*
check, and `npm test` does not supply it either.

**Correction to revision 2 — the exposure is about three times what I said.** `src/server` holds
**18,450 lines across 68 `.ts` files**, not the "~6,000" revision 2 quoted. That earlier figure
came from the handful of files this branch touches, not from the directory.

Revision 1's two pieces of evidence were both wrong and are withdrawn:

- `src/server/daily-gp-store.ts:2874` assigns `result` and never uses it. That is a
  `noUnusedLocals` / lint finding, not a type error.
- Commit `1bb1a3c` fixed a missing export that **bundling already caught**. It is evidence the
  build works, not evidence a type error escaped.

The finding stands on its own terms: a semantic check is absent, and adding a `tsconfig.json` with
`noEmit` closes it.

### Fixed, and what is deferred

`tsconfig.json` and `npm run typecheck` now exist. It is **not** wired into `npm test`: the files
below still report errors, and gating on them would block every commit until they are cleared.

Cleared as part of this work — the two real defects are findings 11 and 12:

| File | Was | Now |
|---|---|---|
| `daily-gp-store.ts` | 4 | 0 |
| `guest-transfer-source-classification.ts` | 5 | 0 |

Deferred, unchanged, and none of them in the transfer path:

| File | Errors |
|---|---|
| `head-to-head-service.ts` | 8 |
| `head-to-head-post.ts` | 3 |
| `competition-submit.ts` | 3 |
| `replay-validator.ts` | 2 |
| `daily-podium-service.ts` | 2 |
| `daily-gp-model.ts` | 2 |
| `pb-ghost-store.ts` | 1 |
| `daily-podium-replay.ts` | 1 |
| `competition-leaderboard.ts` | 1 |

Clear those 23, then add `typecheck` to `pretest`.

---

# Downgraded — not a confirmed product bug

## 3. `isBlockedByTransfer` skips its unknown-state guard once any block is known

**Severity: defensive coverage.** Revision 1 called this "fix before ship". That was wrong.

Where: `game/scoreboard/verification-queue.js:497`

The unknown-state guard sits inside one branch:

```js
if (blocks.length === 0) {
  return storageReadFailed && !transferSafetyConfirmed;
}
```

Once any block is in the merged list, the `storageReadFailed` test no longer runs, and an owner
that matches no known block is allowed to race even though storage could not be read.

**Why it is not a product bug.** Revision 1's probe called
`isVerificationQueueSubmissionBlocked('reddit:b')` with an explicit owner. **No production caller
passes that argument** — every gate calls it with none, so the owner comes from
`getActivePlayerOwnerId()`. That module value is set in exactly one place,
`game/storage.js:369`, at the end of an authoritative bootstrap, and it is deliberately session
state: "the signed-in account cannot change without a reload"
(`game/player/active-owner.js:4`). A reload also clears `knownTransferBlocks`. So the two
preconditions — an in-memory block for one account and an active owner of another — cannot hold at
once. An unconfirmed identity still returns `true` at `if (!owner) return true`, and the server
submission gates reject genuinely open transfers regardless.

This was a methodology failure on my part: I proved a helper-level condition and asserted a product
behaviour without tracing the callers.

**What to do.** Keep it as defensive coverage. The guard's placement is one exported-parameter
caller away from mattering, so a test pinning the intended "unknown means pause" rule is cheap
insurance. Do not treat it as release-blocking.

---

# Tests and build

Validated against `f85324f`.

| Check | Result | Notes |
|---|---|---|
| Eight focused transfer suites | 128 / 128 pass | |
| Full suite | 2,835 pass, 2 fail | Both in `tests/server-daily-gp-store.test.js`. |
| Are the failures this branch's doing? | **No** | Both fail identically at `42bc88c`, checked in a separate worktree. |
| Cause of the two failures | Stale test | The tests mock `hMGet` to answer `[]` for any key that does not end in `:entries`. `getServerDailyGpSnapshot` reads opponent personal bests through `hMGet` on the personal-best hash (`competition-leaderboard.ts:205` → `pb-ghost-store.ts:322`), so it never sees the record and reports `opponentRaceAvailable: false`. |
| `npx vite build` | Clean, 2.7s | Leaves no changes in the working tree. |
| Semantic typecheck | Not configured | See finding 10. |

**Coverage gap.** Findings 1, 2, and 9 reproduce, and the helper condition behind 3 reproduces, but
none of them has a committed regression test. That is the gap to close alongside the fixes.

---

# Release recommendation

| Action | Findings |
|---|---|
| Fix, and commit an exact regression test | 1, 2, 4, 5, 7, 9 |
| Low priority, retention-boundary correctness | 6 |
| Documentation | 8 |
| Build hygiene | 10 |
| Defensive coverage only | 3 |

The branch is not release-ready.

---

# What holds up

These are the parts I went looking to break and could not. Review agrees. Finding 6 is the one
narrow completeness exception, at the pre-lock skip.

- **No unverified read sits between a check and a write.** Both `mergeGuestCampaignProgress` and
  `mergeGuestDailyProgress` read the source once, under the locks, judge that exact payload, and
  copy the same payload. This is what stops a row that expires mid-transfer from being copied as
  absent, which under a replacing copy would empty the account.
- **Damaged data is told apart from absent data.** `guest-transfer-source-classification.ts`
  separates absent, valid, obsolete, and malformed. Only malformed stops the transfer for a person.
  That distinction is why a row this build cannot parse no longer reads as "the player never raced
  here".
- **The completion is atomic.** The record, the receipt, the index entry, and both marker clears
  commit in one fenced transaction (`daily-gp-store.ts:2371`), so a completion is never visible
  without its proof.
- **Sign-in checks the transfer first.** `getServerPlayerBootstrap` resolves the account's transfer
  state at `:3147`, before guest promotion, before guest retirement, and before it applies any
  profile.
- **A transfer id names a record but authorises nothing.** `readGuestTransferReceipt` checks the
  authenticated account on every read, and the moderator diagnostic is gated on
  `assertModeratorForSubreddit` and changes nothing.
- **The Garage keeps what was earned after the choice.** When the baseline is missing,
  `mergeGuestCarUnlockProgress` keeps everything rather than guessing, and logs that it did. That
  is the right way round.
- **Lock ordering is consistent.** Every multi-lock acquisition sorts its keys before taking them,
  so the domain merges cannot deadlock against each other or against a submission.

---

# Fix log

Landed on `codex/guest-transfer-safety-fixes`, one commit per finding.

| Finding | Commit | Regression test |
|---|---|---|
| 1 | Settle the Keep Progress choice when the receipt cannot be saved | `tests/guest-transfer-choice-storage-failure.test.js` (new) |
| 2 | Scope the Garage transfer baseline to the transfer that froze it | `tests/guest-transfer-garage-preservation.test.js` |
| 4 | Keep the player's name out of the transfer's logging | `tests/guest-transfer-garage-preservation.test.js` |
| 5 | Say why a race will not start during a transfer | `tests/race-blocked-by-transfer.test.js` |
| 6, 11, 12 | Judge a recorded Daily day under its own locks | `tests/guest-transfer-daily-validation.test.js` |
| 7 | Report Garage transfer contention as retryable from every path | `tests/server-car-unlock-store.test.js` |
| 8 | Correct what the spec claims about the account transfer index | documentation only |
| 9 | Give a contested queue slot to the faster run | `tests/verification-queue-transfer-recovery.test.js` |
| 10 | Add a typecheck script, and clear the transfer files under it | `npm run typecheck` |
| 3 | Not fixed. Downgraded to defensive coverage; no product bug to fix. | — |

Two fixes went further than the finding described, because the finding was incomplete:

- **Finding 2.** Retrying the cleanup only repairs an *interrupted* transfer. A completed one never
  re-enters the copy, so a failed cleanup there could never be repaired. The baseline now records
  its own transfer id and a later transfer replaces it, which removes the harm rather than the leak.
- **Finding 9.** A plain two-entry setup never reaches the collision branch, because a Guest choice
  clears the account's captured entries first. The test drives the real path: the account races that
  day again between the receipt capture and the completion.

After the fixes: 2,853 tests pass, the same 2 pre-existing failures remain in
`tests/server-daily-gp-store.test.js`, `npm run typecheck` reports the 23 deferred errors and none
in the transfer path, and `vite build` is clean.

**Not verified:** finding 5's message line has never been seen rendered in the running game. Its
show/hide logic and text have unit tests, and its CSS class and grid placement are the ones the
challenge pane already ships, but nobody has looked at it on a phone-width screen in both themes.
