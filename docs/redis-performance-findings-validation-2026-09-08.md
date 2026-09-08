# Redis performance findings validation — 2026-09-08

Reviewed the supplied Redis performance findings against the current working tree based on `0c81d32`, including its existing uncommitted server changes, installed `@devvit/redis` 0.14.1, system change map, and Redis integrity report. The supplied 40-player measurement harness was not attached, so its exact measurements were not reproduced.

## Overall verdict

The batching opportunities are mostly sound. Reject the proposed non-atomic lock release and removal of the expired-guest recheck. Qualify the Campaign savings, analytics retention change, secret caching, and all quoted latency figures.

## Implemented on `codex/safe-redis-optimizations`

- Preview and challenge records now use Redis SET with its `expiration` option at four write implementations. The application expiry timestamps remain unchanged, and the separate EXPIRE request is gone from those paths.
- Leaderboard PB/ghost enrichment now reads compatible records with `redisCompressed.hMGet` in concurrent batches of at most ten. The existing single-record parser and all track, simulation, rules, lap, finish-time, and checkpoint checks remain shared and unchanged in meaning. The page still performs no PB cleanup or writes.
- Tests cover exact expiry options, absence of preview-specific EXPIRE calls, two bounded PB batches for eleven players, malformed and incompatible records, and leaderboard batch integration.

## Measurement corrections

- The installed Redis client sends individual plugin requests for WATCH, MULTI, each queued command, and EXEC; there is no local transaction-command buffer that collapses these into one request. A successful WATCH/MULTI/N-command/EXEC sequence has N+3 requests, plus any base-client reads. This supports counting SDK requests, not claiming measured end-to-end network latency from an immediate-response mock.
- A successful uncontended lock acquisition and release costs **6** calls: SET, WATCH, GET, MULTI, DEL, EXEC. Release alone costs five. The pasted seven-call figure needs an explanation from its harness.
- `recordCompletedRace` costs **8** calls normally: acquisition, promotion-pointer GET, HSETNX, and five-call release. Its following snapshot read is separate. Retries and ownership loss change counts.
- Sequential Redis network waits cannot exceed the number of Redis calls. Values such as 125 calls / 147 waits and 11 calls / 15 waits must count something else, such as nested JavaScript awaits. They cannot be used as network-delay estimates.
- No evidence establishes how frequently rivals lack usable ghosts or that opponent selection is the slowest path in production. Hosted timing, payload sizes, cache state, identity, repair state, and concurrency matter. Batching and parallelism are not the only performance tools: eliminating repeated work and caching also matter.

## Findings by path

| Supplied recommendation | Verdict |
| --- | --- |
| Batch leaderboard ghost reads | Valid call reduction. `readRowsForRankedMembers` in `competition-leaderboard.ts` already runs ghost reads in `Promise.all`, so the claim that these wait one at a time is false. Use compressed multi-field reads and retain PB compatibility and complete-opponent checks. A ten-row cache miss is 18 core `readSnapshot` calls when the ranked caller is on the page, before authentication/cache-internal costs; nearby rows can add more. |
| Batch next-faster candidates in windows | Valid direction. `prepareCompetitionOpponentRace` has four setup calls and up to three per eligible inspected candidate: 124 core calls for 40 fully inspected candidates, but seven when the nearest rival is usable. The full candidate range is currently loaded before the scan. Two windows with three batches each plus unchanged setup cost ten calls; reaching eight requires additional restructuring. Preserve nearest-first order and ghost validation. |
| Combine SET and expiry | Valid at four sites: `head-to-head-service.ts` preview creation, `head-to-head-share.ts` preview storage, `daily-gp-share.ts` preview storage, and `head-to-head-store.ts` challenge storage. Preserve each deadline through SET's `expiration` option. This saves one request per write and removes the creation-without-expiry window. |
| Cache guest signing secret | Repeated GETs are real in `player-token.ts`. Default Redis is installation-scoped; a process cache must preserve that scope, initialization races, and error recovery. A warm cache can avoid reads, but cold processes cannot. Request-scoped reuse is the simpler first step; an unqualified global singleton is not established safe. |
| Batch guest/account row and PB pairs | Valid for `readDailyMergeState` in `daily-gp-store.ts`: five reads become three, including the separate rank-score check. 35 to 21 describes seven such sweeps, not total transfer work. Populated days are reread under locks and incur writes; retained transfer challenge IDs can extend beyond the current playlist. Keep compressed PB parsing and compatibility checks. |
| Reuse and parallelize Campaign stage reads | Valid opportunity, overstated outcome. Missing-progress recovery already reads up to 16 entries in parallel. Standings repair has 16 sequential stages, each with parallel entry/score probes. Rank/count display already makes 32 calls in parallel. Reusing the initial entries can remove up to 16 calls from 80 stage-related calls, before other bootstrap costs. Preserve locked fresh reads and refresh ranks affected by repairs. |
| Campaign startup falls to about 20 calls | Unsupported for the proposed design. Rank/count display alone requires 32 calls for an identified player. Repair already skips writes when the sorted-set score matches the entry time. An ordinal rank is not the score and cannot be compared to a finish time. |
| Restrict Head to Head Campaign standings repair to origin stage | Valid for the repair subroutine in `head-to-head-runtime.ts`: 32 normal probes become two. Applies to the unlocked Campaign-origin path. The preceding progress recovery establishes stage access and must remain; this is not a two-call total post load. |
| Parallelize seven track PB requests | The outer loop in `getServerPlayerTrackPbSummaries` is sequential, so this is a real opportunity. Its helper is `readOrSeedTrackPersonalBest`: missing PBs can trigger locked writes. Seven-way execution is not necessarily one network wait and must account for backfill transactions and failures. |
| Parallelize own row and page entry/name reads | Valid. Own rank, entry, and profile can be read together, but the current conditions avoid unnecessary entry/profile reads for an unranked player. Page entry and profile batches are currently sequential. |
| Skip repeated completed-race flag writes | Valid if based on the persisted `race:completed` field and reuse of the snapshot read. Preserve the promotion-safe write when missing. Cosmetic unlock evidence alone does not prove that the field is persisted. Normal removable write work is eight calls, not nine. |
| Replace lock release with GET then conditional DEL | Reject. After GET sees owner A, A's lease can expire and B can acquire the key before A's DEL. A then deletes B's lock. Short TTLs and unique tokens do not prevent this race. Keep atomic ownership validation and deletion. Existing group-release batching retains these protections. |
| Stamp eight analytics expiries only on bucket creation | Not safe as stated. `applyRetention` in `analytics-store.ts` expires six day/month keys and two scope-wide rolling ledgers (`firstSeen` and `cohortStarts`). Initial-only expiry changes retention semantics and needs recovery for interrupted expiry creation. These eight calls already run in parallel, so eight fewer calls is not eight fewer sequential waits. |
| Remove expired-guest score rereads | Reject. `cleanupExpiredCampaignGuests` performs ZRANGE before WATCH. A guest can refresh its expiry in between; WATCH does not detect changes made before it started. The post-WATCH ZSCORE prevents deletion of that refreshed guest. Parallelizing those rechecks is a separate possibility; removing them is unsafe. |
| Preserve base-client reads after WATCH, separate board/PB persistence, and conditional rate-limit expiry | Valid for these paths. Transaction reads return the transaction client and queue results; decisions use base-client reads protected by WATCH. `submitCompetitionRun` separately settles board and PB writes so a PB failure does not discard a valid board result. Conditional rate-limit expiry preserves the window and repairs a missing TTL. Reads can still be queued when only EXEC results are needed; the rule is not a universal ban on transactional reads. |

## Evidence and validation

Existing regressions directly exercise the two unsafe proposals: `tests/server-redis-lock.test.js` tests ownership changing after observation and before EXEC; `tests/server-campaign-store.test.js` tests guest expiry being refreshed after candidate discovery. Both pass with the existing protections.

Ran six focused suites: `server-redis-lock`, `server-campaign-store`, `server-daily-gp-store`, `server-analytics-store`, `server-car-unlock-store`, and `server-head-to-head`. **316 tests passed.** Negative-path logs and contained missing-analytics-mock warnings appeared; no assertions failed. These tests validate current behavior, not the proposed performance estimates.

Official [Devvit Redis documentation](https://developers.reddit.com/docs/capabilities/server/redis) lists installation scoping, 20 concurrent transaction blocks, and a five-second transaction timeout. The local integrity report also records hosted transaction concurrency failures. Parallel read work and parallel repair transactions therefore need distinct consideration.

The implementation and regression tests are on `codex/safe-redis-optimizations`. No commit, push, or deployment was performed.
