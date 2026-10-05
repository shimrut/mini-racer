# Campaign finished screen investigation — 2026-10-04

## Compact medal counts — 2026-10-05

The user replaced the proposed medal stacks with one count per Bronze, Silver,
Gold and Author tier. The finished summary now renders exactly four icons,
including zero counts, with the count inside each existing medal SVG and the
tier name below. It reuses `screen.medalDistribution`, which counts each stage
once at its saved best tier. Gold/Author stages do not also increment the lower
tier counts. The existing weighted medal total, completion eligibility, total
best time, ranking and three actions keep their existing contracts. View Series
retains the individual stage results. No API or persistence change is needed.

Local layout investigation reproduced the earlier crowding at the Creator
maximum of 50 stages: seven medal rows were 287px tall, and Share Results fell
below both 390x844 and 360x640 viewports. That per-stage grid and the single-medal
enlargement described in older entries below are superseded by the fixed row.

## Fixed endpoint and aggregate results — implemented 2026-10-05

Campaign completion now uses an explicit published `finalStageId`, never the
currently published tail. Numbers ends at Endless Loop (`numbered-v1-16`). The
Redis Creator can designate its current tail, save it, and publish the endpoint
even when that stage is live already. Before that publication the Campaign stays
ongoing and can grow; afterward its endpoint cannot change and no more stages
can be added. Missing endpoint fields on old Creator records do not seal them.
The earlier moving-tail completion proposals below are retained as history and
are superseded by this contract.

The saved completion summary adds **Total best time** and clickable **Overall
place**, which opens the aggregate leaderboard using the existing rank-stat
interaction. No extra leaderboard/refresh/retry action sits in the button column. Total best time is the integer-millisecond sum of each stage's
saved full-race PB, including its required laps once. Ordinary completion still
requires a confirmed medal on the designated final stage; aggregate eligibility
also requires a valid saved time on every stage. It is separate from
Gold/Author-on-every-stage mastery. Earlier-stage PB improvements update the
aggregate through the existing canonical Campaign progress write.

The summary starts `GET /api/campaign/aggregate` immediately and retains its
completion/total while ranking loads. Historic adoption runs bounded server
batches immediately; legacy wait-state fields are ignored. It returns
`ready: false` only while actual inventory/lock work remains, so Overall place
briefly reads Loading. Requests retry automatically from 2 to 15 seconds,
including failures. Owner, series endpoint and modal-session checks
prevent late responses from replacing another player's or Campaign's results.

The aggregate board is accessible only from the summary's **Overall place**
metric. It reuses the current standings presentation, pagination, identity rules
and player highlight, titled for the series. It has no stage rail, ghost or
opponent-race controls. **Back** restores the saved summary and focuses
Overall place without replaying the celebration. A confirmed replay result on an
already completed final stage offers **Results** to revisit the summary;
earlier-stage replay actions keep their existing behavior. The first completion
uses that same **Results** label for the confirmation-gated handoff and explicit
player control described below.

Implementation details and server adoption rules are in
[Campaign aggregate implementation](./campaign-aggregate-leaderboard-investigation-2026-10-05.md).
The prior validation records below describe their respective earlier revisions;
the current change's full-suite, build and browser validation is recorded in
the linked aggregate implementation note.

## Personal finish and sharing — 2026-10-05

Implemented on `codex/campaign-finished-sharing`, branched from
`codex/challenge-view-analytics` with its existing uncommitted work preserved.
Revised after the player-facing design and sharing review.

- A pending final-stage result reserves one greyed-out **Finished** button in place of
  Home/Next from the initial render. It stays disabled until canonical acceptance,
  then enables without changing the action layout. Local medal calculation and
  a temporarily unavailable bootstrap do not suppress this pending action.
  Rejection or an accepted result without a medal restores Home.
  A final-stage run still awaiting confirmation reserves the same slot on
  a slower retry. At this revision completed-series replays showed Home and kept
  the normal result; final-stage replays now expose Results as described above.
  The pending-action correction passes 132 focused tests. Local browser fixtures
  at 1440×900, 390×844 and 360×640 record no Home frames while confirmation is
  withheld or accepted; disabled opacity and enabled Finished are checked.
- The completion screen centers the existing Snoovatar in a circular gold frame,
  with the player name above the campaign victory lockup. Balanced stage-medal
  rows and a compact total keep the identity and achievement together. Secondary
  navigation uses equal-width stacked buttons; the red **Share Results** button sits
  last at the bottom and takes initial keyboard focus. No extra avatar fetch is
  added to Campaign entry; the shared Snoo/silhouette fallback remains in use.
- Sharing uses the game's existing preview, account disclosure, explicit confirm,
  posting, retry and success dialog. Opening **Share Results** prepares the
  server-authored **I finished the {series name} campaign** title and medal
  summary; it never posts. **Post Results** confirms publication as the shown
  player. Cancel/Escape before posting restores Share Results. Posting disables
  cancellation until the response settles; shared success offers Send Results,
  Copy Link and Done. Guest sharing uses the established sign-in explanation.
- `/api/campaign/share/preview` resolves authenticated ownership and reads only
  the requested series' saved results, including the existing repair path. It
  reuses `buildCampaignFinishedScreen()` for the name, stage count and highest
  medal distribution. A ten-minute token stores the exact preview and binds it
  to the Reddit account and community. `/api/campaign/share/confirm` accepts only
  that token, rechecks completion/current name and stage count, and publishes
  the approved snapshot. Client title/medal edits have no authority. The former
  direct publishing endpoint is removed.
- The Campaign entrypoint renders the completion poster with player identity,
  medal counts, **Overall place** when the ranking is ready, and **Play Campaign**.
  The place uses the same `#rank / finishers` figure as the finish screen. A
  later saved race updates that figure on the existing post when it changes.
  Sharing before the ranking is ready leaves the place off until a later save
  can add it. The exact series ID reaches expanded
  startup and opens the viewer's own last unlocked stage. Cold Creator targets
  survive until the catalog arrives; unavailable targets fail explicitly.
  Ordinary Campaign launch retains its existing behavior.
- One post is retained per player, series and community. The permanent pre-submit
  claim, authenticated author check and existing recovery protect concurrent
  confirmations and uncertain replies. Definite pre-post refusal or successful
  deletion of a wrong-author fallback can clear the claim; inconclusive recovery
  keeps it. The existing avatar cache is shared by the podium and Campaign paths.
- Shared-dialog regressions cover Escape cancellation, blocked dismissal during
  posting, and an old Head-to-Head Concede being unable to hijack Campaign success.

Validation of this revision: the six focused Campaign/modal suites pass **233
checks**; preview/confirmation server/client and route suites pass separately.
The full serial suite reports **4,374 passed / two existing failures** in
`medals.test.js` and `track-grounds.test.js` for missing medal thresholds.
Typecheck and production build pass with the existing JSON import warning.
Chromium fixtures pass at 1440×900, 390×844 and 360×640 for one- and 17-stage
completion layouts, pending/confirmed Finished, replay Home, shared preview,
Cancel/Escape, blocked Escape while posting, retry, success and both navigation
destinations. Screenshots, request bodies, focus and geometry were inspected.
The retry fixture's deliberate HTTP 409 is the only expected browser console
error. The standard game-client gameplay and text-state checks also pass.
Evidence: `/private/tmp/dailygp-campaign-revision-*`. Hosted Reddit/Redis posting
and physical-device checks remain unverified.

## Implemented handoff — 2026-10-04

- A submitted final-stage medal offers a disabled Finish while saving. The first
  canonical saved medal on that stage enables it. A rejected or medal-free
  confirmation removes the waiting Finish; a transient failure keeps it waiting.
- A late reply for an earlier attempt can add Finish to an open retry result for
  the same final stage, even if that result initially had no Finish. Confirmation
  while racing or after leaving the result still saves progress but does not
  retain a celebration for a later visit.
- Standings remain open if confirmation arrives there. Returning shows the
  result with Finish; there is no automatic celebration on confirmation or Back.
- Finish rechecks the owner, active Campaign stage, winning state and open result
  context and rebuilds against the published Campaign contract. The original
  moving-tail behavior cancelled a pending celebration when a new last stage
  went live; the fixed designated endpoint now supersedes that extension rule.
  Finish consumes the ready celebration so a saved action cannot repeat it.
- The celebration shows the series name, one saved medal per published stage,
  and the medal total. **View Campaign** returns to the Campaign screen listing
  every live series, including when only one is live. **View Series** opens the
  Tracks picker for the completed series.

The investigation below records the original integration analysis; its proposed
automatic handoff was superseded by this explicit Finish flow.

Initial handoff validation: **314 tests in 11 focused suites passed**, plus
typecheck and the production build. Browser checks against local API fixtures
passed at 1440×900, 390×844 and 360×640, including keyboard handoff, the original two
celebration actions, delayed confirmation after retry, standings return and
rejection. Screenshots and state were inspected. There were no unexpected
browser errors; the rejection fixture produces its expected HTTP 422 message.
Independent review found no remaining concrete issue.

A wider focused run also included the series-list suite and found one unrelated
assertion expecting 16 Numbers stages / 64 medals; existing uncommitted track
work adds stage 17 / 68 medals. That source and test remain untouched. The build
still emits the existing JSON import-attribute warning. Full-suite, hosted
Reddit/Redis and physical-device verification were not performed for this change.
Evidence is saved under `/private/tmp/dailygp-campaign-finish-*`.

Action-label follow-up: the final-stage action is **Finish**; ordinary stages
retain **Next**. Both celebration destinations reuse the existing Campaign
lobby and Tracks picker. The explicit View Campaign destination opens the series
list even when normal one-series entry would skip it. All **236 tests in eight
focused suites**, typecheck and production build passed after this change.
Chromium checks passed all three sizes with the new labels, correct Tracks
destination, and View Campaign opening the series list with one and two live
series. The celebration closes before the series list appears. Screenshots and
the standard browser-game client's gameplay state were inspected; no browser
errors occurred. Evidence: `/private/tmp/dailygp-campaign-finish-labels-*`.

## Original feasibility conclusion

A basic Campaign finished screen is a small frontend change. The game already
defines when a series is finished, returns the saved results needed to determine
it, and has a reusable full-screen modal with title, message, actions, and focus
handling. No new API, Redis record, progression rule, or reward is needed for a
celebration of the current finishing transition.

Rough scope: a few hours for a simple screen using the existing shell and focused
regressions; around half a day for a distinct visual treatment and responsive
verification. These are implementation estimates, not measured delivery times.

The initial investigation changed documentation only. Existing unrelated working-tree
changes were preserved.

## Completion and mastery

There are two different milestones:

| Milestone | Existing rule | Appropriate use |
| --- | --- | --- |
| Series finished | A confirmed medal on the explicit, published final stage | Ordinary Campaign finished celebration and summary |
| `progress.complete` | Gold or Author on every stage of that series | Separate mastery celebration, if wanted later |

The first rule is `isCampaignSeriesFinished()` with `getCampaignFinalStage()` in
[`game/campaign/manifest.js`](../game/campaign/manifest.js). Its original
last-currently-published-stage rule has been replaced.
The second is implemented by `deriveCampaignProgress()` in
[`game/campaign/service.js`](../game/campaign/service.js), lines 72–87, and
`publicProgress()` in
[`src/server/campaign/campaign-store.ts`](../src/server/campaign/campaign-store.ts),
lines 576–592. Crossing the finish line without earning a medal does not satisfy
the existing series-finished rule.

Completion applies to the raced series, such as Numbers, rather than requiring
the player to finish every live series.

## Original finish flow and available integration point

- `handleCampaignWin()` opens the normal race result sheet while an improved
  result is queued for server verification. It also handles non-PB runs,
  invalid runs, and unavailable replays without treating them as new saved
  progress (`game/campaign/engine-methods.js`, lines 1220–1323).
- `showCampaignFinish()` uses the same result sheet for every stage. The final
  stage has no Next action; there is no special Campaign-ending view (lines
  1088–1182). The existing test explicitly checks this
  (`tests/campaign-ui.test.js`, lines 366–379).
- A successful submission returns canonical `progress.resultsByRaceId` from
  `publicProgress(savedProgress)` (`src/server/campaign/campaign-store.ts`, lines
  1066–1074). The client already validates that the response confirms the run
  before applying it (`game/campaign/engine-methods.js`, lines 418–427 and
  1448–1479).
- That accepted-result branch is the natural place to detect the transition
  from unfinished to finished using the existing helper and canonical results.
  Detection should happen before awaiting standings or ghost refresh; the
  celebration does not require either service.
- Bootstrap also supplies `series[].finished`. Do not use that cached summary
  for the immediate trigger: the accepted-result branch initially reuses the
  older `series` array, and `campaignSeriesSummaries()` prefers that array
  (lines 232–244 and 1465–1470). Likewise, do not derive the trigger from the
  displayed results, which can include an unverified queued time (lines
  309–352).

## Smallest recommended implementation

Keep the normal result sheet visible during saving. When canonical saved
progress changes the raced series from unfinished to finished, show a compact
celebration using the existing modal: **Numbers finished**, a short completion
message, the verified series medal total, and **Campaign** to return to its
stages. An **Improve** action can reuse the current race-start route if desired.

`showModal()` already supports a simple title/message/actions screen without
race data, through `showMainResults()`
(`game/race/ui-modal-shell.js`, lines 1271–1365;
`pages/game.html`, lines 411–429). A distinct styled completion view would also
touch the shared modal markup and result CSS. Changing only the existing win
modal title would not create a visible completion screen: win mode selects the
combined view, whose headline is rendered separately
(`game/race/ui-modal-content.js`, lines 449–475).

For the basic version, the runtime change can stay in the Campaign engine and
reuse that shell. A richer presentation can add a small Campaign-specific view
in the existing shell rather than introducing a new routed page.

Required behavior for the later implementation:

1. Celebrate only fresh server-confirmed progress, with an unfinished-to-finished
   transition captured before applying the new progress.
2. Check the original owner, raced series, and active finish session before
   opening the screen. A late queued response must not interrupt another race,
   another series, another account, or an already dismissed result. The existing
   modal context check is a useful starting point, but also admits standings
   opened from that result; the celebration should wait until the finish view
   is appropriate to show.
3. Do not repeat the celebration for duplicate accepted replies, replaying an
   already finished series, bootstrap refresh, or PB ghost retries. Accepted
   progress remains valid when ghost persistence is unavailable.
4. **Superseded moving-tail proposal:** the original analysis allowed another
   published stage to create a new finish. The implementation now uses only
   the explicitly published designated endpoint and rejects stages beyond it.
   `toSeriesDefinition()` still exposes the published prefix, with
   `finalStageId: null` until the endpoint declaration itself is published.

This minimal scope does not promise that a celebration dismissed before saving,
or missed because the app closed, will be shown on the next visit. An exactly-once
acknowledgement across devices/reloads would need persisted presentation state
and the associated Guest/Account transfer handling; that is a separate feature.

## Initial feasibility validation

Read the system change map, Campaign series plan, multi-lap architecture,
existing Career feasibility investigation, and CSS architecture; verified the
current code where older architectural descriptions differ from today's rules.

Ran existing focused suites with `npx vitest run`: Campaign UI, client service,
series screen, server Campaign series, stored-series publication, modal focus,
and modal content. **7 files, 184 tests passed.** Test mocks emitted warnings for
missing standings/ghost responses and an unimplemented analytics Redis method;
these did not fail the suites. No tests were changed.

This initial run established the integration paths before implementation.
The proposed change called for regressions for the first confirmed
final-stage medal, medal-free/pending/rejected results, duplicate and ghost retry
responses, dismissal/navigation/owner changes, and designated endpoint publication,
plus visual and keyboard checks of the new screen. Hosted Reddit/Redis and a
physical-device finish were not exercised in this investigation.
