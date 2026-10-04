# Revised instant race start plan review

Reviewed October 1, 2026, on `challenge-share-buttons`, HEAD `87eab8bc`.
Source: the user's revised five-stage plan and the preceding clarification of
entry-point priorities. The implementation is unchanged from the first review.
No application code or existing tests were changed. Existing dirty ground
settings and the earlier investigation/review documents were preserved.

## Assessment

The revision addresses most first-review findings: loader targets, confirmation
before ranked racing, selected-card preparation, late Next unlocks, synchronous
first drawing, guarded descriptions, route error mapping, and the wider server
consumer inventory. Keep that structure. Make the targeted corrections below
before implementation; several concern guarantees the new plan states more
strongly than its described mechanisms support.

## 1. Readiness must guard engine actions, with a usable Retry

The statement “A disabled Start can't run” does not cover the existing direct
actions. Daily Tracks invokes `handleStartDailyChallenge` directly
(`game/daily-challenge/engine-methods.js:803-809`); Campaign Tracks invokes its
start path (`game/campaign/engine-methods.js:699-708`). Standings/Improve also
calls these methods (`game/scoreboard/opponent-race-engine-methods.js:18-23`).

Specify an engine-side check of the exact resolved track/definition/options
before any reset or race-state mutation. Route unready alternate actions into
selection/preparation while preserving the current surface. DOM disabling is
the UI reflection of readiness, not its enforcement.

The current Retry Start is the same Start button with changed text
(`game/lobby/ui.js:830-835,941-953`). Keeping it disabled after failed
preparation makes recovery unreachable. Keep an enabled Retry action that
repeats preparation; successful preparation can then enable the race action.
This can reuse the existing button and respects the no-loading-label decision.
Make subsequent lobby rerenders derive disabled state from this same state;
current Campaign rendering independently enables unlocked stages (`:894-904`).

Add cases for Tracks, Improve/opponent actions, and failed preparation followed
by clicking the actual Retry button, not only direct preparation-helper calls.

## 2. Retain the prepared assets and install the same presentation

Preparing only the selected card and Next does not mean only two assets ever
enter the caches. Successive selections accumulate entries. The LRU limits are
eight runtimes and seven canvases (`game/track/assets.js:8-10`); trimming removes
the oldest (`:33-36`), and the getters rebuild an evicted asset (`:58-79`). A
readiness record of key/identity/options alone can outlive its cached assets.

Return an actual prepared bundle containing the confirmed definition, runtime,
canvas, presentation and options. Retain the bundles for the required startup
targets, current selected target and Next, with bounded ownership. Alternatively,
invalidate readiness on eviction and prepare again before enabling Start.
Remove the claim that the cache limits alone prevent priority-target eviction.

Resolve presentation from the target contract and confirmed ground after
confirmation. Install that same bundle, including on same-key presentation or
quality changes. Current `loadTrack` recomputes presentation from the engine's
`activeDailyChallenge` (`game/track/engine-methods.js:29-56`), and
`hasCurrentTrackDefinition` checks neither presentation nor quality options
(`game/track/race-definition.js:12-14`). An inactive Home target cannot rely on
the current engine state to supply its race look.

Add successive-selection eviction and same-key event-skin/default-presentation
tests. A temporary test reproduced both runtime and canvas eviction after nine
distinct selected keys using the actual caches.

## 3. Home needs independent preparation ownership

Scope request counters to obsolete UI selections, not every invocation of the
shared preparation helper. One latest-request counter would discard one of
Home's two required concurrent targets. Both independent preparations must
complete; only the selected installation may change active race state.

Home currently loads shared methods without Daily/Campaign mode methods
(`game/modes/runtime-loader.js:16-30`) and its initial contract is null
(`game/engine.js:749-778`). Explicitly obtain both runtimes/contracts without
activating either mode as an incidental preparation effect.
`prepareInitialCampaignLaunch({ prepareTrack: false })` still changes active
Campaign state (`game/campaign/engine-methods.js:566-568`). Preserve the existing
player-identity/progress prerequisite used by Campaign startup
(`game/engine.js:760-764`); Daily work can proceed concurrently with that chain.

Test both targets finishing in either order and Home remaining the active view
through loader dismissal. This is a helper/ownership clarification, not a
request for a second startup system.

## 4. Keep the finish modal through Next's first draw

The proposed reset option says it preserves the current overlay. Next also
needs it to preserve the finish modal: reset unconditionally calls
`this.modal.closeModal()` at `game/race/engine-methods.js:962`, before camera
reset and the render request (`:980-988`). Add explicit preservation for this
surface during installation, then close it after the synchronous new-track
draw. Only preserving StartOverlay does not meet the stated Next behavior.

For H2H startup, explicitly propagate transient preparation failures to the
intended loader Retry path. `loadChallengeLobby` currently catches them and
clears `activeHeadToHead` (`game/head-to-head/engine-methods.js:234-245`), rather
than throwing to the loader. Preserve deliberate unavailable/own-post behavior;
do not treat every returned lobby result as a prepared challenge.

## 5. Stage 1 must compare absence across both parallel reads

The proposed index/record reads are separate operations. Even though writers
update both transactionally (`src/server/tracks/track-store.ts:305-308`), the
index read can capture absence before creation/placement and the record read
can capture the newly placed record afterward. The plan's “Not in the index:
absent” rule would then incorrectly return an empty confirmation.

Confirm absence only when both the index field and raw record are absent.
Preserve raw presence before parsing; missing/malformed/revision or presence
mismatches should retry or return 503. This retains the two-call normal path.
Add a test for null index plus present placed record, as well as the existing
indexed damaged-record case. Parallelism alone provides no snapshot guarantee.

## 6. Retain freshness after contract discovery and the paired gate

Current Daily routes resolve their authoritative contract, then refresh the
catalog before describing tracks
(`src/server/routes/competition-routes.ts:78-83,95-99`). Replacing that refresh
with `loadStoredTracks` against the initial pinned index loses freshness if a
Daily is placed after middleware runs. A new key can be absent from that pin,
or an already cached entry can still be unplaced. Both cases skip the proposed
record-mismatch retry and can emit an empty answer.

Preserve refresh-and-repin after contract discovery/placement, or provide
equivalent catalog-revision evidence with the contract. The post-placement
refresh at `src/server/daily/daily-gp-store.ts:797` must update the future
request track pin as well as global cache state.

Also restore the explicit combined before/after track-and-series revision
check (`src/server/tracks/stored-catalog.ts:62-73`) when loading changed
index/series snapshots. Campaign publication changes both stores in one
transaction (`src/server/campaign/series-store.ts:425-427`). Lazy mismatch
recovery must refresh and repin that pair together, rather than refreshing
only tracks/index and retaining an older pinned series.

Add contract-discovery cases for newly indexed and previously cached unplaced
tracks, plus publication during index/series refresh. The warm single-call
claim describes only a gate that needs no additional refresh; include required
post-contract freshness and changed-snapshot validation reads in the budget.

## 7. Key plus record revision is not a permanent identity

Deleting a track removes its index field
(`src/server/tracks/track-store.ts:311-314`). Recreating it restarts the record
revision at 1 (`:427`). A cache keyed only by key and record revision can alias
an earlier incarnation; “higher revision always wins” can also prevent a
legitimate lower-revision recreation from replacing the deleted definition.

This is an existing defect that the proposed cache design would retain. A
temporary test used the actual save/delete/lock/catalog functions with the
existing Redis transaction test double:

1. Save an editable custom key at revisions 1 and 2, then load its cache.
2. Delete it, recreate different content at revision 1, then place it at 2.
3. Refresh the catalog without an intervening cache refresh during deletion.

Redis held the new locked record at revision 2. The cache returned the old
editable revision-2 definition, and its placed-track description was empty.

The sparse cache needs identity that survives key reuse. A conservative small
correction is catalog-generation-based invalidation of retained entries when
the catalog changes; a persistent per-key generation is another option. Do not
trust the same key/revision across catalog generations without lineage evidence.
Test recreation at identical and lower record revisions.

## Campaign target decision

The revised plan explicitly chooses the lobby default. That differs from the
user's preceding requirement of the latest unlocked track. The default prefers
the first unlocked stage without gold (`game/lobby/service.js:185-186`), then
the last unlocked (`game/campaign/engine-methods.js:206-210`). With stage 0 bronze
and stage 1 unlocked, it chooses stage 0.

If latest unlocked remains the intended requirement, use one latest-unlocked
selector for Campaign startup, Home preparation and initial lobby selection.
The first unfinished stage is a sensible alternative, but this is a product
decision change, not an equivalent implementation of latest unlocked.

## Verification performed

- Two temporary probes passed: asset eviction and stored-key recreation/cache
  aliasing. Files are in `/private/tmp/dailygp-race-start-revised-*.test.js`,
  using `/private/tmp/dailygp-race-start-revised-probe.config.mjs`.
- Application code and existing tests are unchanged at the same HEAD as the
  preceding full-suite check: 3,799 passed, two known failures; TypeScript
  passed then. That broad check was not repeated for this documentation-only
  review.
- `git diff --check` passed. No implementation, commit, browser acceptance,
  phone playtest or hosted Redis timing claim is made.
