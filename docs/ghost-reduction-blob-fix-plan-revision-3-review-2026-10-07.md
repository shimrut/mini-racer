# Ghost reduction and Blob fix plan — revision 3 re-check

## Result

**Ready for implementation; no remaining blocking design finding identified.**
Revision 3 addresses the earlier compaction upgrade, sweep inventory,
row-damage, Start concurrency, retry/signing and build-verification findings.
The new request-handler rate gate is a workable approach, supported by the
controlled model probes below. Actual implementation and hosted lifecycle
validation are still future work.

Reviewed the attached “Fix the five review findings on the ghost move and
compaction (revision 3)” against unchanged branch
`daily-ghost-blob-archive`, HEAD
`ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`. Attachment line numbers are used
below. This was a plan re-check, not execution of its commits/build/upload
steps. Only review documentation changed in the repository; the SDK model
test was created outside the repository. No hosted mutations were made.

Consulted repository rules, the system change map, the earlier implementation
and plan reviews, and matched Devvit documentation through the official skill.
Two agents independently rechecked compaction integration and sweep behavior.

## Findings addressed

| Area | Revision 3 assessment |
| --- | --- |
| Held-list starvation | Page-local watermark, cursor reset on advance/wrap, scan-only checkpoint and no fixed turnaround promise remain correct. |
| Empty/unreadable Redis rows | Present empty fields and decode/parse failures now stop reference construction before deletion. |
| Missing-link run matching | Finite `bestTimeMs` and string `updatedAt` match the existing PB contract. Full Blob payloads and raw guest/account copies preserve both values. |
| Existing sweeps | `refsVersion` mismatch must restart refs and clear the old hash before entering listing. This covers pre-fix list-phase checkpoints. |
| Pause/error race | Only `lastError` is merged into the current watched state; it cannot restore an old running value. |
| Start concurrency | Different-step Start is refused; an already-running same step stays unchanged; decisions use watched current state. |
| Legacy skipped compaction | The audit explicitly clears/rebuilds `doneKeys`, rebuilds boards and starts from cursor zero, including legacy paused steps. |
| Replayed pages | Skipped counts are committed with page advancement rather than each row group. |
| SDK retry/signing | The one-attempt strategy retains the retry middleware required by signing. The new gate limits handler admissions after signing. |
| Release verification | The isolated copy now uses the actual `npm run build` pipeline and configured WebView/server outputs. |

Source evidence remains `competition/ghost-compaction.ts:144–226,309–395`,
`daily/daily-ghost-archive.ts:283–312,550–669,976–1046,1092–1170`,
`guest-transfer/board-merge.ts:93–107`, `competition/pb-ghost-store.ts:89–101`,
`blob/blob-store.ts:68–131,159–205`, `pages/mod-analytics.js:511–517`, and
`vite.config.js:14–95` (server paths relative to `src/server`).

## Implementation and verification details to retain

### Atomic admission and correct scope

For Fix 5 (plan lines 196–216), all sends from the same store must share one
timestamp history. After the final wait, prune/check, reserve the timestamp,
and delegate to the underlying handler without an intervening asynchronous
operation. Concurrent callers must not all pass a check before any caller
records admission. Recheck abort immediately before dispatch and preserve
the handler's options and lifecycle/configuration methods when wrapping it.

For a **closed** 1000 ms window, a send exactly 1000 ms old still counts;
remove it only when it is strictly older. With integer millisecond timestamps,
the model waits past that boundary, and rechecks after every wait.

This guarantee applies to the store/server request sharing that history.
Separate game/server requests can have separate Devvit clients; it is not an
installation-wide traffic proof. No new distributed limiter is required by
the reviewed five fixes. Keep the documented quota and the scope of the local
test distinct.

The revision's explanation attributes the earlier 41 peak to signing timing.
The earlier diagnostic observed 41 at **both** logical dispatch and transport,
so the unchanged session's timer/slot behavior also contributed. Checking
actual handler admissions addresses that distinction.

### No-op and failure cleanup

Carry the referenced migration pattern's cleanup across all exits, including
GET/decide/MULTI/SET/EXEC errors and refusal. Same-step Start and irrelevant
Pause should unwatch and return current state without an identical SET.
Identical writes can create unnecessary WATCH conflicts; avoiding them is an
implementation detail, not an unresolved data-loss finding. Test no-op cleanup
and no state mutation alongside the planned refusal/error tests.

The legacy audit runs on an effective Start after pause/completion. Starting
an already-running same step is a no-op and must leave `skipTracked` absent
for a pre-fix runner, so the eventual audit remains pending. Do not mark legacy
tracking adopted merely because the new worker reads that state. Reset run
counters for a fresh audit/run; preserve current-board counters on ordinary
audited Resume.

### Archive the final implementation

The release-copy procedure (plan lines 222–232) should archive the final
committed implementation SHA after all five fixes, and record that SHA with
the results. `git archive HEAD` omits uncommitted and untracked implementation
files. No proposed fixes are present at the currently reviewed HEAD.

Checking `damaged_row` is useful, but also verify a compaction server/UI
sentinel or relevant bundled behavior, so a copy containing only the sweep
fix is not mistaken for the complete implementation. Preserve the normal
Vite build checks for debug replacement, entrypoints, cache-busting and client
source-map exclusion. The copy isolates source/output; linked dependencies
may share tool caches. Avoid claiming byte-for-byte isolation of every file
under the original `node_modules`.

The attachment says the future isolated build was approved. It does not
provide completed build evidence, and no build was run during this re-check.

### Bound the damaged-copy preservation claim

Fix 2 still deliberately deletes an unreferenced Blob body that cannot be
decoded as a run (plan line 85). Referenced objects are kept by key, and
missing-link rows with usable identity metadata protect matching intact full
Blob copies. Normal archive writes verify upload/readback/decompression,
exact text and SHA before creating a stub.

That is coherent for preserving usable archived runs; it is not a promise to
retain all uninterpretable bytes for forensic recovery. Narrow the “never
deletes a copy that a damaged row may need” heading/claim to that scope if
delete-on-decode-failure remains intentional. This is a scope clarification,
not a newly demonstrated game-readable ghost loss or a requirement for a new
quarantine system.

## Controlled rate-gate validation

Built a small **external model** of the proposed shared gate and one-attempt
strategy, using the installed actual `@devvit/blob` `newS3Client()` and the
application's unchanged Blob adapter. Config RPC and HTTP transport were
stubbed. The check/reserve/delegate step was synchronous and each wait reread
the test clock.

**Five tests passed:**

- 120 concurrent signed requests with wait jitter `[-2, +5, 0]` ms:
  closed-window peak 40; virtual elapsed 2007 ms.
- The same with `[+5, -2, +5]` ms: peak 40; elapsed 2007 ms.
- The same with zero jitter: peak 40; elapsed 2002 ms.
- A controlled HTTP 500 reached transport once and preserved the original
  service error and `attempts: 1`.
- A caller aborted while waiting at a full gate was never delegated.

Authorization headers and Devvit's private installation prefix were checked
in the concurrent cases. Early timers in the model still allow time to move
forward; a fake clock that never advances cannot prove a wait algorithm.

These tests establish that the described approach can meet its bound, not
that the application already implements it. Keep the SDK/factory regression
in the eventual implementation, and run the planned application tests and
release build after the changes. No full repository suite or release build
was rerun in this plan-only re-check.

## Devvit sources and limits

The official `devvit-docs` skill cache script verified the fresh matching
Devvit 0.14 documentation checkout at
`reddit/devvit-docs@c822bd5624677dbcfcd8480624452db4927d39a1`; skill checkout
`reddit/devvit-skills@71ce34c6bec0d6f7c2f2c4cb7d70c509013bcbae`.
Relevant repository-relative files/sections:

- `versioned_docs/version-0.14/capabilities/server/redis.mdx`, “Shared state,”
  “Hash” and “Transactions”: WATCH conditional execution, returned-cursor
  traversal and early-exit cleanup. No documented WATCH-to-EXEC lifetime or
  global HSCAN order was assumed.
- `versioned_docs/version-0.14/capabilities/server/blob-storage.mdx`, “Limits
  and quotas” and “Adding blob storage”: 100 requests/s, supported commands and
  private installation-scoped client.
- `versioned_docs/version-0.14/guides/tools/vite.mdx`, “What it builds”:
  configured client entrypoints and single bundled CJS server.

The SDK probes provide retry/middleware evidence not specified by the Devvit
docs. Hosted capability access, real WATCH conflicts, aggregate throughput,
upgraded move–restore behavior and current production execution state were
not newly verified. No application source or permanent tests changed.

## Re-submitted attachment check

The subsequently supplied attachment `8fbaf2c3-45a7-49f5-998e-a5d49164c0c7`
is byte-for-byte identical to the reviewed revision 3 attachment
`ed3e842f-52df-4200-8ae5-0664e813946e` (`diff -u` returned no differences).
Repository HEAD is still `ceb29c01a1acb6a3be2af379fa1a6ae454b5a1fe`.
The verdict and implementation details above remain unchanged. No additional
SDK tests or build were needed for an identical plan; only this review note
was added.
