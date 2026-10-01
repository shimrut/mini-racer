# Waiting Campaign times and concurrent series publication: plan review

Date: 2026-10-01. Branch: `ingame-mapmaker`.
Reviewed HEAD: `41cbc850a4be58ff324d3aa1a65ffe55dd4aec38`.

Input: the pasted plan at
`/Users/bpopa/.codex/attachments/03219dce-4864-4014-b6ac-b56c9b70130d/Pasted text.txt`.
This is a plan review. No runtime code, repository tests, existing plan files,
or unrelated dirty work were changed.

## Verdict

The client preservation gate and request-local series view address the three
original faults. The transfer refresh belongs after durable pending marks and
before board discovery. Do not implement the plan unchanged: its blanket
snapshot rule also reaches mutation admission checks and progress rewrites,
where an older catalog is not sufficient authority for newer persisted data.
There is also a client load-recovery gap and an existing late-save transfer
gap that the proposed transfer guarantee does not account for.

## Required corrections

### 1. P1: Creator mutation admission must see current publication state

Plan line 60 pins every downstream route, including Creator migration. The
Unplayed copy's final check calls `readTrackUsage()` inside the placement lock
(`src/server/tracks/track-migration.ts:145-147`). That helper uses
`CAMPAIGN_LIVE_STAGES` (`track-usage.ts:20`), so the proposed request pin freezes
the admission check as well as the report.

Reproduction with actual publication, migration and save functions, and an
emulated pre-publication resolver:

1. Capture a catalog before `new-live-v1` exists.
2. Publish that series with the uncopied built-in `smallSteps`, then refresh
   the shared catalog. Publication locks only stored track records that exist
   (`series-store.ts:385`).
3. Run Unplayed copy under the older view. Its in-lock check misses the live
   stage and writes an unlocked copy.
4. A normal Creator save changes the copied track's corner radius. The live
   series retains its race and track IDs. Existing assignment checks enforce
   completeness/ground compatibility but the record stays unlocked
   (`track-store.ts:395-410,429`).

Keep final authoring admission checks authoritative inside the placement lock.
Do not make them depend on a request-start pin. Add the publication-during-
Unplayed-copy regression. The underlying stale-cache check can also fail today;
the planned pin explicitly prevents it from observing a same-process refresh.

### 2. P2: an older catalog must not discard newer saved progress during a write

A fixed catalog does not freeze Redis player records. An older request can
remain pinned before a stage append while another request saves that stage
for the same account. The older request's `mutateProgress()` reads the latest
Redis record (`campaign-store.ts:357`), but `parseBestResult()` discards a stage
absent from its older view (`:182-194`). An accepted old-stage submission then
rewrites this filtered record (`:915-924`).

The actual submission function returned 200/accepted and removed the appended
stage's progress row in a reproduction using an older view. The leaderboard
row survived; bootstrap repair can recover it. This proves an unsafe progress
overwrite, not permanent loss of the ranked score. The older view emulates
the proposal; the AsyncLocalStorage implementation is not installed.

Constrain pins to consistent read/transfer operations, or give mutations an
explicit current-catalog boundary under their existing progress locks. In
either approach, never rewrite a record after silently filtering out newer
saved stages: preserve independently validated rows or stop safely for retry.
Stage 3's transfer-only refresh does not cover ordinary submissions. Add an
overlapping old-stage submission/new-stage result test.

### 3. P2: failed initial catalog loading needs an independent recovery trigger

The proposed Campaign timer exclusion correctly prevents a due-entry busy
loop, but it also removes the only retry for unloaded Campaign entries.
Secondary startup runs once (`game/engine.js:997-999`), Campaign service catches
load failures into an unavailable result (`game/campaign/service.js:164-165`),
and the online handler only schedules queue processing (`engine.js:639-640`).
With the proposed flag still false, that processing skips Campaign again.

Add a deduplicated catalog recovery request with the normal retry delay or an
appropriate reconnect trigger. A temporary load failure must not leave valid
waiting results suspended until manual Campaign navigation or reload. Test
failure, network recovery, catalog success, then exactly one submission.

### 4. P1: the transfer writer-drain claim needs the complete save lifecycle

Plan line 77 assumes the submission lock covers the complete save. This is an
existing gap, not introduced by the catalog reload. The in-flight check reads
submission locks (`daily-gp-store.ts:1019-1026`), but the shared submit starts
releasing that lock (`competition/competition-submit.ts:340-343`) before its
Campaign caller writes progress (`campaign-store.ts:915`).

A reproduction paused an actual guest submit before progress-lock acquisition,
waited for its submission lock to disappear, used the normal chooser, and
completed transfer/cleanup. Resuming the earlier submit recreated guest
progress. Identity resolution then returned `guest_promotion_pending` despite
the completed transfer.

Add a full-save overlap test. Keep the ownership boundary through the final
progress write or provide an equivalent transfer/ownership fence before a
late mutation. If this existing defect is intentionally deferred, narrow the
plan's claim: Stage 3 establishes catalog freshness but does not establish that
all writers have drained. Do not use a manually seeded submission lock as the
sole proof of that boundary.

## What is sound and what the tests must prove

- The unknown-stage deferral preserves replay, owner, expiry and ghost state
  through the existing pending-entry spread and `preserveUpdatedAt` behavior.
- Every successful startup mode eventually loads Campaign. Home's secondary
  `invokeModeMethod` installs Campaign methods before running bootstrap. The
  loaded gate therefore addresses the early missing-method call.
- A successful response without `storedSeries` still establishes an empty
  catalog. Add real service tests in `tests/campaign-client-service.test.js`:
  empty OK, failed load, and unranked OK. Campaign UI tests mock that service
  and cannot verify the readiness producer.
- Define readiness as receipt of the series catalog. A later stored-track load
  can still fail, so distinguish it from success of the whole Campaign load.
- Preserve the existing 30-day expiry semantics: verification stops and replay
  clears, while the time remains as an error marker. The plan's "only end"
  language should not imply that the entire record is deleted at expiry.
- AsyncLocalStorage is feasible in this server; the installed Devvit context
  already uses it. Allocate a fresh holder per request. Test two overlapping
  requests and prove repinning one does not change the other.
- Bootstrap's second catalog confirmation can refresh the shared cache without
  changing its pinned response definitions. Existing published track shapes
  are immutable under the copy/undo rules, so track pinning is not required for
  the three original faults.
- Stage 3 refresh exhaustion should be retryable with no subsequent inventory,
  copy, checkpoint or cleanup work. Keep the durable transfer record pending.
- Test the normal account boundary: an appended-stage account result saved
  after request-start catalog capture but before both pending marks must
  survive. The plan's stale guest/new-series fixture alone is insufficient.
- Direct transfer tests currently have no install scope or request pin. Supply
  mocked install context and the actual pin wrapper, or exercise the server
  app; otherwise catalog reload is a no-op and the test cannot prove repinning.
- Catalog refresh must retain frozen source inventory/checkpoints on copying
  resumes. Preserve the existing completed-record early return.

## Verification corrections and evidence

The plan's two-failure baseline is not current. A targeted baseline run found
three failing assertions:

- `medals defines ordered thresholds for every track` — missing medal row.
- `snow driving is slower than dirt, which is slower than tarmac` — expected
  0.85 to be below 0.85 in the existing dirty ground configuration.
- `track runtime integrity preserves existing track data while intentionally
  extending the registry` — registry key-list mismatch.

Capture the baseline before implementation as JSON and compare individual
test names, counts and assertion details. Preserve the process exit status;
the proposed FAIL-line pipeline can hide an additional failure in an already
failing file, or a typecheck/setup error with no matching FAIL line. Recheck the
full-suite baseline rather than treating this three-file sample as exhaustive.
Add the server bundle check in Stages 2 and 3, which add server imports.

Verification performed for this review:

- `npm run typecheck`: passed.
- The nine focused files named in the plan contain 228 tests: 224 passed in
  the sandbox; four catalog-gate tests could not listen on localhost. Those
  four passed when rerun with loopback access. No focused product failures.
- Three baseline suites: 63 tests, 60 passed and the three assertions above
  failed. No code was changed to suppress them.
- Parent independently reran the Unplayed/pin reproduction: 1/1 passed,
  asserting the documented unsafe outcome.
- Parent independently reran six transfer/catalog reproductions: 6/6 passed.
  Two new cases establish the ordinary progress overwrite and late guest-save
  overlap; the other cases retain the earlier review's qualifications.

Temporary evidence:

- `/private/tmp/dailygp-stage2-pinning-review.test.js` and
  `/private/tmp/dailygp-stage2-pinning-vitest.config.mjs`.
- `/private/tmp/dailygp-mapmaker-transfer-review.test.js` and
  `/private/tmp/dailygp-mapmaker-transfer-vitest.config.mjs`.
- `/private/tmp/dailygp-waiting-series-plan-focused.json` and
  `/private/tmp/dailygp-waiting-series-plan-gate.json`.
- `/private/tmp/dailygp-waiting-series-plan-baseline.json`.

These are local actual-function tests with mocked Redis/catalog interleavings.
The submission reproductions reuse a judged run, without re-running physics.
Mock analytics emits an absorbed missing-`hIncrBy` message. No hosted incidence,
production timing, new implementation, or full-suite pass is established.

## Revised plan double-check

Revised input:
`/Users/bpopa/.codex/attachments/9e3089bb-7994-4f57-bbb6-49ac8d602138/Pasted text.txt`.
HEAD remains `41cbc850`. This section supersedes the earlier verdict for that
new input; it does not describe implemented changes.

The revision addresses the original four objections in direction: a client
catalog retry, preservation of opaque newer progress, a current Redis-based
Unplayed admission check under the placement lock, and a late-write identity
check. Putting mutation protections before request pinning is the right order.
One substantive boundary correction remains.

### Stage 2's pending check must remain valid through the progress commit

Revised plan lines 65-68 say a pending/promotion check under the progress lock
is enough. However, transfer source inventory is captured at
`daily-gp-store.ts:2360-2365`, before Campaign merge takes the progress locks at
`campaign-store.ts:1169-1175`. The transfer can therefore record the old guest
progress while an ordinary writer holds its progress lock.

The uncovered ordering is:

1. The save acquires its progress lock and checks pending/promotion: both are
   absent. Its board save has already released the stage submission lock.
2. Before the progress write commits, the chooser/transfer sets pending marks
   and captures the still-old source inventory.
3. Merge cannot acquire the writer's progress lock and returns retryable. The
   coordinator has already persisted the frozen inventory in copying phase
   (`daily-gp-store.ts:2370,2463`).
4. The writer commits new guest progress after its earlier pending check.
5. Resume compares that new progress with the frozen old fingerprint and
   requires recovery instead of completing the transfer.

Make the state check part of the progress commit's concurrency fence. WATCH
the relevant pending and guest-promotion keys before reading their state,
along with the owned progress lock, and refuse/retry if that state changes
before EXEC. Checking again without protecting the commit leaves another
check/write window. An equivalent ownership design may be used, but do not
rely on the progress lock alone. The existing owned transaction helper watches
only the progress lock (`redis/redis-lock.ts:105`).

Add this exact interleaving alongside the existing proposed test where the
save reaches its late write only after transfer completion. The earlier save
must either finish before inventory capture or abort without changing the
record; resuming the transfer must not enter recovery for that valid race.

Local reproduction confirmed the gap with the proposed check injected by a
temporary Vite transform after progress-lock acquisition. The actual save
passed the check and paused at the owned transaction's WATCH; normal chooser
and selection froze the old inventory and returned retryable 503 for the held
progress lock. The save then returned 200/accepted and changed guest progress.
The next selection returned 409 `guest_progress_recovery_required` and persisted
recovery phase. Parent independently reran this single case: 1/1 passed,
asserting that unsafe outcome. No repository source was changed.

Evidence: `/private/tmp/dailygp-mapmaker-planned-marker-review.test.js`,
`/private/tmp/dailygp-mapmaker-planned-marker-vitest.config.mjs`, and
`/private/tmp/dailygp-revised-plan-marker-review.log`. The test uses mocked Redis
and a judged-run reuse path; the absorbed analytics mock error is unrelated.
It establishes the check/commit gap, not validation of an unimplemented
transaction fence or hosted timing.

### Implementation and acceptance details

- Preserve unknown rows only as opaque persisted data from the same raw read
  under the destination's progress lock. Confirm the record's campaign ID and
  row/key ownership. Keep these rows out of returned verified progress,
  medals, unlocking and guest-source acceptance until their stage validates.
  In transfer writes, preserve the account's own opaque rows; do not treat
  arbitrary unknown guest rows as valid transferable evidence.
- The new catalog retry is sound in principle. Add a fake-timer test proving
  automatic recovery after 30 seconds without an online event, and preserve
  the earliest Daily or Campaign deadline when finally reschedules. Test a
  successful catalog wakeup while queue processing is already active.
- Add real Campaign service readiness tests: OK with omitted storedSeries,
  failed response, and unranked OK. Readiness means catalog receipt, which can
  precede a later stored-track confirmation failure.
- Keep the fixed `PUBLISHED_DAILY_GP_TRACKS_BY_DATE` history alongside Redis
  history in `isTrackPlayedNow`. Check published status and only the published
  stored-stage prefix. Including live app stages and held-ground published
  stages is safely conservative.
- Allocate a fresh request holder. Test two requests that initially pin the
  same cache revision, then repin only one; the peer must retain its view.
- Stage 5 tests need an install context and actual pin wrapper, or the server
  app. Existing direct store tests provide neither; without scope, catalog
  loading returns immediately and cannot prove the refresh.
- Exercise the account save specifically between initial catalog capture and
  pending marks, including an appended stage. The generic "before transfer"
  case does not necessarily exercise this publication boundary.
- Add a server Node/CommonJS bundle check for server stages 2-5, matching the
  `index.cjs` entry in `devvit.json:92`. Keep the full baseline comparison by
  individual assertion and preserve frozen inventories on copying resumes.

No new runtime code or repository tests were written for this double-check.
The earlier typecheck/focused validation applies to the unchanged reviewed
HEAD; it is not validation of the proposed fixes.

## Latest plan: transaction design sound; one caller catch to complete

Input:
`/Users/bpopa/.codex/attachments/4da375ae-9c18-4c3e-b63a-daec1dc31a48/Pasted text.txt`.
Reviewed against unchanged HEAD `41cbc850`.

Stage 2 now watches
pending/promotion keys before checking them and retains that watch through the
same progress-write transaction. It covers the exact inventory-capture race.
The client retry/readiness tests, current Creator admission check, separate
request holders and repin isolation, scoped catalog-refresh tests, copying
resume protection, full baseline comparison and server bundle checks address
the other review points. The stage order puts write/admission protection before
global request pinning.

One narrow response correction remains before implementing Stage 2. The plan
has `repairCampaignProgressFromLeaderboard` catch the new pending error, but
a pending-key change after the check makes EXEC fail with the existing
`CampaignProgressBusyError` (`campaign-store.ts:323-324`). Repair currently
returns `mutateProgress` directly (`:582`), and bootstrap's route turns that
uncaught error into 500 (`routes/campaign-routes.ts:66-72`). Returning the
pre-read progress only for the new error does not cover this post-check race.

Catch the fenced write's retryable conflict in repair as well, or translate
the marker-caused conflict to the pending error. Await the mutation inside
that catch and add a test where transfer marks change after repair's state
check but before its commit: no write, successful Campaign load. This is a
caller response gap; the new fence correctly prevents data corruption.

Parent independently reran a temporary positive reproduction of the proposed
transaction fence: 1/1 passed. When transfer marks changed after the save's
check, EXEC aborted with retryable 503, guest progress stayed unchanged, the
next transfer attempt completed, and the account received the 11-second board
best. Evidence: `/private/tmp/dailygp-mapmaker-watched-marker-review.test.js`,
`/private/tmp/dailygp-mapmaker-watched-marker-vitest.config.mjs`, and
`/private/tmp/dailygp-latest-plan-fence-review.log`.

Two implementation details remain worth keeping explicit: reuse the opened
watched transaction in the writer and discard it on no-op/error exits; preserve
opaque rows only from the correct campaign with matching row/key ownership,
without exposing them as verified results. These are implementation safeguards,
not additional demonstrated plan blockers.

The reproduction uses temporary module transforms, mocked Redis and the
judged-run reuse path. It validates this concurrency boundary locally, not the
complete future implementation or hosted Redis timing. No runtime source or
repository tests changed; the permanent regression tests and staged checks
still need to run during implementation.
