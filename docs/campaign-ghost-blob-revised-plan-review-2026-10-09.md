# Campaign ghost Blob plan — revised review, 2026-10-09

## Latest revision: ready for implementation

Rechecked attachment `8f07be80-83c3-4a93-801b-6568a68ed2d0/Pasted text.txt`
against unchanged HEAD `92dba52de43b9ebfea3a77f4b8e5894f94bf80cb` and matching
official Devvit 0.14 docs at the commit recorded below. No remaining blocking
design finding identified. All three final implementation requirements from the
previous re-check are now explicit in the plan: original decoded stub text,
deadline checks inside every fill, and resumable completed-only Blob measurements.
The activity-staleness wording and associated test coverage are also corrected.

The proposed WeakMap is compatible with the current required object paths:
Campaign own-PB uses the parsed object directly (`campaign-store.ts:1253–1264`);
slower shared submit returns that same existing parsed object
(`pb-ghost-store.ts:393–394`, `competition-submit.ts:370–391`); chosen opponents
and next rivals consume direct parsed returns/Map values
(`competition-opponent-race.ts:151–171,217–246`). Populate the map inside
`parseRecord` and use it before projecting/cloning response records. The Daily
endpoint similarly has the original record before building its response DTO
(`player-account-store.ts:362–378`). No current intervening clone blocks this.

One focused implementation test requirement follows from the newly explicit
deadline checks: test stopping mid-page/mid-candidate batch, not only before a
batch. Raced-list fill must retain the old page cursor if it stops before all
write groups finish (`raced-list-fill.ts:150–166`), so the next tick can replay
idempotent writes. Aggregate fill currently splices retry and candidate queues
before its candidate loop (`campaign-aggregate-store.ts:90,99–103`); preserve any
unprocessed tails when the deadline is reached, and never declare readiness
while they remain. This is part of the plan's existing checkpoint/resume
contract, not an additional design blocker or reason for another plan revision.

The new measurement contract handles continuation-token rejection and keeps the
last completed total visible until a refreshed listing completes, resolving the
earlier concern. The migration/Restore, read-only hydration, generation fencing,
activity approximation and hosted verification verdicts remain unchanged.

No application or permanent test files changed; no probes, full suite, build,
deployment or hosted checks rerun for this plan-only re-check. Existing helper
probes below remain prior evidence, not verification of the planned implementation.
Only this review document was updated.

## Optional automatic migration — feasibility

The user subsequently asked how simple it would be to automate Away 30/60.
This is an assessment, not authorization to implement or enable automation.
The approved core Campaign worker is still a plan. Once built, automation is a
small extension to its existing scheduled, bounded, generation-fenced execution;
it does not require a separate replay migration pipeline.

A suitable product behavior is Off / Automatic after 30 days / Automatic after
60 days. The existing planned scheduler tick can start a fresh pass when the
saved policy is enabled, the activity index is ready, the worker is idle and
the next pass is due. Continue active passes across ticks. After completing a
pass, record the next due day so the worker does not immediately restart scanning
every minute. This is daily eligibility checking with bounded execution, not
an exact trigger at the moment an individual player crosses the threshold.

Pause must suspend automatic starts as well as the current invocation. Restore
must suspend automation until explicitly re-enabled, so restored inactive ghosts
are not immediately archived again. Manual trials must also retain precedence.
Start decisions and due-state updates must use the existing watched generation
and ownership rules. Retain refusal reporting and avoid repeatedly restarting a
job blocked by quota/capability refusal.

The main coordination issue is the current Campaign prerequisite: Daily choice
must be Off, not just temporarily idle. Keeping that rule would leave Campaign
automation waiting whenever continuous Daily archiving is enabled. Supporting
both unattended needs explicit turn-taking or scheduled work windows, with
ownership checks and bounded work. A shared lock by itself also needs fair
scheduling so repeated Daily ticks cannot always take the turn first. This
extends the original promise that Daily behavior stays unchanged and should be
scoped as a narrow maintenance-coordination change if desired.

Add tests for one due-pass start under concurrent ticks, no immediate restart
after completion, restart recovery, disabled/Pause/Restore precedence, retries
and Daily/Campaign turn-taking. Expose enabled threshold, current status and next
pass time in the existing storage card. Relative effort is small for Campaign
automation alone; coordinating both unattended jobs is a modest additional
change. No precise time estimate was established.

Official Devvit source: matching 0.14
`capabilities/server/scheduler.mdx`, “Scheduling recurring jobs,” and
`capabilities/server/redis.mdx`, “Scheduled maintenance.” The existing app also
uses recurring maintenance routes in `devvit.json:185–196`. No runtime files,
tests, deployment, hosted data or Codex reminder/automation settings changed.

## Previous re-check: a8311c98 attachment

Rechecked attachment `a8311c98-65ab-4957-b57e-5616bead54eb/Pasted text.txt`
against the same working-tree HEAD and matching official Devvit 0.14 documentation
listed below. No new design blocker identified. The revision closes the previous
Restore/current-content, endpoint-budget and canonical-cache findings, and makes
Daily Off/drain, conflict checkpoints, automatic Restore verification, resident
Blob accounting and targeted hosted checks explicit.

Retain these three implementation requirements within the proposed design:

1. **Exact equality needs original decoded stub text.** Current PB readers return
   `parseRecord`'s reconstructed object (`pb-ghost-store.ts:87–126,230–299`). It
   changes property order, normalizes values and omits unknown fields. In
   particular, it emits `ghostArchive` before `updatedAt`, whereas
   `buildDailyGhostStub` appends the reference after existing fields. Passing
   `JSON.stringify(parsedRecord)` to the new equality check would reject healthy
   archives. Keep original decoded text in an internal PB read result/accessor
   for the integrity helper; preserve the public normalized record contract.
   Restore also needs the verified original full copy text in its internal result.
2. **Enforce the shared deadline inside existing fills.** The new plan already
   passes the absolute deadline down. Implement checks between raced-list pages
   and write groups, aggregate series and candidates, and new backfill pages,
   with saved progress. Existing row caps are retained, but are not elapsed-time
   bounds. Completed fills being cheap on the current live installation does not
   cover cold installations or newly published series. Aggregate readiness is
   one read per eligible series; completion is hosted state, not proved by source.
3. **Make the new size listing a resumable measurement phase.** Attachment lines
   131–134 should use saved continuation token and partial totals under the same
   deadline/generation. Publish the new count/bytes only after the final page;
   retain the previous completed measurement while a refresh is partial or
   fails. The worker must keep retrying this phase instead of becoming idle
   before measurement completes. `blob-store.ts:170–188` already supplies
   `nextToken`. Display measurement age/coverage, including the Daily card's
   previously measured totals, rather than implying live exact free capacity.

Small wording correction: repeated activity conflicts can leave a value stale
until a later successful event, not necessarily only one event. This is already
within the accepted observed-activity/missing-means-away policy. Ten minutes is
an application rollout mitigation, not a documented guarantee that old writers
are gone; the new targeted overlap check is appropriate.

Three isolated probes passed using current helpers: exact stub reconstruction
for plain and packed ghosts with obsolete outer simulation metadata; and a
healthy stub whose parsed record cannot substitute for original text. The probes
and configuration are only under `/private/tmp/dailygp-blob-plan-review.2kkTVI/`.
An initial external mock-based attempt hit harness/runtime initialization
limitations; using the actual pure classifier removed that dependency. These
probes verify existing helper behavior, not the unimplemented archive reader or
hosted lifecycle. No full suite, build or hosted checks were rerun. Only this
review document changed in the repository during this re-check.

## Earlier revision review

Reviewed the revised attachment `b46dee0f-57e0-442f-96e4-3a115479be0a/Pasted text.txt`
against the working tree on `feat/campaign-more-stages-placeholder`, HEAD
`92dba52de43b9ebfea3a77f4b8e5894f94bf80cb`. Existing unrelated changes were
preserved. This is a plan review: no application, permanent test, configuration,
deployment or hosted data changes. This review document is the only repository
file added by this review.

The revision resolves most earlier findings. Three parts still need explicit
amendments; the other points below clarify execution and verification rather
than require a broader architecture.

## Earlier amendments, now addressed

1. **Restore must not require current live race compatibility.** Attachment
   lines 54–59 require current competition/track, schema, simulation, fingerprint
   and race identity. Lines 107–109 reuse these checks for Restore. Inventory
   finds an unpublished board but does not supply its live stage:
   `game/campaign/manifest.js:121–128,193–194` only indexes live stages.
   `src/server/competition/pb-ghost-store.ts:199–209` rejects obsolete content.
   Split archive integrity from race compatibility. Integrity verifies the SHA,
   reference prefix and original full record against the unchanged stub without
   current catalog lookup, and returns the original stored text. Race readers
   additionally require current compatibility. Restore writes that authentic
   text only over the existing unchanged stub; it never revives deleted rows.
   Retain/derive the board identity needed to validate the prefix without a live
   stage. Add unpublished-stage and obsolete-simulation/fingerprint restore
   tests using the actual shared helper.

2. **Stage 2 needs a deadline shared by the whole scheduler request.** Attachment
   lines 90–91 put the new fill after existing fills with its own time budget.
   `src/server/server-app.ts:344–347` already sequentially runs raced-list fill
   and Campaign aggregate fill. The first can process 1,000 rows with no elapsed
   time bound (`src/server/player/raced-list-fill.ts:119–176`); aggregate fill
   loops over eligible series (`src/server/campaign/campaign-store.ts:1018–1022`).
   A fresh independent allowance does not constrain their combined duration.
   Pass an absolute request deadline through the maintenance work, check remaining
   time before starting each fill/page, and reserve time for checkpoints/cleanup.
   Defer work to the next tick when little time remains. Devvit Web's documented
   maximum request time is 30 seconds; matching Redis docs recommend bounded,
   resumable maintenance.

3. **Apply unavailable-record handling to every cache writer.** Attachment line
   76 only names `PbGhostService.getForChallenge`. The submit response is also
   installed through `game/scoreboard/engine-methods.js:347–358` →
   `game/daily-challenge/engine-methods.js:313–345` →
   `game/ghost/pb-ghost-service.js:57–62`, which unconditionally caches the record.
   Handle `ghostUnavailable` in `installForChallenge` too: supersede stale requests,
   evict the cached ghost record, retain PB metadata in the engine, and allow the
   next attempt to fetch. Keep the flag on the record or explicitly propagate it
   into the cache decision. Existing Daily archival only moves expired,
   unplayable days, so this is completeness of the revised shared reader/client
   contract, not evidence of a current playable-Daily regression.

## Execution details to retain

- **Daily Off is a prerequisite, not an idle-worker test.** Daily choice persists
  after a pass finishes (`daily-ghost-archive.ts:91–98,1394–1401`). The proposed
  Campaign guard can wait indefinitely even when Daily has no work. State the
  prerequisite in the card/trial and display “Waiting for Daily to be switched
  Off.” A worker already in flight has captured its choice at `:1331–1337`;
  changing the setting does not prove it has drained. The 30/s local gate is a
  job budget, not an installation-wide guarantee for concurrent race reads.
- **Three exhausted conflicts require a durable checkpoint outcome.** Existing
  compaction stops without advancing when group commits fail
  (`ghost-compaction.ts:451–454`). Implementing the new skip/count/next-Run
  contract requires a generation-fenced progress-only checkpoint. If that also
  fails, retain the old cursor; do not report a durable skip or successful advance.
  Row writes, inventory and successful counters remain atomic as planned.
- **Upload traffic is not storage occupancy.** The reported 10 GB installation
  grant must include Daily copies, Campaign copies, abandoned uploads and other
  objects. Re-putting one deterministic key increases upload traffic without
  equivalent resident growth; a crash after PUT can leave an uncounted object.
  Label the upload metric as traffic and compare a resident-byte measurement or
  conservative installation estimate with the configured grant. Published Devvit
  docs say 50 GB, but do not independently verify this installation's grant.
  Copy-first safely retains Redis rows when the provider refuses an upload.
- **Define the automatic final Restore pass.** A pass that restored rows has
  found moved rows. To make the one-Run trial reach Done, automatically run the
  planned final verification pass. If unresolved rows remain, report them and
  make Run again the explicit retry action.
- **The trial is a smoke test, not proof of every hosted-only case.** Ordinary
  move/race/restore does not force concurrent scan changes, real conflicts,
  throttling, quota refusal, deployment overlap or stale workers. Add targeted
  hosted exercises for these or mark them unverified. Ten minutes is existing
  application rollout practice, not a documented Devvit old-worker shutdown
  guarantee. Do not claim unspecified HSCAN mutation semantics.

## Stage 2 assessment

No new blocker identified under the explicitly accepted observed-activity and
missing-means-away policy. Full canonical IDs, every-event monotonic updates,
bucketed hashes, adoption activity, commit-time rechecks and a ready gate address
the prior concrete gaps. Skipping a conflict can leave activity stale until
another event; readability preserves the ghost, but this is not an exact
last-race ledger.

Implementation should cover normal and resumed guest adoption after authenticated
account validation (`player-account-store.ts:133–194`), and keep index failure
best-effort. Advance backfill cursors/readiness only after page writes succeed.
Validate stored UTC-day strings before comparing them. These are implementation
details, not additional established design blockers.

## Sources and verification

Used the official Reddit `devvit-docs` skill at
`reddit/devvit-skills@71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae`.
Its cache script verified matching Devvit 0.14 docs at
`reddit/devvit-docs@7557a3b3ca9faf9c63c7e0b264b8ad1460b3511a`.
Installed Redis/Blob/Web packages are 0.14.7. Platform source of truth is
`reddit/devvit-docs`; installed SDK and app source provide implementation evidence.

- `versioned_docs/version-0.14/capabilities/devvit-web/devvit_web_overview.mdx`,
  “Technical limitations,” lines 43–49: 30-second request limit.
- `versioned_docs/version-0.14/capabilities/server/redis.mdx`, “Scheduled
  maintenance,” lines 157–168: bounded batches and persisted progress; “Hash”
  documents returned-cursor traversal but does not specify concurrent scan
  completeness. No upstream Redis scan behavior was assumed.
- `versioned_docs/version-0.14/capabilities/server/blob-storage.mdx`, lines 17
  and 30–35: installation namespace, 100 requests/s and published storage quota.

One new isolated Vitest probe passed, reproducing that an explicitly flagged
unavailable PB installed through `installForChallenge` is cached and prevents
the next ordinary lookup from fetching. Probe/config were created only under
`/private/tmp/dailygp-blob-plan-review.2kkTVI/`; repository global setup and asset
generation were excluded. This demonstrates the current cache writer, not a
test of the unimplemented revision. Earlier baseline tests were not rerun;
no full suite, build, hosted lifecycle or quota checks were performed here.
