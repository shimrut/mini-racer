# Dead Code Audit

Date: 2026-09-23. Branch: `chore/duplicate-cleanup`. Head: `139149e`. The working tree also
holds uncommitted Mapmaker work and nine new tracks. §8 covers that work separately.

This report records findings. It does not change code.

## Why this audit

The last audit ran on 2026-09-22 (`docs/dead-code-audit-2026-09-22.md`). Six removal phases
followed it. Then about 40 duplicated-code cleanup commits changed 267 files. A cleanup of
duplicates can leave the old copy without callers. This audit checks for that. It also adds
two checks that the last audit did not run:

- Class methods and object-literal function members, by name, across all classes. The last
  audit checked only UI getters and a few named members.
- Object fields that code writes and no code reads.

## Summary

| Area | Result |
|---|---|
| Module files | Clean. No orphan file. |
| Engine methods | Clean. Every mixed-in method has a reader. |
| Server routes | Clean. 34 API, 10 menu, and 2 scheduler endpoints, all wired. |
| Stylesheets (all 27, nested rules included) | Clean in the product. 2 unused rules in Runner Lab. |
| Config keys | Clean. |
| TypeScript unused locals and parameters | 0 in `src/`. |
| JavaScript unused imports and locals | 1 new unused import. 1 new unread parameter. |
| Re-exports that no production file reads | 4 barrels, 27 names (§2) |
| Functions and methods that only tests call | 7 (§3) |
| Members that nothing calls | 1 (§3) |
| Functions that always return the same empty value | 2 (§4) |
| Object fields that nothing reads | 12 groups (§5) |
| Uncommitted work | 1 unused pair of constants, 1 misspelled medal key, 1 leftover image (§8) |

**The cleanup commits since 2026-09-22 left no dead code.** No finding below comes from them.
Every finding existed before 2026-09-22. The last audit did not see them because it did not
run the checks listed above.

## 1. Unused import and unread parameter

`npx tsc --noEmit --noUnusedLocals --noUnusedParameters` reports 0 diagnostics for `src/`.

A second run with `allowJs` and `checkJs` covers the JavaScript. It reports two new items:

| File | Line | Name | Cause |
|---|---|---|---|
| `game/car/sprite.js` | 3 | `STOCK_CAR_ASSET_NAME` import | Phase 2 removed `getCarAssetNameForPresetConfig`, its only reader. The re-export on line 5 is live: `player-car-skin.js` reads it. |
| `game/race/ui-modal-content.js` | 498 | `bestTime` parameter of `renderLapTimesList` | Phase 1 removed the local `delta`, its only reader. The last report predicted this. |

The other 17 unread JavaScript parameter bindings are the same as in the last report (§5
there). They are signature cleanup only.

## 2. Re-exports that no production file reads

These files re-export names from the module that now owns them. Production code imports the
names from the owner. Only tests import them through the old file. The functions are live.
Only the re-export lines are dead.

| File | Lines | Names | Since |
|---|---|---|---|
| `game/daily-challenge/service.js` | 30–46 | 12 of the 15 names re-exported from `labels.js`. The three live ones are `getDailyChallengeCardStatus`, `getDailyChallengeExpiry`, and `isDailyChallengeLapCount`. | `fc13cca`, 2026-07-21 |
| `game/medals/medals.js` | 24–44 | 11 names that `medals.js` imports from `medal-timing.js` and exports again: `TRACK_MEDAL_THRESHOLDS`, `allStandardMedalsUnlocked`, `formatMedalTargetsLine`, `getAuthorMedalSeconds`, `getCombinedMedalStackTiers`, `getMedalForLapTime`, `getMedalForRaceTime`, `getNextMedalTarget`, `getRaceMedalThresholds`, `getTimeToBeatSeconds`, `getTrackMedalThresholds` | `5108707`, 2026-07-21 |
| `src/server/daily-gp-store.ts` | 149–150 | `parseStoredPlayerProfile`, `salvagePlayerPreferences` from `competition-identity.ts` | `cb1ed30c` 2026-07-29, `c4da688` 2026-08-10 |
| `game/scoreboard/api-client.js` | 4 | `setGuestPlayerToken` from `player-identity.js`. The other two names in the block are live. | `9b3e2ba`, 2026-07-21 |

`game/index.js:79` also exports `clearModeRuntimeCacheForTests` and `modeRuntimeController`.
`game/index.js` is the page entry. No file imports it, so no code can read these exports. The
import of `clearModeRuntimeCacheForTests` on line 6 exists only for this export. The test in
`tests/mode-priority-loading.test.js` imports the function from `runtime-loader.js`. It was
added in `bed77ee` (2026-08-12).

To remove a re-export, point its tests at the owning module first. About 30 test files import
from these four files. Several of them are mutation-kill tests. In `medals.js`, remove only
the name from the export list: the file also uses some of these imports itself.

## 3. Functions and members that only tests call, or that nothing calls

| File | Line | Name | Test files | Last production caller removed |
|---|---|---|---|---|
| `game/scoreboard/ui.js` | 534 | `LeaderboardsUi.openDailyChallengeLeaderboard` | 2 | `2908592`, 2026-07-29 |
| `game/scoreboard/ui.js` | 362 | `LeaderboardsUi.primeDailyLeaderboardRefreshSession` | 1 | Only `openDailyChallengeLeaderboard` calls it |
| `game/race/ui-modal-shell.js` | 2276 | `ModalShell.updateModalRunSummary` | 1 | No production call in the history |
| `game/race/ui-modal-shell.js` | 2128 | `ModalShell.getModalScoreboardStatusText` | 1 | No production call in the history |
| `game/daily-challenge/labels.js` | 33 | `getDailyChallengeModeSelectObjectiveLine` | 3 | No production call in the history |
| `game/daily-challenge/labels.js` | 153 | `formatDailyChallengePlaylistAvailabilityLabel` | 6 | `feeec0f`, 2026-06-11 |
| `game/race/ring-buffer.js` | 39 | `RingBuffer.toArray` | 1 | No production call in the history |

Nothing calls this member, and no test calls it:

| File | Line | Name | Note |
|---|---|---|---|
| `game/daily-challenge/engine-methods.js` | 909 | `onLeaderboard` in `playlistActions` | The Tracks sheet reads only `onPlay` (`game/daily-challenge/ui.js:291`). The last reader went in `5dbbc8c`, 2026-05-24. |

Notes:

- **The standings pair.** `openDailyChallengeLeaderboard` is about 80 lines. It opens
  standings for the current Daily from the lobby summary. Every live path now calls
  `openDailyChallengeLeaderboardForChallenge` instead. `primeDailyLeaderboardRefreshSession`
  has two calls, and both are inside the dead method (lines 561 and 604). The other helpers
  that the dead method calls have live callers too, so they stay.
- **`getDailyChallengeModeSelectObjectiveLine`** is the only reader of the `modeSelectLine`
  key in `getDailyChallengeCopyLabels` (`labels.js` lines 44 and 51). That key goes with it.
- **Tests read these through the prototype.** `tests/ui-modal-runs.test.js` takes
  `ModalShell.prototype` members by destructuring. A name search in `game/` alone finds no
  caller, and that result is correct.

## 4. Functions that always return the same empty value

`game/daily-challenge/labels.js:166` `getDailyChallengeModifierBadges` returns `[]` for every
input. `labels.js:170` `getDailyChallengeModifierLabel` joins that empty list, so it always
returns `''`. The Daily engine writes both results into the Daily summary as `modifierBadges`
and `modifierLabel` (`game/daily-challenge/engine-methods.js` lines 569–570 and 688–689). No
code reads either field. The `objectiveLabel` field on lines 568 and 687 has no reader either.
`getDailyChallengeObjectiveLabel` stays: line 1438 uses it for the modal message.

`getDailyChallengeModifierBadges` has returned an empty list since the first commit
(2026-05-23).

## 5. Object fields that nothing reads

A field-level check found keys that code writes and no code reads. Most hits are not dead:
Redis options, Reddit API options, console log payloads, stored records that people inspect,
build config, and debug hooks. The rows below are internal objects with no outside reader.
Each row was read in context.

| File | Line | Field | What happens |
|---|---|---|---|
| `game/daily-challenge/engine-methods.js` | 568–570, 687–689 | `objectiveLabel`, `modifierBadges`, `modifierLabel` | Written into the Daily summary. Never read (§4). |
| `game/daily-challenge/engine-methods.js` | 906, 1520; `game/engine.js:803` | `startSource` | Passed to `handleStartDailyChallenge`. That method reads only `preserveRaceComparisonTarget`. |
| `game/race/engine-methods.js` | 680 | `variant: "daily-pause"` | `showModal` never reads `variant`. Also `variant: null` at `daily-challenge/engine-methods.js:1397`. |
| `game/campaign/service.js` | 61 | `continueRaceId` | Campaign progress summary field. Never read. |
| `game/car/player-car-skin.js` | 71 | `unlockRequirement` | Skin list field. Never read. |
| `game/challenge-run/engine-methods.js`, `game/daily-challenge/engine-methods.js` | 202, 362 | `ghostActive`, `ghostExpected` in the return value | The caller reads only `noticeNeeded`. |
| `game/campaign/engine-methods.js` | 1007 | `bestResultComparator` in the fallback policy | `isNewBestResult` does not read this key. |
| `game/lobby/service.js` | 232, 244 | `gapLabel`, `trackLabel` | Lobby view-model fields. Only one test reads `gapLabel`. |
| `game/head-to-head/engine-methods.js` | 231 | `frozenGhostPrepared` | Set on the active Head to Head. Never read. |
| `game/storage.js` | 359 | `transferPauseReleaseFailed` | Written into the cached profile. Never read. |
| `game/scoreboard/verification-queue.js` | 85 | `expiredAt` | Written on an expired Campaign entry. Never read. |
| `src/server/campaign-store.ts` | 569–570 | `guestPromotionPending`, `progressSelectionRequired` in the Campaign bootstrap reply | The client reads neither. Backwards compatibility is required only for Daily GP. |

Smaller cases of the same kind: `activeReplay.prepareFromServer` and `activeReplay.openReplays`
in `podium.js:324–325`, and `syncChrome` in the controller that `podium-replay-view.js:638`
returns. Each function is live. Only the object member is unread.

The check matches by field name across the whole codebase. A field name that some other
object also uses looks read. So this list is a lower bound.

## 6. Developer tools

These do not ship. They are listed so a cleanup can include them or skip them on purpose.

- `tools/runner.css:456` and `:461`: `.status-chip--stuck` and `.status-chip--running`. Runner
  Lab never sets a run status of `stuck` or `running`. The `'stuck'` branch at
  `tools/runner.js:869` is also unreachable.
- `tools/tiktok-studio.js`: 21 unread parameters and locals. `tools/runner.js`: 2 unread
  parameters.
- `.gitignore:18` keeps an exception for `tools/bust-client-asset-cache.js`. That file no
  longer exists, and `tests/release-pipeline.test.js:46` asserts that it stays gone.
- `ok-let-s-plan-for-fluttering-horizon.md` at the repository root is the Head to Head
  rename plan from `93dd6ce` (2026-08-10). `devvit.json` and
  `tests/release-pipeline.test.js` name it. It is a document, not code. Move or delete it
  on purpose.

## 7. Items still open from the last audit

No change since 2026-09-22:

- `fflate` is still imported only by `game/ghost/pb-ghost-size-debug.js`, which the client
  build replaces with a stub. It belongs in `devDependencies`.
- No file imports `@devvit/public-api`.
- The three guest merge helpers still receive `replace: true` from every production caller
  (`src/server/daily-gp-store.ts:2523`, `:2535`, `:2550`).
- `tools/analyze-unused-css.js` still has the four gaps from §10 of the last report.

New dependency notes:

- `src/server/share-image.ts` and `src/server/shared-cache.ts` import
  `@devvit/shared-types`. `package.json` does not declare it. It arrives through the Devvit
  packages.
- 15 test files import `jsdom`. `package.json` does not declare it. It arrives through
  `vitest`.

These two are not dead code. They are undeclared dependencies.

## 8. Uncommitted work in the working tree

These items are in files that are not committed yet.

- **`tools/mapmaker.js:64–65`: `CAR_WIDTH` and `CAR_LENGTH` have no reader.** The uncommitted
  change removed their two readers (the car-size note and a world-units conversion).
- **`game/medals/medal-times.json:830` names `sunetTerrace`.** The track key is
  `sunsetTerrace`. No track has the key `sunetTerrace`, so no code reads this entry. The
  Sunset Terrace track has no medal times. `anvilCircuit` has no medal times either.
- **`assets/share/newCircuit.jpg` is a leftover.** `newCircuit` is the default key that the
  Mapmaker offers for a new track. No track has that key. `anvilCircuit.jpg` sits next to it.
  The other 124 share images match the 124 scheduled tracks one for one.

The nine new track definitions, the new Mapmaker modules, and the new Mapmaker stylesheets
have no dead exports and no unused rules.

## Checked and clean

- **Module files.** A graph from all HTML pages, the server entry, the Vite, Vitest, and
  Stryker configs, and the `package.json` scripts reaches every module. The only files it
  does not reach are the three debug `.stub.js` files (swapped in by
  `tools/debug-module-stubs.js`), the separate `LP/` site, and the Devvit docs skill script.
- **Engine methods.** 164 methods in 10 engine method files. All have a reader. The Daily module
  still overrides 12 shared methods. That is duplication, not dead code. See
  `docs/duplicated-code-audit-2026-09-23.md`.
- **Stylesheets.** A nested walk of all 27 stylesheets found 2,402 class references. All
  product classes have a producer. The 27 that do not appear literally are built from a
  prefix at run time, and each value set was checked.
- **Config keys.** Every key of `CONFIG` and `API_ROUTES` has a reader.
  `TRACK_PRESENTATION_SURFACES.TRACK_PICKER` and `.SHARE` have no producer, but they are
  names in a lookup table, not behaviour.
- **Assets.** All 23 car images, the fonts, the icons, and 124 of 125 share images are used
  (§8 names the one that is not).
- **Test seams** stay as recorded on 2026-09-22.

## Method and limits

- Ran `tsc` with unused checks on `src/`, then again with `allowJs` and `checkJs` on `game/`,
  the root pages, and `tools/`.
- Parsed every module with the TypeScript parser. Counted an export as used only when a
  production file imports it from its own module, directly, through a re-export, through a
  namespace, or through a dynamic import or `import.meta.glob`.
- Counted a class or object member as used only when code reads its name as a property, by
  string, or in HTML. Ran this to a fixed point, so a member that only dead members call
  also shows as dead.
- Read each finding in context before this report names it.
- Did not run the test suite, a production build, or a removal experiment. These are
  verified candidates, not a tested removal.
