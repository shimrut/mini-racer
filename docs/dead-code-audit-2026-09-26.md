# Dead Code Audit

Date: 2026-09-26. Branch: `feat/campaign-series`. Head: `0e8644a`. The working tree also
holds uncommitted work: the water and space grounds, the jet ski and the spaceship, 11 new
tracks, and new series data. §4 covers that work separately.

This report records findings. It does not change code.

## Removal progress

The removals run on branch `chore/dead-code-safe-removals`, which starts from
`feat/campaign-series`. The uncommitted ground work stays out of these commits.

- **Group 1 — done (`bb9d768`), except the items in the uncommitted work.**
  `isHeadToHeadRaceId`, `resultCount`, the song `chords` fields, the series row `ground`
  and `medals`, and `newCircuit.jpg`. The `chords` change is committed only on the committed
  songs. The working tree also drops it from the uncommitted water song.
- **Group 2 — done (`2209eb9`, `9e8e944`).** The four medal helpers, `CAMPAIGN_STAGES`, the
  server `PB_GHOST_SAMPLE_RATE_HZ`, the autopost alias names, and the two Daily store
  re-exports. The tests import each name from its owner, or read the Numbers stages from
  the series. The suite has 5 tests fewer. Each removed test called only a removed helper.
  The medal-times check for every track stays.
- **Waiting for the ground work commit.** `tangentX` and `tangentY` in `getEdgeFrame`, the
  share pictures of `countryRoad`, `snowCircuit`, `gripCircuit` and `middleWay`, and the
  untracked `brokenRoad.jpg` and `dirtSnake.jpg`. These belong to uncommitted files, or they
  become unused only when that work lands.

Validation: `npx tsc --noEmit` passes. Every client entry bundles with esbuild. The full
suite has the same 22 failures before and after each commit. All 22 come from the
uncommitted ground and series work, not from these removals.

## Why this audit

The last audit ran on 2026-09-23 (`docs/dead-code-audit-2026-09-23.md`). Its removals landed
in `b8270d1`. After that, 42 commits changed 363 files: the style cleanup, the move to
`pages/`, the server feature folders, the player account store, the drawn cars, the grounds,
and the Campaign series. A move or a split can leave the old copy without readers. This audit
checks for that.

This audit also adds a stricter field check. The 09-23 check counted a field as read when any
code used the same name, also as a local variable. This check counts only property reads,
destructuring, string keys, and HTML. §3 lists the older fields that it found.

## Summary

| Area | Result |
|---|---|
| Module files | Clean. Every tracked and new module file is reached. |
| Server routes | Clean. 34 API routes and 12 internal endpoints, all wired. |
| Stylesheets (all, nested rules included) | Clean. 678 classes. 25 are built from a prefix, and each value was checked. |
| Element ids | Clean. All 179 ids that code looks up exist. |
| TypeScript unused locals and parameters | 0 in `src/`, `game/` and `pages/`. |
| Ground, track art, car paint, trackside items, spray, car sound | Clean. Every setting has a reader. |
| Dead after the commits since 09-23 | 7 items (§1) |
| Missed by the 09-23 audit | 2 groups (§2) |
| Older unread fields (stricter check) | 19 groups (§3) |
| Uncommitted work | 1 unread pair, 6 unused share pictures (§4) |
| Paths that no current data reaches | 4 (§5) |

## 1. Dead after the commits since 2026-09-23

| Location | Finding | Since |
|---|---|---|
| `src/server/head-to-head/head-to-head-model.ts:68` | `isHeadToHeadRaceId` has no caller and no test. Its three calls now use `isCampaignStageOfSeries`. | `22bfe02`, 09-25 |
| `game/campaign/manifest.js:89` | `CAMPAIGN_STAGES` is read only by 11 test files. The comment says it keeps the name from before the series. `getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID)` gives the same list. | `22bfe02`, 09-25 |
| `src/server/campaign/campaign-store.ts:509` | `resultCount` in each series summary. The client reads `id`, `name`, `ground`, `stageCount`, `medalCount` and `finished`. No code reads `resultCount`. | `22bfe02`, 09-25 |
| `game/audio/procedural-music.js:103–108` | The `chords` field of each race song. Each song reads its chord list constant directly (lines 453, 589, 672, 708, 744, 792). Only `key` and `bpm` are read from the song. | `22bfe02`, 09-25 |
| `src/server/competition/pb-ghost-trace.ts:7` | The server copy of `PB_GHOST_SAMPLE_RATE_HZ`. Its last reader moved into the shared recorder. Only `tests/server-pb-ghost.test.js` reads it. The shared constant in `game/shared/pb-ghost-format.js` is live. | `5ce015d`, 09-23 |
| `src/server/daily/daily-autopost-store.ts:9,17`, `src/server/podium/daily-podium-autopost-store.ts:9,17` | `DailyAutopostSubscription`, `parseDailyAutopostSubscription`, `DailyPodiumAutopostSubscription`, `parseDailyPodiumAutopostSubscription`. These names point at the shared store. Only tests read them. | `41546d8`, 09-23 |
| `assets/share/newCircuit.jpg` | No track has the key `newCircuit`. The 09-23 audit called this picture an untracked leftover. `22bfe02` committed it. | `22bfe02`, 09-25 |

Small note: the Campaign series rows (`game/lobby/campaign-series-screen.js:43,52`) carry
`ground` and `medals`. The row builder does not read them. The list's change check turns the
whole row into text, but the same values are also in the info line. So these two fields do
not change what the player sees.

## 2. Missed by the 2026-09-23 audit

**Four medal helpers.** `game/medals/medal-timing.js` exports `TRACK_MEDAL_THRESHOLDS` (line
34), `getTimeToBeatSeconds` (130), `allStandardMedalsUnlocked` (190) and
`formatMedalTargetsLine` (204). The 09-23 report (§2) said these functions were live and
only the re-export lines in `medals.js` were dead. That was wrong for these four:
`medals.js` imported them only to export them again. Phase 3 (`d5f76f0`) removed those
lines. Now only `tests/medals.test.js` and `tests/medals-author.test.js` call them.
`allStandardMedalsUnlocked` gives the same result as the live
`getWinOverlayAllMedalsUnlocked`.

**Two server re-exports.** `src/server/daily/daily-gp-store.ts:132` and `:134` re-export
`normalizePlayerPreferences` and `parseStoredEntry`. Production code imports both names from
the modules that own them. Only five test files import them through the Daily store: one
imports both names, and four import `parseStoredEntry` with a dynamic import. They were
test-only on 09-23 as well. `d5f76f0`
removed two other names from the same re-export and kept these two.

## 3. Older unread fields that the stricter check found

These fields existed before 2026-09-23. Code writes them, and no product code reads them.
Each row was read in context. Log payloads, stored records, Redis options, Reddit options,
and debug hooks are left out.

| Location | Field | What happens |
|---|---|---|
| `game/campaign/carousel-model.js:47–53`, `game/daily-challenge/carousel-model.js:75–81` | `modeLabel`, `billingLabel`, `lapsLabel`, `metaLabel` on each carousel card | The carousel reads 17 other card fields. `buildMetaLabel` (`campaign/carousel-model.js:12`) exists only to fill `metaLabel`. Tests read these fields. The last `metaLabel` reader went in `4baba76` (07-30). The last `billingLabel` reader went in `c4bf5d6` (08-16). |
| `game/lobby/service.js:195`, `:231` | `goldCount`, `gapMs` | The same values build `progressLabel` and `winMarginLabel`. Those two are read. |
| `game/head-to-head/engine-methods.js:397` | `opponentName` in the challenge verdict | The readers use only `deltaSec`. |
| `game/race/simulation.js:87`, `:208` | `param`, `closestPoint` | `closestPoint` is a copy of `wallPoint`. `simulation.js` is in the Stryker list. |
| `game/engine.js:136,779`, `:443`, `:593,805,812`, `:987`, `:317` | `carAssetPromise`, `fontsReadyPromise`, `initialPbGhostAssetPromise`, `dailyChallengeSummaryPromise`, `_previewPresentationOpId` | Engine fields that nothing reads. The calls that fill them start real work. Keep the calls if the fields go. |
| `game/race/engine-methods.js:1132` and its resets | `runHadTimingAnomaly` | A frame stall sets it. The stall's effect goes through `rankedSubmissionBlockedReason`. Only `tests/race-frame-stall.test.js` reads the flag. |
| `game/engine.js:213–214` and the resets in `game/daily-challenge/engine-methods.js` and `game/challenge-run/engine-methods.js` | `trackMedalBeforeLastLapWrite`, `hasTrackMedalBeforeLastLapWrite` | The code only resets them. One test reads them. |
| `game/race/ui-modal-shell.js:107,1212,1772` | `_modalSecondaryAction` | Set from `options.secondaryAction`. Never read. |
| `game/medals/medals.js:256` | `data-challenge-phase` | No style and no code reads it. `tests/medals.test.js` does. |
| `game/scoreboard/verification-queue-transfer.js:197–298` | `moved`, `preserved`, `quarantined`, `missingReceipt` in the return value | The only caller reads `persisted`. Tests read the rest. |
| `src/server/head-to-head/head-to-head-service.ts:1090` | `resultLabel` in the accept reply | No client code reads it. |
| `src/server/competition/competition.ts:29,77,112` | `allowGuests` | Always `true`. No code reads it. |
| `src/server/competition/replay-validator.ts:142` | `currentModeKey` on the replay engine state | The shared race code does not read it. |
| `src/server/campaign/campaign-store.ts:990–992,1067–1069` | `entryClass`, `pbClass` on each guest stage source | The code uses both values at once to list bad records. The stored copies are not read. |
| `src/server/player/guest-retirement.ts:56,64,76` | `promotedPlayerId` in the return value | The callers read `status` and `selectionPending`. |
| `src/server/moderator/storage-usage.ts:404` | `notCounted` | The moderator page reads `totalBytes` and `groups`. |

Test probes, like `RingBuffer.toArray` (kept on purpose on 09-23):

- `pages/podium-replay-view.js:629–637`: `toggleChrome`, `isChromeVisible` and `advance` on
  the replay controller. Only `tests/podium-replay-view.test.js` calls them.
- `tools/mapmaker/edit-history.js:56`: `cancelEdit`. Only
  `tests/mapmaker-edit-history.test.js` calls it.

## 4. Uncommitted work

- **`game/track/canvas.js:1004`: `tangentX` and `tangentY` have no reader.** `getEdgeFrame`
  returns them. Its only caller reads `normalX`, `normalY` and `facing`.
- **Four share pictures lose their use.** The uncommitted `game/track/catalog.js` takes
  `countryRoad`, `snowCircuit`, `gripCircuit` and `middleWay` out of the Daily schedule. The
  new series data puts them in Campaign series. Only Daily posts use share pictures
  (`src/server/daily/daily-post-service.ts:50`). Their committed pictures in `assets/share/`
  become unused.
- **Two new share pictures have no use.** `assets/share/brokenRoad.jpg` and `dirtSnake.jpg`
  are untracked. Both tracks are Mini Rally stages, not Daily tracks.
- `waterCircuit.jpg` and `spaceCircuit.jpg` are live: both tracks are in the Daily schedule.
  Neither track has medal times. That is not dead code. It is the same kind of gap as the
  Sunset Terrace note of 09-23.

The new track definitions, the jet ski and spaceship parts, the trackside items, and the new
ground settings have no dead exports and no unread settings.

## 5. Paths that no current data reaches

With the uncommitted series data, every series has stages, and all four are live. These
paths stay correct, but no current data runs them:

- **The "Coming soon" row** in `game/lobby/campaign-series-screen.js` and its
  `.is-coming-soon` styles (`styles/lobby-modes.css:901–906`). It is ready for the next
  series.
- **`GROUND_PREVIEW_TRACK_KEYS`** (`campaign-series-screen.js:10–15`). It shows a ground's
  track for a series with no stages. Every series now has a first stage.
- **The Formula Mini rule** (`game/campaign/series-rules.js:6–13`). It hides Formula Mini
  until it has 2 stages. Committed, Formula Mini has 0 stages; uncommitted, it has 2. Both
  rules give the same result for both counts. The rule can change a result only at exactly
  1 stage.
- **The `null` result of `getDefaultCarAssetForGround`** (`game/car/car-skin-grounds.js:39`).
  It is for a ground with no skins. Every ground now has drawn skins.

One stale comment: `game/campaign/manifest.js:65` says that only the Mapmaker and tests use
`CAMPAIGN_ALL_SERIES`. The Mapmaker does not import it. The Campaign series screen does.

## 6. Still open from earlier audits

- The three guest merge helpers still receive `replace: true` from every production caller
  (`src/server/daily/daily-gp-store.ts:2506`, `:2518`, `:2533`). Their `replace: false`
  paths have only tests.
- The test probes kept on 09-22 stay: the three verification queue probes,
  `catalogHeadToHeadSize`, the `*ForTests` resets, `clearAnalyticsMaintenanceMemory`,
  `clearActivePlayerOwnerId`, `dailyPosterCarTravelAt` and `simulateStraightLine`.
- `tools/analyze-unused-css.js` gaps: not rechecked.

Done since 09-23: the hard-crash path, `fflate`, `@devvit/public-api`, and the 18 unread
JavaScript parameters are gone.

## 7. Priority order

The order is by simplicity and by the harm to players if a removal goes wrong. None of the
commits since 09-23 is on `main`, and no moved track or share picture is on `main`. So no
item in §1, §2 or §4 has reached players yet.

1. **Trivial, no player risk. No test changes.** `isHeadToHeadRaceId`, the song `chords`
   fields, `resultCount`, `tangentX`/`tangentY`, the series row `ground`/`medals`,
   `newCircuit.jpg`, and the six series-track share pictures. Remove the four pictures of
   the tracks that leave the Daily schedule in the same commit as that schedule change.
2. **Simple, only tests change. No player risk.** The four medal helpers, `CAMPAIGN_STAGES`
   (11 test files), the server `PB_GHOST_SAMPLE_RATE_HZ`, the autopost alias names, and the
   two Daily store re-exports (5 test files). Point each test at the owning module. Some are
   mutation-kill tests.
3. **Simple, in screens that players use. Low risk.** The carousel card labels and
   `buildMetaLabel`, `goldCount`/`gapMs`, `opponentName`, `_modalSecondaryAction`,
   `data-challenge-phase`, `resultLabel`, `allowGuests`, `notCounted`. A mistake shows as a
   missing label. Look at each screen after the change.
4. **Engine and race rules. Take care, or skip.** The engine promise fields,
   `runHadTimingAnomaly`, the two last-lap medal flags, `param`/`closestPoint`, and the
   replay check's `currentModeKey`. The calls that fill the promise fields load the car
   picture, the ghost and the Daily data, so they must stay. The stall must still block
   ranking. A mistake can stop a ghost or a car picture from loading, stop a run from
   ranking, or make the server reject a valid time. The gain is small.
5. **Guest transfer. Leave.** The transfer report fields, `entryClass`/`pbClass`,
   `promotedPlayerId`, and the `replace: false` merge branches. A mistake can lose a
   player's progress. The gain is close to zero.
6. **Keep.** The paths in §5 are ready for the next series or ground. The Formula Mini rule
   is a product decision: it changes no result with the current data. The test probes stay.

## Checked and clean

- **Module files.** A graph from the 11 HTML pages, the server entry, the four build and test
  configs, the `package.json` scripts, and the three debug stubs reaches every module file.
  `vitest.config.js` names `tools/vitest-global-setup.js` as a string.
- **Exports.** Every export has a production importer or a use in its own file, or it is
  listed above.
- **Class and object members.** Checked to a fixed point. Only the test probes above and
  framework hooks (Vite plugin hooks, a video encoder callback) have no product reader.
- **Grounds.** The simulation reads all 10 driving settings.
- **Track art.** Every key in `game/track/presentation.js` has a reader.
- **Drawn cars.** 29 skins on 6 cars. Every decal area of every skin is painted by a part
  that its car draws. Every material colour is read.
- **Trackside items.** A ground uses each of the 13 items. Every colour is read.
- **Spray styles and car sound profiles.** Every setting is read.
- **Server routes.** 34 API routes. The 12 internal endpoints match `devvit.json`.
  `/api/analytics/guest-transfer` has no in-app caller on purpose.
- **Data files.** Every medal-times key names a track. Every series stage names a track.
  Every scheduled track has a share picture.
- **Car images.** All 23 are in the garage list.
- **TypeScript.** `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` passes on `src/`.
  With `allowJs` and `checkJs`, `game/` and `pages/` report 0. `tools/` reports 25: the
  known 21 in TikTok Studio and 2 in Runner Lab, and 2 callback parameters in
  `tools/mapmaker/track-flow.js:174–175` that the code needs to reach the second parameter.
- The ignored local scripts `tools/backfill-track-biomes.js`, `perf-lap.js` and
  `stutter-probe.js` are not in the repository.

## Method and limits

- Parsed every module with the TypeScript parser. Counted an export as used only when a
  production file imports it from its own module, directly, through a re-export, through a
  namespace, or through a dynamic import or `import.meta.glob`.
- Counted a class or object member as used only when code reads its name as a property, by
  string, by destructuring, or in HTML. Ran this to a fixed point.
- Counted an object field as read only by a property read, destructuring, a string key, or
  HTML. A field name that some other object also reads looks read. So §3 is a lower bound.
- Checked the ground, track art, car paint, trackside, spray and sound tables key by key
  against their readers.
- Walked every stylesheet with nested rules, and every element id lookup.
- Read each finding in context before this report names it.
- Did not run the test suite, a production build, or a removal experiment. These are
  verified candidates, not a tested removal.
