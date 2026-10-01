# In-game Mapmaker: player data and transfer review

Date: 2026-10-01. Branch: `ingame-mapmaker`.
Reviewed HEAD: `41cbc850a4be58ff324d3aa1a65ffe55dd4aec38`.

Scope: Creator tracks, Daily/Campaign placement, Copy/Undo, dynamic Campaign
catalogs, ranked-result recovery and guest/account transfers. This is a code
review. No runtime code or repository tests were changed. Existing dirty ground
settings, share images and earlier review/plan documents were preserved.

The current branch includes the catalog snapshot, failure gate and editor-save
fixes after the earlier review at `784fb905`. Findings from that old review were
not assumed to remain present.

## Confirmed findings

### 1. P1: cold Campaign startup deletes pending Creator-series PBs

`game/campaign/engine-methods.js:1236-1241` treats a missing local Campaign stage
as an invalid queued result and permanently clears that result. Creator series
definitions are not persisted with the client module: a fresh page starts with
an empty stored-series list. The definitions arrive only when Campaign
bootstrap registers `storedSeries` (`game/campaign/service.js:135`).

The startup order makes the failure reachable without a catalog publication
race. The startup coordinator installs the Campaign runtime first
(`game/startup/coordinator.js:31-32`). Campaign startup then awaits player
bootstrap before preparing its Campaign bootstrap (`game/engine.js:759-765`).
An authoritative player profile immediately claims/processes the queue
(`game/player/engine-methods.js:24-25,38-50`), and the shared processor enumerates
Campaign entries without waiting for Campaign data
(`game/scoreboard/engine-methods.js:142-160`).

Trigger: finish a Creator-made Campaign stage, retain a pending ranked save or
ghost recovery after a network failure, and reload into Campaign. The pending
entry has its race ID, track, time, lap count, rules and replay, but the local
manifest cannot yet resolve the race ID. Its time/replay is removed before any
submission request. A later bootstrap cannot recover an unsubmitted run.
Already accepted server results remain stored; an outstanding ghost retry can
still be lost. Transferred pending results are subject to the same missing
catalog check once they belong to the active account.

Local reproduction uses the real queue enqueue/read functions, profile queue
claim, shared queue processor and Campaign processor. It confirmed removal
from browser storage and zero fetch calls. The test resets the local series
registry to emulate a page reload while retaining localStorage.

Targeted correction: resolve/load the authoritative Campaign catalog before
processing a dynamic-series result. An unavailable or not-yet-loaded definition
must preserve the queued replay and retry; it is not evidence the stage was
deleted. Distinguish malformed entries from unresolved valid race IDs.

### 2. P2: a catalog refresh can interrupt an active transfer

`src/server/campaign/campaign-store.ts:1336-1348` enumerates the current live
series again after awaited reads and board writes. Earlier progress locks
(`1169-1175`) and progress maps (`1213-1225`) were captured from an earlier
series view. The live lists in `game/campaign/manifest.js` are dynamic proxies;
another request can update the shared install cache while this request awaits.

Trigger: another request loads a newly published Creator Campaign series while
the transfer is waiting on its stage reads. The final loop now sees the added
series, but its guest/account progress and lock entries do not exist in the
captured maps. `hasRecord(guestProgress)` throws while reading `startedAt`.

The actual merge function was reproduced throwing after Numbers progress had
already reached the account. The selection route maps a generic error to 500,
and the unresolved transfer remains pending. Guest source data survives and a
fresh retry succeeds. This is a transfer interruption, not established permanent
loss or damage to unrelated accounts.

Targeted correction: capture one coherent series/stage view for transfer locks,
source classification, reads, writes and cleanup. Establish its freshness after
the transfer fences both identities and drains writers; do not re-enumerate a
mutable manifest later in the same operation.

### 3. P2: series publication can break Campaign bootstrap or hide saved progress

`src/server/campaign/campaign-store.ts:680-688` loads the progress array in one
series order, then recomputes the selected series index from the live catalog
after the reads. `seriesSummaries()` similarly joins by position (`519-529`).

Publishing a copied hidden app series can insert it before an existing custom
series (`game/campaign/manifest.js:113-115`). A concurrent request may publish
that new catalog into the shared install cache
(`src/server/tracks/stored-catalog.ts:71-72`,
`src/server/campaign/series-store.ts:128-130`).

Reproduced catalog order: `[numbered-v1, custom-v1]` becomes
`[numbered-v1, snow-v1, custom-v1]` while the custom progress read waits.

- When the selected series is custom-v1, the new index points beyond the loaded
  progress array. Bootstrap throws while reading `campaignId`; the route
  returns 500.
- When Numbers is selected, the custom series summary returns zero medals and
  unfinished despite the saved Author result remaining in Redis.

These are response/availability defects; the reproductions did not erase the
saved result. Fixtures use unique custom track keys and complete track data.

Targeted correction: use a captured series list throughout bootstrap and join
progress by `campaignId`, rather than indices obtained from changing views.

## Qualified transfer cases, not counted as permanent data-loss findings

Additional fixtures supplied a transfer worker with a catalog older than saved
rows in another worker. They demonstrated an omitted new guest series, an
omitted appended guest stage followed by whole-progress cleanup, and a newer
account stage dropped from its progress record while its leaderboard row
survived.

The guest-loss fixtures do not establish the normal UI trigger: chooser
bootstrap sets the guest pending marker before selection
(`src/server/daily/daily-gp-store.ts:2036-2038`), preventing the proposed later
guest save. A direct store call with deliberately mismatched worker state is
insufficient to claim ordinary players permanently lose transferred results.

The account remains writable until selection fences it, so the account case
does expose a recoverable stale-catalog progress inconsistency. Its leaderboard
entry survives and ordinary bootstrap repair can reconstruct the result. It
reinforces finding 2's freshness requirement, without proving permanent loss.

An earlier progress update mentioned a completed transfer leaving results
behind; these qualifications supersede any implication that the guest-loss
fixture established normal UI reachability or hosted incidence.

## Safeguards confirmed

- Creator routes check moderator authorization; failed moderator lookup denies
  access. Test Drive uses its own draft/lap storage, without player-save APIs.
- `track-copy.ts:41-59` compares full track JSON and medal metadata, including
  track-wide and per-point corner rounding. Exact locked copies preserve race
  shape beyond the narrower PB fingerprint.
- `track-store.ts:386-405` rejects stale revision saves, changes to locked tracks
  and incomplete assigned tracks.
- `series-store.ts:308-320` preserves published ground and the existing stage
  prefix. Publication freezes tracks in its watched transaction; published
  series deletion is refused.
- `copy-undo.ts:132-154` removes only exact app copies, preserving the app
  fallback's geometry, medals and race identities.
- Shared catalog loading validates the combined track/series snapshot before
  publication. This addresses the prior inconsistent-cache and load-failure
  findings; it does not freeze the catalog for every longer-running consumer.
- Campaign stored results validate series/race/track/lap/rules ownership.
  Head to Head starts use authoritative challenge fields and stored tracks;
  absent local series registration alone does not break their initial start.

## Verification and limits

- `npm run typecheck`: passed.
- Primary focused run: 15 suites, 236 tests passed, covering catalog snapshots,
  track and series stores, placement/copies, transfer recording/recovery,
  Campaign/Daily source validation, Garage preservation and client layouts.
- Separate placement/copy/undo review: 9 suites, 81 tests passed.
- Separate transfer review: 6 suites, 125 tests passed. These suites overlap the
  primary run; their counts must not be added as unique tests.
- Parent independently reran 7 temporary reproduction tests: queue deletion
  (1), transfer/catalog cases (4, including the qualified cases), and bootstrap
  catalog-order cases (2). All asserted the documented outcomes.
- `git diff --check` passed. Only this new report was added for this review.

Temporary evidence:

- `/private/tmp/dailygp-mapmaker-queue-review.test.js` and
  `/private/tmp/dailygp-mapmaker-queue-review.config.mjs`.
- `/private/tmp/dailygp-mapmaker-transfer-review.test.js` and
  `/private/tmp/dailygp-mapmaker-transfer-vitest.config.mjs`.
- `/private/tmp/dailygp-campaign-catalog-repro/catalog.test.js` and its
  `vitest.config.mjs`.
- Primary output: `/private/tmp/dailygp-mapmaker-player-data-focused.log`.

Tests use real application functions with simulated browser storage or mocked
Redis/catalog interleavings. They prove these local behaviors, not hosted
Redis scheduling, production frequency, or deployment state. The full suite,
build and hosted browser smoke were not rerun for this read-only review.

Fix pending-PB deletion before adding the Career interface. The two catalog
operation issues should also be addressed before relying on live Creator
publication during player activity.

## Two-fix proposal assessment

The two-fix grouping is correct, with a transfer freshness qualification:

1. Preserve an otherwise valid waiting result when its stage is unresolved
   locally. Retry after the authoritative series definitions load, and retain
   it across load/network failures. A definitive server response that the
   Campaign race does not exist may terminate that retry; an arbitrary failed
   request or HTTP 404 is insufficient. Successful submission still follows
   the existing settlement/ghost-recovery rules.
2. Pin one immutable, coherent catalog view for every read within an operation,
   including stage lookups, progress parsing, locks, summaries and response
   definitions. A copy used only by the outer loop leaves nested live lookups
   exposed. This addresses both the transfer interruption and bootstrap
   ordering faults. For transfers, a request-start snapshot alone can omit an
   account result saved before the account pending marker is set. Establish
   catalog freshness after both identities are fenced and account for writers
   already in flight, before capturing inventory or copying/cleaning data.
   Alternatively, detect newer/unknown saved stages and stop safely for retry
   before changing their data. Hold that validated view stable thereafter.

Regression coverage must exercise each of the three faults, plus the transfer
freshness boundary: cold reload retains and later submits the waiting replay;
catalog load failure preserves it; authoritative race-not-found handling is
distinct; publication during transfer and bootstrap preserves a coherent view;
the next request sees the publication; and a newer account result before the
transfer fence is preserved or produces a safe retry. Concurrent requests must
not share one mutable request snapshot.

This assessment validates the plan only. No runtime changes or new repository
tests have been implemented.
