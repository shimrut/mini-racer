# Duplicated Code Cleanup Plan

Date: 2026-09-23. Source: `docs/duplicated-code-audit-2026-09-23.md` (the "§" numbers below
point to it).

This plan changes no code. It puts the cleanup in order: the lowest risk to players and the
smallest work come first.

## Risk and size

**Player risk**

- **None.** The code does not ship to players (tests and internal tools).
- **Low.** The same code moves to one place. Players see no change. The tests cover it.
- **Medium.** Players use the code, and it reads or writes stored data or posted text. That
  data must stay the same, byte for byte.
- **Decision.** The change alters what players see, hear, or get. It needs a product answer
  before any code changes.

**Size**

- **S.** One or two files, less than about 50 changed lines.
- **M.** Three to six files, or 50 to 200 changed lines.
- **L.** More than that.

## Rules for every step

1. **Settle the working tree first.** 201 files have uncommitted comment removals. Commit
   them or drop them before step 1.1. Then each cleanup commit holds only its own change.
2. **Use a new branch.** Make one commit for each step, as in the dead-code removal.
3. **Gate each step with `npm test`.** It runs the typecheck first. Judge by the named FAIL
   set. The suite was fully green at the end of the dead-code removal.
4. **Keep what is stored and posted.** Do not change Redis keys, lock keys, post markers,
   format names, or messages that players read, unless the step says so.
5. **Keep exported names.** If a test or another module imports a name, keep that name as
   a re-export.
6. **Keep mutation coverage.** 34 files are in the Stryker `mutate` list. If a step moves code
   from one of them into a new shared file, add the new file to that list.
7. **Play-check where the step says so.** Wait for the watcher to rebuild. Then check the
   named screen at `http://127.0.0.1:8000/game.html`. Do not start another server.

## Phase 1 — Code that players do not run (player risk: none)

**Done on 2026-09-23, branch `chore/duplicate-cleanup` (`944c211`..`c0c1b3d`).** The suite
passes: 236 files, 3,011 tests. Differences from the plan:

- 1.1: all 23 copies now use the helper, because the 7 others were compatible with it.
- 1.3: the tools keep their own `clamp`. `game/shared/clamp.js` gives a different result when
  the minimum is larger than the maximum.
- 1.4: only Runner Lab changed. It now uses the game's `smoothPoly`. On all 258 track
  outlines, the largest change is 3e-14. The TikTok Studio finish line and car are not
  copies: they have a different look on purpose. The lane-gate intersection is not a copy:
  it rejects lines that are almost parallel.
- `.gitignore` ignores `tools/*` except the files it lists. The new `tools/geometry.js` and
  `tools/node-script.js` got an exception each.

| Step | Change | Size | Check |
|---|---|---|---|
| 1.1 | Put one `createMemoryLocalStorage` in `tests/helpers/`. 16 of the 23 copies are the same. Replace those 16. Compare the 7 others one by one. | M | Full suite |
| 1.2 | Make `tests/daily-gp-store.test.js` use `tests/redis-test-double.js` in place of its own Redis fake. If the shared fake lacks a behaviour that the tests need, stop and keep the local fake. | M | That test file |
| 1.3 | Put the tool geometry helpers in one tools module: `distance`, `midpoint`, `clonePoint`, `normalizeVector`, `distanceSq`, and `lerp`. Use `game/shared/clamp.js` for `clamp`. | S | Open Mapmaker, Runner Lab, and TikTok Studio |
| 1.4 | Make the tools use the game's own code. Export `segmentIntersectionParams` from `game/track/geometry.js` and `smoothPoly` from `game/track/runtime.js`. A new export does not change the game. TikTok Studio uses `drawCheckeredLine` from `game/track/canvas.js`, and it can use `createCarSprite` from `game/car/sprite.js`. | M | Runner Lab results can change a little, because its copy of the smoothing already differs. That is the goal. Compare two or three tracks before and after. |
| 1.5 | Share `isMainModule` and `ensurePath2D` between the two asset generators. | S | These run on each `npm test` and `npm run build`. After the change, `npm run generate:share-images` must leave `git status` clean. |

## Phase 2 — Exact copies of small functions (player risk: low)

**Done on 2026-09-23 (`ba98328`..`d3b5e4b`).** The suite passes: 237 files, 3,016 tests.
The local play-check (carousels, podium, replay view, analytics) and the playtest on
r/mini_racer_dev (finish times, Head to Head, sharing) found no problem. Differences from the plan:

- New shared files: `src/server/value-guards.ts`, `game/shared/values.js`, and
  `game/ui/dom.js`. The first two joined the Stryker list, because they hold code from
  mutated files.
- 2.3 shares all three preview car callbacks, not only the size.
- 2.4 and 2.5: `tests/stored-name-keys.test.js` pins the post, podium, launcher, and
  Head to Head keys. It passed before each merge. The store tests already pinned the hashed
  player fields. Two more inline copies of the field hash also moved to `playerFieldHash`.

The copies have the same text. They hold no stored data and no posted text.

| Step | Change | Size | Check |
|---|---|---|---|
| 2.1 | Server: keep one copy each of `isRecord` (4 copies), `sha256` (2), `validPostId` (2), `formatHeadToHeadTime` (2), `formatChallengeResultTime` (2), `hasCredential` (2), and the post record expiry (2). | S | Server tests |
| 2.2 | Client: make `formatLeaderboardTime` call `formatTime` (keep both names, because tests use both). Keep one copy each of `scheduleAfterModalPaint` (2), `cleanText` (3), `setText` (3), `getChallengeTimeMs` (2), and the finite-number check (3). `daily-challenge/service.js` already imports `labels.js`, so no import loop starts. | S | Play-check: finish sheet times, the Head to Head page, and the podium page |
| 2.3 | `game/engine.js`: write the preview car size callback one time and give it to both carousels. | S | Play-check: the car shows on the Daily and Campaign cards |
| 2.4 | Server name normalizer: 9 functions do `trim().toLowerCase()`. Keep one. Some of them build Redis keys. First add a test that pins one key string for each store. Then merge. | M | The new key tests and the store tests |
| 2.5 | The player field hash (4 copies under 3 names) and `keyPart` (2). Both build Redis fields. Pin one field string for each store first, as in 2.4. | S | The new key tests |

## Phase 3 — The same code under different names (player risk: low to medium)

Each step makes one function with inputs in place of two or more copies. Stored keys and
posted text must stay the same, byte for byte.

**Low-risk steps done on 2026-09-23 (`433693f`..`407de92`): 3.1, 3.2, 3.3, and 3.8.** The
suite passes: 237 files, 3,016 tests. Notes:

- New files: `src/server/rate-limit.ts`, `src/server/redis-lock-retry.ts`,
  `src/server/progress-transfer-reply.ts`, and `game/scoreboard/player-request.js`. The three
  server files joined the Stryker list.
- 3.2: the retry function is in its own file, not in `redis-lock.ts`. Four test files mock
  `redis-lock.js`, and they must still control each lock attempt.
- 3.9 is skipped. Each handler builds its inputs in a different way, so a shared frame saves
  about four lines for each handler.
- Still to do: the medium-risk steps 3.4, 3.5, 3.6, and 3.7. Step 2.4 already merged the
  name part of 3.5.

| Step | Change | Risk | Size | Check |
|---|---|---|---|---|
| 3.1 | One fixed-window rate limit in place of 4 copies (§4b). Each caller keeps its key, limit, and window. | Low | S | Tests of the 4 callers |
| 3.2 | Add a lock-with-retry function to `redis-lock.ts`. Use it in place of the 5 loops (§4a). Each caller keeps its tries, waits, and error. | Low | M | Lock, car unlock, Campaign, ghost, and autopost tests |
| 3.3 | One builder for the "transfer in progress" 503 reply (§4e). Keep every check where it is now. | Low | S | Submit and guest transfer tests |
| 3.4 | One autopost store with inputs for the Daily and podium versions (§4c). Keep both Redis keys, the lock key prefixes, the messages, and all exported names. `storage-usage.ts` imports both key constants. | Medium | M | The 4 test files of each store |
| 3.5 | Share `normalizeSubredditName` and the record parse frame in the three post record stores (§4d). Keep all keys. | Medium | M | Post store tests |
| 3.6 | One guest-removal function with a label, in place of `cleanupGuestDailyProgress` and `discardGuestDailyProgress` (§4f). The code is the same, but this is the guest transfer area. | Medium | S | All guest transfer test files |
| 3.7 | One replay-in-post codec with the format name, marker, and size limit as inputs (§3). Also one `collectFallbackTexts`. First pin decoding of a saved pre-refactor token and its hash for each format, then add round-trip tests. A fresh encode/decode pair can drift together while old Reddit posts become unreadable. Keep each format's marker, validation, and decompression limit. | Medium | M | The saved-token and round-trip tests and the replay tests. Play-check: open a podium replay and a Head to Head post. |
| 3.8 | One client request module for Campaign and Head to Head: `requestJson`, `withPlayerIdentity`, `playerIdentityBody`, and `campaignUrl` (§6). The timeout is an input. | Low | S | Play-check: start a Campaign race and open a Head to Head challenge |
| 3.9 | Optional: one frame for the 14 route handlers (§4h). Each route keeps its log line and its error text. | Low | M | Route contract tests |

## Phase 4 — Code shared by the client and the server (player risk: medium)

The server already imports plain JavaScript from `game/shared/`. The shared files must stay
plain JavaScript.

**Compatibility check (2026-09-23).** Phase 4 does not touch the race simulation or the
replay validator. Findings that change the steps:

- The server makes every ghost. The client sends only its inputs, and
  `src/server/replay-validator.ts` records the ghost while it replays them. The client decoder
  only reads ghosts that the server made. The shared check must keep the server's rules and
  must not become looser.
- 4.2: the server measures the ghost size in UTF-8 bytes with `Buffer`, which the browser does
  not have. The client counts characters. Both give the same number for a real ghost, which is
  ASCII only. The shared check must use `TextEncoder`, which gives bytes on both sides. The
  shared file must not import `node:crypto` or use `Buffer`.
- 4.4: the game uses `getUtcDayIndex` only for a fallback cache expiry. The server alone
  decides the live day. The lap count in `preview.js` and `reddit-post-title.ts` reads
  `objectiveParams.lapCount` without the objective type, but the validator uses
  `getDailyChallengeRequiredLaps`. `normalizeDailyGpRaceContract` rejects any challenge where
  the two differ, so they agree today. Use `getDailyChallengeRequiredLaps` in both places, and
  do not make a third copy.
- 4.5: `formatRaceTime` writes the time into the podium post text. Its output must stay
  the same, byte for byte.
- No step adds a network call. Offline play, the verification queue, and "Continue Offline"
  are not touched.

| Step | Change | Size | Check |
|---|---|---|---|
| 4.1 | Put the ghost format constants in one file in `game/shared/`: schema version, sample interval, the two scales, and the compression prefix (§2). The server, the client decoder, and the debug tool import them. The logic does not change. | S | Ghost tests (12 files) |
| 4.2 | Share the ghost format check and the angle function between the server and the client decoder. | M | Ghost tests. Play-check: race a Daily track that has a personal-best ghost. |
| 4.3 | Make the debug size tool use the shared encoder parts in place of its copy. Production builds replace this tool with a stub. | M | The debug size report still works in a local build |
| 4.4 | Keep one copy each of `getUtcDayIndex`, `getChallengeLapCount`, `isRedditAvatarUrl`, and the server `formatChallengeDate` pair (§2). `getUtcDayIndex` sets the day boundary. A mistake puts players on the wrong day. | S each | Day, avatar, and post title tests |
| 4.5 | One "m:ss.mmm" time function for the lobby and the server (§5). Keep the lobby's `--:--.---` when there is no time. | S | Play-check: lobby times |

## Phase 5 — Repeats inside one file in player code (player risk: low to medium)

| Step | Change | Size | Check |
|---|---|---|---|
| 5.1 | `result-flow.js`: the two option builders use one field list. | S | Result flow tests (must pass) |
| 5.2 | `preview-renderer.js`: one bounds function with the padding and the points as inputs. | S | Play-check: carousel previews and the finish replay preview |
| 5.3 | `daily-challenge/storage.js`: the save and set functions share their first part. | S | Daily storage tests |
| 5.4 | `scoreboard/engine-methods.js`: one method in place of the 10 "mark as retrying" blocks. | M | Verification queue and scoreboard tests. The retry states are hard to force by hand, so the tests are the check. |
| 5.5 | `redis-lock.ts`: one lease renewer for one lock and for a group of locks. | S | Lock tests |
| 5.6 | CSS: one selector list for the sliding tab marker, in place of three rules. | S | Styles tests. Play-check: garage tabs, lobby mode switch, and settings switches. |
| 5.7 | `engine.js`: one method for the car sound sync. The race loop and the settings switch call it. | S | Play-check: turn car sound off and on during a race |

## Next batch — very low risk (planned 2026-09-23)

**Done on 2026-09-23 (`9ef5378`..`da4b4b6`): V1 to V5.** After each step the suite passes
in a clean worktree: 237 files, 3,016 tests. Notes:

- V1: the two loop tests build stand-in engines. They now take the real
  `syncCarEffectsAudioFrame`, as the spark test already takes `shouldAnimateFrame`.
- V4: schematic, full, and full-with-run previews and the share image JPEG for all 134
  tracks hash the same before and after. Two runs before the change gave the same hashes.
- V5: `pb-ghost-trace.ts` states the exact types again (`as 2`, `as 20`, `as 1`).

This batch takes the "very low" items from phases 4, 5, and 6. Each step moves code that is
the same in two places to one place. No step touches stored data or posted text. The order
goes from the smallest to the largest check.

| Step | Change | Size | Check |
|---|---|---|---|
| V1 (was 5.7) | Add one race method, `syncCarEffectsAudioFrame`, in `game/race/engine-methods.js`. The race loop and the car sound switch in `game/engine.js` call it. The race methods are always on the engine, so the settings switch can reach it. | S | Audio tests. Play-check: turn car sound off and on during a race. |
| V2 (was 6.2) | Export six helpers from `game/challenge-run/engine-methods.js` and let `game/daily-challenge/engine-methods.js` import them: `normalizeTrackPersonalBest`, `getTrackPersonalBestForChallenge`, `getPbGhostSelectionChallengeId`, `claimPbGhostSelection`, `bumpPbGhostPrepareGeneration`, and `getPendingPbGhostCandidates`. Four have the same text. Two differ only in syntax. Do not touch `applyTrackPersonalBest`, because its two copies act differently. | S | Full suite. Play-check: a Daily race with a personal-best ghost. |
| V3 (was 5.1) | In `game/race/result-flow.js`, one function builds the 14 shared fields for `buildModalRunsPayload` and `buildModalRunsViewOptions`. Each builder keeps its own two differences: the track key fallback chain (`buildModalRunsPayload` only) and the snapshot rule (`??` against `||`). | S | Result flow tests, including the mutation-kill tests. The file is in the Stryker list, so the new function stays in the same file. |
| V4 (was 5.2) | In `game/track/preview-renderer.js`, one bounds function takes the points and the padding. `getTrackBoundsLayout` passes the track and padding 16. `getReplayLayout` passes the track plus the run and padding 28. Both keep what they return. | S | This code also draws the share images and the landing-page track. Render every share image to a temporary folder before and after, and compare the bytes. Play-check: carousel previews. |
| V5 (was 4.1) | Put the ghost format numbers in `game/shared/pb-ghost-format.js`: schema version, sample rate and interval, maximum samples, maximum encoded bytes, simulation revision, and the two scales. The server, the client decoder, and the debug size tool read them from there. The logic does not change. | S | Ghost tests (12 files) and the typecheck. |

**Notes for V5.** The typecheck covers only `src/**/*.ts` and does not read game files, so a
value that the server reads from a game file has no exact type. `PbGhostTrace` uses
`typeof PB_GHOST_SCHEMA_VERSION` and `typeof PB_GHOST_SAMPLE_INTERVAL_MS`. So
`pb-ghost-trace.ts` re-exports each number with its exact type again (for example
`as 2`). The existing tests pin the values. Seven test files import the numbers from
`pb-ghost-trace.ts`, so they stay exported there. The shared file joins the Stryker list,
because `pb-ghost-trace.ts` is in it. The Redis compression prefix stays out of this step:
it is a storage setting, not part of the ghost format.

**Dropped: 5.6, the tab indicator style.** `docs/css-architecture.md` gives each stylesheet
one product area, and `tests/styles-architecture.test.js` checks each of the three rules in
its own file. One shared rule would take styles away from their owners.

**Found while planning (older bug, not changed):** in `styles/lobby-and-garage.css`, the
`prefers-reduced-motion` rule for `.garage-tabs::before, .tracks-tabs::before` (line 375) comes
before the base rule (line 499). Both have the same weight, so the later base rule wins, and the
Garage and Tracks tab marker still slides for players who ask for less motion. The settings
switch has its reduce-motion rule after its base rule, so it works. The lobby mode switch has
no reduce-motion rule. The last change to this rule was `8529560` (2026-07-29).

## Low batch (done 2026-09-23, `3fcb14c`..`e497133`)

After each step the esbuild bundle check and the suite in a clean worktree pass: 238 files,
3,018 tests.

- 5.3: `readStoredChallengeResult` and `writeStoredChallengeResult` in
  `game/daily-challenge/storage.js`.
- 5.4: `showDailyVerificationState` in `game/scoreboard/engine-methods.js` replaces 7 of the
  10 blocks. It is a module function, not an engine method. The other 3 only refresh the card,
  and one more block updates the leaderboard before it refreshes the card, so they stay.
- 4.4: `formatChallengeDate` moves to `src/server/format-race-time.ts`.
  `game/shared/reddit-avatar.js` holds the avatar host check. `game/shared/utc-day.js` holds
  `DAY_MS` (5 copies), `getUtcDayStart` (3), and `getUtcDayIndex` (2). `preview.js` and
  `reddit-post-title.ts` use `getDailyChallengeRequiredLaps`.
- 4.5: `game/shared/race-time-text.js`. `tests/race-time-text.test.js` pins the lobby text
  and the podium post text, and it passed before the change.
- 5.5: `startLeaseRenewal` in `src/server/redis-lock.ts`.
- New files in the Stryker list: `format-race-time.ts`, `reddit-avatar.js`, `utc-day.js`,
  `race-time-text.js`.

## Phase 6 — Daily and shared race-run methods, the safe part (player risk: medium)

This phase removes only the copies that act the same in both files (§1).

| Step | Change | Size | Check |
|---|---|---|---|
| 6.1 | In test mode, `game/engine.js` installs only the Daily methods. Make it install the shared methods first and then the Daily methods, as production does. Production does not change. Without this step, 6.3 breaks the tests. | S | Full suite |
| 6.2 | Export 6 helpers from the shared module, and let Daily import them: `normalizeTrackPersonalBest`, `getTrackPersonalBestForChallenge`, `getPbGhostSelectionChallengeId`, `claimPbGhostSelection`, `bumpPbGhostPrepareGeneration`, and `getPendingPbGhostCandidates`. Do not touch `applyTrackPersonalBest`, because its two copies differ. | S | Full suite |
| 6.3 | Delete the Daily copies of the 7 methods that act the same and call no helper that differs: `beginPersonalBestGhostRunAtGo`, `getDailyChallengeProgressText`, `createDailyChallengeRun`, `syncTrackMedalFromChallengeBest`, `syncChallengeHudPrimaryStats`, `updateDailyChallengeHud`, and `resolveTrackPersonalBestGhostPending`. Daily then runs the shared copies. | M | Full suite. Play-check: a full Daily race, with start, laps, finish, HUD, and personal-best ghost. |

**Progress (2026-09-23, `efdf460`):** 6.1 and 6.3 are done. 6.2 was done earlier (`e0ecf60`).
The seven Daily copies acted the same as the shared ones. One difference: the Daily
`updateDailyChallengeHud` called the Daily UI without `?.`, so it threw when that UI was
missing. The shared copy skips. `tests/daily-runtime-methods.test.js` now pins the five Daily
methods that still override shared ones (the phase 7 race rules). A new Daily copy of a shared
method fails that test. The suite passes: 243 files, 3,023 tests.
The Daily race play-check passed in the playtest on 2026-09-23, and the dev server log had no errors.

**Progress (2026-09-23):** 4.3 is done in `5ce015d`. The recorder moved unchanged into
`game/shared/pb-ghost-recorder.js`. The server wraps it and still validates each trace, and the
debug size tool uses it directly. Before and after the move, 1,500 random drives gave the same
traces from both recorders. 3.4 is done in `41546d8`: `src/server/autopost-subscription-store.ts`
serves both stores. Each store keeps its Redis key, lock key prefix, messages, and exported
names. The old and new stores gave the same lock keys, writes, errors, and log lines in 21 cases
each. Both new files joined the Stryker mutate list.
The playtest on 2026-09-23 passed: a new personal-best ghost appeared on the next race, and the Daily and podium autopost switches worked.

## Phase 7 — Decisions first (they change what players see, hear, or get)

Each item needs an answer first. Then trace the player effect. Then change the code.

1. **Race-run rules for Campaign and Head to Head (§1).** Six methods differ.
   `applyDailyChallenge`, `applyTrackPersonalBest` (and through it
   `prepareTrackPersonalBestGhost` and `applyVerifiedTrackPersonalBest`),
   `clearDailyChallengeRun`, and `markTrackPersonalBestGhostPending`. The question: do
   Campaign and Head to Head follow the Daily rules? Recommendation after the current-code
   check: decide each behavior separately. The last-played-day lobby choice is Daily-specific;
   the faster session best and ghost rollback may be useful across modes, but need mode tests
   and their supporting rollback path before adoption. Do not replace all shared methods with
   the Daily versions as one step.
2. **Post recovery (§4d).** Use one lookup for Daily and podium posts, and check the post
   type. Daily posts made before 2026-09-08 have no post type. Thus the rule must skip posts
   of another known type and accept posts with no type. Pin a same-challenge-id podium/Daily
   collision in a test. The current scheduling makes the collision unlikely, but does not
   prove that it cannot occur in every recovery state.
3. **The double transfer check (§4e).** Daily and Campaign submits check twice, with two
   different rules. Keep the first check for early rejection and the later check as a race
   fence after the submission lock. Align their predicates only after testing stale identity
   status and a transfer starting between the checks. The first check replies before the
   other checks run, so removal can also change the message and the work spent on a rejected
   run. This is the guest transfer area.
4. **Race time formats (§5).** Preserve each current format during code cleanup: lobby,
   finish sheet, leaderboard, posts, and comments. Standardizing their text is a separate
   player-facing decision.
5. **Audio (§7).** Give medal sounds an idle pause as a separate small change. A shared audio
   context needs one owner to coordinate activity: the current car and music idle timers
   could otherwise suspend medal or other sounds. Test any context change on iOS and Android.
6. **Fetch with a timeout (§6).** The original audit found 7 blocks, but Campaign and Head to
   Head now use `game/scoreboard/player-request.js` (step 3.8). The remaining callers differ:
   some obey a cancel signal from the caller, and one returns the raw response. Choose one
   cancellation/deadline rule while keeping each caller's response handling and timeout value.
   This is a technical decision, and the value is low.
7. **Page stylesheets (§10).** Keep page-owned body layouts separate. Share only identical
   reset or colour tokens if that reduces real maintenance; a broad base file has low value
   and can change the cascade. Each changed page needs a build and visual check.

**Verification on 2026-09-23 (current `chore/duplicate-cleanup` branch):** The browser ghost
decoder counts `JSON.stringify(trace).length`, while the server counts UTF-8 bytes. A trace
with valid pose fields and 70,000 `é` characters in an extra field is accepted by the client
at 70,106 characters and rejected by the server at 140,106 bytes. Normal server-generated
traces contain only ASCII fields; step 4.2 should retain the server's byte limit and test a
non-ASCII boundary case. Step 4.3 needs a browser-safe shared recorder: the current server
module also imports `node:crypto`.

The reduced-motion tab transition is still overridden by a later base rule in
`styles/lobby-and-garage.css`. A fresh full preview of the older Albert Gardens track also
reproduces the dark wedge; the fresh schematic preview does not. The combined-path fill is a
candidate, not a proven cause. These are separate visual fixes, not duplication steps.

At this snapshot, this branch is 47 commits after `chore/dead-code-removal`; both branch tips
are outside local `main`. The working tree also contains unrelated user changes, so cleanup
steps should preserve them.

## Leave as they are

- The element lookup lists in the UI classes, the HUD, and the tools.
- The Campaign and car unlock cleanup and discard pairs. They look alike, but they do
  different work.
- The Head to Head brag and comment modules. They already share the confirm step.
- The large setup blocks in the Daily share and store "wave" test files. The value is low.

## Summary

| Phase | Steps | Player risk | Largest size |
|---|---|---|---|
| 1 | Tests and tools | None | M |
| 2 | Exact small copies | Low | M |
| 3 | Same code under other names | Low to medium | M |
| 4 | Client and server shared code | Medium | M |
| 5 | Repeats inside one file | Low to medium | M |
| 6 | Race-run methods, safe part | Medium | M |
| 7 | Items that need a decision first | Decision | L |
