# Old Daily ghost blob archive — proposal review

The latest review is [Review 5](#review-5--lifecycle-corrections-and-implementation-readiness),
dated October 7, 2026. All three remaining P2 lifecycle findings are addressed
in the latest proposal. No further design blocker was found: the plan is ready
for implementation, followed by its specified tests and hosted canary. Earlier
reviews are retained as evidence for the previous proposals; this verdict does
not mean the proposed changes have been implemented or deployed.

Reviewed October 6, 2026 against `codex/fixes`, with the existing dirty tree
preserved. Input: the pasted **Move old Daily ghosts to blob storage** proposal.
This records a read-only application review; no source, dependencies,
configuration, tests, or hosted data were changed. This review document is the
only addition made for this request.

## Verdict

The direction is appropriate for expired Daily ghosts. Upload, read back,
validate, and only then replace the unchanged Redis row is the right handoff.
The proposed scan-completion and restore contracts need correction before
implementation. Exact progress totals and retry behavior also need a durable
commit contract. Chunked files are feasible, but the stated sizes and backfill
duration remain estimates.

This reviews the pasted proposal, rather than replacing the earlier
[feasibility investigation](./expired-daily-ghost-blob-storage-feasibility-2026-10-06.md).
That document proposed expiry plus 24 hours and one object per ghost. The pasted
proposal instead specifies day 8 at 06:00 UTC and chunked objects. The six-hour
boundary is supported by the current code; the earlier extra day is a margin,
not a requirement for the current playable/publication contracts.

## Confirmed parts

- Normal Daily contracts expire seven days after their UTC start
  (`src/server/daily/daily-gp-model.ts:181-196`). Playability ends at the exclusive
  `availableUntil` boundary (`:205-212`). Archive eligibility at
  `availableUntil + 6 hours` means 06:00 UTC on day 8 for these contracts.
- Podium publication allows retries until, but not including, that six-hour
  deadline (`src/server/podium/daily-podium-service.ts:37-60`). It rechecks the
  deadline after capturing the replay (`:451-466`). Published replays already
  contain their ghosts.
- Own Daily PB and opponent reads require a playable day
  (`src/server/player/player-account-store.ts:351-366`,
  `src/server/daily/daily-gp-store.ts:2829-2834`). This migration does not require
  a new blob read in ordinary races or a historical playback screen.
- Guest transfer copies the stored PB payload, rather than reconstructing it
  from the parsed record (`src/server/daily/daily-gp-store.ts:1478-1494`,
  `src/server/guest-transfer/board-merge.ts:99-103`). A valid stub can retain its
  original archive field when copied to an account. Existing ghost-null PBs are
  supported; preserving the optional reference in `parseRecord` is still needed.
- Watching the PB hash and both owner pending-marker keys, then reading source
  values and markers through the base client after WATCH, protects each returned
  row. Transfer sets its markers before source capture
  (`src/server/daily/daily-gp-store.ts:2412-2446`) and clears them on completed
  selection (`:2688-2697`). Exact source comparison prevents resurrection after
  concurrent guest deletion.
- The published `@devvit/blob@0.14.7` package exists. Its `newS3Client()` returns
  a promise and obtains installation configuration for the current request; its
  documentation says not to reuse the client across requests. One client may
  serve the put/get operations of the same incoming job request. Its S3 peer
  dependency is `@aws-sdk/client-s3@^3.931.0`. Package inspection downloaded a
  tarball to `/tmp`; no dependency was installed.
- Reddit's [Blob Storage documentation](https://developers.reddit.com/docs/0.13/capabilities/server/blob-storage)
  supports put/get and advises against `permissions.blob`. Storage is private
  to an installation, so development and production need separate validation.

## Required corrections

### 1. A scan with zero skips does not prove a day is done

The proposed explanation only covers a guest row that the scanner actually
encounters while a transfer is pending. HSCAN is not a snapshot.

A permitted interleaving is:

1. The archive has already visited some hash buckets, while guest field G with
   an inline ghost remains in an unvisited bucket.
2. A sign-in copies G to account field A in an already visited bucket.
3. Transfer cleanup deletes G before the archive visits its bucket; the transfer
   finishes and clears its markers.
4. The scan reaches cursor zero having seen neither G nor A. It records zero
   skips and marks the day done, while A still has an inline ghost.

The copy is at `daily-gp-store.ts:1478-1494` and `board-merge.ts:100-102`; guest
deletion is at `daily-gp-store.ts:1545`, invoked by the transfer at `:2637-2645`.
[Redis SCAN guarantees](https://redis.io/docs/latest/commands/scan/) permit
omitting fields that were not continuously present for the whole iteration.
Watching individual replacement groups does not close this whole-pass gap.

Invalidate/requeue the affected historical day atomically with a transfer PB
write, or use a per-day transfer mutation generation to require an unchanged
generation for a complete verification pass and its done transition. A bounded
periodic reconciliation is another way to provide eventual convergence, but
then done cannot mean permanently ignored. Do not hold a whole-day transaction
or transfer lock over uploads. Add the unseen-source/new-destination scenario
to the proposed tests.

### 2. Restore must include partially migrated days

Restore currently walks only done days. A job can commit its first 50 stubs and
then fail, time out, or wait indefinitely for one pending transfer. Those stubs
are live even though the day never reaches done. Switching to restore would
leave them behind.

Discover every day with confirmed archive work or possible stubs, including
working, failed, and interrupted days. Restore needs its own resumable state;
finishing the move pass cannot be a prerequisite. Retain the original archive
field after account copying, validate challenge/race metadata as well as time
and timestamp, and compare the complete current stub under WATCH before
replacement. Missing or changed rows must not be recreated.

Test a stop after one replacement group but before the move checkpoint, plus
restore while another row keeps the day unfinished.

### 3. Counts and checkpoints must survive the replacement commit

The proposal commits stub replacements in step 8 and saves counts in step 9.
A stop between them leaves real stubs with missing moved/freed counts. On
retry, step 4 ignores those stubs, so the missing totals never repair themselves.
Blindly counting the uploaded file instead would include skipped/deleted rows.

Commit the authoritative replacement counts with their replacements, or persist
idempotent batch receipts that can reconstruct totals after interruption. Define
whether runs means cumulative migrations or currently referenced archive rows.
Manifest file/byte totals must deduplicate confirmed object keys, and uploaded
objects and rows actually moved must have separate counts. Checkpoint and done
writes must remain fenced by job ownership.

Use `beginOwnedRedisLockTransaction` with the job lock and relevant watched keys
(`src/server/redis/redis-lock.ts:101-124`); merely taking a 55-second lock does
not fence later writes after ownership loss. Test interruption between EXEC and
checkpoint, duplicate processing, and a lost lock before a state write.

### 4. Persist the batch identity and impose byte/time bounds

HSCAN COUNT 500 is a hint, not a guaranteed maximum, and returned ordering and
membership can change. The installed client forwards COUNT; the existing test
double instead uses strict array slices
(`tests/redis-test-double.js:176-184`). Include duplicates, reordered results,
oversized pages, and empty pages with nonzero cursors in archive tests.

A SHA-256 name guarantees the same key for identical file bytes. It does not
guarantee the same file on a resumed scan: after 50 rows become stubs, rebuilding
only the remaining inline rows produces a different digest and another object.
Concurrent transfer/deletion can change the page too.

Persist sufficient confirmed-batch information before replacement to resume
that batch, and use deterministic row ordering for identical contents. Split
scan results into chunks bounded by encoded bytes as well as row count, with a
durable continuation for unprocessed rows. Preserve exact decoded JSON text
or explicitly define a lossless comparison; an object in the blob is not itself
the raw compressed Redis string used by the watched source comparison. Keep
these two representations separate.

Valid traces can reach 128 KiB (`game/shared/pb-ghost-format.js:5-6`;
`src/server/competition/pb-ghost-trace.ts:26-27,75`), so 500 valid records need
not produce a 0.5–0.8 MB compressed object. Measure payloads and leave headroom.
Reddit documents [blob request limits](https://developers.reddit.com/docs/0.13/capabilities/server/blob-storage),
[Redis limits](https://developers.reddit.com/docs/capabilities/server/redis),
and a [30-second server request limit](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview).
A rule that only stops starting new pages at 20 seconds does not bound the page
already running. Bound blob operation deadlines/retries, batched post-WATCH
reads, replacement groups, and checkpoint time; keep each transaction within
the documented five-second execution limit. Await all started work before the
route returns.

### 5. A waiting oldest day must not block the whole backlog

Selecting the oldest not-done day without considering `nextPassAt` means one
pending transfer or repeatedly failing record can hold all newer days behind
it. Pick the oldest eligible day whose retry is due and whose state can make
progress. Keep deferred work durable without spinning every five minutes.

Define the rollout day limit as one fixed challenge across scheduled invocations,
rather than one day per invocation. Otherwise a limit of 1 can still move a new
day on each subsequent run and fail to provide the intended production canary.

### 6. Permanent files are a retention change

Guest cleanup currently deletes a guest's PB row after its one-year inactivity
deadline (`src/server/daily/daily-guest-cleanup.ts:62-80`); account-choice discard
also deletes guest rows (`src/server/daily/daily-gp-store.ts:1562-1568`).
Archiving complete records into files that are never deleted keeps those records
after their Redis owners disappear. It also retains redundant objects generated
by failed/partial attempts.

State the intended archive retention explicitly. If existing deletion semantics
are to remain, add reference-aware reclamation and, where necessary, page
compaction. Deleting a guest field must never remove an account's surviving
shared ghost. Compaction requires the same confirmed upload and watched pointer
handoff before deleting an old object. Permanent storage can be a deliberate
archive policy, but its capacity forecast must include deleted-owner records,
unreferenced uploads, and duplicate chunks.

## Measurement corrections

The opening traffic and quota figures are reported inputs, not live measurements
verified in this review. Public documentation lists 50 GB for blobs; the reported
10 GB grant should remain the conservative rollout assumption until the actual
installation quota is confirmed.

- The moderator Ghost replays family combines Daily and Campaign PB hashes
  (`src/server/moderator/storage-usage.ts:461-485`). The overall ghost share
  does not establish how much expired Daily archival will remove.
- The page samples named payload sizes (`:164-178`), not Redis allocator
  occupancy. See the existing
  [storage-estimate investigation](./redis-size-drop-investigation-2026-10-03.md).
- From the proposal's own assumptions, reducing 50–65 MB/day total growth by
  15–20 MB/day leaves approximately **30–50 MB/day** of Redis growth. The hot
  Daily trace component can flatten, while historical stubs, leaderboard rows,
  Campaign ghosts, and other records keep accumulating.
- Count the actual UTF-8 stored-source minus encoded-stub byte delta only for
  committed replacements. Label it Redis payload bytes removed; it is not exact
  allocator memory reclaimed. Sampling moved and unmoved days separately helps,
  but partially moved days also need representation in the estimate.
- At 15,000 rows/day, 40 days means about 600,000 rows and 1,200 nominal
  500-row pages. One page per five-minute invocation takes approximately
  **100 hours**. Finishing in six hours requires about 8,333 rows and 167 serial
  50-row replacement groups per invocation. Within hours is possible only if
  measured hosted throughput supports it; it is not established by blob RPS.
- Sixty blob requests/day describes a clean steady-state put/get path with
  30 files. Backfill, retries, restore, orphan reconciliation and request-scoped
  client setup add work. The 12–21 MB/day forecast also needs measured gzip sizes.
- With a 10 GB capacity and 12–21 MB/day, gross capacity lasts roughly
  **1.3–2.3 years before existing backlog and redundant objects**. These are
  scenario calculations, not a verified operational lifetime.

## Validation

`npm run typecheck` passed. Existing focused tests passed **179/179 across nine
suites**: `server-pb-ghost`, `server-daily-guest-merge`,
`server-daily-guest-cleanup`, `server-guest-transfer-recovery`,
`server-daily-podium-replay`, `server-daily-podium-service`,
`server-storage-usage`, `server-raced-list-fill`, and `server-redis-lock`.
The Vitest global setup regenerated the existing car asset module; final
working-tree inspection showed no new tracked source diff from that operation.

These validate the current contracts, not an archive implementation. Full suite,
build, hosted blob access/quota, live Redis savings, and backfill throughput were
not measured. No temporary migration tests or application edits were made.

## Review 2 — revised proposal

Reviewed the replacement pasted proposal on October 6, 2026. Its distinguishing
changes are one object per ghost, one-minute scheduling, standings-revision
checks, atomic replacement/progress totals, and blob reclamation. This remains
an application read-only review; only this document was updated.

### Correct changes

- The PB-only revision increment proposed for `boardMergeWrite` closes the
  original move-pass omission. Entry writes already increment the revision
  (`src/server/competition/competition-leaderboard.ts:277-285`), and both
  historical guest cleanup paths delete PBs and increment it in the same
  transaction (`src/server/daily/daily-gp-store.ts:1543-1546`,
  `src/server/daily/daily-guest-cleanup.ts:78-81`). PB-only copying currently
  lacks the increment (`src/server/guest-transfer/board-merge.ts:99-104`), so
  stage 3 is necessary. Its proposed three-command PB-only / five-command
  maximum is correct.
- Keep `passRevision` fixed for the entire resumed pass and save that validated
  value as `doneRevision`. The hourly check detects a later transfer even if it
  lands between the final comparison and the completion-state commit. Fence
  pass start, page saves, reopening, and completion-state writes with job lock
  ownership as well as fencing replacement slices.
- Restore now includes partly migrated days. Atomic stub/count/page commits
  fix the previous lost-count interruption. Ready-day selection and the
  persistent day limit address the earlier scheduling and rollout gaps.
- Per-record objects based on exact JSON text make retries of the same source
  field and payload deterministic and allow individual reclamation. A copied
  account stub may keep the guest object's key; it need not rename that object.
- The six-hour boundary and absence of a race-time blob read remain supported
  by the current contracts.

### Remaining issues

#### 1. P1: sweep reference discovery can delete a live ghost

The retention section builds a set of referenced keys, then deletes objects
absent from it. It does not require a revision-stable reference scan before
deletion. The move-pass revision check does not automatically protect this
separate scan.

The original adversarial transfer applies to stubs too: while the sweep scans,
a transfer copies an unvisited guest stub to an account field in an already
visited bucket, then deletes the guest. HSCAN can omit both fields. An object
older than one day now appears unreferenced even though the account points to
it. DeleteObject destroys that ghost's only stored trace. The age grace does
not protect an old object whose ownership changed recently.

Require a complete, revision-stable reference scan before producing deletion
candidates, and define how that evidence remains valid across sweep resumptions
and later archive writes. Keep pointer publication and deletion coordinated;
the archive job lock alone does not serialize guest transfers. Never delete
from a partial, failed, or invalidated reference scan. Saving `sweptRevision`
after deleting does not repair an unsafe deletion.

Add an adversarial sweep test with the unvisited guest / already visited
account interleaving and an object older than the grace period. Its outcome
must be an intact object and a restorable account ghost. Also cover interruption
during reference collection and mutation before deletion begins.

#### 2. P1/P2: per-call timeouts do not bound a 25-ghost slice

With four workers, 25 ghosts require seven waves. Each ghost can take five
seconds for PUT and five seconds for GET. A slice can therefore take about
70 seconds before its single replacement transaction. Even 25 failed upload
timeouts alone can take about 35 seconds. This exceeds the documented
[30-second endpoint limit](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview)
and the proposed 55-second lock lease. If the deadline is checked only between
slices, the unchanged first slice can repeatedly fail to reach its commit.

Use one absolute job deadline, checked inside the pool before starting every
record/operation. Bound each call by the remaining deadline, including response
body consumption, SDK retries, and client setup, and reserve time for Redis
validation/commit/checkpoint. Commit only completed work; leave names that have
not been attempted in the saved page. Test slow success and repeated timeouts
near the deadline, proving progress without dropping unattempted names.

The saved page currently includes only names whose scan-returned values have a
full ghost. Filtering a large HSCAN response still decodes the whole response
before the slice budget applies. Persist returned names and filter/validate in
bounded slices, with explicit record/inflate byte limits. The current HSCAN API
returns values too; saving names does not make the initial Redis read names-only.

#### 3. P2: sweep pagination and continuation are unspecified

[ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
returns at most 1,000 objects per response. A 15,000-object day needs at least
15 listing pages, plus the Redis reference scan and any individual deletions.
The blob adapter must expose key, size, modification time, truncation state,
and continuation token.

Persist bounded reference-scan/list/delete progress. Simply restarting the
entire sweep after every request-budget interruption can keep revisiting the
same prefix and never reach later pages. Mark `sweptRevision` only after the
complete, safely validated sweep finishes. Schedule deferred candidates again
when the grace period expires; an unchanged day revision must not hide them
forever. Test more than 1,000 objects, interruption beyond the first page,
deferred young objects, and failed deletes.

#### 4. P2: cumulative counters do not establish current blob usage

Atomic moved counts are an improvement, but the proposed totals increment
`blobBytes` only when Redis becomes a stub. A successful upload followed by a
failed EXEC occupies blob storage without entering that count. Conversely,
restore leaves objects in place, a later move can reuse the same object, and
sweep deletes objects without any specified deleted-byte adjustment. Row
copies can share one object. The proposed values therefore cannot directly
support exact current runs/bytes in blob storage.

Label cumulative activity counters as such. If the moderator line promises
current storage, maintain/reconcile unique object bytes and current references,
including orphan uploads and deletions, or publish a timestamped complete
listing measurement. Keep an existing snapshot until its replacement scan is
complete. Add upload-before-failed-commit, restore/re-move, shared-reference,
and delete-counter interruption tests.

#### 5. P2: restore-to-move has no state transition

Restore introduces `restored`, while move selection accepts only new, working,
waiting, and changed done days. Switching back to move therefore ignores the
restored day even though its full ghosts are back in Redis. With the limit of
one, that stored state also prevents admitting another day.

Requeue restored days when move resumes, or define a safe explicit reset
procedure. Cover the development rollout's move → restore → move sequence.
Retain archive keys in state as needed for reconciliation; do not erase the
only evidence for cleanup merely to bypass the day limit.

### Revised throughput and capacity claims

The object-per-ghost change raises the normal PUT/GET requirement to two blob
calls per moved row. The claimed 40 one-minute runs for 15,000 rows means
375 rows, or 750 blob calls, per invocation. With a 20-second work window that
requires **37.5 requests/second before Redis and other overhead**, which conflicts
with the claimed 20-request/second peak.

At a real cap of 20 requests/second and 20 seconds of work per minute, the
theoretical minimum is 200 ghosts per invocation: **75 minutes per 15,000-row
day**, and **50 hours for 40 such days**, before overhead, failures, or sweeps.
Even the proposal's claimed 40 minutes per day implies 26 hours 40 minutes for
40 days. A faster backfill needs a different measured budget/rate; the current
numbers do not support completion within hours.

Four concurrent operations are a concurrency limit, not a requests-per-second
limit. Enforce a rate limit if claiming a 20-RPS peak. Likewise, a few hundred
sweep requests is conditional: removing thousands of guest/orphan objects costs
thousands of individual deletes. These remain well within a potentially useful
architecture, but need a hosted throughput benchmark.

The earlier capacity qualification still applies: only the inline Daily trace
working set flattens. With the reported figures, total Redis growth remains
approximately 30–50 MB/day. The moderator Ghost replays family includes Campaign
PBs (`src/server/moderator/storage-usage.ts:461-485`), so its total cannot be
attributed wholly to expired Daily traces. The reported 10 GB grant is the
planning quota; retention sweep savings and object sizes are unmeasured.

### Validation for Review 2

Re-ran four existing suites: `server-daily-guest-merge`,
`server-daily-guest-cleanup`, `server-guest-transfer-recovery`, and
`server-redis-lock`: **63/63 passed**. The previous nine-suite 179/179 and
typecheck result above belong to Review 1; application source has not changed
between these reviews. No tests were edited and no archive implementation,
live blob operation, deletion, or hosted benchmark was performed.

## Review 3 — held lists and revision-stable sweeps

Reviewed the third pasted proposal on October 6, 2026. The application and
configuration remain unchanged. This document records design findings; it is
not an implementation or deployment approval.

### Addressed findings

The absolute blob deadline, per-record start/GET cutoffs, saved unstarted names,
and rate bucket address the previous seven-wave timeout design. The mode table
now includes restore → move, and the moderator separates moved/freed activity
from measured blob inventory. A revision-stable reference scan addresses the
previous transfer-between-reference-pages sweep omission, under the required
writer assumptions. No extra race-time blob reader or new progress store is
needed.

Holding blocked rows separately is reasonable: the chooser writes a guest
pending marker with no expiry (`src/server/daily/daily-gp-store.ts:2109`), so a
day-wide retry rule could keep rewalking the same day indefinitely. The wording
that it marks before reading anything is too broad: chooser evidence reads
happen at `:2093-2097`. The important frozen transfer capture remains after the
protected marker write (`:2412-2414`, then `:2442-2446`).

### 1. P1: existing cleanup can invalidate the sweep's deletion proof

The proposal assumes that a key absent from a consistent reference snapshot
cannot be referenced later except by the archive worker. There is a specific
exception in the current cleanup/transfer interleaving.

`cleanupExpiredDailyGuest` checks the pending marker once, before discovery
(`src/server/daily/daily-guest-cleanup.ts:62-64`). Each deletion transaction
watches only the guest expiry index and raced list (`:36-51`), without watching
or rechecking the pending marker. Transfer prepares its PB payload before its
account mutation (`src/server/daily/daily-gp-store.ts:1444-1469,1478-1505`);
the transaction runner fences coordinator/domain locks, rather than watching
this PB source hash (`:2220-2233`).

A reachable sequence for an expired guest is:

1. Cleanup passes its initial pending-marker check and pauses.
2. Sign-in marks the guest, captures and validates its archived stub, and
   prepares the cached account-copy payload.
3. The already-started cleanup deletes the guest field and increments revision.
   Its watched expiry/raced keys have not changed, so the marker does not abort it.
4. Sweep begins after that deletion and collects a stable R0/R1 reference set
   containing neither the guest nor the account's not-yet-written stub.
5. Transfer writes its cached stub to the account. Even with the proposed
   PB-only revision bump, that write occurs after snapshot validation.
6. Sweep deletes the old object it judged unreferenced. The account's stub now
   points to missing trace data.

This is an existing cleanup fencing gap that the proposed destructive blob
operation turns into a trace-loss path. The archive job lock does not serialize
cleanup or transfer. A later epoch rescan cannot recover a deleted object.

Add the guest pending-marker key to WATCH in **every** `writeWhileExpired`
transaction, and reread/check it through the base client after WATCH and before
MULTI, alongside the expiry score. A new marker must invalidate EXEC; a marker
already present must stop the transaction. This includes the final raced-list
cleanup. That small change makes the claimed transfer-source lifetime real and
supports the reference-snapshot safety argument without a new reference-count
architecture. Add it to the proposal's affected files and acceptance tests.

A temporary test outside the repository reproduced the underlying current-code
gap: setting and touching the pending marker immediately before cleanup EXEC
still returned one cleaned guest and removed its PB field, with the marker
remaining set. This tested actual cleanup plus `RedisTestDouble`, not a hosted
installation or an implemented blob sweep. The reproduction passed and its
temporary test/config files were removed.

Required regression: pause cleanup after preflight, then mark and capture the
transfer source; cleanup must not delete it. Also drive the cached copy / sweep
sequence above and prove the account ghost remains restorable.

### 2. P2: held work must follow the current mode

The held-list rule drops rows that are already stubs and otherwise moves full
ghosts. That is move behavior. Restore sends marked stubs to the same list.

A concrete failure is: move holds an inline guest row because its owner is
marked; restore restores the other rows and the day reaches restored because
it now contains no stubs; the marker later clears. The held processor then
archives that inline row while the application is still in restore mode.
The mode table skips restored days in restore mode, leaving a new stub behind.
Conversely, a held stub awaiting restore is dropped by the rule for already-stub
rows instead of restored.

Use the current mode to determine the desired representation: move processes
full ghosts and drops already-stub work; restore processes stubs and drops
already-inline work. Off mode must perform no blob/Redis migration. Mode changes
must not leave old held entries executing the previous direction. Test marker
release after move → restore and after the day becomes restored, plus release
of a stub held by restore.

### 3. P2: reference collection and partial sweep pages still need continuation

The sweep now persists the S3 continuation token but HSCANs the **whole day anew
in every request** before listing. A 15,000-row day takes roughly 75 sequential
scan calls at nominal COUNT 200, plus decoding. If that cannot fit within the
request budget, every invocation restarts reference collection and never lists
or reclaims anything. This is conditional on measured scan latency, but the
design currently has no bounded path for a larger or slower day.

Persist reference-scan cursor and collected keys, and accept the set only after
an unchanged revision over its complete construction. Permit no deletion from
an incomplete set. When construction spans requests, also invalidate it on
archive-owned pointer changes, or pause that day's held move/restore work while
constructing it: those writes do not increment the standings revision.

For listing/deletion, state needs the unfinished page/index and cumulative
retained object/byte totals, not only `{ token, revision, deleted }`. Advance
the listing token only after its page's work is accounted for; on token-rejection
restart, reset inventory accumulators to prevent double counting. Count
retained bytes after successful deletions and keep the prior completed `blob`
measurement visible until replacement measurement completes.

[AWS ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
limits each response to 1,000 objects. Process partial pages within the shared
deadline. Tests must include a slow reference scan spanning requests, a partial
1,000-object deletion page, token rejection after earlier pages, and a row
changing representation while reference construction is paused.

### 4. P2: held uploads can make a resumed inventory measurement incomplete

Held work precedes sweeps. Between two listing requests it can create an object
whose key sorts before the saved token. Continuing that token omits the new
object, yet the final `{ objects, bytes, measuredAt }` would look like a newly
completed measurement. Standing revision does not change for the archive's
own held-row conversion.

Invalidate/restart the day inventory when archive work creates an object,
including confirmed orphan uploads, or define a separate bounded inventory
generation/frozen measurement period. External guest-copy/deletion changes
also need reconciliation for any measurement presented as current. A fresh
reference set before each request protects deletes under the corrected source
lifetime assumption, but does not make the concatenated S3 listing a complete
current inventory. Test a newly uploaded key behind the token.

### Scheduling and estimates

Ready move work has strict priority over held retries, hourly revision checks,
and sweeps. During catch-up it can consume every request's dispatch window and
delay those hourly tasks for hours. Reserve bounded maintenance time when due,
or state explicitly that maintenance may wait for catch-up; do not promise
hourly service without scheduling it.

The new forecasts are scenarios to measure, which is appropriate. Their upper
throughput still uses twenty seconds even though new ghosts stop starting at
`D - 8 s = T + 14 s`. At the assumed fast 100–200 ms calls, tails finish soon
after that cutoff. A sustained 40-call/second budget with two calls per ghost
therefore supports roughly 280 starts plus limited burst/in-flight allowance,
before Redis and slice overhead. Keep 400 per invocation as an unproven target,
or change the admission policy and benchmark it.

The supplied 408,000 combined rows minus 250,000–300,000 Campaign rows leaves
108,000–158,000 **total Daily rows**, before removing active days, existing
ghost-null records, or held records. An upper backlog of 200,000 full ghosts
does not follow from those inputs. The dashboard's Daily rows can also be
scaled estimates (`src/server/moderator/storage-usage.ts:449-478`). Count
eligible Daily full ghosts for the canary; none of these hosted figures was
independently verified in this review. The earlier overall Redis-growth and
capacity qualifications remain applicable.

### Validation for Review 3

Re-ran the same four existing cleanup/merge/recovery/lock suites: **63/63 passed**.
The temporary cleanup-race reproduction also passed. These confirm the current
baseline and the cleanup gap; they do not verify an archive implementation. No permanent
tests, application source, configuration, dependency, or hosted data changed.
Only this review document was updated.

## Review 4 — cleanup fence and resumable sweep

Reviewed the fourth pasted proposal on October 6, 2026. Input:
`/Users/bpopa/.codex/attachments/538a7e15-b907-421c-99ba-61e2cf68639d/Pasted text.txt`.
Application source and configuration remain unchanged. Line references to the
proposal below refer to this attachment.

### Addressed findings and verdict

The proposed stage 3 now WATCHes the guest pending marker and rereads it through
the base client after WATCH in every cleanup deletion transaction, including
the final raced-list removal (proposal lines 213–216). This closes Review 3's
cached-stub path: a transfer that marks and captures its source prevents cleanup
from deleting that source before the sweep snapshot. Current cleanup still has
the gap at `src/server/daily/daily-guest-cleanup.ts:36-64`; this is a proposed
fix, not a completed fix.

The PB-only revision bump closes the remaining source-writer scan gap; copying
only a PB currently writes the PB and raced-list entry without incrementing the
revision (`src/server/guest-transfer/board-merge.ts:99-103`). Mode-aware held
work now restores rather than creates stubs in restore mode. Saved reference
scan state, a complete unchanged-revision snapshot, upload suspension on the
same day, and listing progress address the earlier sweep continuation and
inventory omissions. The throughput claim is now explicitly a ceiling to
measure with the canary.

No additional P1 trace-deletion path was found under these revised normal-move
assumptions. The three P2 cases below should be added before implementation;
they need small state-transition changes, not another storage architecture.

### 1. P2: cancel the saved sweep when changing modes

Switching mode clears only the pending page (proposal lines 195–196). It does
not explicitly clear the day's sweep or saved reference hash. Sweeps run only
in move mode (line 152), while held processing excludes a day with a running
sweep (line 126).

A done day with a partial refs/list sweep switches to restore and becomes
restoring. A marked stub goes to the held list. Its marker later clears, but
the held handler still excludes the day because its saved sweep remains. That
sweep cannot finish in restore mode, and restore requires an empty held list
(lines 190–192). Restoration therefore cannot complete under the stated rules.

Cancel the sweep state, its listing positions/accumulators, and its saved refs
atomically when changing direction or starting a fresh pass. Returning to move
must build a fresh reference snapshot and inventory. Keep the last completed
blob measurement as the dated measurement until another sweep replaces it.
Off mode may suspend work, but it must not permit an obsolete sweep to resume
after a representation-changing pass.

Required tests: switch to restore during both refs and list phases; release a
held stub's marker and prove it restores; then return to move and prove a new
sweep starts with new refs rather than old continuation state.

### 2. P2: drop already-complete held rows before the marker check

The held handler first keeps every marked owner (proposal line 128), and only
then applies its mode rules for missing/full/stub rows (lines 131–134).

A full ghost held during move already has the desired representation after a
switch to restore. If its chooser marker never expires, this first check keeps
its held entry forever, even with no stubs left on the day. The held-empty rule
then prevents the day from reaching restored. A permanent marker is supported
by the current chooser's plain SET without expiry
(`src/server/daily/daily-gp-store.ts:2108-2109`).

After rereading the row, first remove held work whose row is missing or already
has the current mode's desired representation. Check owner markers only for a
row that actually needs conversion. Removing this queue entry does not modify
the owner's PB; conversion must retain its marker/source/lock fencing.

Required test: move holds a full ghost with a permanent chooser marker; switch
to restore; the row remains full and unchanged, its held entry clears, and the
day can reach restored. Also cover missing rows and move-held stubs.

### 3. P2: revisit unreferenced objects kept only by the age grace

The sweep retains an unreferenced object if its LastModified is within one
hour of startedAt, then clears sweepNeeded on completion (proposal lines
161–165). Future sweeps run only for never-swept days or sweepNeeded days
(line 152). There is no due time for the young unreferenced objects.

For example, an upload succeeds, but before the Redis commit the owner becomes
marked. The worker leaves the PB full and records held work. A sweep soon
afterward finds no reference to the uploaded object but keeps it because it is
young. If the marker never clears and the revision remains unchanged, nothing
sets sweepNeeded again. The orphan remains indefinitely, contrary to the
retention rule for uploads whose commit did not succeed.

Persist a due retry for objects retained solely by age, such as nextSweepAt
after their LastModified plus one hour, with allowance for timestamp precision.
A due retry builds a fresh reference snapshot; it does not reuse the earlier
set. Clear this retry only when no such deferred orphans remain. Ensure any
new orphan upload after a completed sweep also makes a sweep due.

Required test: an unreferenced young object survives the first sweep; advance
the fake clock beyond the grace period with no revision change and a permanent
held marker; another sweep runs and deletes it while preserving live objects.

### Listing, scheduling, and estimates

The partial-page strategy is reasonable with ordered S3 listings and frozen
uploads. When deletions change a refetched page's tail, nextToken must come
from that **refetched response**, paired with its progress checkpoint. Do not
reuse the earlier response's end token after processing newly exposed tail
keys. Include deletions before a partial-page restart in the count test. This
is an implementation detail to make explicit, rather than a new design blocker.
[AWS ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
documents lexicographic ordering for general-purpose buckets and continuation
tokens. Reddit's [Blob Storage documentation](https://developers.reddit.com/docs/0.13/capabilities/server/blob-storage)
describes its installation namespace in an S3 bucket and supports that API.
The hosted dev trial should verify ordering and continuation with deletions.

Three earlier qualifications still apply:

- Strict ready-pass priority can postpone the described hourly maintenance
  during catch-up. Reserve bounded service when maintenance is due, or state
  that it runs hourly only when move backlog permits.
- The supplied 408,000 combined rows minus 250,000–300,000 Campaign rows yields
  108,000–158,000 total Daily rows, before excluding active days and ghost-null
  rows. A 200,000 eligible-ghost upper estimate does not follow from those
  inputs. Current Daily dashboard figures are sampled/scaled
  (`src/server/moderator/storage-usage.ts:449-478`); these hosted inputs remain
  user-reported, not measured by this review.
- Only the hot inline Daily trace working set levels off. Historical stubs,
  standings, and other Redis data continue to grow. The plan's reported
  50–65 MB/day growth minus 15–20 MB/day savings leaves about 30–50 MB/day,
  before any other interventions. This migration buys capacity; it does not
  flatten total Redis usage.

### Validation for Review 4

Re-ran the four existing cleanup/merge/recovery/lock suites: **63/63 passed**.
The baseline confirms current application behavior, not the proposed fixes or
an archive implementation. No tests were edited. No dependency, application,
configuration, or hosted data changes were made. Only this review document was
updated, with unrelated WIP preserved.

## Review 5 — lifecycle corrections and implementation readiness

Reviewed the fifth pasted proposal on October 7, 2026 against `codex/fixes`.
Input:
`/Users/bpopa/.codex/attachments/1734d396-0166-472f-8944-a2b95a504878/Pasted text.txt`.
Application source, configuration, dependencies, and relevant tests are
unchanged. This remains a read-only application review.

### Verdict

The proposal is ready for implementation. All three Review 4 P2 findings are
addressed, including their regression scenarios. No further concrete
transfer/cleanup, restore, retention, or request-runtime design blocker was
found. The remaining work is to implement and prove the specified contracts,
not to add another storage architecture or require another planning revision.

### Closed findings

- **Mode changes cancel saved sweeps.** `lastMode`/`modeSerial` invalidate an
  older sweep when its day is next touched (proposal lines 100–102). Starting
  any fresh pass or applying an epoch change also cancels sweep state, refs,
  and listing position in one transaction (lines 176–179). The dated blob
  measurement survives. Mode-transition tests cover both refs and list phases
  and returning to move with a fresh snapshot.
- **Held rows already in the desired form clear before marker checks.** The
  handler drops missing rows and stubs/full records already suitable for the
  current mode without changing the PB (lines 148–152). A permanent chooser
  marker therefore no longer blocks a fully restored day. A still-marked stub
  legitimately remains restoring until it can be changed safely.
- **Young orphans get another sweep.** Retaining an unreferenced young object
  records `youngOrphanUntil`; completion schedules `nextSweepAt` after that
  grace plus five minutes, and the due sweep builds fresh refs (lines 188–196).
  The day is also marked `sweepNeeded` before any held upload (lines 173–175),
  so a successful upload followed by a failed Redis commit remains discoverable.
  Tests cover elapsed grace without revision changes and a permanent marker.

The side findings are addressed too: refetched pages checkpoint their own
response's next token; due upkeep receives reserved time during catch-up;
the sampled backlog arithmetic is corrected; and Redis growth is described as
continuing after the hot trace working set levels off. The moderator labels
`freed` as committed payload removed rather than allocator memory. Actual
throughput and storage capacity remain measurements for the canary.

### Additional checks introduced by this revision

Moving attempted upload failures into durable held work lets a pass finish
without repeatedly processing one failing row. Unstarted rows remain in the
saved page (proposal lines 127–129). Starting every pass sets `sweepNeeded`,
ensuring a reopened historical day is measured and swept again.

Reference collection now stops before any deletion if an archived reference
cannot be read (lines 182–184). Implement that check against decoded raw rows,
before a parser could discard the reference. The current parser reconstructs
known fields (`src/server/competition/pb-ghost-store.ts:66-108`), while transfer
copies the decoded raw payload (`src/server/daily/daily-gp-store.ts:1478-1494`).
Stage 5's reference preservation and raw-row sweep validation are consistent
with those existing contracts. Normal ghost-null records without an archive
reference must remain distinguishable from damaged archived rows.

During implementation, keep these details in the regression coverage:

- Check phase/request deadlines again after rate-limit waits and before
  dispatching more blob work. Reserved upkeep time must allow move work to
  start within the shared request budget.
- Advance or rotate bounded held-list traversal so permanently marked rows
  cannot repeatedly consume the same first 25 slots and hide later work.
- Fence saved cursor, mode/sweep cancellation, and progress mutations with the
  job lock, using the same ownership rules as replacement commits. Saved
  progress must not be overwritten by a worker after it loses its lease.

These are implementation and test details within the existing design, not
new blockers or an additional revision request.

The existing cleanup fence, PB-only revision bump, and parser changes remain
prerequisites before enabling move. They are explicitly present in stages
3–5. Current application code has not yet gained those fixes; deploy-off first,
dev move/sweep/restore/move validation, and the one-day live canary remain the
appropriate rollout sequence. Reddit's [Blob Storage documentation](https://developers.reddit.com/docs/0.13/capabilities/server/blob-storage)
and [AWS ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)
were checked again for the adapter and ordered continuation assumptions. No
hosted blob access or deletion was performed.

### Validation for Review 5

Re-ran `server-daily-guest-merge`, `server-daily-guest-cleanup`,
`server-guest-transfer-recovery`, and `server-redis-lock`: **63/63 passed**.
These validate the current baseline, not the unimplemented archive or its
proposed fixes. No tests were edited; typecheck/build/full-suite results were
not refreshed for this documentation-only review. Only this review document
was updated, and unrelated WIP was preserved.
