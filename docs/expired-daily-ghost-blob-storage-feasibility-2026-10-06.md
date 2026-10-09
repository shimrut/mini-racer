# Expired Daily ghost archives in Devvit Blob Storage

Investigated October 6, 2026 against local branch
`codex/campaign-completed-poster`. This is a feasibility plan; no application,
dependency, configuration, or hosted storage changes were made. Existing unrelated
working-tree changes were preserved. Assumption: the newly granted access is for
Reddit's Devvit Blob Storage for `mini-racer`; hosted access was not tested.

## Recommendation

Keep the seven playable Daily days in Redis. At least 24 hours after a challenge's
`availableUntil`, move its large ghost traces to compressed, immutable blob
objects and keep each player's small PB metadata and blob reference in the
existing Redis PB hash. Keep leaderboard entries, rankings, challenge history,
and raced lists in Redis. Campaign storage remains outside this initial scope.

This reduces historical Redis payload without rebuilding standings or guest
progress transactions. Saving only the podium's top three ghosts would discard
other players' saved ghosts and is a different retention policy.

The user clarified that transfer may happen on day 8, 9, or 10 after the track
leaves Daily on day 7. Use the timestamp rule
`archiveEligibleAt = Date.parse(challenge.availableUntil) + 24 hours` to avoid
inclusive day-number ambiguity. For example, expiry at October 13, 00:00 UTC
means eligibility at October 14, 00:00 UTC. A bounded scheduled worker may start
then and continue on subsequent runs/days. Day 10 is not a deletion deadline:
unfinished or failed records stay in Redis and remain eligible for retry.

The extra day puts normal archival beyond the six-hour podium publication
window and short in-flight Daily request overlap. There is no need to make blob
storage part of active Daily submissions or coordinate archive execution with
the midnight closure. Guest ownership changes and cleanup can occur much later,
so the transfer/deletion fences and verified handoff below still apply. Waiting
one day reduces timing risk; it does not remove the durability work or by itself
materially reduce the implementation estimate.

## Current behavior and affected paths

- A Daily is playable for seven days, but its data retention deadline is fifty
  years from its start, not seven days. See `daily-gp-model.ts:22-26,205-225`.
  Expired here means unavailable for Daily play, not already deleted from Redis.
- `competition/pb-ghost-store.ts:23-37,60-62,213-276,378-388` stores compressed
  JSON PB records in `dailygp:challenge-pbs:<challengeId>`, keyed by hashed player
  identity. The record bundles best time, splits, race compatibility, and trace.
- Own Daily PB requests are playable-only
  (`player/player-account-store.ts:351-363`), as are opponent races
  (`daily/daily-gp-store.ts:2829-2834`). Archived ghosts need no new public
  history screen for this migration.
- At closure, podium creation reads the top three PB ghosts through the shared
  store (`daily/daily-gp-store.ts:1211-1239`). Publication allows six hours of
  retries after expiry (`podium/daily-podium-service.ts:39-61`). The resulting
  replay is embedded in the Reddit post (`:187-206`); existing published podium
  replays are not dependent on later Redis retention.
- Head to Head posts also freeze their opponent ghost. An expired Daily origin
  cannot receive a new Daily PB from Head to Head
  (`head-to-head/head-to-head-runtime.ts:209-216`). Expiry does not, however,
  make every stored PB row immutable.
- Guest transfer can move historical Daily PBs, and cleanup can delete them.
  Transfer reads/classifies PBs directly, copies their stored values, and compares
  frozen source evidence (`daily/daily-gp-store.ts:327-351,1358-1394,1465-1497`).
  Transfer cleanup deletes the guest PB field (`:1545`); inactive-guest cleanup
  also deletes it (`daily/daily-guest-cleanup.ts:75-98`). These paths must support
  references without losing ghosts or invalidating a pending transfer's source
  inventory merely because its storage representation changed.
- Moderator storage currently measures Redis PB hashes as ghost storage
  (`moderator/storage-usage.ts:461-485`). After migration it must distinguish
  remaining Redis bytes from archived object counts/bytes. Its sampled estimate
  cannot establish exact reclaimed Redis memory; see
  `redis-size-drop-investigation-2026-10-03.md`.

## Platform integration

The [published Blob Storage documentation](https://developers.reddit.com/docs/0.13/capabilities/server/blob-storage)
describes private, per-installation S3 namespaces, a server client from
`@devvit/blob`, and `@aws-sdk/client-s3`. It lists 50 GB storage, 30 MB maximum
request size, and 100 requests/second. Separate installations need separate
migrations; blob objects cannot be served directly as public files.

Add a compatible blob package and S3 SDK, aligning Devvit package versions. The
checkout currently uses Devvit 0.14.7 and has no blob client dependency. The docs
explicitly advise against adding `permissions.blob: true` because it can break
remote builds. Confirm any different instructions supplied with the access grant
and the actual quota/version in a hosted smoke test. Individual `DeleteObject`
is supported; batch `DeleteObjects` is not.

## Implementation tasks

1. **Storage adapter and record format.** Add optional versioned `ghostRef`
   metadata, retaining best time, splits, updated time, fingerprint, lap count,
   and rules/simulation revisions in Redis. Store gzip bytes rather than Redis's
   gzip/base64 envelope. Use an immutable key containing challenge ID, hashed
   owner, and content digest. Existing inline records remain readable. Validate
   digest, schema, and race identity before returning an archived trace. Keep
   metadata reads separate from trace downloads; a blob outage must not erase a
   confirmed PB or become a successful "no ghost" result. Merge tie-breaking and
   readiness checks must recognize a valid reference as a saved ghost, rather
   than prefer an inline ghost solely because the referenced trace is not loaded.
2. **Resumable archive worker.** Discover expired challenges from stored history;
   scan PB rows in bounded batches with a durable cursor and progress/error
   counts. Use `availableUntil + 24 hours`, not `endsAt`, as the eligibility
   boundary. Process eligible unfinished days in bounded batches, continuing on
   later scheduled runs if needed; keep failed rows for retry. This delay also
   exceeds the six-hour podium retry window. Still wait for the reference-capable
   deployment to settle before enabling the worker.
   Add an internal scheduled route; do not expose arbitrary object access to
   client-supplied keys. Finish work before the request responds.
3. **Safe per-row handoff.** Read the source, upload, then GET/decompress/verify
   its contents. Only then replace the inline trace with its reference, under
   the existing ownership/transfer fences and a watched comparison of the
   unchanged source row. Respect pending transfers and frozen inventories.
   A PB lock alone is insufficient: also WATCH the PB hash and both guest/account
   pending-marker keys and check them after WATCH. The existing
   `redis/redis-lock.ts:101-124` helper supports watched keys and post-WATCH checks;
   the marker suffixes use the same hashed identity as the PB field
   (`player/guest-retirement.ts:8-17`). A source comparison also prevents restoring
   a PB deleted by concurrent guest cleanup. Coordinate with existing submit
   fences so a transfer cannot capture source evidence between check and commit.
   Blob upload and Redis update cannot form one transaction. If interrupted,
   the existing inline trace or a verified reference must survive; retries must
   reconcile already uploaded objects and concurrent transfer/deletion/write.
   Do not hold a large day-wide lock over uploads.
4. **Transfer and deletion behavior.** Preserve references during raw PB copying
   and classification. A guest-to-account copy may share the immutable object;
   removing the guest's field must not delete the account's ghost. Account
   replacement, inactive-guest cleanup, and archive retries need durable,
   reference-safe cleanup/reconciliation for unused objects. Complete this
   contract before enabling ongoing archival; do not assume blob TTL follows
   Redis TTL. Avoid changing trace bytes or `updatedAt` during migration.
5. **Rollout and measurement.** Ship reference-capable readers/transfer paths
   first, with archival disabled. Exercise put/get/delete in a development
   installation, then one expired day with Redis originals retained. Verify
   podium/transfer/cleanup behavior and measure compressed trace bytes versus
   retained metadata. Enable replacement gradually, then backfill older days.
   Keep rollback tooling able to restore inline records from verified blobs;
   an older app version that cannot read references is not a safe rollback once
   replacements begin.

One object per ghost avoids downloading and rewriting an entire day for a
single player's transfer or deletion. Chunking can be reconsidered only if
measured object/request overhead justifies it.

## Other archive candidates and thirty-day player inactivity

The next useful candidate is **Campaign ghost traces**, after measuring what
remains following expired-Daily archival. Thirty days without playing is a
reasonable proposed threshold for moving these traces out of Redis, provided
the player's PB metadata, medals, unlocks, progress and standing remain available.
This is optional second-phase work and is not included in the initial 3–5-day
Daily-only estimate. The threshold changes storage location, not ownership or
the existing guest retention/deletion policy.

| Data | Proposed treatment | Reason |
| --- | --- | --- |
| Expired Daily traces | Blob after expiry plus 24 hours | Fixed race closure gives a clear archive boundary |
| Campaign traces of players inactive for 30 days | Optional second phase; blob with on-demand reads and a bounded Redis cache | Bulky payload can be separated from authoritative progress |
| Profiles, settings, medals, unlocks, Campaign progress and PB metadata | Keep in Redis | Required on return and by transactional recovery; measure before assuming worthwhile savings |
| Leaderboard entries/order and aggregate standings | Keep in Redis | Other players still need standings for inactive owners |
| Guest tokens, transfer evidence/receipts, locks and indexes | Keep current authoritative storage/retention | Moving them would affect ownership, retry and recovery guarantees |
| Old analytics snapshots or operational backups | Optional blob copies if a concrete history/restore need emerges | Existing reports depend on Redis presence and summary data; snapshots do not replace those live contracts |
| Track definitions and post catalogs | Keep current serving paths initially | Active races and frozen challenges can still depend on old tracks/posts |

### Activity and playback requirements

- The current profile has `firstSeenAt`, but no durable account `lastPlayedAt`
  (`daily/daily-gp-model.ts:135-143`). PB `updatedAt` is the stored best's age,
  not the player's last attempt: an existing faster PB wins without rewriting
  its date (`competition/pb-ghost-store.ts:361-373`). Campaign progress likewise
  skips equal/slower results (`campaign/campaign-store.ts:1200-1207`). Do not
  treat an old best as proof of inactivity.
- Existing race-start/finish analytics record dated presence, but failures are
  swallowed and some finish reporting is fire-and-forget
  (`moderator/analytics-store.ts:344-375,465-502`). Reuse the authorized race
  event path to maintain a small per-owner activity index, with server time and
  bounded write frequency. Define the policy across Daily, Campaign and Head
  to Head, including starts without successful finishes. Unknown activity is
  not proof of thirty days away; observe it before automatic inactivity-based
  archival. Recording errors should preserve gameplay and conservatively defer
  archival, rather than infer an inactive player.
- An inactive owner's ghost may still be selected as an opponent by active
  players (`competition/competition-opponent-race.ts:156-178,220-228`). Resolve
  the selected ghost from blob before starting the race; keep frequently read
  ghosts cached or exempt from eviction using their access activity. Owner
  inactivity alone does not measure whether that payload is actually cold.
- Returning players should read their progress immediately and load only the
  ghost for the selected stage when needed. Do not restore all Campaign ghosts
  into Redis at login. Blob read failure must not erase progress or incorrectly
  mark a saved ghost absent. A faster accepted run can use the existing hot
  Redis write path; old blob cleanup follows the same reference-safe contract.
- Archive eligibility needs a final activity/source recheck under the existing
  ownership fences so a returning player's write cannot be overwritten. Trace
  compatibility, guest transfer and guest deletion remain required. Additional
  tests must cover return during archival, attempts without PB improvements,
  missing activity, and opponent reads of an inactive player's archived ghost.

Reddit explicitly identifies bulky or infrequently accessed replays and backups
as suitable blob uses in the documentation linked above. Whether thirty-day
Campaign archival is worth adding depends on the measured Daily/Campaign byte
split and ghost read latency; neither was measured live here. Moving all ghosts
to blob with Redis as a bounded cache is a possible later architecture if
measurements support it, but is a larger change than the expired-Daily archive.

## Validation and effort

### Review: assumptions and operational gaps

1. **Preservation is not a new history feature.** Expired Daily PB and opponent
   requests currently reject the race. Published podium/Head to Head posts
   already contain frozen traces. Archiving every old Daily ghost frees Redis
   and preserves data for potential future use, but does not itself let players
   replay historical PBs. Confirm that the current fifty-year retention policy
   is the intended long-term product promise before forecasting archive growth.
   Any reduction would be a separate explicit retention decision.
2. **Ghost demand is shared, and bulk reads amplify latency.** The next-faster
   opponent search reads PBs in windows of ten, up to six windows
   (`competition/competition-opponent-race.ts:15-16,215-230`). Resolving every
   record's reference inside a bulk metadata read could download sixty blobs
   to find one opponent. Select using Redis metadata, then fetch/validate the
   chosen trace with bounded fallback and a retryable unavailable response for
   infrastructure failure. Cache identity must include immutable ghost identity;
   deduplicate simultaneous fetches for popular opponents and bound cache size
   and lifetime. Do not refill every stage at login or repeatedly move the same
   ghost between stores solely because its owner returns.
3. **Blob capacity still fills, and jobs share throughput with players.** The
   published blob quota is finite (50 GB); a hypothetical net growth of 100 MB
   per day fills that in roughly 500 days. Measure actual compressed growth,
   guest deletion and orphan cleanup before extrapolating. Archive put/readback
   verification, player reads and individual deletions share the published
   100-request/second allowance. Leave request and Redis capacity headroom for
   racing, caches, temporary retained originals and archive retry state; measure
   hosted cold-read latency before including Campaign traces in the rollout.
   The [Devvit Web overview](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview)
   documents a 30-second endpoint limit, so historical backfill cannot be one
   unbounded request. Use small runs with checkpoints and bounded concurrency.
4. **A scan cursor alone cannot prove durable completion.** A failed, busy or
   transfer-blocked row must enter durable retry work before the scan advances.
   Transfers can introduce an inline account PB after an expired day was scanned.
   Reconcile those later writes through transfer integration and/or bounded
   periodic revisits; a day cannot be permanently ignored merely because one
   HSCAN reached cursor zero. Record backlog age, failures, bytes actually
   removed from Redis, uploaded bytes, pointer integrity and orphan counts.
   Alert on a meaningful failed/stalled archive or a growing backlog.
5. **Archived trace bytes are not a complete backup.** The proposed objects
   contain pose traces, while owner mappings, rankings, splits and race identity
   remain authoritative in Redis. A blob-only restore cannot recreate all
   progress/standings. Define a separate metadata snapshot/restore procedure if
   disaster recovery is a goal. Saved PB traces also contain poses, not the
   original steering-input tape (`competition/pb-ghost-trace.ts:18-25`): scores
   alone cannot regenerate them, and this change does not preserve every run.
   Preserve historical schema/revision identity and necessary track definitions
   for future playback; current-version compatibility rejection must not silently
   destroy the only stored historical bytes.
6. **Archive deletion and rollout need their own lifecycle.** Existing guest
   expiry/transfer cleanup cannot be treated as permission to retain an orphaned
   blob indefinitely. Delete only after all surviving account references are
   considered, and reconcile failed deletes. Do not assume S3 bucket lifecycle
   configuration, object versioning, or a prior application release provides
   recovery: the documented Devvit command set excludes bucket configuration
   and object-version listing, and older application code cannot read references.
   Start with a recoverable, measured batch and prove repair before scaling.

These are implementation/product requirements, not evidence that migration has
failed. They support keeping the first release limited to expired Daily traces,
then measuring whether inactivity-based Campaign archival is necessary.

Before implementation, validate the current PB, podium replay/publication,
historical guest merge/recovery, inactive-guest cleanup, and storage-estimator
tests. New implementation tests must cover interrupted upload/handoff, readback
mismatch, duplicate retries, changed/deleted source rows, pending transfer source
evidence, shared references after guest cleanup, absent/corrupt/unavailable blobs,
expiry boundaries, and continued readability of legacy inline records. Run
typecheck and build after adding dependencies and implementation.

This is a moderate backend change, rather than a storage setting. A rough
planning allowance is 3–5 focused development days for adapter, worker,
transfer/cleanup support, failure-path tests, and rollout tooling. Hosted access,
quota and latency checks may change that estimate. Historical backfill duration
depends on actual row counts and throughput; this investigation did not measure
the live installation or establish an exact Redis saving.

Local baseline validation: 160 tests passed across seven suites: `server-pb-ghost`,
`server-daily-podium-replay`, `server-daily-podium-service`,
`server-daily-guest-merge`, `server-daily-guest-cleanup`,
`server-guest-transfer-recovery`, and `server-storage-usage`. No tests were changed.
These validate existing behavior, not the proposed blob migration. No hosted
blob/Redis verification or migration has been performed.

After the timing clarification, the existing Daily model and podium publication
suites were rerun to verify the current expiry and six-hour retry contracts.
The proposed 24-hour archive eligibility rule remains a documented plan, not
implemented or tested behavior.
