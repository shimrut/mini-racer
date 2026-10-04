# Instant race start implementation review

Reviewed October 1, 2026, on `instant-race-start`, HEAD `f37949cf`.
Scope: Claude's ten implementation commits after `87eab8bc`, the revised
instant-start/named-track plan, and its earlier review. This is a diagnostic
review. Application code and repository tests were not changed. The existing
dirty `game/track/grounds.js` and three untracked loading-review documents were
preserved.

## Assessment

The implementation contains the main structural improvements: preparation slots
retain actual runtime/canvas references, Home prepares its two successful
targets concurrently, reset can preserve the lobby and finish modal, and the
new race is drawn before the transition. Server middleware loads the index
rather than every track record; descriptions enforce the unloaded-record guard,
index/record reads compare presence, track and series snapshots retain their
paired revision gate, and placement/response confirmation refreshes the pin.

The work does not fully meet the agreed readiness contract. Four reproducible
client defects or requirement gaps remain. One server consumer still loads more
tracks than its request needs, and the authoritative-load guarantee still has
an inherited concurrency gap described separately below.

## P1: Start and Next can run before preparation finishes

`game/track/engine-methods.js:65-68` enables Start when the layout is confirmed,
even if no definition, runtime or canvas has been prepared. The last commit,
`f37949cf`, explicitly changes eligibility to this weaker condition.
`readyRaceTrack` then waits for preparation at `:75-80`. Daily, Campaign and
Head to Head await this helper on their start paths. Campaign Next also enables
on this weaker predicate (`game/campaign/engine-methods.js:1138`), and its final
callback enables Next even after preparation fails (`:1145-1146`).

A temporary hosted-like probe used the actual confirmation service and client
registry, with a test-only delayed built-in importer. A confirmed `smallSteps`
card had no loaded definition or preparation record; `isRaceTrackReady` was
false but `canStartRaceTrack` was true. Start remained pending until the import
completed, then built both assets after the press. There was no track request
in this confirmed-key case. An unconfirmed direct start can still issue its
confirmation request through this same helper; the existing
`tests/race-start-instant.test.js:113-130` deliberately tests that behavior.

This preserves confirmation safety and the visible lobby, but violates the
plan's explicit requirement that Start perform no track fetch or track wait.
Eligibility and engine actions should require the exact prepared bundle or an
equivalently validated installed bundle. An unready direct action should
prepare/select without starting; a usable Retry should remain a distinct
recovery state. Update the new tests that currently endorse confirmation-only
eligibility and preparation during Start.

## P1: Home dismisses the loader after required contract failures

Both branches of `loadHomeRaceContracts` catch failures and return null
(`game/engine.js:786-805`). The Daily call also omits the critical loader's
`throwOnError` option. `resolveInitialRaceTargets` omits a missing target
(`:826-842`), and `prepareInitialRaceTracks` installs the default track when
neither remains (`:852-856`).

A temporary probe ran the actual startup coordinator with both contract
requests failing. It called `onReady`, never called `onError`, prepared zero
targets, and loaded `circuit` with `prepared: null`. One failing branch similarly
allows startup with only the other priority target.

The plan requires both Home targets before loader dismissal and uses loader
Retry for failures. Propagate required-target errors and validate the complete
Home target set before reporting readiness. Deliberately unavailable modes
would need an explicit product state rather than treating network failure as
successful readiness.

## P2: Same-key starts ignore a prepared presentation or asset-option change

Daily obtains the exact prepared record, then only installs it when
`hasCurrentTrackDefinition` fails (`game/daily-challenge/engine-methods.js:749-763`).
Campaign and Head to Head use the same pattern
(`game/campaign/engine-methods.js:827-847`,
`game/head-to-head/engine-methods.js:345-359`). That predicate checks definition
identity and canvas presence, not presentation or asset options
(`game/track/race-definition.js:12-14`). The installed-track readiness fallback
also omits these checks (`game/track/engine-methods.js:57-60`).

A temporary probe prepared the desert Daily bundle for `kettleRun` while a
plain bundle for the same key was installed. Daily Start entered countdown,
never called `loadTrack`, and kept the plain canvas and presentation despite
the ready desert bundle. `applyDailyChallenge` does not refresh the canvas.
A second probe changed quality after installation: the preparation module
correctly invalidated its record, but the engine still reported readiness and
returned the old installed assets.

Install the matching bundle when presentation/options differ even if geometry
and key match, and validate the installed bundle with the same readiness
criteria. These probes use asset-builder stand-ins to identify which bundle is
installed; they do not establish screenshot or phone acceptance.

Current player exposure is much narrower than the generic reproduction:
generated and parsed server Dailies both force `skin: 'default'`
(`src/server/daily/daily-gp-model.ts:232`,
`src/server/daily/daily-gp-store.ts:697`), as do Campaign and Head to Head.
The desert-vs-default scenario is largely dormant in ordinary current play;
it becomes relevant if event-specific presentations are reintroduced.
Quality/frame-skip values currently distinguish cache/readiness keys but do not
change the actual geometry/canvas construction. The quality probe establishes
an inconsistent readiness contract, not a demonstrated current visual-quality
regression.

## P2: Repeated settles cancel preparation for an unchanged card

`prepareSelectedRaceTrack` increments its cancellation token on every call
(`game/track/engine-methods.js:99-107`). For the same slot, key and challenge
object, `prepare` reuses an existing pending promise
(`game/track/race-preparation.js:125-127`). That promise retains the first call's
predicate. The new token makes it false, so the slot is deleted and the build
returns null (`:94-96`).

A temporary probe called the selection helper twice for the same card during a
delayed definition load. Both preparations returned null, with no asset build
and no error. The carousel can schedule another settle even when the selected
index does not change (`game/ui/track-carousel.js:954-984`). Preparation then
has to happen at Start under the current relaxed eligibility.

Preserve cancellation ownership for an identical pending target, or update the
predicate retained by a deduplicated preparation. Notify readiness listeners
when a slot is cancelled so the UI reflects that state.

## P2: A one-day PB request loads unrelated playlist definitions

`getServerPlayerTrackPbSummaries` obtains the whole Daily playlist before
iterating the requested challenge IDs
(`src/server/player/player-account-store.ts:270-286`). The changed playlist
service now loads every playlist track
(`src/server/daily/daily-gp-store.ts:1286`). A request naming one day therefore
loads up to seven definitions on a cold cache, and an unrelated damaged track
can prevent that day's PB response.

This is a source-traced new dependency, rather than a separate route-level
reproduction. Separate contract discovery from definition loading so the PB
consumer loads only its requested challenge tracks. The same contract-only
playlist need applies to other consumers that do not inspect geometry.

## Remaining inherited authoritative-load gap

The named Daily service discovers a stored contract and calls `loadStoredTracks`
without refreshing the request pin
(`src/server/daily/daily-gp-store.ts:812-816`). A key absent from that pin is
skipped (`src/server/tracks/track-store.ts:328-332`), so it cannot trigger the
mismatch-retry path.

A temporary probe pinned an empty index, then simulated another request saving
and placing an edited built-in `circuit` and publishing its Daily contract. The
actual named Daily service returned the new contract, read no override record,
and `TRACKS.circuit` still resolved to built-in geometry. Active/playlist
response adapters refresh afterward, but Daily submit reaches
`submitCompetitionRun`, whose initial load repeats the same absent-pin skip
(`src/server/competition/competition-submit.ts:153`), before replay validation
(`:209`).

This interleaving was already possible at `87eab8bc`; it is an incomplete
authoritative-load guarantee, not evidence of newly introduced accepted corrupt
runs. Refresh/repin after discovering the authoritative contract before
track-dependent service work, or carry catalog revision evidence with the
contract. The probe proves wrong definition selection, not acceptance of a
wrong replay or its frequency in production.

## Product impact and estimated likelihood

Follow-up assessment at the same HEAD. These are conditional estimates from
code and reproductions, not measured production rates. Priority labels above
reflect the promised behavior and impact; they are not frequency measurements.

| Finding | Player scenario and impact | Estimated exposure |
| --- | --- | --- |
| Preparation during Start/Next | Swipe to a track and immediately press Start, or press Next before its preparation finishes. The button responds with a wait while loading/building completes. The lobby/finish screen is retained. | Most plausible in ordinary fast navigation, especially for an unvisited track or slower loading/device. A successfully preloaded initial target is protected. |
| Missing Home target | Open Home when either required mode request fails. Home becomes visible while that mode is not ready; entering it may require another load or recovery. Background work may recover it. | Conditional on request failure; low on a healthy connection, greater during poor connectivity or backend trouble. This is mainly a partial-availability/recovery product decision. |
| Same-key appearance mismatch | Start a different event appearance of the same layout; the previous appearance persists. | Largely dormant with today's default-only server contracts. Does not establish racing on different geometry. |
| Identical Daily selection cancels preparation | A Daily card settles twice while its load is pending, such as another nudge that ends on the same card. Preparation is silently cancelled, so Start must do it later. | Timing dependent; plausible with slow loads and repeated scrolling. A single completed preparation is unaffected. The exact frequency of duplicate settles has not been measured in a browser. |
| Extra PB track loads | Ask for one day's personal best on a server where other playlist definitions are not cached. Extra reads can delay that response; a damaged unrelated definition can make it fail. | Extra work is expected in that cold-cache condition; warm cached records avoid the reads. The unrelated-record failure is a separate rare dependency scenario, not a demonstrated common outage. |
| Inherited stale catalog snapshot | A request starts before another request creates/places an override, then discovers the newly published Daily before finishing. The server can validate against the wrong definition. | Very narrow concurrency window around publication. Potential rejection/validation mismatch; no probe established acceptance of a wrong score or production frequency. |

For product prioritization, address the Start readiness and Daily cancellation
together. Decide explicitly whether Home may open with only one mode ready.
The appearance case has low current exposure. PB loading is an efficiency and
failure-isolation improvement. The catalog race is rarer but deserves a
correctness guard because it reaches ranked validation.

## Additional boundaries and documentation

- The new index identity contains `revision:createdAt`. An actual
  save/delete/recreate probe with an identical injected creation timestamp
  reused the cached old definition. Ordinary sequential network writes will
  normally have different timestamps; this limits the claim that the value
  can never repeat. A persistent generation would provide that guarantee.
- The existing shallow record parser accepts an indexed record with `track: {}`
  and missing lock metadata. The new direct-track read returned an empty list
  in a temporary probe rather than 503. The parser weakness predates this work;
  malformed JSON and index/revision mismatch are already covered correctly.
- Claude's implementation commits contain no documentation updates.
  `docs/system-change-map.md:801` still states that Home loads the default track.
  Record the eventual corrected readiness/loader contract there after fixes.
- Campaign uses the lobby default: the first unlocked stage without gold, else
  the last unlocked stage. That matches the revised plan, but differs from the
  user's earlier latest-unlocked requirement. It remains a product decision,
  rather than an equivalent selector.

## Verification

- `npm test -- --reporter=json
  --outputFile=/private/tmp/dailygp-claude-race-loading-review-tests.json`:
  **3,843 passed, 2 failed, 3,845 total across 314 files**. The failures are the
  same baseline cases previously checked at `87eab8bc`:
  `tests/medals.test.js` ordered thresholds and
  `tests/track-runtime-integrity.test.js` registry extension. The command's
  pretest TypeScript check passed.
- `npm run build`: passed, including production client/server bundles. It emits
  the JSON import-attribute consistency warning for `game/campaign/series.json`.
- Client temporary probes: **3/3 passed**, asserting the unbuilt Start,
  swallowed Home failures and identical-selection cancellation outcomes.
  Files: `/private/tmp/dailygp-client-implementation-audit.test.js` and matching
  `.config.mjs`. Definition imports are delayed through a test-only Vite
  transform; asset builders are stand-ins.
- Same-key/options probes: **2/2 passed**. Files:
  `/private/tmp/dailygp-same-key-preparation-audit.test.js` and matching
  `.config.mjs`. Actual preparation, registry and Daily start methods are used;
ancillary engine UI methods and asset builders are stand-ins.
- Server probes: **3/3 passed, 15 unrelated tests skipped**. Files:
  `/private/tmp/dailygp-implementation-server-review.test.js` and matching
  `.config.mjs`; run with `-t 'implementation server review reproductions'`.
  These use actual services and the repository Redis transaction test double.
- `git diff --check`: passed. No deployment, hosted Redis timing, browser visual
  acceptance or phone playtest was performed.

Passing targeted probes reproduce the stated bad outcomes; they are diagnostic
tests, not regression tests proving fixes. This review document is the only
repository file added by the review.
