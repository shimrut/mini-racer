# Ghost reduction and Blob fix plan — revision 2 re-check

## Result

Revision 2 resolves the signing break, page-local held-list progression,
page-replay skip counting, and old sweep-inventory invalidation in the proposed
design. The run-token fallback also addresses transferred guests whose archive
link alone was lost. **Clarify the legacy compaction reset and close the
remaining damaged-row guard before implementation.** Retain server-side busy
checks and transaction cleanup, and correct the verification claims below.

Read-only application review of the attached “Fix the five review findings on
the ghost move and compaction (revision 2)” against unchanged branch
`daily-ghost-blob-archive`, HEAD
`ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`. Plan line numbers refer to that
attachment. Only review documentation changed in the repository. No commits,
uploads, or hosted data/settings changes were made.

Consulted the repository rules, system change map, implementation review,
revision 1 review, earlier archive design review, and the official Devvit docs
skill. Two agents independently checked sweep/held behavior and compaction
integration. The main reviewer ran the SDK probe described below.

## What revision 2 resolves

| Area | Re-check |
| --- | --- |
| Held traversal | The watermark now belongs to the current input cursor, clears on page changes/wrap, and scan-only progress is saved. The unsupported fixed hourly guarantee is removed. |
| Old sweep checkpoints | `refsVersion: 2` checked before list work can restart the refs phase and atomically clear the old reference hash through `startSweep`. |
| Guest/account fallback | The Blob payload is the full decoded PB JSON, not only a trace. Upload preserves `bestTimeMs` and `updatedAt`, and raw transfer preserves them under the account field. The proposed token can match across that ownership change. |
| Page replay | Accumulating skips in memory and saving them with the page cursor avoids recounting marked rows when a partially completed page is replayed. |
| Stale Start/error state | Making decisions from the watched current state and merging only `lastError` addresses the old stale-state overwrite. |
| SDK signing/retries | Retaining middleware and supplying the described single-attempt strategy works with the actual installed Devvit factory in controlled tests. |

Payload evidence: `daily-ghost-archive.ts:562–575,607`,
`pb-ghost-store.ts:34–47`, and `guest-transfer/board-merge.ts:93–107`.
Token collisions can retain extra orphans; they do not make an unmatched live
reference disappear. Use the same token serialization and metadata validation
on Redis and Blob records.

## 1. Legacy audit must rebuild saved state, not just ignore old eligibility

**Plan lines 139–153.** Saying that `doneKeys` is “ignored once” is insufficient
unless the saved list is also cleared/rebuilt. Example:

1. A pre-fix board is already in `doneKeys` despite a skipped plain ghost.
2. The audit includes it by ignoring the old list during board selection.
3. The row is still marked; the board has `boardSkipped > 0`, so no key is added.
4. If the old saved key remains, the next Run again still excludes the board.

`boardsFor` filters saved keys at `ghost-compaction.ts:169`; new-run setup
currently spreads the existing step at lines 201–212. Merely declining to add
an already-present key does not remove it.

**Specify:** on the legacy audit start, atomically rebuild all eligible boards,
clear `doneKeys`, reset `index`, `cursor` and the run/current-board counters,
then set `skipTracked: true`. Re-add only boards completed with zero skips.
Normal audited Pause/Resume must preserve its cursor and counters.

The legacy branch must take precedence over ordinary Resume. A pre-fix paused
step has `startedAt && !finishedAt`; current Resume otherwise preserves its
board list and nonzero cursor (`ghost-compaction.ts:196–200`). That can leave
previously skipped earlier pages unaudited. Avoid resetting an active worker
underneath its in-flight work: reject Start while it is running, or serialize
that transition using existing locking. A paused legacy step can begin the
audit safely.

Required regressions: an old completed board remains marked during audit,
then its marker clears and Run again includes it; and an old paused step has a
skipped row before its nonzero saved cursor, which the audit visits.

## 2. Treat present undecodable or unidentifiable rows as ambiguous

**Plan lines 66–81.** The plan still restricts its unreadable-row stop to
non-empty values. HSCAN returning a field with `value: ''` means that field
exists; it is not an absent row. `readRun` returns null for it at
`daily-ghost-archive.ts:283–290`. Without a stop, no reference/token protects
the corresponding old object.

Also, `readRun` only decodes and parses a JSON object. It does not validate PB
metadata. A damaged, parseable no-ghost/no-ref row missing `bestTimeMs` or
`updatedAt` can create `run:undefined:undefined`, which cannot match its original
full Blob record. Valid JSON alone does not establish a usable run identity.

**Specify:** stop deletion for every present undecodable value, including an
empty string, and for a missing-link row whose time/save-date fields cannot
form a valid token. Validate with the existing record contract rather than
inventing a stricter incompatible timestamp format. Missing-link-only stubs
and legitimate seeded ghost-null rows with valid metadata remain eligible for
the token fallback.

The proposal to delete an object that cannot be decoded as a run also needs a
bounded claim: decoding failure does not prove the absence of recoverable
data. If an ambiguous missing-link row exists, retain/quarantine such an object
or stop that sweep rather than claim it cannot be needed. This is defensive
recovery behavior requiring additional pre-existing damage, not evidence of
normal writers corrupting a readable ghost. If the scope intentionally covers
only lost archive links with intact row/object metadata, state that narrower
guarantee instead of the heading's universal preservation claim.

Required regressions: present empty PB value; parseable PB missing token
metadata; and unreadable Blob payload in a day containing an ambiguous row.
Keep the proposed transferred-guest, legacy list-phase and failed-GET tests.

## 3. Keep refusal cleanup and a server-side busy guard in Fix 3

**Plan lines 104–122.** The referenced migration pattern already has a
`finally` that discards/unwatches (`moderator/challenge-analytics-migration.ts:
60–75`). Carry that part into `updateState`, including when async `decide`
refuses before MULTI or throws. The matched Devvit Redis guide explicitly
requires cleanup on early exits before EXEC.

State the running-step guard explicitly: refuse a Start for another step while
`current.running` is non-null. For example, Expired has no prerequisite and
can otherwise replace `running: 'campaign'` with `running: 'expired'`. The
existing UI disables the other button (`pages/mod-analytics.js:511–517`), but
the server has no equivalent guard (`ghost-compaction.ts:186–226`). WATCH
protects concurrent writes; it does not establish that a requested transition
is allowed.

Do not claim that `boardsFor` before MULTI necessarily expires WATCH. The
matched Devvit docs specify a five-second transaction execution timeout, but
no WATCH-to-EXEC lifetime was found. Preparing many board-length reads while
WATCH is open is a latency/resource concern. Short preparation outside WATCH
plus a checked state snapshot remains an optional improvement, not a newly
proved correctness blocker.

## 4. Single-attempt behavior passes; strict 40/s does not

**Plan lines 162–194.** Implemented only the proposed retry-strategy sketch in
an external temporary probe, using actual `newS3Client()` and the application's
unchanged `createDevvitBlobStore`/`createBlobSession`. Devvit config RPC and HTTP
transport were stubbed; requests were never sent to hosted storage.

| Probe | Result |
| --- | --- |
| HTTP 500 | One signed, installation-prefixed request; original service error preserved with `attempts: 1`. |
| Successful PUT + GET | Two signed requests; returned bytes matched the uploaded test bytes. |
| Abort | Abort reached the handler and the caller; one attempt. |
| 80 failed calls, eight workers, nominal 40/s session | Exactly 80 HTTP attempts; peak **41** in a rolling one-second window. |

The four-case run had **three passing tests and one failed assertion**: the
strict `peak <= 40` assertion. A focused diagnostic rerun reproduced 41 at
both the logical dispatch and transport boundaries, with a 7 ms delay before
the first transport attempt. Do not call the whole probe green.

The session schedules nominal 25 ms slots (`blob-store.ts:172–180`) rather
than enforcing a strict rolling-window count. Timer/dispatch timing can put 41
starts inside one measured second. This does not invalidate the one-attempt
strategy and is below Devvit's documented 100 requests/s quota in this probe.
It is not evidence of a hosted quota violation or an installation-wide bound.

**Specify:** either enforce the intended strict window, or describe nominal
40/s pacing and adjust the verification assertion accordingly while preserving
headroom below the Devvit quota. A 40-call-only test proves total attempts, but
cannot expose this rolling-window behavior. Keep the actual Devvit factory in
the regression alongside the authorization/prefix and abort/readback checks;
a generic S3 client with an imitation bucket middleware does not cover that
factory path.

## 5. Release build verification is still incomplete

**Plan line 190.** Devvit supports esbuild; Vite is optional. The issue remains
that this repository's release configuration is implemented in Vite. An
esbuild-only check must explicitly cover generated assets, debug-module
replacement, client source-map exclusion, asset cache busting, all configured
WebView entrypoints and the single bundled CJS server. Otherwise it is a
compile check, not validation of the upload package.

Evidence: `package.json` build script, `vite.config.js:14–95`, `devvit.json`
post/server paths, and `docs/system-change-map.md:858–879`. No release build or
full application suite was rerun for this plan-only review. Existing production
execution claims in the attachment were not newly verified from hosted state.

## Devvit documentation and evidence limits

Reused the official `devvit-docs` skill from
`reddit/devvit-skills@71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae`; its cache
script verified the fresh matching 0.14 documentation checkout at
`reddit/devvit-docs@c822bd5624677dbcfcd8480624452db4927d39a1`.
Relevant paths/sections relative to the documentation repository:

- `versioned_docs/version-0.14/capabilities/server/redis.mdx`, “Shared state”
  and “Transactions”: conditional execution, early-exit cleanup, five-second
  transaction execution timeout. “Hash” and the migration example cover
  returned-cursor scans, without a global page-order/rehash timing guarantee.
- `versioned_docs/version-0.14/capabilities/server/blob-storage.mdx`, “Limits
  and quotas” and “Adding blob storage”: 100 requests/s and installation-scoped
  preconfigured client behavior.
- `versioned_docs/version-0.14/guides/tools/vite.mdx`, “Build with the Devvit
  Vite plugin” and “What it builds”: bundler choice and bundled CJS output.

The docs do not specify custom Smithy retry behavior; the installed middleware
and real-factory probe provide that evidence. Local mocks/probes do not verify
hosted WATCH conflicts, capability access, throughput, or an upgraded complete
move–restore lifecycle. No application source or permanent tests changed.
