# Dead Code Audit

Date: 2026-09-22. Branch: `racer-v2-4`. Independently rechecked against `e9a578e`.

This report records findings. It does not change code.

## Removal progress

The removals run on branch `chore/dead-code-removal`, one commit per phase, in order of risk.

- **Phase 1 — done.** Unreachable code: `IGNORE SUPABASE/`, the ten no-caller exports (§2),
  the three engine methods and `prefetchClientTracks` (§3), the seven UI members and the type
  (§4), the eleven locals and imports (§5), the five config keys (§7), and `LP/car.webp` (§9).
  The now-unused imports went with them. `competitionFor` in `campaign-store.ts` lost its
  ignored player argument at all 18 call sites. Unused TypeScript diagnostics went from 6
  to 0. The tests and the build pass.
- **Phase 2 — done.** Six test-only functions (§12): `getCarAssetNameForPresetConfig`,
  `createAvatarImage`, `getAvailableDailyChallengeSkins`, `isValidDailyGpTime`,
  `toBestTimeMs`, and `segmentsIntersect`, with the tests that only exercised them. The
  `DAILY_GP_MIN_TIME_SECONDS` and `DAILY_GP_MAX_TIME_SECONDS` constants went too, because
  `isValidDailyGpTime` was their only reader. The avatar test for the `hidden` option now
  calls `applyAvatar` directly, so that coverage stays.
- **Phase 3 — done.** The 15 product CSS rules and the Mapmaker rules (§6). `306e003`
  (2026-08-18) had removed the JavaScript that drew the analytics bars. The toolbar test in
  `tests/styles-architecture.test.js` now asserts that `.lobby-mode-toolbar__back` stays
  gone. `npm run analyze:css` reports 3 unused classes, down from 8. The 3 are the known
  false positives in §10. The built CSS holds none of the removed selectors. The lobby and
  the Campaign toolbar and carousel look unchanged.
- **Phase 4 — done.** `formatCombinedRankOutOf`, `buildModalStatsPlan`, and
  `scheduleModalScoreboardRefresh` (§12), plus `getCombinedRankNumber`. Its only production
  caller was `formatCombinedRankOutOf`, so the "used inside its own file" check had hidden
  it. The live modal reads `playerRankLabel` directly, and the `ui-modal-*` tests cover it.
  18 test blocks that only exercised these functions went. One mixed block keeps its
  `buildScoreboardRankDisplay` checks.
- **Phase 5 — done.** The 13 Campaign share images (§9). The 113 remaining images match the
  113 scheduled tracks one for one. `tools/generate-share-images.js` creates none of them
  again, because it works from the Daily schedule. It recreates an image if a track returns
  to Daily.
- **Phase 6 — done.** The whole hard-crash path (§13): `handleHardCrash`, the four event
  fields, the server crash branch, and the music branch. Two validator tests that also
  checked failure-detail rounding and omission now reach those details through the live
  "ended early" path. Tests that pinned a live failure reason now use `no_finish` in place
  of `'crashed'`. The wall-hit auto-restart tests in `tests/simulation-run-policy.test.js`
  run the real engine and simulation, and they pass with the setting on and off. The
  TypeScript "no overlap" diagnostic at `replay-validator.ts:289` is gone, so the other
  diagnostics fell from 23 to 22.

After phase 6 the suite has 236 files and 3,011 tests, and all pass. That is 23 tests fewer
than the 3,034 at the start, and each removed test exercised only removed code.

The last full audit ran on 2026-08-01. That audit found no dead module files. This audit
repeats the file check and adds five more checks: exported names, engine methods, CSS
rules, config keys, and package dependencies.

## Method

- Built a module graph from the `devvit.json` entrypoints, `src/server/index.ts`, the Vite
  configs, and the `package.json` scripts. Followed static imports, dynamic imports,
  HTML `src` and `href`, and CSS `@import`.
- Counted every reference to each exported name across all tracked files. Told apart three
  cases: no reference, test reference only, and production reference.
- Ran `npm run analyze:css`. Then checked the four stylesheets that this tool does not read.
- Ran `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`.
- Read each candidate before this report names it. Dynamic dispatch hides many callers in
  this codebase, so a grep alone is not sufficient.
- A name search also fails the other way: a same-named symbol, a test, or a copy in
  `IGNORE SUPABASE/` makes dead code look used. So the second pass counts an export as used
  only when production code imports it from its own module. It counts an engine method as
  used only when code reads it as a property or by string.

## Summary

| Area | Dead items |
|---|---|
| Module files | 0 |
| Exported functions | 10 |
| Production functions that only tests call | 12 (§12) |
| Hard-crash leftovers | 1 function, 4 event fields, 2 branches (§13) |
| Engine methods | 3, plus 1 helper they keep alive |
| Other UI getters and controller methods | 7 |
| Exported types | 1 |
| Locals, imports, and server parameter bindings | 11 (6 TypeScript, 5 JavaScript) |
| Additional unread JavaScript parameter bindings | 19; signature cleanup only |
| Product CSS rules | 15 |
| Mapmaker CSS | 5 standalone rules plus 1 shared-selector member |
| Config keys | 5 |
| Package dependency classification | 1 development-only dependency; 1 redundant direct-dependency candidate |
| Assets | 14 (1 LP image, 13 share images) |

## 1. Module files — clean

No orphan module was confirmed in the maintained product, build, test, or developer-tool surfaces.
This is not a claim that every tracked module ships to players: the four tracked files in
`IGNORE SUPABASE/` are an excluded legacy island, and `.cursor/skills/devvit-docs/scripts/ensure-docs.cjs`
is invoked by its skill instructions. `tools/vitest-global-setup.js` is selected through the
Vitest configuration rather than an import. The three developer labs under
`tools/` look unreferenced to a graph walk, but `tools/mapmaker.html` links to
`tools/runner.html` and `tools/tiktok-studio.html`. `npm run mapmaker` serves all three.

Two scripts under `tools/` are untracked and git-ignored: `backfill-track-biomes.js` and
`stutter-probe.js`. The first imports `../game/track/biomes.js`, and that file does not
exist. The script cannot run. Both files are local only, so they are outside the product.

## 2. Exported functions with no caller

No file calls these ten functions. No test calls them either.

The last column names the commit that last changed the declaration line (`git blame`). It
is not always the commit that added the function. `head-to-head.js` was renamed from
`campaign-challenge.js`, so its dates predate the rename.

| File | Line | Name | Line last changed in |
|---|---|---|---|
| `game/player/profile-cache.js` | 99 | `clearCachedPlayerProfiles` | Keep a profile outage from resetting the selected car (2026-08-12) |
| `game/track/client-registry.js` | 51 | `isClientTrackLoaded` | Prioritize startup assets by launch mode (2026-08-11) |
| `head-to-head.js` | 195 | `openCampaignAsRedirect` | Block accepting your own player challenge (2026-07-25) |
| `head-to-head.js` | 205 | `openDailyAsRedirect` | Block accepting your own player challenge (2026-07-25) |
| `src/server/campaign-store.ts` | 244 | `hasStoredCampaignProgress` | Bind queued results to the account that raced them (2026-08-12) |
| `src/server/guest-retirement.ts` | 92 | `isRetiredGuestPlayerId` | Bind queued results to the account that raced them (2026-08-12) |
| `src/server/guest-transfer-source-classification.ts` | 49 | `requiresReviewedRecovery` | Stop transfers destroying data they cannot read, keep, or pause (2026-09-09) |
| `src/server/guest-transfer-source-classification.ts` | 60 | `carriesCopyableData` | Stop transfers destroying data they cannot read, keep, or pause (2026-09-09) |
| `src/server/head-to-head-store.ts` | 151 | `deleteHeadToHeadAccept` | Rename Campaign Challenge to Head to Head (2026-08-08) |
| `src/server/pb-ghost-store.ts` | 241 | `classifyStoredPbRecord` | Stop transfers destroying data they cannot read, keep, or pause (2026-09-09) |

Read these three groups before you remove anything:

**The two page redirects.** `head-to-head.js` exports `openCampaignAsRedirect` and
`openDailyAsRedirect`. The live page uses `openHomeAsRedirect` from
`game/head-to-head/poster-access.js`. The two exports are copies of a pattern that the page
no longer needs.

**The PB classifier.** `src/server/pb-ghost-store.ts` holds three classifiers.
`classifyStoredPbRecordFor` has callers in `daily-gp-store.ts` and `campaign-store.ts`.
`classifyStoredPbRecordValue` is the worker that both other classifiers call. Only
`classifyStoredPbRecord`, which reads Redis itself, has no caller.

**The guest transfer predicates.** `requiresReviewedRecovery` and `carriesCopyableData` read
as the intended vocabulary of the transfer safety work. Their callers test
`classification.state` directly instead. These two are unwired helpers, not rot. Decide
whether to wire them or to remove them.

`IGNORE SUPABASE/daily-gp-model.ts:172` also exports an unused `assertDailyGpTrackCooldown`.
That whole directory holds four files, and no file outside it imports them. `devvit.json`
excludes the directory from the shipped source. Treat the directory as one decision, not as
one dead function.

The directory also hides dead code elsewhere. It declares its own `isValidDailyGpTime` and
`toBestTimeMs`, so a repo-wide name search shows the `src/server/daily-gp-model.ts` copies as
used. They are not (§12). The directory cannot run either: `daily-gp-store.ts` imports
`../src/shared/`, and that folder does not exist. `tests/release-pipeline.test.js:63` names
the directory, so a removal must update that test.

## 3. Engine methods with no caller

`Object.assign` mixes the engine method objects onto `RealTimeRacer.prototype`. The engine
method files define 148 methods. A method is live only when code reads it as a property
(`this.name`, `engine.name`) or by string. Three methods have no such read:

- `game/track/engine-methods.js:190` — `getLoadedTrack`
- `game/track/engine-methods.js:194` — `prefetchTracks`
- `game/player/engine-methods.js:67` — `runAfterPlayerIdentityReady`

All three methods are one-line pass-throughs.

`getLoadedClientTrack` has six other callers and stays. `prefetchClientTracks` in
`game/track/client-registry.js:81` does not. Line 195 is its only caller, so it dies with the
method. `isClientTrackLoaded` in §2 sits in the same module. These track items all come from
`ddbf60c` (Prioritize startup assets by launch mode, 2026-08-11).

`runAfterPlayerIdentityReady` has the same name as the function that
`game/player/identity-recovery.js:46` exports. A name search finds that function and hides
the dead method. Every production call, in `game/campaign/engine-methods.js:1060` and
`game/daily-challenge/engine-methods.js:1571`, calls the imported function directly with
`this`. No code and no test reads the method. It came from `2ca4145` (2026-08-14).

## 4. Exported type with no reference

`src/server/daily-podium-model.ts:39` exports `DailyGpPodiumCustomPostData`. No file names
it. The neighbouring `DailyGpPodiumPostData` is live.

### Additional unused UI members

These seven members have no production or test consumer. References were checked by
member name and against the owning instances; no reflective invocation was found.

| File | Line | Member |
|---|---|---|
| `game/daily-challenge/ui.js` | 133 | `dailyChallengePlaylistCloseBtn` getter |
| `game/settings/garage-ui.js` | 43 | `garageButton` getter |
| `game/settings/garage-ui.js` | 45 | `closeButton` getter |
| `game/settings/ui.js` | 83 | `settingsBtn` getter |
| `game/settings/ui.js` | 87 | `settingsView` getter |
| `game/settings/ui.js` | 88 | `settingsBackBtn` getter |
| `podium-replay-view.js` | 545 | `hasGhost(rank)` controller method |

Garage and Settings bind open buttons through `[aria-controls]` and close buttons through
`bindReusableModal`. The related live controls must stay. The podium page uses `hasGhosts()`;
only the singular `hasGhost(rank)` member is unused.

## 5. Locals and imports with no reader

`npx tsc --noEmit --noUnusedLocals --noUnusedParameters` reports six.

| File | Line | Name | Note |
|---|---|---|---|
| `src/server/head-to-head-service.ts` | 52 | `releaseRedisLock` | Unused import |
| `src/server/daily-podium-replay.ts` | 54 | `emptySlot` | Unused helper function |
| `src/server/daily-gp-store.ts` | 1008 | `releaseSubmissionLock` | The file releases locks through `releaseSubmissionLocksSafely` and `releaseRedisLockGroup` |
| `src/server/daily-gp-store.ts` | 3030 | `result` | The call has side effects; only the variable is dead |
| `src/server/campaign-store.ts` | 1145 | `guestProgressLock` | A lookup, not an acquire; `redditProgressLock` stays |
| `src/server/competition.ts` | 93 | `playerId` | See below |

`toCampaignCompetition` accepts a `playerId` option and never reads it. Three call sites pass
a value: `campaign-store.ts:129`, `daily-gp-store.ts:327`, and `daily-gp-store.ts:1839`.
The parallel `toDailyCompetition` has no such option. The option is a deliberate leftover,
not a defect. `8532f72` (2026-08-08) removed the per-guest expiry that read it and replaced it
with a shared ledger, so one guest cannot expire other players' standings.

The two lock names need the same care. `releaseSubmissionLock` and `guestProgressLock` are
dead by the compiler, but a lock that nobody releases is a different problem. Both sites
release their locks elsewhere, so these two are safe. The campaign merge releases its whole
`locks` array in a `finally` block at `src/server/campaign-store.ts:1342`. The merge writes
only the account's progress, through `redditProgressLock`. Check this again if the code moves.

The TypeScript command does not cover JavaScript (`tsconfig.json` sets `allowJs: false`
and includes only `src/**/*.ts`). A separate AST scope check found five additional
declarations with no reads:

| File | Line | Name |
|---|---|---|
| `game/medals/medal-icon.js` | 28 | `HEX_CENTER` |
| `game/daily-challenge/engine-methods.js` | 830 | `hadChallengeRun` |
| `game/daily-challenge/engine-methods.js` | 1339 | `trackKey` |
| `game/race/ui-modal-content.js` | 513 | `delta` |
| `game/race/ui-modal-content.js` | 583 | `objectiveType` |

Their current initializers have no required side effects. Removing `delta` also leaves
`renderLapTimesList`'s `bestTime` argument unused.

An additional 19 JavaScript parameter bindings are unread. These are signature cleanup
candidates, not evidence that their containing functions are dead. Preserve argument
positions and inspect callers before removing a positional parameter or public option.

| File | Line | Unread bindings |
|---|---|---|
| `game/audio/car-effects-audio.js` | 348 | `index` |
| `game/daily-challenge/labels.js` | 60, 68 | `challenge`; `objectiveType`, `completedLaps` |
| `game/daily-challenge/storage.js` | 21 | `challenge` |
| `game/medals/medals.js` | 565, 567 | `staggerMs`; `winSecondaryBaseDelayMs` |
| `game/race/run-policy.js` | 67 | `policy`, `checkpointCount` in test-only `handleHardCrash` |
| `game/race/ui-hud.js` | 219, 232 | `label`; `trackKey`, `bestLapTime` |
| `game/race/ui-modal-content.js` | 544, 747 | `scoreboardMode`, `scoreboardSubhead`; `title` |
| `game/race/ui-modal-shell.js` | 1264 | `lapData` |
| `game/track/canvas.js` | 123 | `seed` |
| `game/track/preview-renderer.js` | 172, 349 | `shadowRgb`; `transparentBackground` |

## 6. CSS rules with no producer

No HTML file and no JavaScript file produces these fifteen product rules.

| File | Lines | Selector |
|---|---|---|
| `styles/race-hud-and-medals.css` | 460, 464, 468 | `.combined-medal-challenge-label--pending`, `--outcome`, `--error` |
| `styles/race-hud-and-medals.css` | 481, 492, 496 | `.combined-medal-challenge-margin` and its `.is-gain` and `.is-loss` forms |
| `styles/lobby-modes.css` | 309, 313 | `.lobby-mode-toolbar__back` and `.lobby-mode-toolbar__back svg` |
| `mod-analytics.css` | 418, 425, 431 | `.analytics-bar`, `.analytics-bar__fill`, `.analytics-bar__marker` |
| `styles/race-hud-and-medals.css` | 231, 236, 242 | `.medal-svg--combined`, `--combined-stack`, `--playlist` |
| `styles/track-carousel.css` | 796 | `.track-carousel__unlock-medal-progress` |

The medal tier generator only produces supported tiers or `placeholder`; it cannot
produce the three retired layout modifiers. No caller passes them as a custom class.
The carousel selector sits inside a reduced-motion media query; its old markup is
explicitly excluded by `tests/campaign-lock-medal-visual.test.js:26`.

Mapmaker also has five unused standalone rules in `tools/mapmaker.css`: `.chip-row`
at lines 277 and 443, `.chip-row button` at 281, `.chip-row button[data-active="true"]`
at 287, and `.legend-line` at 382. At line 207, remove only `.chip-row` from the shared
selector group; the other selectors in that rule remain live.

`.combined-medal-challenge-label--won` stays. `game.html:265` writes it. Its three sibling
states do not appear in any file.

`tests/campaign-ui.test.js:1222` and `tests/styles-architecture.test.js:595` assert that the
`.lobby-mode-toolbar__back svg` rule exists. No markup ever carries the class. The tests pin
dead CSS, so remove them together.

## 7. Config keys with no reader

`game/config.js` holds 36 top-level keys. Four have no reader:

- Line 18 — `smokeColor`
- Line 23 — `finishLineBorderColor`
- Line 38 — `crashRelaunchDelay`
- Line 39 — `minLapTime`

`resumeRelaunchDelay` on line 37 is live. Do not confuse it with `crashRelaunchDelay`.

`game/scoreboard/api-client.js:10` adds an `apiBaseUrl` key to the frozen `API_ROUTES`
object. Every other key of that object has a reader. This one has none.

## 8. Package dependencies

Both sit in `dependencies`, not in `devDependencies`.

**`fflate`: live development dependency.** Only `game/ghost/pb-ghost-size-debug.js` imports it. `vite.config.js` swaps
that module for `game/ghost/pb-ghost-size-debug.stub.js` in the client build, and the stub
imports nothing. The server compresses with `node:zlib`. So `fflate` never reaches a
shipped bundle. The unbundled debug module calls it at line 255, and its portable fallback
is covered by `tests/pb-ghost-size-debug.test.js:74`. Move it to `devDependencies` if cleaning
dependency categories; do not remove it as dead code.

**`@devvit/public-api`: redundant direct-dependency candidate.** No file in the project imports it. `node_modules/@devvit/cli`
declares it, so the install keeps it either way. Confirm with Devvit before you remove it,
because the platform may expect the entry.

## 9. Assets with no reference

`LP/car.webp` is 19 KB. No LP page, no LP stylesheet, and no generator names it.
`devvit.json` excludes `LP/` from the shipped source, so this weight stays on the marketing
site only.

Thirteen share images under `assets/share/` are never requested. Together they are 440 KB:
`goldenRatio`, `imaginaryNumber`, `infinitePie`, and `numberZero` to `numberNine`.

The server looks up a share image as `share/${trackKey}.jpg` (`src/server/share-image.ts:4`).
Its only caller is `src/server/daily-post-service.ts:50`. All three routes into that code pass
`getServerDailyGpChallenge()`, and the Daily track comes from `TRACK_SCHEDULE_KEYS`
(`src/server/daily-gp-store.ts:844`). The thirteen tracks are Campaign tracks. Commit
`0fbbdbb` (Keep Campaign tracks out of Daily, 2026-08-10) removed them from that list. The
Daily history backfill names none of them.

Head to Head posts race on Campaign tracks, but they attach no share image at all. Only the
Daily post sets `styles.shareImageUrl` (`src/server/daily-post-service.ts:64`). So these
images are dead today. They become useful again only if Head to Head posts start to attach
a share image. Decide that before you delete them.

The other 113 share images match the 113 scheduled tracks one for one. The remaining 27
files under `public/` and `assets/` are named by path.

The first pass reported all 153 files as referenced. That check accepted a bare file stem
as a reference, and every track key appears in the catalog.

## 10. Four gaps in `npm run analyze:css`

The tool reads only `styles.css` and `preview.css`. It does not read `podium.css`,
`head-to-head.css`, `campaign.css`, or `mod-analytics.css`. §6 found three dead rules in
`mod-analytics.css` that the tool cannot see.

The tool also holds a list of class prefixes that code builds at run time. That list misses
`challenge-result-lockup__outcome--`. `game/medals/medals.js:263` builds those class names
from a phase value. So the tool reports `.challenge-result-lockup__outcome--won`, `--lost`,
and `--error` as unused, and all three are live.

The parser only extracts selectors at brace depth zero (`tools/analyze-unused-css.js:41`),
so it misses selectors inside media queries. Its broad `medal-svg--` allowance at line 156
also hides obsolete non-tier modifiers whenever any medal tier producer exists.

Adding stylesheets and the missing prefix alone is insufficient. A follow-up should walk
nested CSS rules and distinguish finite generated tier names from unrelated modifiers.

## 11. Test-only and legacy behavior, separate from straightforward deletions

- `src/server/head-to-head-catalog.ts:256`, `catalogHeadToHeadSize`, is used only by
  `tests/server-head-to-head-catalog.test.js` at lines 141, 401, 431, and 477. It is a
  test-only Redis wrapper, not a function with no callers. Intentional test reset helpers
  such as `clearAnalyticsMaintenanceMemory` also remain outside the no-caller list.
- The sole production callers of `mergeGuestCampaignProgress`, `mergeGuestDailyProgress`,
  and `mergeGuestCarUnlockProgress` all pass `replace: true`
  (`src/server/daily-gp-store.ts:2810`, `:2822`, `:2837`). Their older best-of/union behavior
  is therefore unreachable through current production calls, although tests still exercise it.
  Relevant branches are `src/server/campaign-store.ts:1206`,
  `src/server/daily-gp-store.ts:1503`, and `src/server/car-unlock-store.ts:589`.
  Garage's immediate source deletion at line 593 is likewise bypassed by the production
  caller's `preserveSource: true`.

These legacy transfer branches need a separate targeted cleanup with recovery tests.
Do not delete transfer helpers or transaction fallbacks just because one option branch
is currently unused. Existing default-merge coverage includes
`tests/server-campaign-store.test.js:1119`, `tests/server-daily-guest-merge.test.js:174`,
and `tests/server-car-unlock-store.test.js:190`.

## 12. Production functions that only tests call

No production code calls these twelve exports. Tests call them, so a search that counts any
reference shows them as used. The first pass found them, but the first report left them out.

| File | Line | Name | Test files |
|---|---|---|---|
| `game/car/sprite.js` | 104 | `getCarAssetNameForPresetConfig` | 1 |
| `game/race/result-flow.js` | 259 | `formatCombinedRankOutOf` | 3 |
| `game/race/result-flow.js` | 282 | `buildModalStatsPlan` | 3 |
| `game/race/result-flow.js` | 443 | `scheduleModalScoreboardRefresh` | 3 |
| `game/scoreboard/verification-queue.js` | 556 | `readVerificationQueueTransferBlock` | 1 |
| `game/scoreboard/verification-queue.js` | 951 | `getDailyChallengeVerificationState` | 1 |
| `game/scoreboard/verification-queue.js` | 1056 | `markDailyChallengeVerificationRejected` | 3 |
| `game/track/geometry.js` | 24 | `segmentsIntersect` | 2 |
| `game/track/presentation.js` | 106 | `getAvailableDailyChallengeSkins` | 1 |
| `game/ui/avatar.js` | 61 | `createAvatarImage` | 1 |
| `src/server/daily-gp-model.ts` | 252 | `isValidDailyGpTime` | 1 |
| `src/server/daily-gp-model.ts` | 258 | `toBestTimeMs` | 1 |

`catalogHeadToHeadSize` in §11 belongs to the same group. `handleHardCrash` belongs to it too,
but §13 treats it with the rest of the crash path.

Remove each function together with the tests that call it. `stryker.config.mjs` mutates
`result-flow.js` and `verification-queue.js`, and tests such as
`tests/result-flow-verification-mutation-kills.test.js` exist to kill mutants there. Removing
a function also removes its mutants, so production coverage does not drop.

`getCarAssetNameForPresetConfig` ignores its argument and always returns
`STOCK_CAR_ASSET_NAME`. `segmentsIntersect` has one test caller,
`tests/geometry-crossing-fraction.test.js:22`. `tests/track-runtime-integrity.test.js:25`
defines its own copy and does not use the production function.

Three rows above are test tools, not dead code. Tests call them to set up or read state
while they test live code. Keep them:

- `markDailyChallengeVerificationRejected` sets up a rejected entry in
  `tests/result-flow-verification-mutation-kills.test.js:502` and
  `tests/verification-queue-wave2.test.js:45`.
- `getDailyChallengeVerificationState` and `readVerificationQueueTransferBlock` read queue
  state for assertions.

`catalogHeadToHeadSize` (§11) is a probe of the same kind. So nine of the twelve rows are
removal candidates.

These six exports are also called only by tests, but they are deliberate test seams. Keep
them: `resetVerificationQueueForTests`, `clearClientTrackRegistryForTests`,
`clearAnalyticsMaintenanceMemory`, `clearActivePlayerOwnerId`, `dailyPosterCarTravelAt`, and
the physics harness `simulateStraightLine`.

## 13. The hard-crash path has been dead since July

Commit `08b9ce9` (Make wall collisions forgiving, 2026-07-15) removed the only production call
to `handleHardCrash`. Walls now scrape and bounce. No production code sets a crash any more,
but everything downstream of a crash is still present.

Wall hits and the collision auto-restart setting are live, and they do not use this path. A
wall hit emits a `wallImpact` event of kind `scrape` (`game/race/simulation.js:748`). When the
setting is on, `game/race/engine-methods.js:744` calls `restartCurrentRunAfterCollision()`.
That method keeps the status at `'playing'` and resets the run to the start line. It never
sets `'crashed'` and never sets `crashEndedRun`. The setting's storage key
(`VectorGpAutoRestartAfterCrash`) and its `crashAutoRestartEnabled` field keep the old
names, but they belong to the live restart. They are not part of the dead path.

The dead path:

| File | Lines | What is dead |
|---|---|---|
| `game/race/run-policy.js` | 67–80 | `handleHardCrash`, the only writer of `state.status = 'crashed'` |
| `game/race/simulation.js` | 27–28, 30–31, 44–45, 47–48 | `challengeFailed`, `challengeFailureReason`, `crashImpact`, and `crashEndedRun`; production only resets them |
| `src/server/replay-validator.ts` | 289–294 | The crash rejection branch |
| `game/audio/procedural-music.js` | 485–486 | The `'crashed'` music filter branch |
| `game/config.js` | 38 | `crashRelaunchDelay` (already in §7) |

No production code reads `challengeFailed`, `challengeFailureReason`, or `crashImpact`. Only
the validator branch reads `crashEndedRun`. `tests/run-policy.test.js` and `tests/run-policy-contract.test.js`
call `handleHardCrash` directly. `tests/replay-validator-branches.test.js` reaches the validator
branch only through a stub `updateSimulation` that returns `crashEndedRun: true`.

Decide the validator branch on purpose. It is dead today. It also rejects a crashed replay if
hard crashes ever return. If you keep it as a guard, say so in a comment. If you remove it,
remove the whole path in one change, together with its tests.

## Checked and clean

- **Module files.** No orphan was confirmed in the maintained surfaces; excluded legacy
  and skill files are described in section 1.
- **Routes.** There are 46 concrete project endpoints: 34 API endpoints, 10 menu actions,
  and 2 schedulers, excluding the package-owned telemetry router. The earlier count of 37
  counted the shared menu registration call once rather than its ten concrete paths.
  The internal endpoints are wired by `devvit.json`. `/api/analytics/guest-transfer` has no
  in-app caller on purpose. `docs/guest-transfer-recovery-runbook.md:35` documents it as a
  moderator tool.
- **Assets.** Apart from the thirteen share images in §9, every file under `public/` and
  `assets/` is requested.
- **Test helpers.** All exports of `tests/helpers/` have a reader.
- **Own-file-only exports.** 84 exported names have callers only inside their own file. Only
  the `export` keyword is redundant, and removing it gains nothing. Leave them. Eight of them
  sit in files that `stryker.config.mjs` mutates.

## Three things that look dead and are not

Each of these failed a naive check. Do not report them again.

1. **`campaignEngineMethods` and `headToHeadEngineMethods`.** `game/engine.js` does not
   import them. `game/modes/runtime-loader.js:11` collects every export whose name ends with
   `EngineMethods` and mixes it in at run time.
2. **The carousel element ids.** `game.html` declares `daily-carousel-rail`,
   `campaign-carousel-prev`, and eleven more. `game/ui/track-carousel.js:262` builds each id
   from an `idPrefix` and a suffix. The getters at lines 266 to 273 request all eight
   suffixes.
3. **`.analytics-legend__swatch--new` and `.analytics-tip__key--new`.** `mod-analytics.js`
   lines 174 and 309 build these names from a series value of `new` or `returning`.

An earlier version of this list named a fourth item, the crash check in
`src/server/replay-validator.ts:289`. That entry was wrong. The check is dead in
production (§13).

## One item from the 2026-08-01 audit is now resolved

That audit kept `assertModeratorForSubreddit` and `isModeratorForSubreddit` in
`src/server/moderator-access.ts` as an unwired security check. Both are now wired.
`src/server/server-app.ts:105` supplies the function, and
`src/server/routes/analytics-routes.ts` calls it at lines 71 and 95.

## Independent verification and limits

- Reviewed the live working tree initially based on `b383d3f`. Another task committed the
  pre-existing Brag copy/test and audit-document changes as `e9a578e` during this review.
  This audit changed documentation only; no source code or tests were edited.
- Parsed static imports, literal dynamic imports, HTML links, and CSS references across
  351 tracked non-test JS/TS modules, then checked configured scripts, build stubs, test
  setup, skill tooling, and the excluded legacy island. Dynamic engine registration was
  checked separately; an absent direct import alone is not a dead-code finding.
- Independent nested CSS traversal checked all tracked stylesheets, including developer
  tools. No additional unread custom properties or unused keyframes were confirmed.
- Full Vitest baseline: 232 files / 3,005 tests passed in the sandbox; 4 route suites /
  29 tests were blocked by `listen EPERM`. Rerunning those four suites with loopback access
  passed all 29. Combined result: **236 files / 3,034 tests passed**.
- TypeScript with unused checks produced **6 unused-declaration diagnostics and 23 other
  diagnostics** (exit 2). Type checking is not green. The replay status diagnostic
  (`replay-validator.ts:289`) rests on narrowing that ignores the `updateSimulation` call, so
  it proves nothing alone. The branch is still dead, for a different reason: no production
  code sets a crash (§13).
- A second recheck on the same day re-verified every file, line, and commit that this report
  cites. It corrected these errors: the replay crash check (§13), the engine method count and
  one missed method (§3), the asset claim (§9), the carousel id count and line, the PB
  classifier callers (§2), the "Added by" column label (§2), and the Stryker claim for
  own-file-only exports. It added §12 and §13. It did not rerun Vitest.
- No production build, hosted runtime exercise, or deletion experiment was performed.
  These are verified cleanup candidates, not proof that an implementation removing them
  has passed regression checks. Tests passing do not prove absence of dead code.
