# Campaign aggregate leaderboard investigation — 2026-10-05

Status: implemented locally on `codex/campaign-finished-sharing`, with existing
WIP preserved in the full working-tree checkpoint requested on 2026-10-05.
See [checkpoint validation](./test-failures-investigation-2026-10-04.md#full-working-tree-checkpoint--2026-10-05).
The original feasibility analysis and its baseline
validation remain below as history. This describes local source and validation;
hosted player data and adoption runtime have not been measured.

## Correction after player report — 2026-10-05

The first implementation deliberately withheld every new board for ten minutes,
even a completed three-stage Creator series with only two finishers. Its extra
Refresh leaderboard action exposed that migration wait in the game UI. Both
choices were incorrect for the requested finish experience and are superseded.
Adoption now runs immediately, including previously saved wait states. A cold
three-stage Creator API regression proves its existing finisher is included and
the caller receives `ready: true`, rank #2/2 on the first request. The overall
place stat opens the shared board; only View Campaign, View Series and Share
Results remain in the action column. Requests recover automatically without a
manual refresh/retry action.

Correction validation: 285 focused checks pass; full Vitest completes 4,438 passed
and 2 existing medal-calibration failures across 343 files. Typecheck/build pass.
Desktop 1440x900, phone 390x844 and short phone 360x640 browser fixtures pass native
click/Enter on Overall place, board pagination, Back/focus and Results reentry,
with exactly three navigation/share actions and no runtime errors. Standard game
client still drives Campaign. Screenshots/text/errors were inspected. Hosted
Reddit/Redis and physical-device validation remain outside this local evidence.
Artifacts: `/private/tmp/dailygp-campaign-place-fix-*`.

## Implemented behavior — 2026-10-05

- Campaigns have an explicit `finalStageId`, using the existing stable race ID.
  Numbers ends at Endless Loop, `numbered-v1-16`; the other app series remain
  undesignated. `getCampaignFinalStage()` returns the matching published stage
  or null. The published tail of an ongoing Campaign never implies completion.
- Creator exposes **Final stage** only on the current draft tail. **Save**
  records the declaration; publication fixes it permanently. The authoritative
  series store separates draft `finalStageId` from internal
  `publishedFinalStageId`, exposing only the latter as the public endpoint.
  Publication may designate an already-live tail without adding another stage.
  Before publication the series can grow; afterward the server rejects endpoint
  changes and additional stages, retaining all existing stage/track locks.
  Undeclared legacy Creator series stay ongoing. Only an exact migrated app copy
  can inherit its explicitly designated app endpoint; Copy Check/Undo also check
  endpoint equality.
- `game/campaign/aggregate.js` derives **Total best time** from the saved full-race
  PB milliseconds on every stage of the fixed series. A confirmed medal on the
  final stage and a positive safe-integer time on every stage are required. The
  sum must remain a safe integer. PBs already include all required laps, so laps
  are not multiplied again. Missing or provisional times do not enter the score.
  Lower totals rank higher, with the existing ordinal ordering for ties.
  `progress.complete` remains the separate Gold/Author mastery condition.
- `src/server/campaign/campaign-aggregate-store.ts` stores one permanent sorted
  set per series, under `campaign:<series>:aggregate:v1:*`, with a standings
  revision and bounded adoption state. `campaign-store.ts` updates the score in
  the same owned transaction as its source progress. Accepted PB improvements
  on any stage, repair of missing/faster valid stage entries, and guest/account
  merge recompute that derived score. Discard, retirement and inactivity cleanup
  remove guest rows using the existing ownership/transfer fences.
- Authenticated `GET /api/campaign/aggregate` repairs the caller's canonical
  progress and returns a board only for an eligible finisher. An unpublished or
  undesignated endpoint is unavailable; a non-finisher receives
  `campaign_unfinished`. The snapshot contains the total, rank, finisher count,
  page, nearby/current-player rows and pagination state. It reuses public name
  preferences and a revision-keyed ten-second shared page cache. An aggregate
  has no single track, race opponent or PB ghost.
- Historic adoption scans the designated final stage's entry hash and reconciles
  saved series evidence under the same progress locks and transfer fences as
  online writes. Each invocation processes at most ten candidates. HSCAN COUNT
  is treated as a hint: surplus candidates remain queued; busy/transfer candidates
  remain pending for retry without starving fresh pages. Cursor, overflow and
  retry state persist until all retained candidates have been checked. The
  existing `runRacedListFill` scheduler also runs these bounded Campaign batches,
  so adopting existing finishers does not depend on their visiting this screen.
  Adoption starts on the first request with no wall-clock delay. Legacy stored
  `notBeforeMs` fields from the initial implementation are ignored, preserving
  their cursor, overflow and retry work so those boards resume immediately.
- While adoption is incomplete the API returns `ready: false`, the player's
  confirmed total, and no partial rank/rows. The summary starts its request as
  soon as it opens and shows Loading only while actual inventory/request work
  remains. Background requests retry automatically from two to fifteen seconds,
  including network failures, retaining the completion and total. Late responses must still match the active player owner, series endpoint
  and summary/standings session. Ranking availability does not delay accepting
  the race result.
- The completion summary shows **Total best time** and **Overall place**. The
  clickable Overall place metric is the only aggregate leaderboard entry, using
  the existing rank-stat button style. There is no extra Leaderboard, Refresh or
  Retry action in the navigation/share column. The board reuses the existing standings
  view, pagination and current-player highlight with a series title. Back
  restores the summary and Overall place focus without another celebration.
  The final-stage handoff is always labeled **Results**, including the first
  completion and a replay of an already completed final stage. Earlier-stage
  replays retain their existing actions. Stage Standings continue
  to show stage rankings.

Integrated validation: full Vitest completed **4,436 passed / 2 failed** across
343 files (341 passing), with only the existing missing-medal calibration failures
in `tests/medals.test.js` and `tests/track-grounds.test.js`. The first sandbox run's
loopback errors were environmental; the completed run allowed localhost. Typecheck,
production build and diff checks pass; the existing JSON import-attribute build
warning remains. Final summary/layout/style checks pass **50/50** after short-phone
spacing was tightened.

Local Chromium API fixtures passed at 1440x900, 390x844 and 360x640, exercising
pending/accepted Finished, total/place, shared pagination, series header,
non-raceable rows, Back/focus, final-stage Results reentry and both destinations.
Creator native checkbox/save/publication verified the fixed tail and disabled
Add stage. Standard gameplay client drove the final Numbers track. Screenshots,
rendered text and console errors were inspected; no browser runtime errors.
The summary's avatar, medals, metrics and all actions fit the tested short phone.
Hosted Redis/backfill timing and physical-device validation were not performed.
That implementation validation run made no commit, deployment or hosted data mutation.

Evidence lives under `/private/tmp/dailygp-campaign-aggregate-*`, including
`full-tests-final.log`, `browser-results.json`, `game-client/` and `build-final.log`;
Creator evidence is `/private/tmp/dailygp-campaign-final-stage-browser-results.json`.

## Revised requirement: a designated last stage

The user clarified that a Campaign must have a designated last stage. Finishing
and ranking must refer to that stable endpoint, rather than the last stage
currently published. This supersedes the proposal to rotate aggregate boards
when published stages are appended.

Implemented endpoint contract:

- Store an explicit final-stage identifier on the series, preserve it through
  Creator save/publication, app-series authoring and client/server manifests.
- Before the designated final stage is published, the Campaign can remain
  playable but cannot be finished or enter the aggregate leaderboard. An
  undesignated endpoint must not implicitly become the current published tail.
- Once the final-stage designation is published, freeze that endpoint and
  reject additions beyond it on the server. Existing published-stage and track
  locks continue protecting the race contracts before it.
- Completion requires a confirmed medal on that designated final stage. The
  aggregate additionally requires valid saved times for the entire fixed series.
- Use one permanent aggregate board per Campaign series. Current rank changes
  when PBs improve; adding content cannot change the ranked stage set.

The investigation baseline selected the published list's `.at(-1)` and allowed
appending/publishing additional stages. That behavior has now been replaced by
the explicit authoring and publication contract above.

The original planning estimate for endpoint designation/enforcement was **half a day to one developer day**,
including Creator/data propagation and focused regressions. The whole feature
was roughly **2–4 developer days** with aggregate persistence, UI and tests;
the fixed endpoint removes board rotation and extension migrations. Existing
records require an explicit endpoint assignment when adopting the new contract.
A one-time population of eligible historic finishers is needed only if such
players already exist for that designated final stage; hosted data was not read.

## Original feasibility assessment

The investigation assessed this as a moderate feature. Adding the player's total to the existing Campaign
finished screen is small; trustworthy overall place needs a new server-side
aggregate index. Existing Campaign standings rank one stage at a time.

Planning estimate: **2–4 developer days** for total, place, a paginated
leaderboard, later access, existing-player backfill, recovery/identity tests and
responsive verification. A total-only display is several hours. These are scope
estimates, not measured delivery times; hosted backfill duration depends on the
number of retained players, which this investigation did not query.

## Scoring and access rules

- Rank each finished series separately, such as Numbers. Do not combine
  unrelated Campaign series into one score.
- **Total best time = sum of the saved personal-best milliseconds on every
  stage through the designated final stage, once all are published. Lower is
  better.** Each saved stage time
  already covers its required laps; do not multiply by laps again. Sum integer
  milliseconds before formatting.
- Require the existing series-finished condition and a valid saved result for
  every included stage. Never treat a missing stage as zero. Normal progression
  already requires a medal on the preceding stage, but retained/recovered data
  still needs the explicit completeness check.
- Call the value **Total best time**. It combines PBs from different attempts;
  the existing data cannot reconstruct a first-playthrough total or the time
  spent racing/retrying the whole Campaign.
- Improving any stage PB improves this total, including after finishing. Overall
  place is a current position and can change when other players improve.
- Keep the current ordinal ranking behavior for equal millisecond totals rather
  than introducing a separate tie scoring system in this feature.
- Show **Total best time** and clickable **Overall place #X / Y** on the
  finished results screen. The aggregate leaderboard's only UI entry is
  that screen. Back returns to those results. Ordinary stage Standings continue
  showing stage rankings.

“Finished” means a confirmed medal on the designated published final stage
([manifest.js](../game/campaign/manifest.js)).
`progress.complete` means Gold/Author on every stage and is mastery
([campaign-store.ts](../src/server/campaign/campaign-store.ts), lines 576–592).
The aggregate should use ordinary finished status rather than mastery.

## Reuse identified in the original investigation

The line numbers in this historical evidence table refer to the investigation
baseline; current implementation is summarized above.

| Existing capability | Evidence | Reuse |
| --- | --- | --- |
| Full saved per-series PB map | `CampaignBestResult`, `parseBestResult`, and `publicProgress` in `src/server/campaign/campaign-store.ts`, lines 94–110, 182–220 and 576–592 | All inputs for the sum already exist. |
| Client normalization of integer PB milliseconds | `game/campaign/service.js`, lines 50–68 | Display a total from canonical results. |
| Dedicated finished-screen model and view | `game/campaign/finished-screen.js`, lines 14–40; `pages/game.html`, lines 453–480; `game/race/ui-modal-shell.js`, lines 1362–1425 | Add the two metrics and explicit leaderboard action. |
| Ranked name/time rows, current-player highlight, pagination | `game/race/ui-modal-content.js`, lines 543–725 | Reuse presentation and loading/error patterns. |
| Redis positional rank and paged standings primitives | `src/server/competition/competition-leaderboard.ts`, lines 242–248 and 391–479 | Use the same operations for a separate aggregate snapshot. |
| Owned progress transaction and identity transfer fencing | `src/server/campaign/campaign-store.ts`, lines 363–404 and 421–443 | Keep aggregate updates serialized with their source progress. |

The stage storage keys in
[`competition.ts`](../src/server/competition/competition.ts), lines 91–110,
are per race/stage. The snapshot route also accepts a `raceId`, not a series
aggregate (`src/server/routes/campaign-routes.ts`, lines 105–119).
At the investigation baseline there was no overall Campaign board to expose
with a UI-only change. The implemented aggregate has its own series API.

## Original implementation plan

The implemented behavior above follows this plan with the fixed endpoint and
final-stage-only summary reentry described there. This section preserves the
original design reasoning.

1. Add a small aggregate module with a shared eligibility/sum helper and one
   board per series with its frozen designated endpoint. Store one Redis
   sorted-set member per eligible player, scored by total milliseconds. Reuse
   profile lookup for public display names. A standings revision supports the
   existing short-cache pattern; a duplicate entry hash is unnecessary unless
   a breakdown or update date is actually shown.
2. Maintain that derived score inside the existing owned progress write, rather
   than issuing a detached write after releasing the lock. Two stage submissions
   must not overwrite a newer total with an older snapshot. Include progression
   repair and guest/account merge; remove guest rows on discard, retirement or
   inactivity cleanup. Recompute/upsert-or-remove from current saved evidence
   rather than persisting a client-supplied total.
3. Add a dedicated series-aggregate snapshot API/client adapter. Return the
   player's total, live place, finisher count, ranked rows and pagination. Reuse
   authenticated guest/account identity resolution and public name preferences.
   Keep this separate from a track `Competition`: an aggregate has no single
   track, lap count, PB ghost or Race Opponent action.
4. Populate existing eligible players before presenting ranks as complete. Use
   bounded cursor reads of the current final-stage **entry hash** as the
   candidate inventory; read/reconcile their saved series results and exclude
   medal-free or incomplete candidates. A sorted-set-only walk would miss
   retained accepted entries whose rank needs repair. Make the backfill
   resumable, recomputing under the same player locks/transfer fences as online
   writes. Registering only people who open the new screen would produce a
   ranking of visitors rather than all retained finishers.
5. Load aggregate data when the finished screen opens. Keep the saved completion
   visible if rank loading fails, with an in-place retry. Check player owner,
   series/layout and active modal before applying a late response. Do not let
   leaderboard availability become a prerequisite for accepting a race result.
6. Reuse the current leaderboard view with explicit series context and a
   finished-screen return target. Preserve focus and avoid replaying celebration
   sound/animation on Back. Add the aggregate keys to the existing moderator
   storage inventory.

Routine work is proportional to the stages of one player, not every finisher.
The sorted set supplies rank/page/count operations; do not recalculate every
player's total on each leaderboard open.

## Details that make this more than adding the numbers

### Original extension analysis — superseded by the fixed endpoint requirement

Creator publication exposes a fixed prefix; published stages are immutable and
new stages can be appended. The draft tail is hidden until published
(`src/server/campaign/series-store.ts`, lines 31–48 and 107–115;
`tests/server-series-store.test.js`, lines 116–135 and 266–282).

A 16-stage total must never compete with a 17-stage total. The original proposal
was to bind the aggregate
board to the actual published stage list/race contracts, including required laps
and rules. Publishing an extension selects a new board; eligibility then
requires finishing that extension. A name-only change or unpublished draft
should not reset ranking. Stored track locks protect published geometry; any
future permitted geometry/scoring change must also change ranking identity.
Reusing unchanged legacy stage PBs follows the existing Campaign validity rules;
this feature cannot reconstruct historical geometry evidence absent from them.
With the revised requirement, enforce the designated final stage and prevent
extensions beyond it instead of creating replacement aggregate boards.

### Original progress repair finding

The stage leaderboard saves before Campaign progress
(`src/server/campaign/campaign-store.ts`, lines 1003–1055). A failure can leave a
better accepted stage entry behind an older progress PB. At the investigation
baseline, bootstrap repair checked only **missing** rows and skipped an already present result
(lines 644–693, particularly 649–652 and 671).

For an aggregate advertised as the sum of saved PBs, reconcile faster valid
stage entries as well as absent rows, then publish the aggregate from the
reconciled canonical progress. Reuse the existing contract/identity validation,
including its compatibility policy for early retained entries
(`src/server/guest-transfer/board-merge.ts`, lines 17–35).
Neither an interrupted progress save nor failed PB-ghost persistence should
silently freeze an incorrect total or erase accepted progress. Retry and
backfill must converge to the same score under the owned lock.

### Original summary reentry finding — superseded

Canonical unfinished-to-finished confirmation grants the Results action
(`game/campaign/engine-methods.js`). Clicking consumes it. Replays of an already
finished series intentionally have no new celebration (`tests/campaign-ui.test.js`).

The initial design considered a **Campaign Results** action on every stage replay
of a canonically finished series. The implemented access rule is narrower:
**Results** is the final-stage button for both the first confirmed completion
and a later replay.
The player explicitly reopens the summary, whose Overall place metric remains the
board's only entry. Earlier-stage replays keep the existing game flow while their
accepted PB improvements still update the aggregate.

### Original shared-modal integration finding

`showRunsModal()` remembers only combined race results or the generic main view
(`game/race/ui-modal-shell.js`, lines 1831–1842); Back restores only those views
(lines 1996–2016). Add a finished-results return target.

`buildModalRunsPayload()` falls back to the current track when no track is supplied
(`game/race/result-flow.js`, lines 273–279), and the leaderboard header prefers
that track's name (`game/race/ui-modal-shell.js`, lines 2974–2995). Give aggregate
standings explicit series context so they are not titled after the final track.
Omit stage/day rails, single-race share actions and opponent-race controls.
The existing time formatter supports accumulated minutes
(`game/race/ui-modal-content.js`, lines 1045–1053).

## Original file scope and validation plan

Server: a new focused aggregate module, Campaign progress/cleanup/merge hooks,
Campaign routes and app wiring, plus the storage-usage inventory. Client:
Campaign finished model/engine/service, API route table, shared modal payload and
return handling, finished markup and CSS. No simulation or replay format change
is needed for a composite PB leaderboard.

Future regressions should cover integer sum/laps, incomplete and provisional
results, ordinary finish versus mastery, PB improvement on any stage, duplicate
and concurrent saves, board/progress partial commits, guest merge/cleanup,
existing-player adoption, progressive pre-final publication and endpoint freeze, stale owner/endpoint responses,
pagination/current-player place, series title, Back/focus and completed-series
reentry. Check the extra metrics/actions on small phone and short-height layouts.

Original investigation baseline run:

```sh
npx vitest run tests/campaign-finished-screen.test.js tests/campaign-ui.test.js tests/campaign-client-service.test.js tests/server-campaign-store.test.js tests/server-campaign-series.test.js tests/server-series-store.test.js tests/server-competition-leaderboard-cache.test.js tests/guest-transfer-campaign-validation.test.js tests/ui-leaderboards.test.js --maxWorkers=1
```

**9 files / 238 tests passed.** Fixtures emitted missing standings/ghost response
and analytics Redis-method warnings without failing. No tests or expectations
were edited. Log:
`/private/tmp/dailygp-campaign-aggregate-investigation-tests.log`.
This is baseline evidence, not validation of an implemented aggregate feature.
Full-suite, hosted Redis/player-data, backfill runtime and physical-device
validation were not performed.

Consulted `docs/system-change-map.md`, the existing Campaign finished-screen
investigation, Campaign series plan, multi-lap architecture, player Career
feasibility and test-failure investigation. Current code takes precedence over
older rules recorded in those documents.
