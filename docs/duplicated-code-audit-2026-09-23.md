# Duplicated Code Audit

Date: 2026-09-23. Branch: `chore/dead-code-removal`, with the uncommitted working-tree
changes that were present on that date.

This report records findings. It does not change code.

## Summary

About 3.4% of the source lines (2,238 of 64,770) are in exact copies of 60 tokens or more.
That amount is low. The risk is not in the amount. The risk is in a small number of copies
that are no longer the same.

The findings in order of risk:

1. **Daily and the other modes use two copies of the same race-run methods.** 19 methods are
   copies. 6 of them now behave differently: 4 directly and 2 through a helper. No test runs
   the second copy's logic (§1).
2. **The personal-best ghost format is in four places.** The server owns the format. The
   client decoder, a debug tool, and the podium preview each have their own copy (§2).
3. **Two replay-in-post codecs are the same code with different names** (§3).
4. **The server repeats five store patterns.** Two lookups have already drifted apart (§4).
5. **Race times have at least five text formats** in about eight functions and about
   twenty inline expressions (§5).

## Method

- Scanned 216 production files: `game/`, `src/server/`, the page scripts in the root,
  `LP/config.js`, and `tools/`. Did not scan the 129 track definition files or the generated
  car asset file, because they hold data.
- Used a token scanner (the TypeScript scanner). Found exact copies of 60 tokens or more, and
  copies of 80 tokens or more with names and values ignored.
- Parsed 4,257 functions. Grouped the functions that have the same body, and the functions
  that have the same body after local names are renamed. Listed the function names that
  occur in two or more files.
- Parsed 1,294 CSS rules in the game stylesheets and the page stylesheets.
- Scanned the 241 test files on their own (§11).
- Read each finding in the code. Removed the false positives (see "Checked, not
  duplication").

## 1. Daily and shared race-run methods (high)

`game/challenge-run/engine-methods.js` (375 lines) came in `ddbf60c` on 2026-08-11. It has
20 methods. 19 of them are copies of methods in `game/daily-challenge/engine-methods.js`.

`loadModeRuntime` in `game/modes/runtime-loader.js` installs the shared methods first. Then
it installs the methods of the mode. Thus:

- Daily races use the Daily copies.
- Campaign, Head to Head, and the home screen use the shared copies.

Of the 19 copies:

- 8 have the same text.
- 7 have different syntax only (`??=` against `if`, line breaks, optional calls). They
  behave the same.
- 4 behave differently:

| Method | Daily copy | Shared copy |
|---|---|---|
| `applyDailyChallenge` | Keeps the faster of the stored best and the session best. | Replaces the session best with the stored best. |
| `applyTrackPersonalBest` | Copies the checkpoint times as they are. Builds the pace baseline also when the track is not loaded. | Cleans the checkpoint times first. Builds the pace baseline only when the track is loaded. |
| `clearDailyChallengeRun` | Shows the last played day in the lobby if that day is still open. | Always shows the current day. |
| `markTrackPersonalBestGhostPending` | Keeps the previous ghost, so it can put it back if the new time does not save. | Does not keep the previous ghost. |

Correction: `prepareTrackPersonalBestGhost` and `applyVerifiedTrackPersonalBest` have the same
code in both copies. But each one calls the `applyTrackPersonalBest` helper in its own file,
and that helper is different. Thus these two methods also act differently, through the helper.
The count is 4 methods that differ directly and 2 that differ through the helper.

The "keep the faster best" rule is in Daily since the first commit. The "keep the previous
ghost" rule came in `5de2611` on 2026-07-18. The shared copy has neither rule. The history
does not tell if this was on purpose. I did not trace if a player can see these differences
in Campaign or Head to Head.

Tests: only `tests/mode-priority-loading.test.js` imports the shared copy. It checks only
which copy is installed. In test mode `game/engine.js` installs the Daily copies, so the other
tests run the Daily copies.

## 2. Personal-best ghost format in four places (medium)

The server file `src/server/pb-ghost-trace.ts` owns the ghost format. Three other files repeat
parts of it:

- `game/ghost/pb-ghost.js` (the client decoder) repeats the schema version, the sample
  interval, the two scales, and the format check.
- `game/ghost/pb-ghost-size-debug.js` (a debug tool; production builds replace it with a stub)
  repeats the encoder. `quantizePose`, `appendPose`, and `cloneRawPose` are exact copies.
  `lerpRawPoseAtTime`, `shortestAngleDeltaMilli`, `sample`, and `finish` are rewrites with the
  same logic. It also repeats the Redis compression prefix from
  `src/server/redis-compressed-value.ts`.
- `podium-replay-view.js` has its own encoder and angle function for the local preview.

If the server format changes, these copies do not change with it. The server already imports
from `game/shared/`, so one shared module can serve both sides.

Other client and server pairs of the same kind:

- `getUtcDayIndex`: `game/daily-challenge/service.js` and `src/server/daily-gp-model.ts`
  (exact).
- `isRedditAvatarUrl`: `game/ui/avatar.js` and `src/server/daily-podium-service.ts` (same
  three hosts, written two ways).
- `getChallengeLapCount`: `preview.js` and `src/server/reddit-post-title.ts` (same logic).
- `formatChallengeDate`: two server copies with the same output
  (`daily-podium-service.ts`, `reddit-post-title.ts`). `podium.js` has a third one with a
  different output.

## 3. Replay-in-post codecs (medium)

`src/server/daily-podium-replay.ts` and `src/server/head-to-head-replay.ts` each hold one
codec: `encodeEnvelope`, `extractToken`, the decoder, `sha256`, `isRecord`, and
`isLapCount`. The two codecs differ only in the format name, the marker text, and the size
limit (384 KB and 128 KB).

`collectFallbackTexts` (22 lines) is an exact copy in `daily-podium-replay.ts` and
`head-to-head-post.ts`.

One codec with the name, the marker, and the limits as inputs can replace both.

## 4. Server stores and services (medium)

**a. Lock with retry, five copies.** `redis-lock.ts` gives `acquireRedisLock`, but no retry.
Five files add their own loop: `daily-autopost-store.ts`, `daily-podium-autopost-store.ts`,
`pb-ghost-store.ts`, `car-unlock-store.ts`, and `campaign-store.ts`. The tries and the waits
are different in each file.

**b. Rate limit, four copies.** The same fixed-window counter is in `competition-submit.ts`,
`head-to-head-service.ts`, `leaderboard-race-service.ts`, and `daily-gp-share.ts`.

**c. Autopost stores.** `daily-autopost-store.ts` (160 lines) and
`daily-podium-autopost-store.ts` (170 lines) are one file twice. Only the names, the Redis
keys, and the messages differ.

**d. Post records.** `daily-gp-post-store.ts`, `daily-podium-post-store.ts`, and
`launcher-post-store.ts` repeat the record parse, the key builder, and
`normalizeSubredditName`. The post recovery in `daily-gp-share.ts` (`recoverDailyGpPost`) and
in `daily-podium-service.ts` (`recoverDailyGpPodiumPost`) are copies that drifted apart. The
podium lookup checks the post type. The Daily lookup checks only the challenge id, and a
podium post has the same challenge id. Today no player path gets to this difference. Daily
shares stop 7 days after the day starts, and the podium post can open only at that time.

**e. "A transfer is in progress."** Four files build the same 503 reply. Two rules decide if
a transfer is in progress. The Daily and Campaign submits check `guestStatus` and the Reddit
selection. Then they call `submitCompetitionRun`, which checks again with
`isProgressTransferPending`. Thus these submits check twice, with two rules.

**f. Daily guest cleanup.** `cleanupGuestDailyProgress` and `discardGuestDailyProgress` in
`daily-gp-store.ts` are the same 50 lines. Only the messages differ.

**g. Small helpers.**

- Name normalizing: `trim().toLowerCase()` is in 19 places in the server. 9 of them are
  separate functions under 5 names.
- `isRecord`: 4 exact copies. `daily-gp-store.ts` has a fifth one, `isRecordObject`.
- The player field hash: 4 exact copies under 3 names (`campaign-store.ts`,
  `car-unlock-store.ts`, `daily-gp-store.ts`, `pb-ghost-store.ts`).
- Exact pairs: `keyPart`, `validPostId`, `formatHeadToHeadTime`,
  `formatChallengeResultTime`, `hasCredential`, and the post record expiry.
- `normalizeGuestPlayerId`: two copies, and two more under other names (one of them on the
  client).

**h. Route handlers.** 14 handlers repeat the same frame: call the service, send the status
and the body, and send a 500 on an error.

## 5. Race time text (medium to low)

- "m:ss.mmm": `formatLobbyTime` on the client and `formatRaceTime` on the server are two
  implementations of one format.
- "mm:ss.mmm": `formatTime` and `formatLeaderboardTime` in `game/race/ui-modal-content.js`
  are the same function twice.
- "ss.mmm": `formatHeadToHeadTime` (two exact copies) and `formatLapTime` in
  `daily-gp-share.ts`, which pads the seconds to two digits.
- "x.xxxs": `formatChallengeResultTime` (two exact copies), and about twenty inline
  `toFixed(3)` expressions on the client.

One time module in `game/shared/` can hold each format one time.

## 6. Client services (low to medium)

- `game/campaign/service.js` and `game/head-to-head/service.js` have exact copies of
  `requestJson`, `withPlayerIdentity`, `playerIdentityBody`, and `campaignUrl`. Only the
  timeout value differs.
- The client has seven "fetch with a timeout" blocks: `storage.js`,
  `daily-challenge/service.js`, the two services above, and three in
  `player/guest-progress-selection.js`.
- `toRaceChallenge` in the Campaign and Head to Head engine methods differs in two values. The
  "never ends" date is in six places in three files. Two of the six are on the server.
- Small copies: `scheduleAfterModalPaint` (2), `setText` (3), `cleanText` (3),
  `getChallengeTimeMs` (2), and the finite-number check (3).

## 7. Audio (low)

The three audio modules each create an audio context. Each repeats the create, pause, and
resume code. `keepAlive`, `scheduleIdleSuspend`, and `clearIdleSuspendTimer` are exact copies.
Each module has an input for a shared context, but no caller gives one. Thus the game opens
three audio contexts. The medal sounds have no idle pause. Their context stays on until the
tab is hidden. The car sounds and the music pause when idle.

## 8. Repeats inside one file (low)

- `game/scoreboard/engine-methods.js`: the block "mark as retrying, refresh the Daily card,
  update the open modal" occurs 10 times.
- `game/race/result-flow.js`: two option builders list the same 15 fields.
- `game/track/preview-renderer.js`: two bounds functions differ only in the padding and the
  points.
- `game/daily-challenge/storage.js`: the save and set functions share their first 15 lines.
- `game/engine.js`: the preview car size callback is written twice. The car sound sync is a
  copy of the block in the race loop.
- `src/server/redis-lock.ts`: the single and group lease renewers differ only in two calls.

## 9. Tools (low, not shipped)

- `tools/runner.js` has its own copy of the game's track smoothing (`smoothPoly`). The game's
  copy has the comment "Must match the server replay validator". The runner copy already
  differs in its text. The game does not export `smoothPoly`.
- `tools/tiktok-studio.js` copies `drawCheckeredLine` (exported by `game/track/canvas.js`)
  and the car drawing in `game/car/sprite.js`.
- `tools/mapmaker/lane-gate.js` copies `segmentIntersectionParams` from
  `game/track/geometry.js`.
- Geometry helpers: `distance` (5), `clamp` (4, and `game/shared/clamp.js`), `midpoint` (4),
  `clonePoint` (3), `normalizeVector` (3), `distanceSq` (3), and pairs of `lerp`,
  `resampleClosedPolygon`, `rotateToNearest`, `distanceToSegment`, and `resizeCanvas`.
- `isMainModule` and `ensurePath2D` are in two asset generators.

The tools already import from `game/`, so they can use the game's exports.

## 10. CSS (low)

- The game stylesheets have no identical rules. One 10-declaration block (the sliding tab
  marker) is in three rules: the garage tabs, the lobby mode switch, and the settings switch.
- The page stylesheets repeat the `*` reset (5 files), `html, body` and `body` (`podium.css`,
  `campaign.css`), `.challenge-avatar--generic` (`lobby-modes.css`, `head-to-head.css`), and
  `.expired-message__ok` (`head-to-head.css`, `preview.css`).
- `head-to-head.css` copies 13 tokens from `foundation.css`. `preview.css` copies 10. The red
  accent `#ef4444` is set in 7 files under two names (`--accent`, `--accent-color`).

## 11. Tests (low)

- 23 test files each define `createMemoryLocalStorage`. `tests/helpers/` has no shared one.
- `tests/daily-gp-store.test.js` has its own Redis fake. `tests/redis-test-double.js` also
  exists.
- The Daily share and store "wave" test files repeat large setup blocks.

## Checked, not duplication

- The element lookup lists in the UI classes (`get modal() { return
  document.getElementById(...) }`), in the HUD, and in the tools.
- Import lists, `game/track/catalog.js`, and `game/track/tracks.js`.
- `game/debug/*.stub.js` and `game/ghost/pb-ghost-size-debug.stub.js`: stubs by design.
- Car unlock cleanup and discard: the discard also writes the promotion key.
- Campaign cleanup and discard: the discard also renews its locks.
- Head to Head brag and comment: they already share the confirm step. Their preview rules
  are different.
