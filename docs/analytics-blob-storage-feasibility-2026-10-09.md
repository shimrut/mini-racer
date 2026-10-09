# Analytics in Devvit Blob — feasibility, 2026-10-09

Read-only feasibility assessment following the Campaign ghost plan discussion.
Inspected current branch `feat/campaign-ghost-blob-move`, HEAD
`879a8c3a036d1758efe7c139323f5e7b02d71ba4`, including existing unrelated WIP.
That checkout has changed since the earlier ghost plan review: last-raced
recording and backfill now exist. No application changes, deployment, hosted
reads/writes or tests were performed. This document is the only file added by
this assessment.

## Assessment

Closed historical analytics are suitable for compressed Blob archives and
server-side retrieval. Moving all analytics to Blob is a larger redesign:
current event collection depends on atomic hash increments, identity membership
and individual player lookups. Retain the current active Redis contract and
archive historical payloads first.

The smallest useful approach keeps compact report totals in Redis while moving
older day/month membership lists to Blob. The ready main-dashboard path already
builds days, months and cohorts from one summary hash
(`analytics-store.ts:934–946,978–996`), so archiving consumed raw lists need not
add Blob latency to normal reports. A historical-detail/recovery reader can
fetch the selected archived chunks on demand. If report rollups themselves are
later moved, update the report reader to combine selected archived periods with
live data; avoid loading the entire archive on every refresh.

## Data classification

| Family | Recommendation | Reason |
| --- | --- | --- |
| Current UTC day/month player and mode membership | Keep in Redis | Every event uses HSETNX to prevent duplicate player counts. |
| Small daily/monthly summary and live counters | Keep in Redis initially | Existing dashboard already reads these; moving them alone targets relatively compact data. |
| Closed older daily/monthly player and mode membership | Archive after consumers finish | Likely useful storage candidates; preserve raw history in verified compressed objects. Actual savings are unmeasured. |
| First-seen and cohort-start player ledgers | Keep in Redis | Returning-player classification and cohort counting require per-player state; old anchors still prevent reclassification as new. |
| Last-raced index | Keep in Redis | Campaign archive selection needs current individual-player activity. |
| Challenge Today membership/counters | Snapshot closed days before expiry if history is wanted | Current daily retention is only two days; this mainly adds history. |
| Challenge lifetime viewer membership | Keep exact membership in Redis initially | A future view of an old post still needs lifetime deduplication. |
| Challenge lifetime counters | Keep live counters in Redis | Older posts can continue receiving events. |
| Legacy challenge sources and migration receipts | Explicit cutover required | A complete mapping marker does not stop legacy delta/viewer reconciliation. |

Source: `analytics-store.ts:298–312,383–445,506–513`,
`challenge-analytics-store.ts:25–26,78–79,122–138,209–224`, and
`challenge-analytics-migration.ts:174–187`.

Main analytics daily membership retains 365 days, monthly membership 400 days,
and the report exposes 13 months. Scope-wide ledgers refresh a 400-day hash TTL
as new events arrive; it is not per-player expiry. These are distinct from the
50-year Daily race-board archive contract (`daily-gp-model.ts:19–24`). Do not
confuse race records with analytics retention.

## Safe archival and retrieval

1. Choose a recent-data window, for example 30 or 60 days, as a separate analytics
   policy. Archive only settled periods after all dependent consumers finish.
2. Preserve completed report snapshots alongside the selected original raw
   membership data. Monthly unique players and lifetime unique viewers cannot
   be obtained by summing daily unique counts. Arbitrary-range distinct reports
   require membership unions or an explicit different metric definition.
3. Write versioned, bounded compressed chunks; GET, decompress and verify before
   deleting Redis source data. Keep a small Redis manifest of period, keys,
   checksum, version and completeness. Bound scans and commits by deadlines,
   persist cursors, fence stale workers, and reject deletion when the source
   changed or a late writer is still allowed.
4. Preserve existing moderator authorization. Blob retrieval stays on the server
   and uses the installation's namespace. Expose selected archived periods only
   through authorized report/detail endpoints, with bounded fetching/cache.
5. On failed retrieval, show history as unavailable or partial, never as a zero
   result. Readers do not need to rehydrate Redis merely to display old data.

Readiness dependencies are concrete. `last-raced-fill.ts:105–121` scans the daily
player hashes directly and has no Blob fallback; deleting them before its ready
record could silently omit players. Historical summary migration and cohort
backfill also need those hashes (`analytics-store.ts:781–790,828–840`). Gate
archival on those consumers completing or teach them to read the archive. Cohort
fill ends at its cutover (`:854–861`); do not require filled-through to advance
over every later live day, since it intentionally will not. Preserve cohort
anchors even after D30 is mature: deleting an anchor changes future HSETNX
behavior. Existing cohort count/reconciliation findings are documented in
`analytics-cohort-fix-implementation-review-2026-10-07.md`; archival must retain
the evidence needed for repair rather than imply snapshots are automatically
complete because a calendar window elapsed.

The challenge page currently supports Today/Lifetime, not date-range history.
New historical challenge queries need an endpoint/UI addition. Legacy migration
source removal needs a corresponding writer cutover and reconciliation policy.

## Scope, sizing and documentation

This is more involved than automatic starts for the Campaign ghost worker,
because analytics sources are shared mutable counting state with dependent
backfills. A narrow archive of consumed historical lists is materially simpler
than replacing live counters and exact distinct membership.

The Storage card combines analytics families and samples/scales their sizes
(`storage-usage.ts:532–549`, plus challenge families). No eligible-byte count or
hosted savings estimate was collected. Measure old day/month lists separately
from live ledgers and lifetime viewer sets before choosing archive priority.

Used the official Reddit `devvit-docs` skill and matching Devvit 0.14 docs at
`reddit/devvit-docs@7557a3b3ca9faf9c63c7e0b264b8ad1460b3511a`. Relevant files:

- `capabilities/server/blob-storage.mdx`, “When to use blob storage,” lines 23–28,
  recommends infrequently accessed archives; lines 43–56 list object commands.
- The same file, lines 17 and 30–35, defines installation-private storage and
  published 100 requests/s, 30 MB/request and 50 GB quotas. Honor the reported
  installation-specific 10 GB grant when planning shared ghost/analytics usage;
  its entitlement was not independently verified.
- `capabilities/server/redis.mdx`, “Shared state,” lines 83–94, covers concurrent
  requests and atomic dependent state; “Scheduled maintenance,” lines 157–168,
  recommends bounded, resumable migrations.

No live event-log store or SQL-style Blob querying was assumed. Current source
stores counters and identity membership, so an archive preserves that existing
information; it cannot manufacture a detailed event history that was never kept.
