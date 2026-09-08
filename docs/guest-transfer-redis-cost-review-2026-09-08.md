# Guest transfer Redis cost review — 2026-09-08

Reviewed the uncommitted `guest-transfer-redis-cost` working tree. This report records findings; it does not implement fixes or approve deployment.

## Recommendation

The two originally reproduced regressions below have been addressed and re-reviewed. Keep the shared Daily raw-row cleanup behavior. Defer concurrent Daily discard until hosted latency and transaction concurrency have been checked. See the follow-up validation and remaining edge case below.

## Original reproduced findings — addressed by follow-up

1. **Campaign discard skips leftover data.** Its new stage sweep uses parsed leaderboard entries and compatible PB records, without checking ranking membership. An incompatible PB and ranking member can remain while discard deletes the guest progress key and expiry-ledger membership. Previously Campaign discard unconditionally removed all three stage records. This is a new Campaign regression, separate from the pre-existing Daily parsed-PB limitation. Determine stage eligibility from raw entry/PB existence and ranking membership, retaining the owned per-stage transaction. Test incompatible PB-only, malformed entry-only, and rank-only states.
2. **Renewal can falsely lose ownership while the lock group grows.** Campaign starts its lease during acquisition and appends locks to the same array. `renewRedisLockGroup` uses that live array across WATCH, ownership reads, and EXPIRE. If another lock is appended while the read is pending, the comparison can inspect a token the read never requested and return false despite valid ownership. Snapshot the group once per operation and use the same snapshot throughout WATCH, ownership verification, and mutation. Cover an acquisition completing during the ownership read.

## Measurements and claim limits

- The current checked-in-test fixture, run against the working tree with `REPORT_TRANSFER_COST=1`, reports **320 calls, 270 sequential steps, and a largest MULTI-through-EXEC window of 19**, rather than the quoted 327/277/19. The before figures were not independently recreated in this review. Record identical fixtures and revisions before publishing a percentage reduction.
- These are immediate-response mock measurements, not hosted timings. Timer-driven renewals, error/release fallback paths, and authentication plus post-selection bootstrap are outside the normal-path cost fixture. The step counter groups overlapping calls; it is not a production latency measurement.
- The group release preserves compare-and-delete ownership checks. Its fallback permits eight individual transactions concurrently. The existing hosted integrity report records transaction concurrency-limit failures during Campaign lock release, so additional Daily concurrency needs bounded execution and hosted validation.
- The shared conflict matcher and owned-transaction commit helper improve transfer conflict handling. The statement that conflicts become 503 everywhere is too broad: other raw EXEC paths remain, including empty-guest retirement and Campaign expiry cleanup.
- The ordinary Account discard has short stage transactions, but this does not establish a 19-call maximum for every transfer mode. Guest-choice Campaign cleanup still queues all stages in one transaction.

## Validation

All 75 tests passed across `server-guest-progress-selection`, `server-redis-lock`, `server-daily-guest-merge`, `server-campaign-store`, and `server-car-unlock-store`. Campaign tests emitted contained analytics mock warnings about missing `hIncrBy`.

Two additional temporary diagnostic tests reproduced the findings above against the current modules. They assert the observed faulty behavior, not successful fixes. They are outside the repository at `/tmp/guest-transfer-review.test.js`, using `/tmp/guest-transfer-review.config.mjs`.

No production code, existing tests, or unrelated working-tree changes were edited during this review. No commit, merge, push, or deployment was performed.

## Follow-up verification

- Stable snapshots are now taken by group begin, renewal, release, and the ownership helper. The same snapshot is used across awaited operations. The new growth regression exercises the one-lock GET path; the implementation also snapshots multi-key MGET operations correctly.
- Campaign stage eligibility now uses `competitionHoldsPlayerRows` to inspect raw entry/PB values and ranking membership. The regression covers rank-only, malformed entry, and stale-fingerprint PB stages. The shared Daily probe also uses this helper; keeping that extension is consistent with discarding all of the selected guest's rows.
- One narrow edge remains: the helper uses `Boolean(rawEntry)` and `Boolean(rawPb)`, so existing empty-string hash fields still count as absent. The installed Redis SDK preserves empty strings from HGET. A null/undefined presence check would satisfy the literal raw-existence contract; empty-string-only records should be covered if this edge is addressed. No normal save writer creating these empty-string rows was established in this review.
- The focused 77 tests pass. The full suite independently passes **219 files / 2,699 tests** with loopback access; the sandbox-only run had 25 route-test failures caused by `listen EPERM`. `npm run build` also passes.
- The working-tree cost test reports **343 calls / 270 steps / maximum window 19**. Its call count increased by 23, matching the added membership read for 16 Campaign stages and 7 Daily days. It invokes `selectGuestProgress`, not the entire HTTP endpoint. The quoted **350 / 277 whole-POST** figure was not independently established by that test; authentication and the subsequent bootstrap require separate endpoint measurement.
- These checks establish local correctness and mock operation counts, not hosted completion time. The earlier limitations on Guest-choice transaction size and blanket 503 coverage still apply.

This follow-up changed only this review document. Production implementation and existing tests remain untouched by the reviewer.
