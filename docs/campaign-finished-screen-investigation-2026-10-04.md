# Campaign finished screen investigation — 2026-10-04

## Conclusion

A basic Campaign finished screen is a small frontend change. The game already
defines when a series is finished, returns the saved results needed to determine
it, and has a reusable full-screen modal with title, message, actions, and focus
handling. No new API, Redis record, progression rule, or reward is needed for a
celebration of the current finishing transition.

Rough scope: a few hours for a simple screen using the existing shell and focused
regressions; around half a day for a distinct visual treatment and responsive
verification. These are implementation estimates, not measured delivery times.

This investigation changes documentation only. Existing unrelated working-tree
changes were preserved.

## What “finished” currently means

There are two different milestones in the current code:

| Milestone | Existing rule | Appropriate use |
| --- | --- | --- |
| Series finished | Any medal on the last currently published stage | Ordinary Campaign finished celebration |
| `progress.complete` | Gold or Author on every stage of that series | Separate mastery celebration, if wanted later |

The first rule is `isCampaignSeriesFinished()` in
[`game/campaign/manifest.js`](../game/campaign/manifest.js), lines 229–234.
The second is implemented by `deriveCampaignProgress()` in
[`game/campaign/service.js`](../game/campaign/service.js), lines 72–87, and
`publicProgress()` in
[`src/server/campaign/campaign-store.ts`](../src/server/campaign/campaign-store.ts),
lines 576–592. Crossing the finish line without earning a medal does not satisfy
the existing series-finished rule.

Completion applies to the raced series, such as Numbers, rather than requiring
the player to finish every live series.

## Current finish flow and available integration point

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
4. Use the current published stage list. Creator series can grow: drafting an
   appended stage leaves the published endpoint unchanged, but publishing it
   creates a new last stage. The player can then finish the extended series.
   `toSeriesDefinition()` exposes only the published prefix
   (`src/server/campaign/series-store.ts`, lines 107–115), covered by
   `tests/server-series-store.test.js`, lines 116–135 and 266–282.

This minimal scope does not promise that a celebration dismissed before saving,
or missed because the app closed, will be shown on the next visit. An exactly-once
acknowledgement across devices/reloads would need persisted presentation state
and the associated Guest/Account transfer handling; that is a separate feature.

## Validation

Read the system change map, Campaign series plan, multi-lap architecture,
existing Career feasibility investigation, and CSS architecture; verified the
current code where older architectural descriptions differ from today's rules.

Ran existing focused suites with `npx vitest run`: Campaign UI, client service,
series screen, server Campaign series, stored-series publication, modal focus,
and modal content. **7 files, 184 tests passed.** Test mocks emitted warnings for
missing standings/ghost responses and an unimplemented analytics Redis method;
these did not fail the suites. No tests were changed.

This establishes the current integration paths, not a tested implementation of
the proposed screen. A future change needs regressions for the first confirmed
final-stage medal, medal-free/pending/rejected results, duplicate and ghost retry
responses, dismissal/navigation/owner changes, and extended published series,
plus visual and keyboard checks of the new screen. Hosted Reddit/Redis and a
physical-device finish were not exercised in this investigation.
