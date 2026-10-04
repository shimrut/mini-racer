# Mobile backend latency: Devvit Redis versus Cloudflare

Investigated 2026-10-04. Scope: existing Reddit-hosted Mini Racer versus a proposed Workers + D1 + R2 backend. This is code-path and platform-documentation research, not a deployed comparison. No application code or infrastructure changed.

## Expected outcome

A deliberately batched Cloudflare implementation can plausibly match or improve normal finish acknowledgements and first-page standings reads. Moving the verifier to Workers does not inherently require slower validation: it runs the same bounded JavaScript simulation. A naive Redis-to-SQL translation can regress performance, especially exact rank on large boards, remote-primary database calls, and ghost writes.

There are no measured successful submit/standings percentiles for the current hosted path in the inspected material, and there is no deployed Cloudflare game backend. Do not state a milliseconds difference or speed multiplier as a measured result. Existing mock call counts and guest-transfer timings are not score-validation latency.

Once a race is ready, driving runs on the client. Backend latency affects race preparation, accepted-result confirmation, leaderboard refreshes and selected-ghost loading, rather than steering response or the fixed-step recorded lap time. Rule/version parity still needs validation after a runtime port.

## Current critical paths

The Daily finish response includes more than replay simulation:

1. Request middleware checks stored-track catalog readiness. Warm catalog revision checks still perform Redis operations (`src/server/server-app.ts:351-365`, `src/server/tracks/stored-catalog.ts:44-66`).
2. Daily loads the authoritative contract, resolves authenticated identity and checks transfer state (`src/server/daily/daily-gp-store.ts:2869-2919`).
3. Shared submit loads the track, rate-limits and synchronously validates physics (`src/server/competition/competition-submit.ts:153-209`). The validator uses fixed timesteps and up to 2,500 frames per required lap for current rules, up to three laps; it does not wait for the real race duration (`replay-validator.ts:224-226,246-288`).
4. The submission lock, raced-board tracking, transfer checks and previous-entry reads precede writes (`competition-submit.ts:239-259,303`).
5. Board and PB/ghost persistence run concurrently, and both settle before the response continues (`competition-submit.ts:328-341`). The ghost branch has its own ownership/read/compression/transaction path.
6. Rank/count, Garage, rewards and profile work run concurrently afterward. Lock release is awaited before the successful Daily response (`daily-gp-store.ts:2933-2944`).

There is no Reddit post/comment creation in the ordinary ranked finish path. Removing social publishing is not a supported explanation for faster normal validation.

For standings, a shared revision/cache lookup precedes the source read. On a cache miss, the source reads count, ranked members, then entry/profile batches. Legacy entries lacking an opponent-ready marker need batched PB checks. The personal rank/current row and potentially a nearby page follow (`src/server/competition/competition-leaderboard.ts:193-217,391-433,449-504`). Modern marked standings rows do not require full ghost reads. Shared pages cache for ten seconds, keyed by board revision.

The client can display a previously confirmed snapshot immediately and refresh in the background. An improved submit causes a fresh standings request after acceptance. Failure retries default to 30 seconds; that is retry scheduling, not validator execution time (`game/scoreboard/verification-queue.js:9`, `game/scoreboard/engine-methods.js:320-418`).

## Cloudflare comparison

| Operation | Credible expectation | Main determinant |
| --- | --- | --- |
| Pure replay CPU | Same algorithm; actual relative CPU speed unknown | Worker runtime, track geometry, lap/frame count, concurrent work |
| Finish acknowledgement | Could match or improve with fewer persistence stages; not guaranteed | SQL batches, primary distance, R2 upload, accepted-score/ghost recovery policy |
| Top leaderboard page | Could match or improve with indexed bounded queries and caches | Query/index design, page size, profile joins, cache state |
| Exact personal rank and nearby page | Main risk of regression on large boards | Redis ranked index versus SQL counting/window scans |
| Selected ghost fetch | Cached objects can benefit from CDN proximity; first fetch can be slower | R2 location, cache miss, object size, authentication and download route |
| Players far from primary region | Replica reads can improve; writes retain primary-region round trip | Read replicas, session freshness and Worker placement |

Redis's existing `ZRANK` has logarithmic complexity. A simple SQL `COUNT` of competitors ahead of a player can walk an indexed range, so its cost grows with the board size/rank even with an index. Top-page retrieval and exact arbitrary rank are different workloads. Scope all queries to the competition; 200,000 player records do not imply 200,000 entries on every board. [Redis ZRANK](https://redis.io/docs/latest/commands/zrank/), [D1 indexes and query plans](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

D1 primary queries execute serially. Cloudflare's illustrative guidance puts simple indexed lookups below a millisecond of SQL execution and writes at several milliseconds, but these are query-level guidelines, not this game's total response time. A long rank query or large transaction can queue other primary work. Read replicas distribute read traffic; they do not distribute primary writes. [D1 throughput limits](https://developers.cloudflare.com/d1/platform/limits/).

Workers execute near the incoming request by default. That does not put the D1 primary in every region. Avoid multiple sequential cross-region database calls; use batches and benchmark placement near the backend when useful. [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/).

D1 read replication requires Sessions API usage; otherwise queries still go to the primary. Replicas are asynchronous. Carry a post-write bookmark or read the primary when the player's own accepted result must be visible immediately. An unconstrained replica read can show older data. Bookmarks preserve a lower bound on freshness; they do not promise the globally latest state from every other player. [D1 read replication and sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Keep ghost references and availability in D1, and fetch the R2 object only when its replay is needed. Standings should not fetch ten ghost files to paint ten rows. An R2 binding call is not automatically a CDN cache hit; a suitable custom-domain or Worker cache path must be implemented. Use immutable versioned keys and publish references only after upload success, preserving truthful recovery when a ghost is unavailable. R2 and D1 have no shared transaction. [R2 caching](https://developers.cloudflare.com/r2/buckets/public-buckets/), [R2 consistency and cache behavior](https://developers.cloudflare.com/r2/reference/consistency/).

Paid Workers have 128 MB per isolate and a default 30-second CPU limit, configurable up to five minutes. These are resource ceilings, not expected validation durations. They require a realistic verifier memory/CPU benchmark. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Pros, costs of the change, and validation needed

Benefits are lower bulk-storage cost, independent native API ownership, fewer platform RPC stages when using SQL effectively, optional geographically distributed reads, and CDN delivery of reusable ghost files. The existing client snapshot behavior can remain responsive independently of the network refresh.

Costs are the SQL persistence rewrite, more expensive arbitrary rank queries, centralized write contention/distance, explicit replica freshness, and cross-store ghost publication/recovery. The 10 GB per-D1-database limit eventually requires partitioning if the structured-record portion grows past that size. A cheap storage bill is not a performance guarantee.

Before claiming an improvement, compare the same representative replay inputs and board sizes on both hosted backends. Measure client request-to-response time and server components separately: authentication/contract lookup, simulation CPU, database persistence, R2 publication, rank/finish follow-ups, leaderboard source/cache reads, and selected-ghost downloads. Include cold and warm requests, near and distant regions, typical and long three-lap races, cached/uncached boards, large personal-rank lookups and concurrent submissions. Report median and 95th-percentile timing plus error/retry rates; preserve accepted-score and ghost-availability correctness.

## Evidence boundary

`docs/redis-performance-findings-validation-2026-09-08.md:17-21` establishes individual SDK plugin request semantics, not measured end-to-end latency. `docs/redis-improvements-2026-09-21.md:219-225` describes absent request/Redis percentiles. The October 3 hosted log review in `docs/mode-switch-loading-investigation-2026-10-03.md:133-146` also lacked successful bootstrap timings. The current code was rechecked for this investigation; prior counts are not assumed current after intervening optimizations.

See [hosting and storage costs](./mobile-backend-hosting-costs-2026-10-04.md) for the user-reported 75% ghost split and provider prices. Documentation checks only were run for this update; no live provider benchmark or new gameplay test was performed.
