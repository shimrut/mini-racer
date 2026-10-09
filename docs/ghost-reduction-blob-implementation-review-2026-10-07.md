# Ghost reduction and Daily Blob Storage implementation review

Reviewed October 7, 2026 on branch `daily-ghost-blob-archive` at
`ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`. The implementation range starts after
`27aa4f6978b8573d00f4064fde400e122e2fd093` and includes the Blob adapter, archive
move/restore/sweep, transfer prerequisites, packed ghost codec/writer,
moderator controls, and compaction worker. The earlier
[archive proposal review](./daily-ghost-archive-plan-review-2026-10-06.md)
reviews the design; this document reviews the implementation.

## Verdict

The core packing and storage adapter work, but the migration is not established
as working on hosted Devvit. Development logs show Blob capability refusal;
later logs show successful compaction, not successful Blob migration. Four
implementation problems are reproduced locally: compaction can undo Pause,
permanently skip temporarily ineligible rows, starve held archive retries, and
exceed Devvit's Blob request limit through SDK retries. A fifth reproduction
shows a deletion safeguard gap when a Redis archive row is already damaged.

None of these reproductions lost a ghost the game could still read before the
failure. The ordinary effects are an undone Pause, incomplete compaction,
less Redis space reclaimed, delayed Restore completion, and refused Blob
requests. The damaged-row case loses a copy available for manual recovery
after the game has already lost the ability to read that row.

The earlier empty-nonterminal scratch HSCAN finding is **withdrawn as a
confirmed finding**. Its synthetic reproduction does not establish that
Devvit's backend returns that response for these scratch hashes. The damaged
row finding is explicitly conditional on existing corruption; no normal writer
creating such a row was identified.

This review changed only this document. Application source, configuration,
dependencies, permanent tests, moderator settings, and hosted data were not
changed. Unrelated dirty landing-page and documentation work was preserved.

## Devvit sources and SDK contract

Used Reddit's official
[devvit-docs skill](https://github.com/reddit/devvit-skills/blob/71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae/skills/devvit-docs/SKILL.md),
including its ensure-docs.cjs script. The skill directs documentation lookup
to reddit/devvit-docs and excludes legacy public-api references. It selected
versioned_docs/version-0.14 for this app's installed **0.14.7** packages,
with matchedVersion: true. Documentation snapshot:
c822bd5624677dbcfcd8480624452db4927d39a1. Installed SDK code was checked
separately to verify the actual web-runtime implementation.

The paths below are relative to that official documentation repository.

| Source and section | Relevant contract | Application/SDK verification |
| --- | --- | --- |
| [versioned_docs/version-0.14/capabilities/server/redis.mdx](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/server/redis.mdx), Storage values and Compression | Compression applies to supported writes/reads; the guide warns against mixing raw and compressed clients on a key. | Maintenance intentionally reads physical values and writes the SDK-compatible `__gz:b64__:` envelope. Actual 0.14.7 SDK tests verified both directions. `redisCompressed.hScan` returns raw envelopes, so explicit decoding is necessary here. This implementation depends on the installed envelope format. |
| Same file, Shared state, Transactions, Limits, and Migration example | “Use Redis transactions when correctness depends on reading a value”; migration follows the returned cursor, with “0 means iteration is complete.” | SDK transaction reads return the transaction client and queue commands; they do not yield values. The implementation correctly reads through the base client after WATCH. Normal mutation commits fence lock, PB, transfer markers, and progress state. The error handler in finding 1 bypasses that protection. |
| [versioned_docs/version-0.14/capabilities/server/blob-storage.mdx](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/server/blob-storage.mdx), How it works, Limits and quotas, Supported commands | “you’ll need to request access to this capability”; “separate installations cannot share blob storage.” Limits are 100 requests/s, 30 MB/request, 900-byte paths, 50 GB. | Supported Put/Get/Delete/ListObjectsV2 commands are used. Actual Blob middleware enforces the installation bucket/prefix and strips list-result prefixes. The adapter creates one client per incoming request, matching SDK credential/context requirements. |
| [versioned_docs/version-0.14/capabilities/server/scheduler.mdx](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/server/scheduler.mdx), Faster scheduler and Limitations | Minute-resolution scheduling is supported; execution can be late. Ten live recurring actions are allowed. | Configuration has five tasks. Archive and compaction use minute cron expressions and installation locks. No scheduler configuration defect was found. |
| [versioned_docs/version-0.14/capabilities/devvit-web/devvit_web_overview.mdx](https://github.com/reddit/devvit-docs/blob/c822bd5624677dbcfcd8480624452db4927d39a1/versioned_docs/version-0.14/capabilities/devvit-web/devvit_web_overview.mdx), Technical requirements | Maximum server request time is 30 seconds. | Workers budget time for Blob work and Redis commits. Local checks do not establish hosted latency or throughput within that budget. |

The Redis guide is internally inconsistent about transaction concurrency:
Shared state says 30, while the limits table and MULTI entry say 20/default.
Use 20 as the conservative documented value; do not claim this installation's
actual allowance was measured. Both entries specify a five-second transaction
execution timeout. The guide also marks hMGet as potentially allowlisted.
It was already used widely before this branch; no branch-specific entitlement
regression was established.

Neither the repository doubles nor the SDK's bundled Redis mock establish
real Devvit WATCH conflict behavior. The bundled mock retains watched keys but
does not enforce their invalidation in EXEC. SDK-boundary probes below validate
client behavior with stubbed transport, not backend concurrency.

## Hosted read-only evidence

The installed 0.14.7 CLI's `devvit list installs` reported:

- mini_racer_dev: **v2.5.2.15**.
- MiniRacerGame and vector_gp_dev: **v2.5.2**.

Captured existing logs with bounded reads of
`devvit logs <subreddit> mini-racer --since 24h --json --log-runtime`.
No archive, compaction, restore, or moderator action was initiated.

- Development: 520 parsed records, October 7 07:43:00–12:53:15 UTC.
  There were **402 Blob permission-denied sweep records** between
  07:43:57 and 07:49:50, with “app not allowed to use blob storage” from
  BlobService.GetConfig. All 67 captured move-pass summaries reported
  moved 0; populated days also reported failed uploads. A moderator set
  the archive to Off at 07:50:43.
- At 11:51:52 UTC, development logged completed expired compaction:
  **82 checked, 73 packed, 53,015 payload bytes saved**. This is application
  progress evidence, not Redis allocator measurement or full readback proof.
- Production: 266 parsed records, October 6 13:23:47–October 7 12:51:20 UTC.
  No archive or compaction completion appeared in this capture. Absence of
  those records does not establish production capability access or failure.

The logs do not identify a Git commit per entry. In particular, do not attribute
the morning refusal flood to current HEAD: current source has a first-request
Blob preflight at daily-ghost-archive.ts:1177-1192, which stops a refused run
before processing days. Historical refusal confirms the access problem at
that time; it does not prove current entitlement is still missing. A successful
hosted move–restore–move canary remains unverified.

## Findings

### 1. P2: a compaction error can undo a moderator's Pause

`src/server/competition/ghost-compaction.ts:415-420` writes the entire cached
`ctx.state` with a plain SET after an error. It does not reread the current
state or fence job-lock ownership. Pause saved while a Redis call is outstanding
can therefore be overwritten by the older running state.

The external reproduction paused the expired step inside an outstanding
HSCAN, confirmed running === null, and then rejected the scan. The error
handler changed running back to expired. The next scheduled run can resume
despite the accepted Pause. This is an application state-write defect and does
not depend on standard Redis scan behavior.

Save the error through an owned, watched update of the latest state, preserving
its current control state. Cover failure after Pause and after lease loss.

### 2. P2: compaction permanently excludes rows skipped during sign-in

`ghost-compaction.ts:331-334` skips a row whose raw PB changed or whose transfer
marker is set. However, workPage still finishes the board and adds it to
doneKeys at lines 378-388. Start/Run again excludes those boards at lines
169 and 198; no retry list retains the skipped eligible rows.

The external reproduction compacted an expired board while its only ghost's
marker was set. The step finished with the ghost still plain. After removing
the marker, Run again selected zero boards and left it plain. Independent
transfer review confirmed this path. PB data is retained, but completion and
storage savings are incomplete.

Sign-in copies the stored row exactly, so a copied account row can also remain
plain. This affects rows skipped during the run, rather than every row on the
board. No hosted count of affected rows was measured.

Retain skipped eligible rows/boards for bounded retry, or make explicit rescans
revisit them. Cover marker removal and row replacement between scan and commit.

### 3. P2: held archive work can starve behind the same first 25 rows

`src/server/daily/daily-ghost-archive.ts:922-923` scans the held hash from cursor
zero and keeps the first 25 names. If those names still require work but retain
sign-in markers, lines 935-941 keep them without advancing traversal. Later
eligible entries need never receive a retry. This also affects restore upkeep.

An abandoned sign-in selection can retain its marker. In Move mode, blocked
rows behind that prefix retain their full Redis ghosts and reduce storage
savings. In Restore mode, archived rows behind it are never restored and the
day remains unfinished; their Blob objects are retained.

The external reproduction held 26 valid ghosts, retained markers on the first
25, and cleared the 26th. Repeated upkeep left the free 26th inline and held.
The defect also applies if a response contains more than 25 names: slice
keeps selecting the same prefix. Hosted hash order was not measured; the
reproduction uses a stable valid page order, and Devvit's migration example
establishes cursor continuation rather than random selection on repeated zero.

Persist a held traversal cursor or rotate bounded work. Test more than one
slice with markers that remain set in the first slice.

### 4. P2: SDK retries bypass the Blob request limiter

`src/server/blob/blob-store.ts:175-191` spaces logical store calls at 40/s.
Each call invokes client.send, whose installed SDK performs retries inside
that one call. The limiter does not see those extra physical requests.
daily-ghost-archive.ts:154 runs eight workers.

A fresh probe used the actual @devvit/blob client and AWS retry middleware,
with a local request handler returning two HTTP 500/InternalError responses
followed by success for each PUT and GET. It ran 20 upload/readback pairs with
eight workers through the application's createBlobSession. Backoff jitter
was held at Math.random() === 0.25 for reproducibility. The logical call count
never exceeded 40 in a rolling second, but **117 physical attempts occurred
within one second** (120 overall in 1,054 ms). This exceeds Devvit's documented
100 requests/s limit under that transient failure pattern; no hosted quota
violation was observed.

The resolved CJS retry implementation restores a successful retry token's
cost. An all-failure version of the same probe stopped at 90 physical attempts;
that quota behavior does not protect the success-after-retries case above.
Do not infer a steady-state overrun merely by multiplying 40 by three.

The user's independent all-failure measurement peaked at 90–91 attempts/s,
consistent with that all-failure probe. **117 is the controlled
failure–failure–success result**, not the result of every call failing and not
a hosted observation. Success replenishes retry capacity in the installed
implementation. Requests refused under either pattern leave Redis ghosts
unchanged and retain the work for later retry.

Limit actual transport attempts, or make SDK sends single-attempt and handle
retries through the existing durable worker. Preserve timeout/abort handling
and avoid creating another unbounded retry loop.

### 5. P2: an unreadable archive row can lose its surviving Blob copy

`daily-ghost-archive.ts:1008-1010` skips rows when `readRun` cannot decode the
stored envelope or parse JSON. That does not establish the absence of a live
archive reference. Reference collection omits the key, allowing the listing
phase to delete its Blob object after the grace period. The damaged-reference
guard at lines 1011-1024 covers readable JSON with invalid ghostArchive, but
not unreadable rows.

The external reproduction archived a valid ghost, corrupted its Redis stub
JSON, aged the object beyond the grace period, and swept again. The Blob was
deleted while the corrupt Redis row remained. **Existing row corruption is
required**; no normal writer producing it was identified. This is a defensive
data-preservation gap, not a demonstrated routine-write regression.

A missing link on a previously archived row has the same recovery consequence:
the sweep cannot associate its object with that row. A missing link by itself
does not establish corruption, because legitimate legacy ghost-null rows also
exist. The game already cannot read the damaged ghost; the surviving object is
useful for manual recovery. No reviewed writer creates invalid row text or
drops an archive link while copying the stored record.

Treat unreadable PB rows as an incomplete reference inventory: stop that day's
deletion and surface a repairable error. Cover invalid JSON and invalid gzip
envelopes alongside the existing readable-but-invalid-reference test. This
matches the prior design review's requirement to stop before deleting when
an archive reference cannot be read.

## What passed and what remains unverified

- Packing unpacks and compares the trace before use. Readers preserve plain,
  packed, and archived forms through the existing PB/transfer contracts.
- Upload/readback is checked before a watched Redis replacement. Restore
  preserves packed full records and references copied during transfer.
- Daily guest cleanup watches and rereads the transfer marker; PB-only transfer
  writes raise the standings revision. No additional integration regression
  was found in these paths.
- Blob client context, namespace, supported commands, package version parity,
  key length and per-object size match the checked SDK/docs. No
  permissions.blob setting was added or needed by the documented setup.
- Request budgets, aborts, and progress checkpoints exist. Real backend WATCH
  conflicts, capability access now, hosted throughput, quota behavior, actual
  memory savings and the complete move–restore–move lifecycle remain unverified.

The empty-nonterminal scratch HSCAN condition remains a hardening/test question,
not a confirmed backend incident or a reason to claim migration lost work.
Devvit's docs and SDK establish cursor passthrough, but do not specify the
backend hash encoding or prove this response occurs on the worker's small
scratch hashes. No Redis listpack threshold or generic Redis implementation
assumption was used to promote it to a confirmed finding.

## Validation

- **392 distinct tests passed across 20 repository suites** during this review,
  including archive, Blob adapter, codec, compaction, PB readers/writers,
  Daily/Campaign transfer and cleanup, moderator routes/UI, storage estimates,
  and changed analytics integrations. Overlapping agent runs count once.
- The fresh Devvit-specific pass reran the three core suites: **54/54 passed**
  (server-blob-store, server-daily-ghost-archive, server-ghost-compaction).
- **Four additional actual-SDK boundary probes passed**, covering raw scan
  envelopes and explicit compression compatibility, queued transaction reads
  and request binding, installation Blob middleware, and the retry-rate case.
  Transport was stubbed and no hosted requests were sent by those probes.
- npm run typecheck passed. vite build passed with a nonfatal warning about
  inconsistent JSON import attributes for game/campaign/series.json.
- The analytics route suite initially encountered sandbox loopback EPERM;
  all 34 tests passed after rerunning with loopback access.
- Earlier targeted application reproductions used Redis/Blob doubles; those
  files were removed. New SDK probes and read-only log captures used temporary
  files outside the repository. No permanent tests were added or modified.
- The full repository suite was not run. Passing local tests do not establish
  hosted Redis/Blob transaction, capability, throughput, or storage results.
