# Ghost reduction and Blob fixes — implementation review

## Proposed error guard — check, not applied

**Approved for the explicitly chosen behavior.** The proposed
`errorBelongsToState` helper rejects a late error while a different step runs,
keeps same-run running/paused error reporting, and rejects a new run of the
same step. It is evaluated inside the existing watched `updateState`, so a
concurrent Start between validation and EXEC triggers a reread rather than
saving the error onto stale state. Refused error saves return the current
object and unwatch without writing it. Server error logging remains first.

The user explicitly chose to keep a paused step's same-run error while the
state is idle, even if another step started and finished in the meantime.
That is an accepted reporting policy for this proposal, not an unresolved
request to add a global run generation or error-context redesign. Start
clears the error at its commit; this chosen idle policy may save a later
failure afterward, as the user's table states.

Validation in a temporary tracked-HEAD copy of
`8471f947f234cf157d6fcb0e8b40da744c2feaaa`:

- The user's new regression fails on current code with
  `running: "expired", lastError: "Redis read failed"`.
- With only the proposed helper/handler guard applied to that copy, all
  **24 compaction tests passed**: the 21 existing tests, the user's new test,
  and two additional checks for same-run running error retention and another
  step starting/finishing immediately before the paused request fails.
- The existing Pause/error and new-run/error tests pass with the guard.
- **Typecheck passed.** No full-suite/build rerun was needed for this proposal
  check; this is not a verified committed implementation or hosted Devvit run.

Two minor wording/copy details: describe `state.running === null` as “no step
is running,” since it does not prove why the state is idle. The pasted test's
`NOW\.getTime()` must be normal JavaScript `NOW.getTime()`; the isolated test
used that spelling.

Rechecked the official Devvit skill's matching 0.14 Redis **Transactions**
documentation and the current helper's base-client read/WATCH/EXEC flow.
Only this review document changed in the workspace. The temporary source/test
copy was removed after validation. Before/after/typecheck logs remain at
`/private/tmp/dailygp-error-guard-before.log`,
`/private/tmp/dailygp-error-guard-after.log`, and
`/private/tmp/dailygp-error-guard-typecheck.log`.

## Latest implementation re-check — `8471f947`

**Both earlier P2 findings are resolved. One P3 reporting issue remains.**
Reviewed `8471f947f234cf157d6fcb0e8b40da744c2feaaa`, including
`0071f12f` (run identity) and `8471f947` (atomic Start/writer switch).
Application and repository tests were not modified during this review; this
review document was updated, and external probes were written in `/private/tmp`.
Existing unrelated WIP was preserved. No hosted operations or commits were made.

### Resolved findings

- **Old worker saving into a new audit:** a worker captures `ctx.runId` after
  the post-lock state reread and keeps it separate from mutable `ctx.state`.
  All group, page and completion commits check the step name and that captured
  identity after WATCH. Fresh runs increment the watched current ID; ordinary
  Resume preserves it. The original held final-page reproduction now leaves
  the reset audit unchanged. The next request checks all 201 rows and packs
  the previously missed prefix ghost.
- **Start publishing state before enabling packed writes:** `updateState`
  queues the step state and writer switch on the same transaction client and
  executes once. An already-running Start still commits the switch without
  rewriting the saved progress. The positive local writer cache is updated
  after successful EXEC through `notePackedGhostWritesOn`, with no second
  Redis SET. A failed enqueue or exhausted WATCH conflict does not enable it.

Source: `src/server/competition/ghost-compaction.ts:157–187,261–308,317–361,508–536`
and `src/server/competition/pb-ghost-write.ts:26–35`.

### P3 — A late error from a paused step can appear during another step's run

Source: `src/server/competition/ghost-compaction.ts:533–536` and
`pages/mod-analytics.js:556–559`.

The error handler checks the failing step's run ID but does not check which
step currently runs. A paused Campaign run retains its ID while a moderator
starts Expired. A late Campaign HSCAN failure therefore still passes the
guard and sets the shared `lastError` after Expired's Start cleared it.
The Storage UI displays the error without identifying its originating step.

Reproduced independently by both reviewers with the project's Redis double:

1. Seed Campaign running with ID 4 and an earlier completed Expired step.
2. Hold Campaign's HSCAN, Pause Campaign, then Start Expired. Expired starts
   with ID 2, reset counters and no error.
3. Fail the old Campaign read. State remains `running: "expired"`, with the
   fresh audit's counters intact, but `lastError: "old campaign read failed"`.

This is a remaining reporting edge, not a new progress/data-loss regression.
The same-step new-run error fence works. Intentional error retention for a
paused run does not give its shared message an originating-step label.

Fix direction: use the active step/run ownership check for shared error saves,
or retain the error's step/run context and show its source in the UI. A guard
that allows any idle state can still accept an old error after the other step
has finished, so it does not fully distinguish these histories.

### Validation at the updated revision

- **349 test files, 4,647 tests passed** through `npm test` in an isolated
  tracked-HEAD copy, including the pretest typecheck. The run excluded unrelated
  untracked WIP tests and used the approved localhost-capable test execution.
- **`npm run build` passed** in that copy. Verified the CJS server, all ten
  configured WebView entrypoints, no client `.map` files, and run identity plus
  atomic switch logic in the minified server bundle. The same unrelated,
  nonfatal Campaign JSON import-attribute warning remains.
- **Five external probes passed:** original 201-row race now fenced and fully
  audited next; actual installed Devvit `TxClient` staging both keys under one
  transaction ID, discarding a switch enqueue failure and enabling the cache
  immediately on retry; already-running switch repair without progress writes;
  exhausted conflict keeping both keys/cache off; and the P3 cross-step
  reporting reproduction.
  Three of these five use the actual installed transaction client with stubbed
  RPC; persisted state and WATCH behavior use the project's Redis double.
- A separate agent reviewed all run identity/save paths and independently
  reproduced the reporting issue. No hosted Devvit Redis/Blob validation was run.

External probe source/config:
`/private/tmp/dailygp-devvit-native-review/followup-implementation.test.js` and
`/private/tmp/dailygp-devvit-native-review/followup-implementation.config.mjs`.
Suite/build logs:
`/private/tmp/dailygp-compaction-followup-full-suite.log` and
`/private/tmp/dailygp-compaction-followup-release-build.log`.
The isolated source/build copy was removed after validation.

One harmless proposal difference: same-step Start or Resume of a numberless
legacy run uses its stable parsed ID 0 rather than necessarily assigning ID 1
on that action. Its progress is preserved, and its next fresh initialization
increments from 0, so this does not defeat the stale-worker fence.

## Earlier result — `1d820ff6`

**Two P2 compaction findings remain.** Both were reproduced against the
implementation. The held-list, sweep and Blob retry/rate fixes passed the
review and their focused checks. Neither compaction reproduction loses a ghost;
they leave packing incomplete or the packed-write policy disabled.

Reviewed branch `daily-ghost-blob-archive` at
`1d820ff66815f45ed9031b44e18a2bf8c99bd46e`, including the five fixes after
`ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`:

- `bc28f0ce`: held-list rotation.
- `5c8774de`: damaged-row sweep protection.
- `5ddb32b4`: compaction state updates.
- `bda781eb`: skipped-row tracking and legacy audit.
- `1d820ff6`: one Blob attempt and transport rate gate.

This was a read-only application review. Only this review document was added
to the repository. Existing unrelated work was preserved. Reproduction probes
were written outside the repository; no hosted operations, deploys or commits
were performed. The earlier revision 3 report approved a design; this report
checks its implementation.

## 1. P2 — An old worker can finish the fresh legacy audit without scanning it

Source: `src/server/competition/ghost-compaction.ts:263–280,339–344,442–484`.

Start correctly resets a pre-fix step to its first board and cursor zero.
However, Pause and Start do not invalidate the active worker's lock. Every
worker commit checks only the current running step name. An old request waiting
on HSCAN can therefore finish after Pause followed by Start of the same step,
apply its old page to the new counters, and mark that board done.

Reproduction with the project's Redis test double:

1. Seed a legacy running step without `skipTracked`, one 201-row board and
   cursor 200. The first page contains a plain ghost previously left behind;
   the final page has one packable ghost.
2. Hold the worker's final-page HSCAN response. Pause, then Start. Verify the
   new audit has index/cursor/checked zero, empty `doneKeys` and `skipTracked=true`.
3. Release the old HSCAN response. The worker packs the final row, advances
   the new audit and marks the whole board done.
4. The earlier plain ghost remains. Run again excludes the board because its
   key is in `doneKeys`.

Observed result:

```json
{"total":201,"checked":1,"missedGhostStillPlain":true,"runAgainBoards":0}
```

The subagent also reproduced an old worklist advancing a newly rebuilt,
different worklist. The same-board case above proves an unfinished board can
be excluded from subsequent runs, rather than just missed in one request.

Fix direction: give a fresh audit/run an identity captured by the worker and
checked in every watched commit. Preserve it for a genuine resume and change
it when rebuilding the audit. An alternative is to fence the restart against
the active worker before publishing its new state. Checking only `running`
cannot distinguish these two runs of the same step.

## 2. P2 — A failed Start publishes running state before enabling packed writes

Source: `src/server/competition/ghost-compaction.ts:254,287–297`,
`src/server/competition/pb-ghost-write.ts:15–29`, and
`src/server/competition/pb-ghost-store.ts:399–407`.

Start first commits `running` and `writePacked=true`, then separately writes
`WRITE_PACKED_GHOSTS_KEY`. Normal PB writers use that separate key, not the
compaction state's `writePacked` field. If the switch write fails on the first
enable, Start reports an error but the worker is already allowed to run and
normal PB writers continue storing plain ghosts.

Retrying Start while that step is running returns the current state with
`started=false`, so it never retries the failed switch write. Pause and Start
can repair it, but a normal retry cannot. This undermines the policy that new
PBs are packed from the first successful compaction admission onward.

Reproduction: fail only the first SET of `WRITE_PACKED_GHOSTS_KEY`, leave the
state transaction working, then retry Start. The stored state and writer
disagree, and the actual writer encoder still emits a plain ghost:

```json
{"running":"expired","stateWritePacked":true,"actualPackedWrites":false,"retried":true}
```

Fix direction: enable the one-way writer switch before admitting compaction,
or commit both persisted values together and update the in-process writer
cache after successful commit. Same-step retries should also repair a missing
switch rather than permanently returning the contradictory state.

## Assessment of the five original findings

| Area | Implementation assessment |
| --- | --- |
| Error undoing Pause | Error handling now merges only `lastError` into freshly watched state. The original race is addressed; findings 1 and 2 concern separate Start/restart paths. |
| Skipped compaction rows | Per-board skips keep boards out of `doneKeys`; page advancement commits skip counts once. Legacy Start rebuilds the audit, but finding 1 can defeat that reset. |
| Held-list starvation | `heldCursor` plus page-local `heldAfter` advances/wraps; empty scan pages checkpoint progress. Cursor progress only accounts for handled names. No actionable defect found in the examined paths. |
| SDK retries and rate | One-attempt strategy keeps signing middleware, and the gate reserves a slot synchronously immediately before delegating to the handler. Actual installed-client probes confirm one attempt and a maximum of 40 admissions in a closed one-second window for one store. |
| Damaged-row sweep | Unreadable/empty rows stop reference construction; missing links can retain matching run tokens; `refsVersion` restarts old inventories. Blob read failure does not advance past an unchecked object. No actionable defect found in the examined paths. |

## Devvit documentation and SDK basis

Used the official
[Devvit docs skill](https://github.com/reddit/devvit-skills/blob/71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae/skills/devvit-docs/SKILL.md),
refreshed its official docs cache, and matched the project's Devvit 0.14.7
packages to `versioned_docs/version-0.14` at docs commit
`c822bd5624677dbcfcd8480624452db4927d39a1`.

- [Redis documentation](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/server/redis.mdx): shared-state WATCH/read/validate/MULTI/EXEC pattern, early-exit cleanup, HSCAN and cursor-based migration sections. Reads after WATCH use the base Redis client; transaction reads are queued. The compaction findings do not depend on a standard Redis backend encoding or scan ordering promise.
- [Blob documentation](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/server/blob-storage.mdx): installation namespace, supported S3 operations and the 100 requests/second quota. The implementation's 40 limit applies to the store/client sharing its timestamp history, not the aggregate of separate server requests.
- [Build documentation](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/guides/tools/vite.mdx): required bundled CJS server and WebView build outputs.

Also inspected the installed Redis transaction implementation and actual
Devvit S3 client/request handler. Redis documentation has conflicting
concurrent-transaction figures (30 in prose, 20 in the table); neither figure
was used to derive a finding. The documented execution timeout was not
treated as an undocumented WATCH-to-EXEC lifetime.

## Validation and limits

- **Full committed-revision suite: 349 files, 4,642 tests passed.** `npm test`
  also passed its `tsc --noEmit` pretest. Run in an isolated tracked-HEAD copy,
  excluding unrelated untracked WIP tests. Local HTTP listeners required the
  sandbox-approved rerun; that rerun passed.
- **Release pipeline: `npm run build` passed** in the same isolated copy.
  Verified `dist/server/index.cjs`, every configured WebView entrypoint,
  absence of client `.map` files, and the five-fix code in the server bundle.
  The build retained a nonfatal, unrelated JSON import-attribute consistency
  warning in Campaign series loading.
- Focused archive/compaction/UI/Blob suites passed. Six additional probes used
  the installed `newS3Client` and real `FetchHttpHandler` with stubbed config
  RPC and `globalThis.fetch`. They covered one-attempt errors, concurrent rate
  admission, aborts, signing, namespace behavior, PUT/GET/LIST/DELETE and
  preserved handler lifecycle/configuration methods.
- Two root reproduction tests passed by asserting the failures described
  above; independent compaction review also reproduced both paths. These are
  deterministic application-control-flow checks using the project's Redis
  double, not claims about hosted scan timing or ordering.

External reproduction source:
`/private/tmp/dailygp-devvit-native-review/implementation-compaction-repro.test.js`.
Run with:

```sh
node node_modules/vitest/vitest.mjs run --config /private/tmp/dailygp-devvit-native-review/implementation-compaction.config.mjs
```

Full-suite and release logs are respectively
`/private/tmp/dailygp-claude-implementation-full-suite.log` and
`/private/tmp/dailygp-claude-implementation-release-build.log`.

No hosted Devvit Redis/Blob lifecycle test was run. Passing local tests and
build confirms the examined code and packaging; it does not resolve the two
reproduced compaction findings.

## Proposed follow-up fixes — design check

**Both proposed fixes address the reproduced failures**, subject to the
implementation details below. Checked against the unchanged source revision
above, the official Devvit skill's matching 0.14 Redis documentation, and the
installed Devvit 0.14.7 transaction client. No follow-up implementation was
made or tested. A separate agent checked the run-number paths.

### Run number

- Allocate the next number from the freshly watched step (`n + 1`) in the
  same transaction that initializes a fresh run. Do not reset to 1 on every
  run. A fresh legacy audit increments the number as it resets progress;
  ordinary numbered Pause/Resume preserves it.
- Capture the number once after the worker's state reread under its lock.
  Store it separately from `ctx.state`: `commit` replaces that mutable state
  before validation. Comparing two values from the refreshed state would
  let the old worker adopt the new identity and defeat the fence.
- Check the captured number and running step inside the existing watched
  commit before row writes, page advancement and completion. WATCH then
  covers a restart racing between validation and EXEC.
- The error handler's `lastError` update is a save outside `commit`. Fence
  it too if the stated promise is that an old run saves nothing into the new
  run. Lock release remains necessary when an obsolete worker exits.
- Treat a missing legacy number as a stable unnumbered value, such as zero.
  Its next Start may persist its first number, including an already-running
  Start, while preserving boards/cursor/counters/`skipTracked` on that repair
  path. A numbered already-running Start preserves its number. Number
  adoption alone must not falsely mark the legacy audit complete.

The proposed regression should assert both halves: the held old page cannot
pack a row or advance/finish the reset audit; after that worker exits, a new
request scans the whole 201-row board and packs the earlier missed ghost.
Also retain a normal Pause/Resume case to verify progress and identity survive.

### Writer switch and state in one transaction

The official Redis documentation's **Transactions** section describes a
transaction as a “single isolated step” and states the commands happen
“together or none at all.” Queue both the persistent packed-write switch and
the step state on the same Devvit transaction client, then use one EXEC.
The installed client supports that sequence; reads needed for decisions use
the base Redis client after WATCH, not queued transaction reads.

- The current already-running Start returns through `next === current`
  without EXEC. The switch repair must still execute on that path while
  preserving progress and the established run number.
- Update this process's positive packed-write cache only after successful
  EXEC. Do not leave a second fallible Redis SET after the commit or set the
  cache positive before commit. Other process caches retain the existing
  one-minute refresh behavior; this proposal does not change that contract.
- On queue failure, discard; on a WATCH conflict, reread and retry. A conflict
  must not publish a positive cache value. The normal failure regression
  should inject the switch enqueue failure before EXEC and verify neither
  persisted value changes, rather than expect the project's sequential test
  double to roll back commands it has already executed.

The failure-then-retry test is appropriate, but also seed the exact existing
bad state (running step, `writePacked=true`, missing switch) and verify Start
repairs the switch while keeping the run number, cursor and counters. Prime
the local cache false and assert it becomes true only after the successful
shared commit. Separate commits with focused tests are sensible.
