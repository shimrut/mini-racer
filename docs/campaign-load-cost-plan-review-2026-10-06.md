# Campaign load cost plan review — 2026-10-06

Reviewed the supplied A/C/B proposal against clean HEAD `a3508696` on
`codex/campaign-completed-poster`. These optimizations are not implemented in
this checkout. Runtime code and repository tests were left unchanged; proposed
behavior was exercised only in temporary fixtures.

The [revised-plan review](#revised-plan-review) below covers the subsequent Opus
rewrite. The following original review is retained as evidence of the first
proposal and its reproduced failures.

The cost-reduction goal is valid, but the plan should not ship unchanged. A
preserves persistent repair protections but needs an error fallback and an
explicit snapshot-freshness tradeoff. B suppresses retries after incomplete
repairs. C can return inconsistent rank/count pairs and does not enforce its
claimed strict ten-second freshness limit. None of the reproductions showed
canonical Campaign progress being deleted or overwritten by the proposal.

## A: progress repair precheck

The healthy-path saving is real. Existing `mutateProgress` acquires the progress
lock, rereads progress, checks compatible stage entries and transfer state, and
releases the lock even when no write is needed
(`src/server/campaign/campaign-store.ts:428-464,666-714`). Checking
`withRecovered(progress) === progress` and the derived aggregate first can avoid
this work. Actual writes must continue to reread everything under the lock and
retain the existing transfer fences (`:402-408,447-454`).

Two equivalence claims need correction:

- **Availability:** with unchanged progress and a busy progress lock, current
  repair can return read-only evidence without reading the aggregate. The same
  is true during a pending transfer. The proposed precheck reads the aggregate
  first; an aggregate-only Redis error now rejects the request rather than
  reaching the existing busy/transfer fallback. Temporary differential tests
  reproduce both cases. Treat the precheck as best effort: if it fails, continue
  through the original path and let that path decide whether to return or fail.
- **Snapshot freshness:** injecting a concurrent start immediately after the
  initial bootstrap progress read makes current code return the new `startedAt`,
  while A returns `null`. A completed replacement transfer can likewise leave
  A returning a retired stage from its earlier snapshot. Both versions preserve
  the newer stored progress. The added stale-response window can affect visible
  Start/Continue, medals, stage access and Garage projection; it is not exact
  response equivalence (`:598-629,825-841`).

The scope also reaches Head to Head: `getCampaignProgressForSelection` determines
Campaign-origin `trackLocked` and progress PB evidence in
`src/server/head-to-head/head-to-head-runtime.ts:272-282`. Leaving its direct
standings-repair call unchanged does not leave all H2H behavior unchanged.
Sign-in selection summaries also consume this helper
(`src/server/daily/daily-gp-store.ts:1591-1599`). Consider limiting the first
precheck to bootstrap, or explicitly test and accept the snapshot tradeoff for
these other consumers. Keep both aggregate callers using `retryIfBusy: true`
on their original locked path (`campaign-store.ts:1035,1070-1072`).

The temporary baseline/A comparison passes 24 tests: unchanged progress,
faster-entry repair, missing aggregate repair, busy and transfer recovery,
strict aggregate reconciliation, SDK call counts, and the differing snapshot
and error interleavings. These are temporary proposal checks, not permanent
implementation coverage or hosted Redis evidence.

## B: daily standings-repair marker

Do not use a 24-hour marker to record only an attempted repair. The actual repair
returns `void` and can exit or skip work without throwing:

- Pending transfer before or during the sweep (`campaign-store.ts:736,753`).
- Busy stage submission lock (`:751`).
- Lost transaction ownership (`:755`).
- Interrupted EXEC or a contained write failure (`:765-769`).

With the proposed NX marker set before the sweep, all these outcomes retain the
marker and suppress the next load's repair for 24 hours. Simply clearing the
marker in an outer `catch` misses contained failures and skipped locks. Two
temporary tests against the actual repair function reproduce occupied-lock and
caught-write-failure cases: after the first problem clears, the second marked
load performs zero repairs; the current unthrottled repair restores the missing
ranking row immediately.

Keep the existing retry behavior in the first version, or make the repair
report whether its entire sweep completed successfully and retain a long-lived
marker only for that outcome. A brief in-flight claim, if needed, must remain
distinct from successful completion and preserve ownership-safe cleanup.

Even a successful-check throttle deliberately changes recovery timing for a
mismatch arising after that check. “Fixed within 24 hours” is not a guarantee:
expiry runs no repair itself; another eligible load must arrive and succeed.
Atomic entry/score writes are verified in
`src/server/competition/competition-leaderboard.ts:266-284`, but they do not
eliminate historical inconsistencies or failed repair attempts. The cited GitHub
issue #1 could not be retrieved, so its claimed provenance was not verified.

## C: shared counts, individual ranks

Counts are suitable non-personalized cache data; ranks must remain per player.
This follows the intended use of the [Devvit cache helper](https://developers.reddit.com/docs/capabilities/server/cache-helper).
The existing adapter preserves successful source results after cache-write
failure, falls back when cache access fails before invoking the source, and
preserves source failures (`src/server/redis/shared-cache.ts:25-64`).

Required qualifications and guards:

- **TTL is not a strict maximum age.** Installed `@devvit/cache` 0.14.7 retains
  values for logical expiry plus 30 seconds and can return an expired value
  when another request holds the refresh lock
  (`node_modules/@devvit/cache/PromiseCache.js:37,181-183,228-229`). A deterministic
  harness using the actual SDK returned a 39-second-old count under refresh
  contention. If ten seconds is a requirement, include a source timestamp in
  the cached value and read directly when it is too old; TTL alone is
  insufficient.
- **Rank/count consistency:** a new ranked player can receive live rank 1
  with cached count 0, or rank 2 with count 1. Bootstrap values seed the stage
  standings sheet (`game/campaign/engine-methods.js:115-147,1833-1918`), whose
  separate rank and count display can show `#1` beside `No racers yet`, or
  `#2` beside one racer (`game/race/ui-modal-shell.js:2687-2726`). Directly reread
  a stage's count when its fresh rank exceeds the cached count. Approximate
  counts can still differ from current counts even after this guard.
- Validate the cache container and every current stage's count as a numeric,
  nonnegative safe integer. Checking only integer-ness accepts negative values.
  Missing stages after Creator publication must trigger a direct read. Retain
  direct-read fallback for malformed values and cache failure.
- Keep rank requests concurrent with the shared count request. Current count
  and rank reads already run concurrently (`campaign-store.ts:648-658`), so
  count caching primarily reduces commands rather than 17 sequential waits.

Mocking `cacheSharedJson` is useful for proposed Campaign-store tests, but add
coverage for actual SDK expiry/contention behavior or the explicit timestamp
guard. The standalone adapter bypasses caching outside a Devvit request, as the
proposal correctly notes. Existing standings-page caches include board revision
in their keys (`competition-leaderboard.ts:420-429`); this count proposal instead
deliberately accepts staleness.

## Cost corrections

| Path | Verified healthy SDK requests |
| --- | ---: |
| Signed-in Numbers bootstrap fixture, current code | 98, one transaction |
| Same fixture with A | 90, zero transactions |
| Current standings-repair sweep, 17 stages | 35 |
| B skipped sweep | 1 |
| B first eligible sweep | 36 |
| Direct count read, 17 stages | 17 |
| C same-process cache hit | 0 |
| C Redis cache hit | 1 |
| C cold population | 20 |

A saves exactly eight in the tested healthy account path: acquisition, progress
reread, transfer read and five-request release. Repair-needed requests add the
preliminary stage reads before the unchanged locked rereads. B saves 34 net
commands on skipped healthy sweeps. C cold population adds three cache commands
before/after the 17 source reads. Its hit savings depend on cache/process state.
The supplied approximately 110 total is not a universal current load count.
These are local SDK request counts, not measured hosted latency; authentication,
catalog reads, promotion, cleanup, Garage migration and actual repair work vary.

Instrument the whole bootstrap HTTP request as well as store phases: the route
also refreshes stored catalog/tracks and retries pending shared-post refresh
before sending the reply (`src/server/routes/campaign-routes.ts:88-112`). A log
inside `getServerCampaignBootstrap` alone misses those costs. Preserve isolated
measurement/rollout steps, but do not deploy the proposal based only on local
call counts. Watch HTTP failures, cache errors and interrupted repair logs too;
the two proposed error substrings do not cover all failures.

## Validation and limits

- `npm run typecheck`: passed.
- Full `vitest run` with localhost access: **344 files / 4,537 tests passed,
  zero failed or skipped**. The proposal's 13-known-failures baseline is stale.
- The completed full run includes all 158 focused Campaign store, aggregate,
  sharing, route, Redis-lock and shared-cache checks.
- Initial sandboxed focused run: 147 passed / 11 route failures, all
  `listen EPERM`; these environment failures disappeared with localhost access.
- A temporary differential fixtures: 24 passed.
- B actual-repair retry fixtures: two passed, confirming the proposed regression.
- Actual SDK cache harness: verified cold/local/Redis-hit costs and returned a
  39-second-old value while another request held the refresh lock.
- No runtime edits, repository test changes, deployment or hosted-data mutation.
  Full-suite success establishes the current baseline, not the safety of an
  unimplemented proposal. Hosted timing, Redis concurrency and player/device
  behavior remain unmeasured.

Evidence: `/private/tmp/campaign-load-review-full-results.json`,
`/private/tmp/campaign-load-review-full.log`,
`/private/tmp/campaign-load-review-typecheck.log`,
`/private/tmp/campaign-load-review-focused.log`,
`/private/tmp/dailygp-A-review/`, `/private/tmp/campaign-b-review/`, and
`/private/tmp/campaign-load-review-cache.mjs` with
`/private/tmp/campaign-load-review-cache-results.json`.

## Revised plan review

The rewrite fixes the two originally identified design flaws: A can now recover
from precheck errors, and B records successful repair rather than an attempted
repair. A and B are reasonable to implement after the details below are made
explicit. C can remain deferred. The revised plan is still not a guarantee of
identical player-visible responses, and it is not implemented in the repository.

### A: fresh read and fallback are necessary, but read ordering matters

The new fresh progress GET fixes the original concurrent-start and
already-completed-replacement examples when those updates commit before that
GET. The catch restores busy/transfer availability when an aggregate-only
precheck read fails. Seven saved SDK requests is verified: the same healthy
signed-in bootstrap fixture now costs **98 → 91**, with **one → zero
transactions**.

Two small implementation requirements remain:

1. Read the compatible leaderboard entries, **then** read fresh progress, and
   evaluate both `withRecovered` and aggregate eligibility against that fresh
   progress. If progress is read before the entry scan, a replacement transfer
   completed during the scan can leave the precheck returning a retired result.
   Reading progress afterward detects that discrepancy and enters the locked
   reread. Keep `retryIfBusy: true` callers outside this precheck.
2. Keep precheck results separate from the existing fallback's `recoveredResults`,
   or clear that variable before **every** fallthrough to the original locked
   path. Catching exceptions alone is insufficient. The current busy fallback
   rereads entries only when that buffer is empty
   (`campaign-store.ts:710-711`); a populated precheck buffer silently changes
   its behavior even when the locked-path code itself is unchanged.

Temporary tests demonstrate the second issue both after a failed precheck and
after a successful precheck that decides repair is needed. A failed aggregate
probe followed by a replacement and busy lock projects a retired row unless the
buffer is reset. A newer accepted PB appearing during lock retries returns
12,345 ms from the reused buffer, versus the current 11,000 ms when the original
fallback rereads. Resetting restores the fallback's fresh evidence.

An unlocked fresh GET still does not supply lock-equivalent freshness: a save
or transfer can commit after it. Reading entries then progress reduces the
exposure; it does not serialize the response with concurrent writers. Actual
repairs still reread and fence all mutations under the original lock. The
selection/H2H consumers identified above remain within A's indirect scope.

### B: successful completion fixes retries; marker I/O must be best effort

The new ordering fixes the original suppressed-retry examples. A boolean result
must remain false after any busy stage lock, failed ownership check, interrupted
EXEC, contained write failure or early transfer return. Continue checking other
stages after a skipped stage if current code does so, but do not mark the partial
sweep complete.

Additional details to include:

- Marker GET failure must fall back to ordinary repair. Marker SET failure after
  successful repair must preserve a successful bootstrap and allow a later
  attempt. Catch only optional marker I/O; preserve existing repair-read errors
  and logging rather than masking unrelated failures.
- Bind the marker to the checked published stage list. A series-ID-only `1`
  also suppresses the first check of stages appended after that marker was
  written. Ongoing Creator series can grow
  (`series-store.ts:424-449`). A versioned stage-count stamp is sufficient for
  their immutable, append-only published prefixes; a stage-list signature is
  also valid. Compare it with the current stages before treating the marker as
  a hit. This adds no Redis command.
- If “done” requires no active transfer at the completion check, read transfer
  state again at the end of an otherwise successful sweep. Current code checks
  again only when it encounters a mismatch. A transfer starting during healthy
  entry probes otherwise goes unnoticed. This adds one read on checked loads,
  not on marker hits. It is a completion observation, not an atomic guarantee
  that no transfer can begin afterward. If this new optional final check fails,
  return incomplete without setting the marker; do not turn an otherwise
  successful bootstrap into a new error. Preserve the existing initial
  transfer-read error behavior.
- A missing entry is a normal inspected stage for a new player. Keep the
  existing repair eligibility; do not introduce new cleanup semantics for
  malformed or rank-only records during this optimization.

Concurrent sweeps are acceptable: stage mutations still use the existing
submission lock and fresh transaction-protected reread. Two successful sweeps
may both write the marker, so “one write per player per series per day” is an
approximate uncontended cost, not a strict write-count guarantee. No exclusive
24-hour checker claim is needed.

Successful throttling still delays discovery of a mismatch introduced after the
scan until a later eligible load after expiry. That is an intentional recovery
tradeoff, so C is not the only possible visible change. Keep the earlier warning
that 24-hour expiry itself runs no repair.

### C: clamping is acceptable for an explicitly approximate count

With valid counts, `Math.max(sharedCount, playerRank ?? 0)` ensures the returned
count is at least the fresh observed rank. It does not establish the exact
number of racers. Apply it only while constructing each player's response;
do not mutate the cached map or write that per-player adjustment back into the
shared cache. The actual SDK returns the same value object on local hits; a
temporary harness confirms that an in-place clamp changes later callers'
cached values.

Keep the original missing-stage/malformed-value/direct-read fallback, including
numeric nonnegative safe-integer validation. Keep ranks outside the shared
cache and concurrent with the count request. A null rank must not turn an
otherwise valid count into null or NaN.

“About 40 seconds” is a fair warning for this installed cache, not a strict
upper bound. A process that reads a nearly expired Redis envelope may reuse it
locally until `checkedAt + 1 second`
(`PromiseCache.js:130`); in-flight operations also consume time. An exact
freshness guarantee still requires a source timestamp guard. The current stage
sheet displays rank and racer count separately, rather than literal
`#341 of 340`, but the underlying contradiction is real.

### Revised costs and rollout

| Healthy signed-in Numbers fixture | SDK requests | Transactions |
| --- | ---: | ---: |
| Current code | 98 | 1 |
| Revised A | 91 | 0 |
| Revised A + B, matching marker | 57 | 0 |
| A + B + C, same-process/Redis count hit | 40 / 41 | 0 |
| A + B + C, cold count population and matching B marker | 60 | 0 |
| A + B, marker missing, successful scan plus final transfer check | 94 | 0 |

B's hot saving is **34**, not 33: the skipped current sweep costs 35 including
its initial transfer read, and the marker hit costs one GET. The revised
successful miss costs 38 for B alone: current sweep 35, final transfer check one,
marker GET one and marker SET one. Without the final check it costs 37. Repair
writes, retries and failed prechecks add work beyond these healthy cases.

Starting from the supplied approximate 110 baseline, subtracting seven and 34
gives about 69, then a Redis count hit gives about 53. Thus the rewritten
approximately 70/55 totals are plausible warm estimates, not measured totals
for every load. The 98-request fixture is the verified current local baseline.
Keep the existing whole-request timing/phase recommendation and distinguish
marker misses, hits, actual repairs and cache misses. Use the current green
suite as the rollout baseline; do not carry forward the obsolete 13 failures.

### Revised validation

- A: **64 differential assertions passed**, comparing baseline and both read
  orders with/without a reset. Passing assertions deliberately confirm the
  naïve variants' differing behavior; they do not certify those variants safe.
- B: **12 temporary tests passed.** The revised repair/wrapper verifies incomplete-work retries,
  marker read/write outages, transfer starting during healthy reads, marker
  hits, appended-stage invalidation, and two simultaneous sweeps where only the
  successful checker marks. A failure of the added final transfer check returns
  incomplete without writing a marker or propagating a new error.
- C: a real-SDK harness verifies per-response clamping preserves the shared map,
  invalid count rejection, and the observable effect of an in-place mutation.
- Runtime HEAD is unchanged. The earlier full baseline remains 344 files /
  4,537 passing tests plus passing typecheck; it was not rerun merely for this
  document update. Hosted timing, concurrency and device behavior are unverified.

Before implementation, promote the concrete A fallback/read-order, B incomplete
sweep/I/O/stage-growth/concurrent-sweep, and optional C validation/isolation
cases into permanent regressions. Keep original aggregate and H2H coverage.

Revised evidence: `/private/tmp/dailygp-A-revised-review/vitest.log`,
`/private/tmp/dailygp-A-revised-review/after-reset.ts`,
`/private/tmp/campaign-b-revised-review/test-output.log`,
`/private/tmp/campaign-b-revised-review/campaign-store-revised.ts`, and
`/private/tmp/campaign-load-review-revised-c.mjs` with
`/private/tmp/campaign-load-review-revised-c-results.json`.
