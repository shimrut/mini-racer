# Mobile backend hosting and storage costs

Prices checked: 2026-10-04. Currency: USD/month, before tax.

Scope: standalone Android/iOS Mini Racer backend. This is a researched recommendation and cost model, not a deployment or measured capacity forecast. No application code or infrastructure was changed.

## Recommendation

For a standalone product expected to retain 5-50 GB, use a Node.js/TypeScript service for the existing replay simulation, managed PostgreSQL for player profiles/progress and ranked results, and object storage for verified ghost files. A concrete managed configuration is Render for the API, Supabase PostgreSQL for records, and Cloudflare R2 Standard for ghost files.

The earlier Redis proposal in [the port investigation](./android-ios-port-investigation-2026-10-04.md) minimizes changes to the current storage implementation. PostgreSQL plus object storage is the recommended growth option after researching costs and transaction requirements. It requires deliberate backend storage work: existing Redis WATCH/locks, guest-transfer receipts, ranked updates, and PB ownership guarantees must become equivalent SQL transactions/constraints. This is additional implementation scope, not a package-import replacement.

Start without an additional Redis cache. Add caching or ranking acceleration only if measured query performance requires it. SQL ranking must use appropriate race/player indexes and bounded queries; storing a leaderboard in PostgreSQL alone does not prove acceptable response time under load.

Ghosts can be uploaded under immutable/versioned object keys, with a committed database row referencing the accepted version. Upload before committing that reference; failed/uncommitted uploads need cleanup. Keep the current principle that a score can be accepted while an unavailable ghost is honestly reported and recovered. PostgreSQL and R2 do not share one transaction.

## Input size and measurement boundary

The user reports approximately 0.8-0.9 GB and approximately 200,000 stored player records. These are sizing inputs, not newly measured production facts. Stored players do not establish daily activity, authenticated monthly active users, submission count, or network traffic.

If the size comes from Mini Racer moderator analytics, `src/server/moderator/storage-usage.ts:47-56` samples and scales several families. It measures estimated key/value/field bytes rather than Redis allocator RAM. The PostgreSQL representation, indexes, WAL and free space will have a different footprint. Do not treat 0.9 GB of that estimate as precisely 0.9 GB of purchased Redis RAM or PostgreSQL disk.

## Concrete managed baseline

Current source prices:

- Supabase Pro is $25/month, with $10/month of compute credit. Small database compute is approximately $15/month, making one Small project approximately $30/month before disk/usage overages. Medium compute is approximately $60/month, making that project approximately $75/month. [Plan pricing](https://supabase.com/pricing), [compute sizes](https://supabase.com/docs/guides/platform/compute-and-disk).
- General-purpose PostgreSQL disk includes 8 GB per primary project, then costs approximately $0.125 per provisioned GB-month. Billing uses provisioned disk, not just live table bytes. [Disk pricing](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size).
- Render's `1c-2g` Node service is $25/month; `2c-4g` is $85/month. The compute plan IDs replace the older Standard/Pro names. [Pricing](https://render.com/pricing), [plan definitions](https://render.com/docs/compute-plans).

Each row below holds compute constant to isolate storage growth. The second column models Small PostgreSQL plus a 1-CPU API. The third models Medium PostgreSQL plus a 2-CPU API. These are configurations, not validated traffic capacities. The quoted monthly compute amounts are approximate hourly-billed monthly equivalents.

| Provisioned PostgreSQL disk | Small DB + 1-CPU API | Medium DB + 2-CPU API |
| --- | ---: | ---: |
| 8 GB included; covers a 0.9 GB or 5 GB footprint if remaining space is sufficient | $55.00 | $160.00 |
| 10 GB | $55.25 | $160.25 |
| 25 GB | $57.13 | $162.13 |
| 50 GB | $60.25 | $165.25 |

Formula for the Small baseline: `25 + 15 - 10 + 25 + max(provisionedGB - 8, 0) * 0.125`.

Allow space for indexes, WAL and growth: a 50 GB live dataset needs more than a 50 GB disk. Compute upgrades depend on query/validation throughput and latency. Supabase recommends Small for databases up to 50 GB and Medium up to 100 GB, but actual workload still needs benchmarking. Paid daily database backups are included in Pro; optional point-in-time recovery and replicas cost extra.

The baseline excludes API/database bandwidth overages, ghost operation charges, authenticated-user overages, extra replicas/environments, email/SMS, optional support/workspace upgrades, taxes, and store developer accounts. It includes one API service and one database project only.

## Ghost storage

R2 Standard storage is $0.015/GB-month, with 10 GB-months free. Its monthly free tier also includes one million Class A operations and ten million Class B operations. Above that, Class A operations are $4.50/million and Class B $0.36/million; billing rounds up to the next billing unit. Internet egress from R2 is free. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

| Ghost objects stored for a full month | Storage charge only |
| --- | ---: |
| 5 GB | $0.00 |
| 10 GB | $0.00 |
| 25 GB | approximately $0.23 |
| 50 GB | $0.60 |

These are object-storage figures, separate from the PostgreSQL disk table. Do not charge the same bytes to both stores. If most growth is ghost files, the relational database can remain much smaller than the game's total retained data. The current production split has not been measured during this investigation.

For illustration, 20 million billable-category reads in a month consume the ten-million free allowance and add $3.60. A new 50 GB ghost store with reads/writes inside the unused free operation allowances adds $0.60/month. Existing usage elsewhere in the same account can consume those allowances. Serving blobs through a separately metered API would also consume that API's bandwidth; direct authorized object downloads avoid that extra hop.

## Keeping Redis instead

Upstash offers the following fixed plans, before API compute and optional regions/add-ons. The 25 GB case needs its 50 GB plan. These capacities leave no extra storage headroom at an exact tier boundary. [Official Redis pricing](https://upstash.com/pricing/redis).

| Dataset capacity | Fixed database plan |
| --- | ---: |
| Approximately 0.9 GB | $20/month for 1 GB |
| 5 GB | $100/month |
| 10 GB | $200/month |
| 25 GB | $400/month for 50 GB |
| 50 GB | $400/month |

PAYG can be much cheaper: $2/million billed commands, $0.25/GB-month after the first GB, and bandwidth beyond 200 GB/month at $0.03/GB. However, storage billing totals all replicas and regions; logical 50 GB is not necessarily billed 50 GB. Optional production HA/SLA features add $200/month. [Pricing and billing details](https://upstash.com/pricing/redis), [replication](https://upstash.com/docs/redis/features/replication).

Compatibility matters more than the sticker price here. TCP supports WATCH, while REST does not support WATCH/UNWATCH/DISCARD. Upstash documents eventual consistency and causal guarantees on one TCP connection; strong consistency is deprecated. Existing `src/server/redis/redis-lock.ts:104-123` watches transaction keys and performs guarded reads through the base client. A port must pin those reads and transaction operations appropriately and prove save/transfer concurrency. Cheap PAYG is not yet a verified replacement for the authoritative game store. [WATCH support](https://upstash.com/docs/redis/commands/transactions/watch), [REST limitations](https://upstash.com/docs/redis/features/restapi), [consistency](https://upstash.com/docs/redis/features/consistency).

Conventional managed single-primary Redis/Valkey over TCP preserves more existing semantics, but memory capacity is a meaningful cost. Service RAM is not all usable dataset capacity. A self-hosted Redis server can reduce rental cost at the expense of operating backups, recovery, upgrades and availability; this research does not include a selected self-hosted configuration.

## Activity costs that storage does not predict

Supabase Auth includes 100,000 monthly active users on Pro; additional MAUs cost $0.00325 each. Two hundred thousand accumulated player records do not incur that charge. Two hundred thousand MAUs using the paid auth product would add $325/month, before compute/traffic changes. This applies when using the metered auth service, not merely because the game has player rows. Anonymous auth sign-ins can also contribute to active-user counts. [Auth pricing](https://supabase.com/pricing).

Replay validation CPU depends on submissions and the simulation workload, not retained database size. The current server simulates submitted input tapes and creates verified ghosts (`src/server/competition/replay-validator.ts:187-305`). The chosen API size needs a representative replay benchmark and concurrent-request test before a throughput commitment.

Supabase includes 250 GB uncached egress, with additional usage at $0.09/GB; cached egress has a separate allowance and rate. API-host egress is a separate bill. R2 reduces the cost of delivering retained ghost files, but it does not make database or API traffic free. See the respective provider pricing pages for allowances.

A reasonable planning starting point is approximately $55/month for the Small-DB/1-CPU configuration, plus actual traffic/auth/object usage. A Medium-DB/2-CPU configuration is approximately $160/month plus disk and usage. Neither number is a forecast inferred from 200,000 records.

## Cloudflare database alternative

D1 is inexpensive for small SQL applications but caps each paid database at 10 GB. Reaching 25-50 GB of relational data requires a partitioning design, with consequences for global ranking and cross-player operations. For this product, managed PostgreSQL avoids introducing that design purely to save a small storage bill. R2 is still a useful Cloudflare component. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Workers is an alternative API/validator runtime with a $5/month paid base, included request/CPU allowances, and metered excess. Reusing the Node service on Render is the costed baseline because no Workers compatibility/CPU/memory benchmark was performed. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Validation and next measurements

Checked current primary provider docs, existing Redis transaction/compression paths, the replay validator, and the moderator size estimator. A separate read-only review checked managed Redis pricing and compatibility. Verified table arithmetic programmatically. No application tests were added or changed because this update contains research documentation only.

To tighten the monthly forecast, obtain daily active players, monthly authenticated players, race submissions/day, average replay-validation CPU, leaderboard/API requests, ghost download volume, and the current storage-family breakdown. Then benchmark the two proposed compute configurations using representative player/race data and the actual save/retry/transfer interleavings.
