# Analytics cohort fix — implementation review

Reviewed `dea6fa15` and `9afcbe88` on `fix/analytics-cohort-counts` against
`0e1e080c`. The ready-summary path now avoids whole cohort-start and daily
presence reads, and normal race events update the existing summary hash.
Four P2 issues remain. This review changes documentation only; application
code and repository tests remain unchanged, with unrelated WIP preserved.

Consulted `docs/system-change-map.md`, the analytics gates in
`docs/reddit-launch-checklist.md`, the cohort entries in `CHANGELOG.md`, and
`docs/redis-performance-findings-validation-2026-09-08.md`. The cohort contract
remains signed-in, analytics-observed race activity on exact UTC-day offsets;
guests stay outside cohort denominators.

## P2 — A transient Redis failure permanently loses live cohort counts

Source: `src/server/moderator/analytics-store.ts:425–440` and `380–389`.

The new summary count is separate from the successful deduplication write.
`markCohortStart` writes the account's anchor with HSETNX before incrementing
the cohort count. `markPlayerPresence` writes the daily presence before
reading the anchor and incrementing a return. If the subsequent count write
or anchor read fails, later successful starts/finishes see the existing
anchor/presence and skip the count. The backfill ends at the cutover date,
so subsequent live days are never reconciled.

Two temporary tests using the actual module and the existing Redis double
reproduce this after an already-complete cutover:

- Two new accounts race on August 15. One account's cohort HINCRBY fails
  once after its anchor succeeds. A successful finish and an August 16
  summary still report one cohort member instead of two.
- One account first races on August 15 and returns on August 16. Its anchor
  HGET fails once after daily presence succeeds. A successful finish and
  an August 17 summary still report D1 `0 / 0%` instead of `1 / 100%`.

The previous cohort reader derived these values from the retained account
anchors and daily presence, so these particular partial writes did not
permanently lose the derived cohort metric. Containing analytics failures
still correctly protects gameplay, but it no longer preserves recoverability
of the cohort result.

Fix direction: make the cohort deduplication/count update replay-safe and
atomic, or provide reconciliation of closed live days. Retrying only the
race event does not repair the current implementation.

## P2 — Cutover-day backfill can double-count an in-flight race

Source: `src/server/moderator/analytics-store.ts:850–876` and `425–429`.

On the next UTC day, backfill recounts `cohorts-live-from` and overwrites
its owned fields with absolute values. Race writers do not participate in
the fill lock or a shared transaction. A race whose daily presence is saved
before midnight can still be awaiting its summary increment when the
next-day fill counts that presence. The delayed increment then adds the
same return a second time, after the absolute backfill value was saved.

A temporary test holds the August 15 D1 HINCRBY for a single August 14 cohort
member, loads the August 16 summary, then releases the race. The backfill
first reports `1 / 100%`; the following summary reports `2 / 200%`.
The fill marker has advanced, so later reads do not correct it.

Fix direction: fence the absolute cutover recount against race writers, or
use a migration representation that merges historical and live observations
without counting an observation twice. The fill-only lock does not provide
that coordination.

## P2 — The cutover day is exposed as complete before it is counted

Source: `src/server/moderator/analytics-store.ts:848–851` and `888–900`.

The first summary read marks today as `cohorts-live-from`, fills only through
yesterday, and treats every date at or after that marker as counted. Accounts
that first raced, or returned, earlier today under the old code have presence
and anchors but no new summary cohort counts. Today therefore exposes partial
cohort sizes and false zero return rates until a next-day read recounts it.

Reproduction: one account first raced yesterday and returned today before
the upgrade; a second account first raced today before the upgrade; a third
first races today under the new code. Today's summary reports one new cohort
member instead of two, and yesterday's D1 as `0 / 0%` instead of `1 / 100%`.
The existing test at `tests/server-analytics-store.test.js:665–707` explicitly
expects the incomplete same-day cohort size, so its passing result does not
verify correctness at cutover.

Fix direction: keep the cutover day uncounted in the response until its
historical portion is reconciled safely, including milestones that return
on that date. The existing blank-milestone contract can represent pending
work without displaying a false zero.

## P2 — The 15-second fill budget does not bound a large daily scan

Source: `src/server/moderator/analytics-store.ts:821–841` and `864–876`.

The budget is checked only before an eight-day batch. Each `countCohortDay`
loops through all HSCAN pages and associated HMGET calls without checking
the budget or saving within-day progress. The checkpoint is written only
after all eight days finish. A large or slow day can therefore exceed the
advertised request budget; a request terminated before the batch checkpoint
starts that unfinished batch again on the next read.

An actual-source probe with a 120,000-member daily hash completed 24 HSCAN
pages and their HMGETs despite a fake clock already exceeding the budget.
With the probe clock advancing one second per Redis operation, it reached
56 simulated seconds before returning. This proves that the deadline is not
checked during the scan; it is not a measurement of hosted Redis latency or
a hosted request timeout. No within-day cursor is persisted.

Fix direction: bound work between scan pages and preserve replay-safe partial
progress, or move the fill to a bounded background process. The statement
in `docs/system-change-map.md` that this runs for at most 15 seconds per
request overstates the current implementation.

## Validation and limits

- `npm run typecheck`: passed.
- Existing focused tests: **89 passed** across analytics store, analytics
  routes, moderator summary, analytics UI, and storage usage. The first route
  run hit sandbox `listen EPERM` before HTTP assertions; rerunning the route
  file with loopback access passed all 34 tests.
- Three temporary Vitest correctness assertions fail as expected on current
  code: lost cohort increment, lost return after an anchor-read failure,
  and the midnight return counted twice. Repository tests were not edited.
- Separate actual-source probes confirm the partial cutover response and
  unchecked scan budget. The scan probe uses a fake clock and Redis double.
- No full-suite, production build, hosted Redis, or hosted moderator-page
  validation was performed. The review does not claim production deployment
  or observed production occurrences of these failures.

Temporary evidence:

- `/private/tmp/dailygp-cohort-review-repro.mjs`
- `/private/var/folders/jh/36_zxzws0sggn5x8t4h3bfyr0000gn/T/analytics-cohort-review-gswbx2wl/cohort-review.test.js`
- `/private/var/folders/jh/36_zxzws0sggn5x8t4h3bfyr0000gn/T/analytics-cohort-review-gswbx2wl/vitest.config.mjs`
