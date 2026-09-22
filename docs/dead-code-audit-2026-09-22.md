# Dead Code Audit

Date: 2026-09-22. Branch: `racer-v2-4`.

This report records findings. It does not change code.

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

## Summary

| Area | Dead items |
|---|---|
| Module files | 0 |
| Exported functions | 10 |
| Engine methods | 2, plus 1 helper they keep alive |
| Exported types | 1 |
| Locals and imports | 6 |
| CSS rules | 11 |
| Config keys | 5 |
| Package dependencies | 2 |
| Assets | 1 |

## 1. Module files — clean

Every tracked module file has a production reference. The three developer labs under
`tools/` look unreferenced to a graph walk, but `tools/mapmaker.html` links to
`tools/runner.html` and `tools/tiktok-studio.html`. `npm run mapmaker` serves all three.

Two scripts under `tools/` are untracked and git-ignored: `backfill-track-biomes.js` and
`stutter-probe.js`. The first imports `../game/track/biomes.js`, and that file does not
exist. The script cannot run. Both files are local only, so they are outside the product.

## 2. Exported functions with no caller

No file calls these ten functions. No test calls them either.

| File | Line | Name | Added by |
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
`classifyStoredPbRecordValue` and `classifyStoredPbRecordFor` have callers in
`daily-gp-store.ts` and `campaign-store.ts`. Only `classifyStoredPbRecord`, which reads
Redis itself, has none.

**The guest transfer predicates.** `requiresReviewedRecovery` and `carriesCopyableData` read
as the intended vocabulary of the transfer safety work. Their callers test
`classification.state` directly instead. These two are unwired helpers, not rot. Decide
whether to wire them or to remove them.

`IGNORE SUPABASE/daily-gp-model.ts:172` also exports an unused `assertDailyGpTrackCooldown`.
That whole directory holds four files, and no file outside it imports them. `devvit.json`
excludes the directory from the shipped source. Treat the directory as one decision, not as
one dead function.

## 3. Engine methods with no caller

`Object.assign` mixes the engine method objects onto `RealTimeRacer.prototype`. Of 186
methods, two have no caller:

- `game/track/engine-methods.js:190` — `getLoadedTrack`
- `game/track/engine-methods.js:194` — `prefetchTracks`

Both methods are one-line pass-throughs. `getLoadedClientTrack` has six other callers and
stays. `prefetchClientTracks` in `game/track/client-registry.js:81` does not. Line 195 is
its only caller, so it dies with the method.

`isClientTrackLoaded` in §2 sits in the same module. All three items come from the same
startup work in August 2026.

## 4. Exported type with no reference

`src/server/daily-podium-model.ts:39` exports `DailyGpPodiumCustomPostData`. No file names
it. The neighbouring `DailyGpPodiumPostData` is live.

## 5. Locals and imports with no reader

`npx tsc --noEmit --noUnusedLocals --noUnusedParameters` reports six.

| File | Line | Name | Note |
|---|---|---|---|
| `src/server/head-to-head-service.ts` | 52 | `releaseRedisLock` | Unused import |
| `src/server/daily-podium-replay.ts` | 54 | `emptySlot` | Unused helper function |
| `src/server/daily-gp-store.ts` | 1008 | `releaseSubmissionLock` | `releaseSubmissionLocksSafely` replaced it |
| `src/server/daily-gp-store.ts` | 3030 | `result` | The call has side effects; only the variable is dead |
| `src/server/campaign-store.ts` | 1145 | `guestProgressLock` | A lookup, not an acquire; `redditProgressLock` stays |
| `src/server/competition.ts` | 93 | `playerId` | See below |

`toCampaignCompetition` accepts a `playerId` option and never reads it. Three call sites pass
a value: `campaign-store.ts:129`, `daily-gp-store.ts:327`, and `daily-gp-store.ts:1839`.
The parallel `toDailyCompetition` has no such option. Confirm that the campaign keys must
not carry a player before you delete the option, because a silently ignored argument can also
be a defect.

The two lock names need the same care. `releaseSubmissionLock` and `guestProgressLock` are
dead by the compiler, but a lock that nobody releases is a different problem. Both sites
release their locks elsewhere, so these two are safe. Check this again if the code moves.

## 6. CSS rules with no producer

No HTML file and no JavaScript file produces these eleven rules.

| File | Lines | Selector |
|---|---|---|
| `styles/race-hud-and-medals.css` | 460, 464, 468 | `.combined-medal-challenge-label--pending`, `--outcome`, `--error` |
| `styles/race-hud-and-medals.css` | 481, 492, 496 | `.combined-medal-challenge-margin` and its `.is-gain` and `.is-loss` forms |
| `styles/lobby-modes.css` | 309, 313 | `.lobby-mode-toolbar__back` and `.lobby-mode-toolbar__back svg` |
| `mod-analytics.css` | 418, 425, 431 | `.analytics-bar`, `.analytics-bar__fill`, `.analytics-bar__marker` |

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

**`fflate`.** Only `game/ghost/pb-ghost-size-debug.js` imports it. `vite.config.js` swaps
that module for `game/ghost/pb-ghost-size-debug.stub.js` in the client build, and the stub
imports nothing. The server compresses with `node:zlib`. So `fflate` never reaches a
shipped bundle.

**`@devvit/public-api`.** No file in the project imports it. `node_modules/@devvit/cli`
declares it, so the install keeps it either way. Confirm with Devvit before you remove it,
because the platform may expect the entry.

## 9. Asset with no reference

`LP/car.webp` is 19 KB. No LP page, no LP stylesheet, and no generator names it.
`devvit.json` excludes `LP/` from the shipped source, so this weight stays on the marketing
site only.

All 153 tracked files under `public/` and `assets/` have a reference.

## 10. Two gaps in `npm run analyze:css`

The tool reads only `styles.css` and `preview.css`. It does not read `podium.css`,
`head-to-head.css`, `campaign.css`, or `mod-analytics.css`. §6 found three dead rules in
`mod-analytics.css` that the tool cannot see.

The tool also holds a list of class prefixes that code builds at run time. That list misses
`challenge-result-lockup__outcome--`. `game/medals/medals.js:263` builds those class names
from a phase value. So the tool reports `.challenge-result-lockup__outcome--won`, `--lost`,
and `--error` as unused, and all three are live.

Add the four stylesheets and the missing prefix. Then the tool result is trustworthy again.

## Checked and clean

- **Module files.** No tracked file is unreachable.
- **API routes.** All 37 routes have a caller. `/api/analytics/guest-transfer` has no
  in-app caller on purpose. `docs/guest-transfer-recovery-runbook.md:35` documents it as a
  moderator tool.
- **Assets.** No unreferenced file under `public/` or `assets/`.
- **Test helpers.** All exports of `tests/helpers/` have a reader.
- **Own-file-only exports.** 84 exported names have callers only inside their own file. Only
  the `export` keyword is redundant. Stryker mutates many of them. Leave them.

## Four things that look dead and are not

Each of these failed a naive check. Do not report them again.

1. **`campaignEngineMethods` and `headToHeadEngineMethods`.** `game/engine.js` does not
   import them. `game/modes/runtime-loader.js:11` collects every export whose name ends with
   `EngineMethods` and mixes it in at run time.
2. **The carousel element ids.** `game.html` declares `daily-carousel-rail`,
   `campaign-carousel-prev`, and ten more. `game/ui/track-carousel.js:263` builds each id
   from an `idPrefix` and a suffix.
3. **`.analytics-legend__swatch--new` and `.analytics-tip__key--new`.** `mod-analytics.js`
   lines 174 and 309 build these names from a series value of `new` or `returning`.
4. **`src/server/replay-validator.ts:289`.** TypeScript reports that
   `state.status === 'crashed'` can never be true, because line 262 narrows the value to
   `'playing'`. `updateSimulation` mutates `state` between the two lines. The check is live.
   The compiler cannot see the mutation.

## One item from the 2026-08-01 audit is now resolved

That audit kept `assertModeratorForSubreddit` and `isModeratorForSubreddit` in
`src/server/moderator-access.ts` as an unwired security check. Both are now wired.
`src/server/server-app.ts:105` supplies the function, and
`src/server/routes/analytics-routes.ts` calls it at lines 71 and 95.
