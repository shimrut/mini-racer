# Dead and Redundant Code Audit

Date: 2026-10-03. Branch: `codex/restore-v240-tracks`. Head: `94cba4ae`. The working tree
also holds a large amount of uncommitted work: the new Garage (paint, decals, car type tabs),
the series rule "live only when the Creator makes it live", the restored tracks, and the
landing page. That work is in progress. §3 lists only what it makes unused. This audit does
not judge it.

This report records findings. The section below lists what was removed after it.

## Removal progress

Done on 2026-10-03, on `codex/restore-v240-tracks` after `94cba4ae`, one commit for each
item. Each commit holds only these lines. The other uncommitted work in the same files stays
uncommitted.

- `025dc0d0`: `loadAllStoredTracks` and `listedStoredTrackKeys`. The comment about the full
  track list moved to `listStoredTrackRecords`.
- `8f058f45`: `prefetchDailyChallengePlaylist`. Its only helper,
  `prefetchDailyChallengeSnapshots`, then had no game caller, so it went too. Five test
  files keep their checks of the missing snapshot ids and the snapshot cache.
- `acac0df1`: the engine reads `NARROW_VIEWPORT_MAX_WIDTH` in place of the two `768` values.
- `e9eb75f3`: `CAMPAIGN_HAS_SERIES_CHOICE`. The tests ask `campaignHasSeriesChoice()`.
- `c2105d77`: `isReady`. The tests ask `findRecord`.
- `54428716`: `canUndo` and `canRedo`. The tests check that `undo()` and `redo()` give
  `null`.
- `369314cf`: the two Home start checks now watch `prepareInitialCampaignLaunch`, and the
  engine method `resolveDefaultCampaignStage` went. With a planted Campaign call at the Home
  start, in a copy of the code, the new checks fail and the old checks still pass.
- `0fa8b134`: `lockStoredTrack` and `saveCreatorTrackSnapshot` stay as test helpers, with
  comments that say so. 18 test lines use `lockStoredTrack` to set up a locked track, also
  for writes at the same moment. 11 test calls use `saveCreatorTrackSnapshot` to test one
  save with no conflict recovery. A removal would copy the same code into the tests.

Not done, on purpose:

- **The Community routes (§1.1) stay.** Decision on 2026-10-03: Community comes back later.
- The short answer of the Creator track list (§1.2). This report grouped it with the
  Community decision.
- §3: it waits for the uncommitted work. §4: low risk, not no risk. §5: as before.

Checks: `tsc` gives 0 errors. Every client entry, the Creator, the Mapmaker, Runner Lab and
the server bundle with esbuild. The full suite on the working folder has the same 48 failures,
by name and message, before and after. 46 of them come from the uncommitted work: 45 guest
transfer recordings and one track placement test. The other 2 also fail in the committed
code: the medal order and the track registry. The full suite on a clean copy of `94cba4ae` and on a clean copy of `0fa8b134` has the same 2
known failures (the medal order and the track registry) and no other.

## Why this audit

The last audit ran on 2026-09-27 (`docs/redundant-code-audit-2026-09-27.md`, head
`2c8d15b`). Since then, 138 commits landed. Most of them moved the tracks, the Daily list
and the Campaign series to Redis, built the Creator, and made the race start instant. A
move like this can leave an old path without a caller.

## Summary

| Area | Result |
|---|---|
| Module files | Clean. Every file is reached. |
| TypeScript unused names | 0 in `src/`, `game/` and `pages/`. `tools/` has the same 25 as on 09-27. |
| Server routes | 5 Community routes and 1 route branch have no caller (§1.1, §1.2). |
| Functions and values with no caller | 5 groups (§1.2) |
| Code that only tests use | 5 items, and 2 test checks that always pass (§2) |
| Made unused by the uncommitted work | 3 items (§3) |
| New copied code | The segment math now runs in the server's track check (§4) |
| Stylesheets, element ids, share pictures, track files, medal times, packages | Clean |
| Older findings | Still open, unchanged (§5) |

## 1. Dead code

### 1.1 The Community map routes of the old Creator

On 2026-09-30, `aa28438f` changed the Creator to edit game tracks. Its message says: "The
Creator no longer publishes Community maps." The Creator stopped calling five server routes
(`src/server/routes/community-map-routes.ts:41–96`):

- read the draft and save the draft (`/api/creator/draft`, GET and PUT),
- publish the draft (`/api/creator/publish`),
- list every map, also the unpublished ones (`/api/creator/maps`),
- change the status of a map (`/api/creator/maps/:id/status`).

No game page, Creator page or tool calls them. Only
`tests/server-community-map-routes.test.js` does. The store functions behind them have no
other caller: `readCommunityDraft`, `saveCommunityDraft`, `publishCommunityDraft`,
`changeCommunityMapStatus`, and the unpublished branch of `listCommunityMaps`
(`src/server/community/community-map-store.ts`). The publish step also needs a Test Drive
lap proof that no client makes now.

The two player routes (`/api/community/maps` and `/api/community/maps/:id`) still have a
caller: the Community screen, which the game hides on purpose (`COMMUNITY_VISIBLE = false`).
With the five routes gone, nothing can add a Community map. Keep or remove is a product
decision, not an automatic delete. **Decision, 2026-10-03: keep. Community comes back later.**

### 1.2 New since 2026-09-27

| Location | Finding | Since |
|---|---|---|
| `src/server/tracks/stored-catalog.ts:112`, `src/server/tracks/track-store.ts:350` | `loadAllStoredTracks` and its only helper `listedStoredTrackKeys` have no caller, not even a test. Their comment says that the Creator, the copies and the moderator pages use them. They do not. | `390cae90`, 10-01: "Load only the stored tracks that a request names." |
| `game/daily-challenge/engine-methods.js:1065` | `prefetchDailyChallengePlaylist` has no caller. The only call named it as text (`invokeModeMethod("daily", "prefetchDailyChallengePlaylist")`). | `94cba4ae`, 10-02 |
| `src/server/routes/track-routes.ts:86–88` | The Creator track list has two answers: the full records (`?full=1`) and short summaries. The Creator always asks for the full records. No client asks for the summaries. The summary list itself stays live: the Daily and series screens of the Creator read it directly. | `aa28438f`, 09-30 |
| `game/race/race-camera.js:6` | `NARROW_VIEWPORT_MAX_WIDTH` has no reader. The Drive Draft read it until it got its own Desktop and Mobile screens. The game does not use the name: it writes `768` twice (`game/track/engine-methods.js:186`, `:215`). | `949a7651`, 09-29 |
| `tools/mapmaker/edit-history.js:33–34` | `canUndo` and `canRedo` have no reader since the Undo and Redo buttons left the Creator. Only `tests/mapmaker-edit-history.test.js` reads them. The Creator ships to Reddit, so this is player-side code. | `a5caf1f0`, 09-29 |

Two comments in `src/server/tracks/track-store.ts` are out of place. The comment at `:366–367`
("Every stored track with its shape, newest change first. Only the Creator reads this list.")
sits above `readStoredTrackKeys`, which reads only the keys. The comment on
`loadAllStoredTracks` is in §1.2.

## 2. Code that only tests use

| Location | Finding | Tests |
|---|---|---|
| `src/server/tracks/track-store.ts:576–604` | `lockStoredTrack` and its two retry values. The game locks a track inside the placement write with `freezeStoredTrack`: for a Daily at `daily-gp-store.ts:798`, for a series at `series-store.ts:428`. The tests use `lockStoredTrack` to set up a locked track. | 3 files, 16 lines |
| `game/campaign/manifest.js:93` | `CAMPAIGN_HAS_SERIES_CHOICE`. The game reads `campaignHasSeriesChoice()` since `7ca14011` (09-30). With the app data, the value is always `false`, because only Numbers is live in the app. | 3 files |
| `game/campaign/engine-methods.js:591` | The engine method `resolveDefaultCampaignStage`. The game calls the module function with the same name directly (`:627`), never the method. See the note below. | 1 file |
| `game/track/race-preparation.js:199` | `isReady`. It came with `e824ac1f` (10-01) and never had a game caller. | 1 file, 7 checks |
| `tools/mapmaker/creator-track-save.js:191` | `saveCreatorTrackSnapshot`. The Creator saves with `saveCreatorTrackWithRecovery`. | 1 file |

**Two checks that always pass.** `tests/startup-mode-identity-matrix.test.js:111–116` and
`:128–140` replace the engine method `resolveDefaultCampaignStage` with a stub. Then they
check that the Home start does not call it. The game never calls the method on any path, so
both checks pass whatever the Home start does. They do not show that Home leaves the
Campaign alone. Removing the method also removes these two checks. A real check must watch
the Campaign bootstrap instead.

**Test seam, keep.** `setStoredTrackLoader` (`game/track/client-registry.js:13`) lets a test
swap the server request for a stored track. It is of the same kind as the `*ForTests` resets.

## 3. Made unused by the uncommitted work

These items are unused only in the working tree. Judge them when that work is committed.

- `CAMPAIGN_ALL_SERIES` (`game/campaign/manifest.js:165`). The series screen now shows only
  the live series, so it reads `CAMPAIGN_SERIES`. Only 3 test files read the full list.
- The `panelTrails` getter (`game/settings/garage-ui.js:101`). The new Garage no longer shows
  or hides the trails panel by this name.
- `listStoredTracks` (`src/server/tracks/track-store.ts:379`). In the committed code, the
  Creator's Daily and series screens and its track list route use it. The uncommitted Creator
  access file (`creator-track-access.ts`) replaces these uses with `listCreatorTracks`. Take
  care: the route still has a dependency named `listStoredTracks`, but in the working tree
  that one is `listCreatorTracks` (`server-app.ts:166`). A name search makes the export look
  used. Only `tests/server-track-store.test.js` calls the export.

The new paint and decal settings (`game/car/player-car-paint.js`,
`game/car/player-car-decals.js`) have the same 40 lines with other names. This is in
progress and not reported as copied code here.

## 4. Copied code

### 4.1 The segment math now runs in the server's track check

On 2026-09-30, `51b0dc9f` moved `lane-gate.js` and `track-quality.js` from the Mapmaker tools
into `game/track/authoring/`. The server now runs `track-quality.js` before it lets a track
into a Daily or a series (`src/server/tracks/track-readiness.ts:11`). The 09-23 audit listed
the lane gate copy as a tool copy that does not ship. Now it ships.

Three functions find where two segments cross. Each has its own rule for parallel lines:

| Location | Used by | Parallel when |
|---|---|---|
| `game/track/geometry.js:13` | The race: walls, checkpoints and the finish line. The server replay check runs the same race code. | The divisor is exactly 0 |
| `game/track/authoring/lane-gate.js:49` | The Creator: gates across the road | The divisor is less than 1e-9 |
| `game/track/authoring/track-quality.js:15` | The track check on the server and in the Creator | Its own form, which also finds overlapping lines |

The closest point on a segment is written five times: `lane-gate.js:12`,
`track-quality.js:105`, `tools/mapmaker/track-flow.js:71`, `tools/mapmaker.js:266`, and
`tools/runner.js:116`.

`game/track/authoring/geometry.js` has its own `clamp`. `game/shared/clamp.js` has another.
The two give the same result except when the low bound is above the high bound.

This audit did not find a track on which the copies give different answers. The risk is
drift: a fix in one copy can miss the others.

### 4.2 Files that only forward

Three tool files only re-export the authoring folder. Each says that it keeps old imports
working:

- `tools/geometry.js` (11 tool files import it),
- `tools/mapmaker/track-quality.js` (3),
- `tools/mapmaker/lane-gate.js` (2).

The importers can import `game/track/authoring/` directly. No player risk.

## 5. Still open from earlier audits

All of these are still in the code, with the notes of their reports:

- **09-23:** Daily still overrides shared race-run methods. The largest copy is 226 tokens
  (`game/challenge-run/engine-methods.js:136–171` and
  `game/daily-challenge/engine-methods.js:1075–1120`). The replay-in-post codec, the
  post-record reading and the ghost size check each exist twice.
- **09-26, group 4:** the engine promise fields, `runHadTimingAnomaly`, the two last-lap
  medal flags, `param` and `closestPoint`, and `currentModeKey`.
- **09-26, group 5:** the transfer report fields, `entryClass` and `pbClass`, and
  `promotedPlayerId`.
- **09-27, §2:** the transfer options that only tests use (`classifySource`,
  `preserveSource`, the own lock runners).
- **09-27, §3.1:** the row delete in four places, the raced-list rules in the fill and the
  guest clean-up, the transfer choice on both sides, the two Daily wrappers with the same
  body, and the start of the guest expiry sweep.
- **09-27, §4:** the raced-list fill and its fallbacks wait for the ready record on every
  install.
- **Test probes kept on purpose:** the three verification queue probes,
  `catalogHeadToHeadSize`, the `*ForTests` resets, `clearAnalyticsMaintenanceMemory`,
  `clearActivePlayerOwnerId`, `dailyPosterCarTravelAt`, `simulateStraightLine`,
  `RingBuffer.toArray`, the podium replay probes and `cancelEdit`.

## 6. Priority order

The order is by simplicity and by the harm to players if a removal goes wrong.

1. **No player risk, no test changes.** `loadAllStoredTracks` and `listedStoredTrackKeys`,
   `prefetchDailyChallengePlaylist`, and the two comments. Use `NARROW_VIEWPORT_MAX_WIDTH`
   for the two `768` values, or remove it.
2. **No player risk, only tests change.** `CAMPAIGN_HAS_SERIES_CHOICE`,
   `isReady`, `saveCreatorTrackSnapshot`, `canUndo` and `canRedo`. For `lockStoredTrack`,
   the tests need another way to set up a locked track first.
3. **Fix the two checks that always pass**, then remove the engine method
   `resolveDefaultCampaignStage`.
4. **Product decision.** The five Community routes and their store functions (§1.1), and the
   short answer of the Creator track list. Decide first if Community maps will come back
   through the Creator.
5. **After the uncommitted work is committed.** `CAMPAIGN_ALL_SERIES`, `panelTrails` and
   `listStoredTracks`.
6. **Low risk, Creator and server track check.** One segment crossing and one closest-point
   function for the authoring folder (§4.1), then the forwarding files (§4.2). Run the track
   check on every app track before and after, and compare the answers. Keep the race copy in
   `game/track/geometry.js` apart: the server replay check runs it, so a change there can
   change the verdict on a saved run.
7. **As before.** §5 keeps the order and notes of its reports.

## Checked, not reported

- **Route bodies.** Many routes have the same shape: read the user, call one store function,
  answer, catch the error. The Creator routes share their helpers. Each route calls a
  different store function.
- **Tables.** The ground settings, the track catalog and the HUD element lists give clone
  hits. Each hit is rows with other values.
- **Import lists.** The engine and the server app import many names in the same order.
- **Saved settings in the browser.** About 16 places read JSON from the browser storage with
  the same guard. This is older than 09-23.
- **Switches that hide content on purpose.** `QUICK_RESTART_SETTING_VISIBLE` and
  `COMMUNITY_VISIBLE` are `false` by decision.
- **The local Mapmaker file writer** (`tools/mapmaker/track-repository.js`). The Mapmaker
  server (`npm run mapmaker`) uses it. It is a tool.

## Method and limits

- Built a module graph of every tracked and untracked source file from the 11 game pages,
  the server entry, the tool pages and the build and test configs. Dynamic imports and the
  track definition glob count as uses.
- Built a graph of every top-level function, class and value with the TypeScript checker.
  A declaration counts as live only when a page or the server reaches it. Then the tests
  were added as roots to find what only tests reach.
- Listed class members, object methods and `this` fields that no product code reads by
  property name or as text.
- Matched every stylesheet class and id against the source, every element lookup against
  the pages, every server route against the client paths, and every share picture, track
  file and medal row against the track catalog.
- Ran `tsc` with the unused-name checks on `src/`, and with `checkJs` on `game/`, `pages/`
  and `tools/`.
- Found copies with a token scan (60 tokens exact, 80 tokens with names and values
  ignored), and kept the hits that touch lines changed since `2c8d15b`.
- Read each finding in the code, and dated it with `git log -S`, before this report names
  it.
- Did not run the test suite, a build, or a removal. These are verified candidates, not a
  tested removal. The scripts are in the session scratchpad only.
