# Instant race start and named-track server loads: plan review

Reviewed October 1, 2026, on `challenge-share-buttons`, HEAD `87eab8bc`.
Source: the user-pasted four-stage plan, compared with current code and the
race-start investigation and Creator consistency reviews. This is a plan
review. No application code or existing tests were changed. The existing
dirty `game/track/grounds.js` and untracked investigation report were kept.

## Verdict

The cached-Daily diagnosis is supported, and loading stored tracks by key is
a useful server improvement. Revise the client prerequisite and the lazy
server consistency contract before implementing the stages. In particular,
removing the confirmation await does not establish that Start uses the right
layout, and the proposed resolver exception does not protect every response.

The plan's first stage also conflicts with its stated goal: calling
`ensureStoredTracks` in the background from Start still calls the server from
Start. Define the target as no track-definition fetch or wait for a prepared
selection. Campaign start stamps, analytics, and optional ghost requests
remain separate existing work.

## Clarified entry-point loading requirement

In the follow-up, the user specified that each entry point must prepare its
likely race targets during the existing loader, with the remaining tracks
loading in the background:

| Entry point | Tracks required before the loader completes |
| --- | --- |
| Head to Head post | The track named by the resolved challenge |
| Daily entry | The post-bound Daily track for a dated post; the current Daily for the stable launcher |
| Campaign launcher | The latest unlocked stage in the launcher's target series |
| Lobby launcher | The Daily track and the latest unlocked Campaign stage |

This is a sensible loading policy. Resolve the authoritative mode contract
and player progress first where necessary, confirm the required definitions,
and prepare their collision runtime and race canvas before enabling their
race actions. Start then adopts prepared state and begins the countdown
without fetching or confirming track geometry. Existing start stamps,
analytics, and optional PB-ghost work may still occur independently.

Current direct-mode startup already has a selected-contract/track barrier
(`game/startup/coordinator.js`, `game/engine.js:718-825`). Home currently
selects `DEFAULT_TRACK_KEY` (`game/engine.js:783-789`) and warms Daily and
Campaign after loader dismissal (`:728-731,999-1035`); that differs from the
new requirement. The Campaign target must come from confirmed unlock state
for the correct series. The current selector prefers `lobbyState.nextStage`
before the last unlocked stage (`game/campaign/engine-methods.js:206-210`),
so verify it matches the user's latest-unlocked rule.

The policy needs a few explicit boundaries:

- A player can select a different track before its background load finishes.
  Promote that selection to foreground preparation and keep the visible
  surface with a preparing/retry state until it is ready. Immediate Start
  can be promised for prepared targets, not every possible selection.
- Background work must not occupy the required target's network/CPU path or
  evict its prepared assets. Runtime and canvas caches hold eight and seven
  entries respectively (`game/track/assets.js:8-10`). Fetch remaining
  definitions in the background; prepare expensive race assets selectively,
  especially for the selected card and Campaign Next, while preserving the
  required targets. Only one track should be installed as the active race.
- Lobby now waits for two required preparations, so its loader depends on the
  slower one. Fetch independent data concurrently and provide retry for a
  failed required target. Failure of an unrelated background track should
  not undo an already ready target.
- Readiness belongs to the particular confirmed definition and asset options.
  A Daily rollover, new unlock, resolved post fallback, or changed layout can
  change the target. Recompute and prepare it while preserving the current
  surface; late background responses must not switch the active race.

This clarifies the client requirement; it does not remove the server lazy-load
consistency and consumer-inventory corrections below. No implementation was
requested or performed in this follow-up.

## 1. Keep confirmation as a ranked-start prerequisite

`game/track/race-definition.js:17-23` compares the attempt with the latest
locally loaded definition. It does not check whether confirmation succeeded.
While a request is pending, or after it fails, the bundled definition can
still be the latest definition and the guard returns null. A later different
answer invalidates the attempt; a failure leaves the client unaware of the
difference. Server verification protects authoritative results, but does not
prevent the player racing the wrong course and losing that attempt.

Locking does not prove the bundled definition equals the stored one. Existing
unlocked app-key copies can be edited before placement; the normal save path
rejects already locked tracks, not all existing app-key copies
(`src/server/tracks/track-store.ts:387-397`).

Move confirmation to lobby preparation. Keep the selected race visibly
preparing or retryable until its authoritative definition is ready. Preserve
the existing failed-confirmation blocking contract in
`tests/stored-track-race-correctness.test.js:232-248`; update its trigger to
the preparation flow rather than replacing it with unconditional starts.

A temporary probe used the actual Daily start handler with the proposed
nonblocking helper. Start ran and the stale guard returned null before the
answer; resolving a different layout then returned the changed-track error.
This reproduces the missing prerequisite without editing source.

## 2. Background preparation needs a selected-track readiness contract

The prewarm waits for idle and is fire-and-forget
(`game/daily-challenge/engine-methods.js:422,442`). Selecting a card and
immediately pressing Start can beat confirmation, the definition import, and
asset preparation. A Redis-only key still awaits its loader inside
`game/track/client-registry.js:90-93`. Asynchronous hydration of all cards does
not eliminate this case.

Track readiness must cover the selected confirmed definition, runtime,
canvas, quality/frame-skip options, and race presentation. Start should use
that prepared selection; pending or failed preparation must stay visible.
Recheck selection/surface/status after each asynchronous wait and catch
confirmation failures. A resumed swipe must invalidate queued preparation
before asset building; the current prewarm checks occur only before loading
the definition (`daily-challenge/engine-methods.js:415-427`).

Begin batch confirmation before initial carousel painting. The cached path
paints before the seven-card branch (`daily-challenge/engine-methods.js:877-883`),
and `TrackCarousel.render` immediately calls `loadClientTrack` for every
missing card (`game/ui/track-carousel.js:326-334`). With custom keys, adding
the batch after this paint can join multiple already-started per-key requests
instead of sending one batch.

## 3. Preserve the visible surface through reset, then fade

Moving `beginRaceStartTransition` after `loadTrack` is insufficient by itself.
The start callers pass `showStartOverlayOnReset: false`; `loadTrack` forwards
it to `reset` (`game/track/engine-methods.js:170-175`). Reset hides the lobby
(`game/race/engine-methods.js:974-978`). Today the already-pending transition
prevents that hide (`game/race/ui-start-overlay.js:105-106`). After the
proposed reorder, the later transition sees `display: none` and returns
immediately (`ui-start-overlay.js:77-80`). A second temporary probe reproduced
that sequence using the real reset and overlay methods.

Install/reset the selected track while preserving the current lobby, ensure
the new canvas is painted, then begin the exit. Reset only requests a future
frame (`race/engine-methods.js:988`), so a mocked `loadTrack` order assertion
does not prove the first visible frame. Head to Head currently has no exit
transition call; adding one is separate from reordering Daily and Campaign.

Campaign Next has an earlier exposure too: `startCampaignNextStage` resets
and closes the finish before unlock verification/preparation
(`game/campaign/engine-methods.js:1088-1094`). Keep that finish visible while
Next prepares. Prepare both when Next is already unlocked at finish and when
verification later enables it (`campaign/engine-methods.js:1351-1354`). That
later path does not rebuild the finish. Use the shared helper with
`requireModal: false`, because its default requires the Daily playlist modal.

## 4. Guard response descriptions and map failures consistently

Stage 4's resolver exception will not protect
`describePlacedStoredTracks`: it reads the entry map directly and returns an
empty array for unloaded entries (`src/server/tracks/track-store.ts:170-177`).
The client treats an explicit empty built-in answer as authoritative absence,
removes its override, and confirms the app definition
(`game/track/stored-track-service.js:67-69`).

Descriptions must use the guarded resolver or assert that each indexed key
was successfully loaded at its expected revision. Never emit an empty
authoritative answer for an indexed but unavailable key.

Also make the new error produce the promised retryable 503 throughout the
named-track routes. Most current catches return generic 500, including Daily
submit/snapshot, Campaign start/submit/ghost, and several Head to Head routes
(`competition-routes.ts:121-137`, `campaign-routes.ts:83-130`,
`head-to-head-routes.ts:156-216`). Middleware cannot catch an error later
swallowed by a route handler.

## 5. Validate lazy record reads, not only the index/series gate

Currently the track records are read inside the paired before/after revision
check (`src/server/tracks/stored-catalog.ts:62-76`). Keeping that gate around
only index/series loading does not validate record reads moved into routes.

Pin the track index/cache view alongside the request's published series
(`src/server/campaign/series-store.ts:134-153`). Validate every fetched record
against the expected per-key revision. If a save or placement changes it,
refresh/retry within a bounded budget and fail retryably if consistency cannot
be established. Do not omit the record or label a normal intervening write as
corruption. Prevent older delayed reads from replacing newer cache entries,
and permit successful sparse loads to add entries at the same catalog revision.

Extend the existing consistency tests to writes during a lazy fetch,
publication between gate and fetch, concurrent requests with different pinned
views, and indexed missing/malformed records. The old pair gate alone is not
proof that the new record-loading design is consistent.

## 6. Load dependencies before services use them

The route inventory must include earlier and indirect track reads:

- Campaign bootstrap repairs progress before its response hook. The hook at
  `src/server/routes/campaign-routes.ts:27` executes after bootstrap at
  `:60-65`; repair reads medal thresholds at
  `src/server/campaign/campaign-store.ts:239,646-651,772-775`. Load the selected
  series tracks before repair, and additional response-series tracks before
  building the payload.
- Player bootstrap and progress selection need Daily/Campaign track data.
  Daily chooser counts read tracks at `daily/daily-gp-store.ts:1505`; transfer
  classification reads them at `campaign/campaign-store.ts:1163`. After
  `reloadPinnedCatalog` at `daily-gp-store.ts:2348`, load the frozen/current
  transfer inventory before classification or writes.
- Daily selection reads schedule candidates before it knows today's key.
  `daily/daily-schedule-store.ts:75` uses `hasTrack`, and
  `daily/daily-gp-store.ts:844,852,869-872` reads candidate ground through
  `TRACKS`. Load candidates first, or make existence and ground available as
  metadata without requiring full geometry. A selected-key load afterward is
  too late.
- Head to Head browsing reads `TRACKS` inside `parseCard`'s blanket catch
  (`head-to-head/head-to-head-catalog.ts:133-166`). An unloaded-key exception
  becomes null and silently removes a valid card from browsing (`:296-299`).
  Load candidate keys before track-dependent parsing or rethrow the guard.
  Include this branch and moderator catalog sweeping in the inventory.

Giving each route fixture one stored track is useful but cannot reliably find
these branches: mocks can skip the service, and catches can suppress the
guard. Add service-level cases for these concrete consumers.

## Stage 3 assessment

The exact `GET /api/tracks/stored` middleware exemption is sound for normal
records: the handler reads its requested records directly and does not need
the resolver or series. Parallelizing independent record batches is also
reasonable. Real thrown Redis failures remain errors.

The no-index target has a limit: `readRecords` already skips missing/malformed
records (`track-store.ts:192-195`), and `readPlacedStoredTracks` returns an
empty array for them (`:280-286`). This is existing behavior, not a newly
proven bypass regression. If the plan promises never confirming a damaged
indexed override as app geometry, add key-specific index membership/revision
evidence and reject inconsistency. A missing record alone does not establish
that no override exists; the test budget must include that evidence.

## Recommended staging and verification

Implement the direct-record endpoint optimization independently. Ship lobby
confirmation, selected-track readiness, runtime/canvas preparation, and
surface-preserving transition together before removing the Start confirmation
wait. Keep the broad lazy-server change separate, with the consistency and
consumer inventory above specified first.

The `:5173` mock Daily test can verify visual timing, but its no-track-request
assertion cannot verify moved confirmation: the existing helper already skips
localhost and mock Daily (`game/track/engine-methods.js:24-25`). Add a
hosted-like real-service test with seven persisted cards, delayed/failed
confirmation, immediate Start, custom keys, and successful Retry. Verify the
actual reset/render/transition integration and the later Campaign Next unlock
path. Phone and hosted latency remain acceptance checks after implementation.

Current-checkout validation:

- `npx tsc --noEmit`: passed.
- Full `npx vitest run` with JSON reporter outside the loopback restriction:
  3,799 passed, 2 failed, across 310 files. The two failures are
  `medals.test.js` (ordered thresholds) and `track-runtime-integrity.test.js`
  (appended registry expectation), matching the plan's stated baseline.
- The first sandboxed run had loopback permission failures; the permitted
  rerun resolved them. They were not product failures.
- Two temporary client probes passed and reproduced the plan gaps in items
  1 and 3. Source and existing tests were unchanged.
- JSON report: `/private/tmp/dailygp-race-start-plan-review-tests-unrestricted.json`.
  Probes: `/private/tmp/dailygp-race-start-plan-probe.test.js`, using
  `/private/tmp/dailygp-race-start-plan-probe.config.mjs`.

No implementation, build acceptance, phone playtest, or hosted Redis latency
claim is made by this plan review.
