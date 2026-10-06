# Mobile backend hosting and storage costs

Prices checked: 2026-10-04. Currency: USD/month, before tax.

Scope: standalone Android/iOS Mini Racer backend. This is a researched recommendation and cost model, not a deployment or measured capacity forecast. No application code or infrastructure was changed.

## Recommendation

The user subsequently reported that ghosts account for approximately 75% of current storage. With that split, Workers + D1 + R2 is the preferred low-cost starting option, subject to replay-runtime and persistence validation. Keeping Redis-compatible records with a Node service and R2 ghosts is the alternative requiring less persistence rewriting. For an expected 25-50 GB of relational records and indexes specifically, managed PostgreSQL avoids partitioning around Cloudflare D1's per-database limit. A concrete PostgreSQL configuration remains Render for the Node.js/TypeScript API, Supabase PostgreSQL for records, and R2 for ghosts.

The earlier Redis proposal in [the port investigation](./android-ios-port-investigation-2026-10-04.md) minimizes changes to the current storage implementation. Either SQL option requires deliberate backend storage work: existing Redis WATCH/locks, guest-transfer receipts, ranked updates, and PB ownership guarantees must become equivalent SQL transactions/constraints. This is additional implementation scope, not a package-import replacement. Total retained game data and relational database size are separate quantities; 50 GB dominated by ghost objects is not a reason by itself to reject D1.

Start without an additional Redis cache. Add caching or ranking acceleration only if measured query performance requires it. SQL ranking must use appropriate race/player indexes and bounded queries; storing a leaderboard in PostgreSQL alone does not prove acceptable response time under load.

Ghosts can be uploaded under immutable/versioned object keys, with a committed database row referencing the accepted version. Upload before committing that reference; failed/uncommitted uploads need cleanup. Keep the current principle that a score can be accepted while an unavailable ghost is honestly reported and recovered. PostgreSQL and R2 do not share one transaction.

## Input size and measurement boundary

The user reports approximately 0.8-0.9 GB and approximately 200,000 stored player records. These are sizing inputs, not newly measured production facts. Stored players do not establish daily activity, authenticated monthly active users, submission count, or network traffic.

The user reports approximately 75% of this storage is ghosts. Offloading those objects leaves approximately 0.20-0.225 GB of non-ghost records and approximately 0.60-0.675 GB of ghosts at today's reported size. Non-ghost data includes more than player rows. New object references, database/index overhead and changed compression will alter the physical footprint.

If the size comes from Mini Racer moderator analytics, `src/server/moderator/storage-usage.ts:47-56` samples and scales several families. It measures estimated key/value/field bytes rather than Redis allocator RAM. The PostgreSQL representation, indexes, WAL and free space will have a different footprint. Do not treat 0.9 GB of that estimate as precisely 0.9 GB of purchased Redis RAM or PostgreSQL disk.

### Projection using the reported 75/25 split

The following is a separate scenario from the earlier all-SQL/all-ghost tables. It holds the current split constant and assumes those logical record bytes map directly to D1 billing size. It includes the Workers paid minimum, D1 storage overage and R2 storage overage only. It excludes activity overages and additional indexes/metadata. R2 fractional GB-months round up to a whole billing unit.

| Total retained data | Non-ghost records | R2 ghosts | CF subscription plus storage/month |
| --- | ---: | ---: | ---: |
| Current 0.8-0.9 GB | 0.20-0.225 GB | 0.60-0.675 GB | $5.00 |
| 5 GB | 1.25 GB | 3.75 GB | $5.00 |
| 10 GB | 2.50 GB | 7.50 GB | $5.00 |
| 25 GB | 6.25 GB | 18.75 GB | approximately $6.07 |
| 50 GB | 12.50 GB | 37.50 GB | approximately $11.05 |

At 50 GB total, the 12.5 GB record share needs at least two D1 databases. At a constant 25% record share, one database reaches its 10 GB cap at approximately 40 GB total, before additional SQL overhead. Plan partitioning earlier rather than treating all future 50 GB as R2 objects. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 billing and rounding](https://developers.cloudflare.com/r2/pricing/).

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

### Redis-compatible provider shortlist with ghosts removed

Render Key Value uses Valkey, with conventional Redis-compatible TCP operations. At the reported current record size, a 1 GB service is a reasonable initial candidate at $20/month; the smaller 256 MB service leaves too little room for overhead and growth. A $25/month 1-CPU Node API makes the illustrative current baseline $45/month plus activity/optional services. Actual Redis memory and replay workload must be measured. [Render pricing](https://render.com/pricing), [October 1 price change](https://render.com/blog/lower-prices-for-key-value-services).

Using the constant 75/25 split, conservative candidate tiers are below. API compute is held at $25 solely to show the storage change; this is not a validated capacity forecast. R2 charges use whole GB-month billing units.

| Total retained data | Record share | Candidate Valkey RAM | Valkey/month | API + Valkey + ghost storage/month |
| --- | ---: | ---: | ---: | ---: |
| Current 0.8-0.9 GB | 0.20-0.225 GB | 1 GB | $20 | $45.00 |
| 5 GB | 1.25 GB | 3 GB | $60 | $85.00 |
| 10 GB | 2.50 GB | 5 GB | $100 | $125.00 |
| 25 GB | 6.25 GB | 10 GB | $200 | approximately $225.14 |
| 50 GB | 12.50 GB | 20 GB | $350 | approximately $375.42 |

Render paid Journal + Snapshot persistence can lose up to the last second of writes. This must be weighed against the product's saved-progress requirements; selecting a provider is not proof of its recovery behavior. [Render persistence](https://render.com/docs/key-value#data-persistence).

Redis Cloud is another managed shortlist candidate, particularly when persistence, backups and HA are wanted. Pricing depends on region, capacity, replication and RAM/SSD configuration; the advertised $5 entry price is not a quote for this game's required capacity. Use its calculator for a configuration with sufficient usable dataset headroom. [Redis Cloud pricing](https://redis.io/pricing/), [database sizing](https://redis.io/docs/latest/operate/rc/databases/configuration/sizing/).

Upstash PAYG is attractive on cost at a small record footprint: $2/million commands plus replicated storage charges. Its HTTP-friendly API does not preserve WATCH-based logic, and its documented eventual/connection-causal consistency needs verification for authoritative saves. It is not the least-work conventional Redis port merely because it implements sorted sets. See the compatibility discussion above.

DigitalOcean managed Valkey and AWS ElastiCache are further options, with configuration-specific costs and transaction restrictions. DigitalOcean currently does not support managed backup/restore or AOF for Valkey; that makes it less attractive as the sole persistent player store. Redis Cluster/serverless variants can restrict multi-key transactions by hash slot. [DigitalOcean Valkey limits](https://docs.digitalocean.com/products/databases/valkey/details/limits/), [AWS serverless WATCH](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ServerlessWatch.html).

For a self-managed option, a DigitalOcean Basic VM can run Node and ordinary Redis/Valkey together. Current regular VM hardware prices are $12/month for 2 GiB, $24 for 4 GiB, $48 for 8 GiB and $96 for 16 GiB. These are hardware prices, not tested capacity commitments. Weekly VM backups add 20%; database persistence, off-server backups, restore checks, upgrades and availability remain our responsibility. A VM image backup alone should not be treated as a validated database recovery plan. [VM pricing](https://www.digitalocean.com/pricing/droplets), [backup pricing](https://www.digitalocean.com/pricing/backups).

Additional candidates checked 2026-10-06 (official pages were unreachable from the research environment; figures come from search summaries and need confirming before purchase):

- Hetzner CX23 (2 vCPU, 4 GB, EU): approximately €5.49/month after the April and June 2026 increases. Cheapest self-managed host for Node and Redis together. CX plans are in EU data centres; US players would see slower result confirmation and standings, not slower driving. [Price change report](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do).
- Aiven for Valkey: Hobbyist approximately $19/month (1 CPU, 1 GB, remote backups, no region choice); Startup from approximately $60/month. [Pricing](https://aiven.io/pricing/valkey).
- Redis Cloud Essentials: 1 GB approximately $20/month with backups and HA on paid tiers. Its 1 GB tier lists approximately 2,000 ops/sec, which may be tight at the traffic modelled below. [Plan details](https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/).
- Railway: no managed tier; self-run Redis billed at approximately $10/GB RAM and $20/vCPU per month on a $5 Hobby plan. [Pricing](https://railway.com/pricing).

## Activity costs that storage does not predict

Supabase Auth includes 100,000 monthly active users on Pro; additional MAUs cost $0.00325 each. Two hundred thousand accumulated player records do not incur that charge. Two hundred thousand MAUs using the paid auth product would add $325/month, before compute/traffic changes. This applies when using the metered auth service, not merely because the game has player rows. Anonymous auth sign-ins can also contribute to active-user counts. [Auth pricing](https://supabase.com/pricing).

Replay validation CPU depends on submissions and the simulation workload, not retained database size. The current server simulates submitted input tapes and creates verified ghosts (`src/server/competition/replay-validator.ts:187-305`). The chosen API size needs a representative replay benchmark and concurrent-request test before a throughput commitment.

Supabase includes 250 GB uncached egress, with additional usage at $0.09/GB; cached egress has a separate allowance and rate. API-host egress is a separate bill. R2 reduces the cost of delivering retained ghost files, but it does not make database or API traffic free. See the respective provider pricing pages for allowances.

A reasonable planning starting point is approximately $55/month for the Small-DB/1-CPU configuration, plus actual traffic/auth/object usage. A Medium-DB/2-CPU configuration is approximately $160/month plus disk and usage. Neither number is a forecast inferred from 200,000 records.

## All-Cloudflare backend

Yes: the standalone application's backend can use Cloudflare alone. The proposed minimum is:

- Workers for the public API, authenticated sessions, and replay validation using the existing shared simulation.
- D1 for player profiles/progress, authoritative race definitions, accepted ranked results, and ghost references.
- R2 Standard for immutable verified ghost/replay objects and other large files.
- Cron Triggers for Daily scheduling; static assets/Pages for web surfaces where needed. The native apps can continue to bundle their gameplay assets.

Start without KV or Durable Objects on the authoritative save path. D1 atomic batches, conditional updates, unique constraints and idempotency records must replace the existing Redis fences. A read in one request followed by an unconditional write in another is insufficient. D1 and R2 still do not share a transaction. Add Durable Objects only if a measured coordination requirement warrants them. [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/).

D1's paid limit is 10 GB per database and cannot be increased; the account permits 1 TB total by default. Each primary database executes queries serially, so indexed queries and realistic concurrent-load checks matter. If the future 25-50 GB is predominantly R2 ghosts, the 10 GB SQL limit need not be a problem. If it is relational data, partitioning across databases requires deliberate ranking and cross-player consistency design. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The Workers Paid $5/month minimum includes 10 million requests and 30 million CPU milliseconds per month. Excess requests are $0.30/million and excess CPU $0.02/million milliseconds. D1 includes 5 GB storage, 25 billion rows read and 50 million rows written per month; excess storage is $0.75/GB-month, reads $0.001/million and writes $1/million. Index maintenance also counts towards written rows. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Assuming the relational database stays within the unused 5 GB allowance and Worker/D1/R2 activity stays within the included allowances, the following models the paid subscription plus separately retained ghost objects. It is a base charge, not an activity forecast:

| R2 ghost storage | Workers subscription + D1 within 5 GB + R2 storage |
| --- | ---: |
| 5 GB | $5.00/month |
| 10 GB | $5.00/month |
| 25 GB | approximately $5.23/month |
| 50 GB | $5.60/month |

If all the specified storage is instead relational data, subscription plus D1 storage would be:

| Total D1 data and indexes | Workers subscription + D1 storage | Capacity consequence |
| --- | ---: | --- |
| 5 GB | $5.00/month | One database |
| 10 GB | $8.75/month | At the single-database cap; plan headroom earlier |
| 25 GB | $20.00/month | At least three databases |
| 50 GB | $38.75/month | At least five databases; more for headroom |

Formula: `5 + max(totalD1GB - 5, 0) * 0.75`. The allowance is account-wide, not 5 GB free for every database. The multi-database figures price storage only and do not solve the partitioning work.

Replay validation is a bounded JavaScript simulation (`src/server/competition/replay-validator.ts:187-305`), so Workers is a plausible runtime. Paid HTTP Workers allow up to five minutes of CPU per invocation (30 seconds by default), with 128 MB per isolate. Compatibility, memory and Cloudflare CPU usage have not been benchmarked. For illustration only, one million validations taking 100 ms CPU each would consume 100 million CPU milliseconds and add $1.40 above the 30-million allowance, before other API work. At one second CPU each, the same count adds $19.40. These are hypothetical inputs, not measured validation timings. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

If the verifier needs a full Node/Linux runtime or more memory, Cloudflare Containers can keep execution within the same provider, with separate usage costs; they are a fallback rather than part of the $5 configuration. [Containers overview](https://developers.cloudflare.com/containers/).

Workers/D1 do not introduce Supabase's per-MAU authentication charge. However, replacing trusted Reddit identity with native guest/account sessions, account linking and recovery still requires implementation. Buying database storage alone does not provide a finished authentication system. No identity design or migration has been implemented.

## Google/Firebase and Apple cloud options

Firebase plus Google Cloud Run is a real cross-platform alternative: Firebase Auth for identity, Firestore for records, Cloud Storage for ghosts, and a Node container on Cloud Run for the existing verifier. Firestore changes the persistence/ranking implementation; it is not Redis or relational SQL. Cloud Run can alternatively use a conventional Redis provider to preserve more current code. Firebase clients support Apple and Android. [Firebase Storage](https://firebase.google.com/docs/storage), [Firestore leaderboard examples](https://firebase.google.com/codelabs/build-leaderboards-with-firestore).

Cloud Run request-based pricing has a free allowance equivalent to 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds monthly at the reference region's rates. Actual costs depend on region, memory, concurrency, traffic and minimum-instance policy. Firestore includes 1 GiB of data, 50,000 reads/day and 20,000 writes/day on its eligible free database. Its bill includes queries/index reads, storage and network traffic. Firebase Cloud Storage now requires Blaze billing even where no-cost quotas apply. This is a pay-as-you-go alternative, not a fixed-price capacity quote. [Cloud Run pricing](https://cloud.google.com/run/pricing), [Firestore billing](https://firebase.google.com/docs/firestore/pricing), [Storage billing requirement](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).

Apple iCloud/GameKit saves and Google Play Games Saved Games are useful for personal progress/settings/PB backups. Private Apple saves depend on the player's iCloud account/storage; Google Saved Games data is free but each file is limited to 3 MB. They do not run this game's JavaScript replay validator or automatically provide one unified iOS/Android ranking. Optional platform leaderboards can display already validated scores while the game's shared backend remains authoritative. [Apple game saves](https://developer.apple.com/documentation/gamekit/saving-the-player-s-game-data-to-an-icloud-account), [Google Saved Games](https://developer.android.com/games/pgs/savedgames).

CloudKit is broader than personal iCloud saves: it supports shared public records/assets and web APIs. An Android app can integrate through a web/API path, so it is inaccurate to say CloudKit is inaccessible outside Apple devices. Private-user access requires Apple's account authentication; server-to-server keys operate on the public database. A CloudKit-based shared backend would still need separately hosted validation and a ranking/identity design. It is not the preferred foundation for this game's common Android/iOS backend. [CloudKit overview](https://developer.apple.com/icloud/cloudkit/), [CloudKit web-service authentication](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html).

## Sizing at reported traffic (2026-10-06)

User-reported inputs: approximately 15,000 DAU, 80,000 MAU and 260,000 stored players on the Reddit version. These players stay on Devvit; a standalone mobile backend starts with zero users, so the figures below describe a mobile audience that reaches today's Reddit size. Storage scaled from the earlier 0.8-0.9 GB report is approximately 1.0-1.1 GB, of which approximately 0.25-0.3 GB is non-ghost records.

Replay validation CPU was benchmarked locally (Node 22, `validateDailyGpReplayDetailed` on six built-in tracks, synthetic steering, 30 runs each). Finished one-lap replays took approximately 10-22 ms; finished three-lap replays 39-47 ms. Replays that used the full frame budget without finishing took up to 43 ms for one lap and 141 ms for three laps. Worker CPU speed was not measured.

Assumptions: 10-20 submitted finishes and 40-80 API requests per DAU per day (4.5-9 million validations and 18-36 million requests per month), 30-60 ms average validation CPU, and 2 ms CPU for other requests. These are planning inputs, not measured traffic.

| Option | Approximate monthly cost at this traffic | Rewrite needed |
| --- | ---: | --- |
| Workers + D1 + R2 | $10-90 (Workers $10-25; D1 writes/rank reads $0-55; R2 ghost writes $0-9) | Redis locks, transactions and ranked boards move to SQL |
| Node service + managed Valkey + R2 ghosts (Render) | $70-115 (two 1-CPU or one 2-CPU API $50-85, 1 GB Valkey $20, R2 $0-9) | Swap Devvit Redis client for a standard Redis client |
| Single self-managed VM (Node + Redis) + R2 ghosts | $30-60 plus backup/ops work | Same as above |

Server code is approximately 26,000 lines of TypeScript; 45 files call Redis, including 11 `watch` and 10 `multi` sites. The SQL rewrite is estimated at 2-4 additional weeks of manual work on top of the 2-5 week independent backend; with AI-assisted implementation the coding time is much shorter, leaving real-device and hosted-load testing as the main schedule cost. The lasting cost is maintenance: the Reddit version stays on Devvit Redis (42 server imports of `@devvit/redis`, 33 test files using fake Redis), so a D1 backend means two storage layers for every future data change. A Redis-backed mobile server can reuse the same server code and tests through a client adapter.

Redis is not the main cost in the Node route: with ghosts in R2, about 0.3 GB of records fits the $20 1 GB tier, roughly $0.00025 per MAU. API compute is the larger share. Redis cost grows with stored data because it is held in RAM, so keeping ghosts out of Redis is what keeps it cheap. Pay-per-command Redis (Upstash PAYG, $2/million) is likely more expensive at this traffic, because each request makes several Redis calls. At launch, with no mobile players yet, a $12-24 VM can run Node and Redis together, or Workers can start at $5.

Authentication at 80,000 MAU: verifying Sign in with Apple and Google tokens on our own server has no per-user fee. Supabase Auth Pro includes 100,000 MAU.

## Validation and next measurements

The [latency investigation](./mobile-backend-latency-investigation-2026-10-04.md) traces the current finish/standings paths and explains the Cloudflare query, placement, rank, replica-consistency and ghost-cache tradeoffs. No current-versus-Cloudflare response-time measurements are available; storage prices are not a latency forecast.

Checked current primary provider docs, existing Redis transaction/compression paths, the replay validator, and the moderator size estimator. A separate read-only review checked managed Redis pricing and compatibility. Verified table arithmetic programmatically. No application tests were added or changed because this update contains research documentation only.

To tighten the monthly forecast, obtain daily active players, monthly authenticated players, race submissions/day, average replay-validation CPU, leaderboard/API requests, ghost download volume, and the current storage-family breakdown. Then benchmark the two proposed compute configurations using representative player/race data and the actual save/retry/transfer interleavings.
