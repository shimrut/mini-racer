# Ghost reduction and Blob fix plan review — 2026-10-07

## Result and scope

**Revise the plan before implementation.** The five original findings are
addressable through the existing worker and state model, but Fix 5 as written
breaks Blob calls before they reach HTTP. The plan also needs upgrade handling
for existing compaction and sweep checkpoints, explicit held-page progression,
and counters that survive page replay accurately.

Reviewed the attached **“Fix the five review findings on the ghost move and
compaction”** plan against branch `daily-ghost-blob-archive`, HEAD
`ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`. Plan line numbers below refer to
the pasted attachment. This is a plan review, not authorization to implement,
commit, upload, or change hosted settings. Only review documentation changed.

Read the repository rules, `docs/system-change-map.md`, the implementation
review, the earlier archive design review, and the official Devvit documentation
through the `devvit-docs` skill. Two agents independently checked compaction
integration and sweep/held behavior; neither changed application files.

## 1. Fix 5: retain the middleware required by signing

**Plan lines 147–162: verified blocker.** Removing `retryMiddleware` does not
merely disable retries. The installed signing plugin attaches
`httpSigningMiddleware` *after* that named middleware
(`node_modules/@smithy/core/dist-cjs/index.js:126–137`). Removing its anchor
makes middleware resolution fail before transport.

An actual `@devvit/blob` `newS3Client()` probe, with a stubbed Devvit config RPC
and local HTTP handler, produced:

| Configuration | HTTP requests | Signed request with installation prefix | Result |
| --- | ---: | --- | --- |
| Remove `retryMiddleware` | 0 | No | Middleware-resolution error |
| Replace it with a pass-through under the same name | 1 | Yes | Controlled HTTP 500 |
| Retain it and supply a one-attempt retry strategy | 1 | Yes | Controlled HTTP 500 |

The removal error names `retryMiddleware` as missing when adding
`httpSigningMiddleware`. This is an installed-SDK result, not a hosted test or
an assumption about standard Redis/S3.

**Correction:** retain the middleware and configure a one-attempt retry
strategy. The probe verified a strategy using `StandardRetryStrategy(1)` and
setting both the resolved `maxAttempts` and `retryStrategy` providers. The
Devvit factory takes no client-options argument; changing only a property
without checking the resolved strategy is insufficient evidence. If the
implementation imports a Smithy package directly, declare that dependency
rather than relying on a transitive package accidentally remaining installed.

Test the actual Devvit factory path, not only a generic S3 client with a
bucket-filling imitation: HTTP 500 reaches transport once, signing and the
private installation prefix remain present, successful upload/readback works,
and abort/timeout behavior remains intact. Keep the existing durable retries.
The proposed “one put reaches the handler once” assertion would catch the
current removal failure, provided middleware errors are not accepted as the
expected failed request.

## 2. Fix 4: include legacy skipped boards and count completed pages

**Plan lines 124–136 and 175: missing upgrade path.** Existing saved state
already places boards containing skipped rows in `doneKeys`. Adding counters
with zero defaults does not identify or reopen those boards.
`ghost-compaction.ts:169,198` still excludes them from a new run. A pre-fix
paused run can also have skipped a row before its saved cursor.

**Correction:** version the skip-tracking behavior and give legacy steps one
audit pass. Include their previously completed boards and rescan the current
board from the beginning when resuming a legacy paused step. Keep existing
packed rows and write policy; rereading them is harmless. Test serialized
pre-fix finished and paused states, not only runs started after the fix.
The plan's observation that nine particular development rows had no ghost
does not establish that every legacy board is free of skipped rows.

**Counter correction:** do not permanently increment skip counts in each
`packGroup` EXEC. `workPage` intentionally rereads a page if its deadline
arrives after a group commit but before the page-cursor commit
(`ghost-compaction.ts:343–389`). Packed rows cease to qualify on replay;
marked plain rows still qualify and would be counted again. Sharing a
transaction with the row writes prevents conflict-retry duplication, but not
this deliberate page replay.

Accumulate the rechecked skipped results for the current page and save them
with the transaction advancing that page's cursor. Discard an unfinished
page's in-memory count. Preserve `boardSkipped` on Resume, reset it at a new
board, and reset the run counter on a new run. Test a deadline between group
commits and the final cursor commit, plus an EXEC conflict at that final commit.

## 3. Fix 2: rebuild old inventories and define lost-link coverage

**Plan lines 63–81: new checks must precede all deletion after upgrade.** A
saved sweep already in `phase: 'list'` resumes directly while its `modeSerial`
matches (`daily-ghost-archive.ts:1160–1170`). It never executes the new
unreadable-row guard or creates the new `field:` tokens. Its old inventory can
therefore still delete the object the fix intends to preserve.

**Correction:** version reference inventories/sweeps and restart the refs
phase for legacy checkpoints before allowing deletion. The existing archive
epoch/reopen mechanism is another possible route, but all affected saved
sweeps must be reset durably before the upgrade is marked complete; a partial
reset must not leave old inventories eligible on the next request. Test an
actual serialized pre-fix list-phase sweep with a damaged or missing-link row.

The own-field fallback also has a limit: Blob keys retain the field used for
the original upload (`daily-ghost-archive.ts:131–132`), while guest transfer
copies the stored text to the account's different field unchanged
(`guest-transfer/board-merge.ts:93–107`). If that account stub subsequently
loses its archive link, `field:<account>` does not protect its
`<originalGuest>-<digest>.gz` object after the guest row is gone.

This still requires pre-existing damage; valid transferred references remain
safe, and it is not evidence of normal writers dropping a readable ghost.
Either define the fallback as **same-owner protection only**, or preserve
objects conservatively when a missing-link account row cannot be associated
with its original upload owner. New provenance metadata alone cannot recover
that association for an already damaged old row. Add the regression: archive
guest → transfer → remove guest → damage account link → sweep.

Also stop on a present empty-string value: it is unreadable row data, not an
absent hash field. Validate and strip the exact day prefix before parsing the
object basename; the last separator before the hex digest is safe even when
the player hash contains `-`.

## 4. Fix 1: make the watermark page-local and persist scan-only progress

**Plan lines 27–40: clarify the algorithm.** Sorting each page does not give
the complete scan a global field order. The plan does not explicitly reset
`heldAfter` when moving to another input cursor or wrapping to zero. If it
carries the watermark across pages, a page ending in `z...` can filter out a
later page of eligible `a...` names forever.

**Correction:** bind `heldAfter` to the current input cursor and clear it on
every page advance and wrap. Save cursor progress when a four-page/deadline
budget yields without selecting a slice; saving only slice commits and
all-marked slices can repeat the same scan-only work indefinitely. Preserve
the one-slice-per-day upkeep budget.

Test later pages whose names sort before earlier pages, a response larger than
the slice, field removal between invocations, wrap behavior, and a scan-only
budget yield with eligible work on a later page. These are algorithm tests,
not assertions that every such response has occurred on hosted Devvit.

Remove the claim that Devvit's small hashes necessarily use standard Redis's
one-page encoding behavior. The matched Devvit guide does not document backend
encoding thresholds or globally sorted scan pages. Its Hash table says
“No server-side cap; uses requested count,” and its migration example follows
the returned cursor until zero. Neither establishes the unconditional
`ceil(N/25)` hourly guarantee. Describe eventual turns under a stable finite
held set, and state any timing bound's assumptions explicitly.

## 5. Fix 3: make Start's decision from the watched current state

**Plan lines 93–108: the WATCH approach is appropriate for Devvit.** Read
through the base client after WATCH; the installed transaction client's reads
queue commands and return the client, rather than the fetched state.

Keep `boardsFor` outside the transaction as proposed, but derive Start's
prerequisite, resume/restart, and running-step decisions from the current
watched state. Bind any precomputed board list to the snapshot used to make
it; recompute outside the transaction or abort if that snapshot has changed.
Wrapping a precomputed `nextStep` in WATCH still permits a delayed Start to
overwrite newer progress or restart after a Pause. Reject starting a different
step while another step is running, even if the UI disables that button.

Cover delayed concurrent Starts, Start versus Pause, and board completion
during board-list preparation. Clean up failed transactions and report conflict
exhaustion honestly. The proposed error-only merge into current state addresses
the original Pause bug without needing a new worker-generation system.

## Verification and Devvit sources

The esbuild-only instruction (plan line 168) is not forbidden by Devvit:
`guides/tools/vite.mdx`, “Build with the Devvit Vite plugin,” explicitly allows
other bundlers. However, this repository's release build is `npm run build`
and its Vite config supplies debug-module replacement, client source-map
relocation, hashed assets, and WebView entrypoint validation. If esbuild-only
is intentional, the plan must explicitly reproduce and check those packaging
requirements, generated assets, and Devvit's single bundled CJS server output.
An ordinary esbuild compile does not establish release equivalence.

Documentation was refreshed through the official `devvit-docs` skill at
commit `71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae`, matching the project's
Devvit 0.14 family. Documentation checkout:
`reddit/devvit-docs@c822bd5624677dbcfcd8480624452db4927d39a1`. Relevant paths
relative to that repository:

- `versioned_docs/version-0.14/capabilities/server/redis.mdx`, “Shared state,”
  “Hash,” and the compressed migration example: WATCH/read/check/write and
  returned-cursor continuation; no global HSCAN ordering or encoding guarantee.
- `versioned_docs/version-0.14/capabilities/server/blob-storage.mdx`, “How it
  works,” “Limits and quotas,” and “Adding blob storage”: private installation
  namespace, 100 requests/s, preconfigured client and supported commands.
- `versioned_docs/version-0.14/guides/tools/vite.mdx`, “Build with the Devvit
  Vite plugin” and “What it builds”: optional bundler integration and required
  bundled CJS server.

SDK middleware and retry behavior are not specified by those Devvit docs;
the installed SDK source and the actual-factory probe provide that evidence.
The Redis mock does not establish hosted WATCH invalidation behavior.

This plan review ran three controlled SDK configurations, with no network
transport to Reddit/Blob Storage. No application tests were changed. Earlier
passing implementation tests are recorded separately in
`ghost-reduction-blob-implementation-review-2026-10-07.md`; they do not prove
this proposed fix plan. Hosted capability access, Redis conflicts, throughput,
and the upgraded move–restore lifecycle remain unverified. Upload alone does
not grant the experimental Blob capability or start paused/done maintenance
controls.
