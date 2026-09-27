# Redundant Code Audit

Date: 2026-09-27. Branch: `feature/full-history-transfer`. Head: `2c8d15b`. The working tree
also holds uncommitted ground tuning (`game/race/ground-effects.js`, `game/track/grounds.js`
and its test). That work is in progress. This audit does not judge it.

This report records findings. It does not change code.

## Removal progress

The quick items (priority 1 in §6) are done on branch `chore/redundant-code-quick-wins`,
which starts from `feature/full-history-transfer` at `2c8d15b`. One commit for each item:

- `f329ec9`: `getNextMedalTarget` and the tests that checked only it. This report first
  said that one test file called it. Two did: `tests/medals-author.test.js` also calls it,
  through a namespace import.
- `debc65e`: the three unread parameters of `fillTrackPresentation`, and the `void` lines.
- `fccc7ee`: the `obsolete` list. It was the only reader of `obsoleteRaceIds` in the
  Campaign progress check, so that list went too. An old row is still skipped, and a
  damaged row still stops the transfer.
- `517a044`: the two outdated comments.
- `4aab16d`: the Mapmaker copies of `distance`, `midpoint`, `subtract` and the finite point
  check. `tools/geometry.js` now has `subtract` and `isFinitePoint`. The check now always
  gives `true` or `false`; every caller uses it as a condition. `distanceSq` in
  `game/track/canvas.js` stays: game code does not import from `tools/`.
- `dbbe224`: the route helper. The PB ghost routes use `sendPlayerAuthorizationFailure`
  from the player routes.

Validation after each commit: `npm test` (it runs the typecheck first) has the same 4
failures as before the first commit. They are the known medal ordering test and three
ground tests; the uncommitted ground tuning in the working tree causes at least two of
them. Every client entry, the Mapmaker, Runner Lab and the server bundle with esbuild.
`tsc` with the unused-name checks gives 0 on `src/` and the known 25 on `tools/`. It also
caught one missed rename in the Mapmaker playtest that the tests and the bundle did not
catch. The Campaign screen draws its track preview as before on :8000.

The low-risk items (priority 2 in §6, and group 3 of the 09-26 audit) followed on the same
branch, one commit for each:

- `e4d22de`: the four carousel card labels and the meta line builder.
- `9378059`: `goldCount` and `gapMs` in the lobby states.
- `ce0c378`: `opponentName` in the Head to Head verdict.
- `35480d5`: `_modalSecondaryAction`.
- `feaea2a`: `data-challenge-phase`. Its tests now check the outcome text and the
  accessible label.
- `561bf8a`: `resultLabel` in the Head to Head win reply. The game stopped reading it on
  2026-07-25 (`65980295`), so no open game page needs it.
- `ec899a6`: `allowGuests` on the competition shape.
- `af4ea28`: `notCounted` in the storage view. The page hid it on 2026-09-08. Its four
  points are now a comment on the storage walk.
- `fb1ab39`: one grid function for the checkered and the painted finish line. A recording
  of every drawing call, for both styles and 16 lines, is the same before and after.
- `4fe9f77`: a new find of the same kind. The Head to Head finish hero reads only the phase
  and the error. The finish screen still passed it a status text, the viewer's avatar and
  the verdict, through four layers. No caller set the status text. The avatar stays in the
  lobby, and the verdict still sets the opponent gap.

Each commit passed the same checks as above. The Daily and Campaign carousels on :8000
show the track, the day or stage, and the laps as before.

The uncommitted ground tuning stays out of these commits.

## Why this audit

The last dead code audit ran on 2026-09-26 (`docs/dead-code-audit-2026-09-26.md`). The last
copied code audit ran on 2026-09-23 (`docs/duplicated-code-audit-2026-09-23.md`). After the
09-26 audit, 24 commits changed 71 production files. Most of them rebuilt the guest
transfer: the raced lists, the transfer in pieces, the Merge choice, the removal of Keep
guest, and the Daily guest clean-up. One commit added the water and space grounds. A
rebuild can leave an old path without a caller, or put a second copy of a rule in a new
file. This audit looks for both: code that nothing needs (dead code) and code that says
the same thing twice (copied code).

## Summary

| Area | Result |
|---|---|
| Module files | Clean. Every file is reached. |
| Exports | 1 new export that only tests use (§1.1). |
| Class and object members, unread field names | No new ones. |
| TypeScript unused names | 0 in `src/`, `game/` and `pages/`. `tools/` has the same 25 as on 09-26. |
| Stylesheets, element ids, share pictures, medal times | Clean. |
| Older dead code that earlier audits missed | 2 items (§1.2) |
| Transfer options that production always sets the same way | 6 steps have code that only tests run (§2) |
| New copied code in the transfer and the raced lists | 6 groups (§3.1) |
| New copied code in grounds and tools | 3 groups (§3.2) |
| Temporary code with a known end | The raced-list fill and its fallbacks (§4) |
| Older findings still open | §5 |

The largest new find is §2. Each transfer step keeps options that its one production
caller never uses. The direct tests of these steps test mostly those unused options. The
path that players run is tested only through the full transfer tests.

## 1. Dead code

### 1.1 New since 2026-09-26

| Location | Finding | Since |
|---|---|---|
| `game/medals/medal-timing.js:110` | `getNextMedalTarget` has no production caller. Its last caller was `getTimeToBeatSeconds`, which `2209eb9` removed as test-only. Only `tests/medals.test.js` and `tests/medals-author.test.js` call it now. | `2209eb9`, 09-26 |

### 1.2 Older, missed by earlier audits

| Location | Finding | Since |
|---|---|---|
| `game/track/canvas.js:294–297` | `fillTrackPresentation` does not read `outerPath`, `width` or `height`. The lines `void outerPath; void width; void height;` hide this from the unused-parameter check. Three production callers and one test pass these values. | `ae76056`, 06-01 |
| `src/server/campaign/campaign-store.ts:1035` | The Campaign guest source snapshot fills an `obsolete` list and returns it (line 1112). No code reads it. The history has no reader since the list came in. The name check missed it, because a local function and a state value also use the name `obsolete`. | `ce7239f`, 09-09 |

## 2. Transfer options that only tests use

Each transfer step has one production caller: the transfer in `selectGuestProgress`
(`src/server/daily/daily-gp-store.ts:2482–2592`). That caller always passes the same
options. The other value of each option runs only in tests.

| Step | Production always passes | Code that only tests run |
|---|---|---|
| `mergeGuestCampaignProgress` (`campaign-store.ts:1119`) | `classifySource: true`, `transactionRunner` | The path without the checked guest source: it reads the guest's progress, entry and PB again (`:1230`, `:1252`, `:1256`, `:1280–1281`), calls the source check with no rows (`:1219`), and reads the raw PB again (`:1329–1332`). The own lock runner (`:1158`). The default `stagesToRead` in `captureClassifiedGuestCampaignSource` (`:1032`). |
| `cleanupGuestCampaignProgress`, `discardGuestCampaignProgress` | `transactionRunner` | The own lock runner (`campaign-store.ts:1432`). |
| `mergeGuestDailyProgress` (`daily-gp-store.ts:1281`) | `classifySource: true` | The guest reads in `readDailyMergeState` (`:1035–1045`) and the raw PB read (`:1389`). |
| `cleanupGuestDailyProgress`, `discardGuestDailyProgress` | `challengeSpecs` (always an array) | The day lookup from `challengeIds` (`daily-gp-store.ts:1449–1451`). |
| `mergeGuestCarUnlockProgress` (`car-unlock-store.ts:266`) | `preserveSource: true`, `transactionRunner` | The delete of the guest's Garage (`:316`). The own transaction (`:320–332`). The 09-23 notes already listed the delete. |
| Source check in the transfer (`daily-gp-store.ts:2376`) | — | Two branches that no merge reaches: the Campaign re-read without rows (`:2419–2426`) and the Garage re-read (`:2439–2445`). The Campaign merge always passes its rows. The Garage merge always passes `{ unlocks }`. |

**The tests.** All 9 direct calls of `mergeGuestCampaignProgress` in
`tests/server-campaign-store.test.js` use the path without the checked source and the own
runner. None of the 6 direct calls of `mergeGuestCarUnlockProgress` passes
`preserveSource: true`. 2 of the 4 direct calls of `mergeGuestDailyProgress` pass
`classifySource: true`. The path that players run is tested through
`selectGuestProgress` in `tests/server-guest-progress-selection.test.js` and the other
transfer tests.

**Mock guards.** Seven reads check `typeof redis.zScore === 'function'` before they call it
(`campaign-store.ts:378`, `:1072`; `daily-gp-store.ts:303`, `:338`, `:1051`, `:1248`;
`competition-leaderboard.ts:165`). The Devvit client always has `zScore`. The shared test
double (`tests/redis-test-double.js`) has it too. This audit did not run the tests without
the guards, so it does not say that no test fake needs them.

## 3. Copied code

### 3.1 New since 2026-09-26: transfer and raced lists

**The board merge step.** Campaign (`campaign-store.ts:1301–1353`) and Daily
(`daily-gp-store.ts:1367–1411`) have the same decision and the same write for one board:
which entry moves, which PB moves, and the five queued commands. The write closure is an
exact copy. The decision has two differences. Campaign rewrites the account's entry only
when the entry is a valid stage result, and it compares the guest's entry with that
result. Daily uses the stored entry as it is. Campaign takes the raw PB from the checked
source; Daily encodes the decoded PB again. A fix in one copy can miss the other.

**The row delete.** Four places queue the same four commands to delete a player's rows on
a board (entry, rank, PB, standings revision):

- `clearGuestCampaignProgress` (`campaign-store.ts:1448–1453`)
- `clearGuestDailyProgress` (`daily-gp-store.ts:1459–1464`)
- `cleanupExpiredDailyGuest` (`daily-guest-cleanup.ts:76–82`), new
- `cleanupExpiredCampaignGuests` (`campaign-store.ts:432–438`), for many players at once

**The raced-list rules.** `src/server/player/raced-list.ts` owns the list. Five of its
rules also exist as copies:

| Rule | Copies |
|---|---|
| The key text | `racedListKey` hashes the player ID. The fill writes the same key text for a hashed owner inline (`raced-list-fill.ts:104`). |
| The write: add the board, extend a guest's list, set a guest's Daily expiry | `queueRacedBoard`, the first half of `listRacedBoard`, and `addOwner` in the fill (`raced-list-fill.ts:103–113`). |
| The field `daily:<day>` | Built once by `racedListField`. Read with an inline prefix in `daily-guest-cleanup.ts:67–68`, `raced-list-fill.ts:108` and `:243–244`. |
| The keys of a Daily board from a day ID | `dailyBoardKeys` (`raced-list-fill.ts:53`), `dailyBoard` (`daily-guest-cleanup.ts:24`), and the same four lines in `toDailyCompetition`. |
| The list of stored Daily days | `readStoredDailyChallengeIds` (`storage-usage.ts:262–270`) and `listBoards` (`raced-list-fill.ts:74–77`). |

If the key text or the field format changes in `raced-list.ts`, the copies still write or
read the old one.

**The transfer choice on both sides.** The client and the server each map a stored choice
to the choice that runs: `runnableTransferChoice` in
`game/scoreboard/verification-queue-transfer.js:20` and in `daily-gp-store.ts:219`. The
server also has `copiesGuestProgress` (`:224`), which gives the same answer as
`runnableTransferChoice(choice) === 'merge'`. The reply reason
`progress_selection_continue` is written in `game/player/guest-progress-selection.js:126`
and in `src/server/guest-transfer/guest-progress-selection-error.ts:25`. The comment at
`daily-gp-store.ts:208` still says that Keep guest replaces the account's progress. It now
runs as Merge.

**Wrappers that add nothing.** `cleanupGuestDailyProgress` and `discardGuestDailyProgress`
(`daily-gp-store.ts:1470–1486`) have the same body: both call `clearGuestDailyProgress`
with the same input. The Campaign pair at least passes a different label.
`guestOwnsDailyDay` (`:1058`) only calls `competitionHoldsPlayerRows`.

**The guest expiry sweep.** The Daily guest clean-up copies the start of the Campaign one:
read the expired guests, then take the throttle key (`daily-guest-cleanup.ts:95–104`,
`campaign-store.ts:398–408`). The rest is different on purpose: Daily cleans one guest at a
time from the raced list.

### 3.2 New since 2026-09-23: grounds, cars and tools

- **Painted finish line.** `drawPaintedFinishLine` (`game/track/canvas.js:693`) repeats the
  first 14 lines of `drawCheckeredLine` (`:26`): the direction, the normal, and the grid
  of cells.
- **Mapmaker helpers.** The 09-23 cleanup put the tool geometry in `tools/geometry.js`. Later
  files have their own copies again: `distance` in `tools/mapmaker/track-flow.js:42`
  (09-25) and `tools/mapmaker/track-quality.js:13` (09-23); `subtract` in
  `track-quality.js:25` and `sub` in `tools/mapmaker/ribbon-walls.js:33`; `finitePoint` in
  `tools/mapmaker-playtest.js:90` and `isFinitePoint` in `tools/runner.js:28`.
  `distanceSq` in `game/track/canvas.js:761` is the same as the one in `tools/geometry.js`.
  None of this ships to players.
- **Route helper.** `sendAuthorizationFailure` (`src/server/routes/pb-ghost-routes.ts:22`)
  and `sendPlayerAuthorizationFailure` (`src/server/routes/player-routes.ts:18`) are the
  same function. They are older (July), and the 09-23 scan did not list them.

### 3.3 Still open from 2026-09-23

These copies are still in the code, as `docs/remaining-cleanup-2026-09-23.md` lists them:

- Daily still overrides five shared race-run methods (`tests/daily-runtime-methods.test.js`
  pins the list).
- The replay-in-post codec: `head-to-head-post.ts:94–128` and `daily-podium-replay.ts:170–204`.
- The post-record reading: `daily-gp-post-store.ts:31–46` and `daily-podium-post-store.ts:93–109`.
- The ghost size check: `game/ghost/pb-ghost.js:52–61` and
  `src/server/competition/pb-ghost-trace.ts:48–57`.

## 4. Temporary code with a known end

The raced-list fill (`src/server/player/raced-list-fill.ts`) walks the old rows once, so
the raced lists name every board. The file says that each install runs its own fill.
While the ready record is absent, the transfer uses fallbacks:

- the transfer works on every live Campaign stage and the playable Daily days
  (`daily-gp-store.ts:2335–2336`);
- the check for guest progress reads every board (`:1572–1581`);
- the choice screen counts Daily results with `countDailyProgressResults` and shows
  `dailyPlaylistSize` (`:1522–1534`).

When every install has its ready record, these fallbacks cannot run. Then the walk, its
state and lock keys, the analytics page line for its progress
(`readRacedListFillStatus`), and the fallbacks can go. `readTransferBoards` and
`dailyBoardKeys` stay, but they belong in `raced-list.ts`, not in the fill file. The
scheduler job (`devvit.json`, `* * * * *`) runs every minute also after the fill is ready.
Each run then does one Redis read.

## 5. Status of the 2026-09-26 findings

- **Groups 1 and 2:** done (`bb9d768`, `2209eb9`, `9e8e944`).
- **Waiting for the ground work:** done in `c828ab5`. `tangentX` and `tangentY` are gone.
  The four share pictures are gone. `brokenRoad.jpg` and `dirtSnake.jpg` were never
  committed. Every scheduled track has a share picture, and no picture is extra.
- **Group 3 (screens):** all still present. The carousel card labels and
  `buildMetaLabel`, `goldCount` and `gapMs`, `opponentName`, `_modalSecondaryAction`,
  `data-challenge-phase`, `resultLabel`, `allowGuests`, and `notCounted`.
- **Group 4 (engine and race rules):** all still present. The engine promise fields,
  `runHadTimingAnomaly`, the two last-lap medal flags, `param` and `closestPoint`, and
  `currentModeKey`.
- **Group 5 (guest transfer):** the `replace: false` branches are no longer an open item.
  `e263db4` deleted the replace path, so the merge path is now the only one. The transfer
  report fields, `entryClass` and `pbClass`, and `promotedPlayerId` are still present.
- **Group 6 (keep):** unchanged. The stale comment at `game/campaign/manifest.js:65` is
  still there.

## 6. Priority order

The order is by simplicity and by the harm to players if a removal goes wrong.

1. **No player risk.** `getNextMedalTarget` (two test files change). The three unread
   parameters of `fillTrackPresentation` (three callers and one test). The `obsolete`
   list. The stale comments at `daily-gp-store.ts:208` and `manifest.js:65`. The Mapmaker
   helper copies. The route helper copy.
2. **Low risk.** One helper for the painted and checkered finish line grid. Look at a
   dirt or snow finish line after the change.
3. **Medium risk, guest transfer.** The options in §2 that only tests use. First move the
   direct tests to the options that production passes, so the tests cover the player's
   path. Then remove the unused options. A mistake can stop a transfer or lose a guest's
   progress. Run all transfer tests, and do a transfer on the test subreddit.
4. **Medium risk, guest transfer.** One board merge step for Campaign and Daily, and one
   row delete. Decide first if the two decision differences in §3.1 are on purpose.
5. **Medium risk, every race save.** One owner for the raced-list rules. `queueRacedBoard`
   and `listRacedBoard` run in every race save. A mistake makes a list miss a board, and a
   later transfer then misses that board. Do this together with step 6, because the fill
   holds two of the copies.
6. **After the fill is ready on every install.** Remove the fill and the fallbacks in §4.
   Check the ready record on each install before the change.
7. **As on 09-26.** Groups 3 and 4 of the 09-26 audit, and the copies in §3.3, keep their
   earlier order and notes.

## 8. One "faster time wins" rule (done)

Decided on 2026-09-27: the Campaign way, with one change. A time counts on a board if it has
the same player, track and lap count. A time with no lap count or an older check label
still counts, because the server checked it on the day of the race.

- `009d151`: the source check read the empty lap count of Daily saves from 2026-07-08 to
  07-23 as damage, so a Merge that reached such a guest time stopped for review. Found
  while checking the rule; the full history transfer had not shipped.
- `6761ca2`: one shared step, `src/server/guest-transfer/board-merge.ts`, for Campaign and
  Daily. The Campaign progress check and the choice screen use the same rule. A Daily
  ranking out of step is now repaired, as on Campaign. Five recordings changed on purpose.
- Checked: the full suite (only the 2 older failures), every bundle, the planted-bug run
  on the shared step (97%), and a Merge on r/mini_racer_dev at 18:05 on 2026-09-27: done
  in 1.9 s, no server error, and the boards were right on the tested account.

## 7. Safety nets before the medium and high risk work

Added on 2026-09-27 on `chore/redundant-code-quick-wins`, before any medium or high risk
change. Each is test code only. Each was checked with planted changes: it must fail when
the rule it guards changes.

| Guards | Test | What it fixes |
|---|---|---|
| Raced-list owner, fill removal | `tests/raced-list-names.test.js` | The list key, the board fields, the guest clean-up and fill keys, and the commands of each kind of race save, written out in full. |
| Transfer options, copies, "faster time wins" | `tests/guest-transfer-recording.test.js` | 21 player cases, each with Merge and Keep account: the choice screen, the replies, and every stored key the transfer changed. A transfer stopped at each saved step and run again must end with the same data. |
| Replay format in posts | `tests/replay-post-tokens.test.js` | Five saved replay posts, read only, from the body, the text fallback and with Windows line ends. Each must give the stored fingerprint and envelope. |
| Ghost size check | `tests/pb-ghost-size-limit.test.js` | The limit on both sides, and today's one difference. |
| Lost-post lookup | `tests/post-recovery-lookup.test.js` | Today's answers of both lookups for podium posts, Daily posts with and without a type, other days and other subreddits. |
| Engine values, replay check | `tests/replay-verdict-recording.test.js` | The server's full answer for four finished tarmac runs and eight changed replays. |

**Planted-bug runs on the transfer code** (Stryker, only the transfer functions, a
scratchpad config; the project config is unchanged). The share of planted bugs that the
tests catch:

| File (transfer part) | Before | With 14 cases | With 21 cases |
|---|---|---|---|
| `campaign-store.ts` | 59.1% | 71.1% | 72.3% |
| `daily-gp-store.ts` | 64.0% | 71.3% | 71.9% |
| `car-unlock-store.ts` | 50.7% | 55.1% | 55.1% |
| `guest-transfer-source-classification.ts` | 51.7% | 52.3% | 52.8% |
| `daily-guest-cleanup.ts` | 60.2% | 60.2% | 60.2% |
| `raced-list-fill.ts` | 81.3% | 81.3% | 81.3% |
| `raced-list.ts` | 79.4% | 79.4% | 79.4% |

The seven added cases closed the gaps they aimed at, in both merges: the tie rule for
equal times, a series the guest only started, an old Daily entry, a board the guest never
raced, and a best time that moves alone. Most planted bugs that still survive are in three
kinds of code: the paths that only tests
reach (§2, which the refactor removes), return values that nothing stores, and the lock
and lease handling, which no recording stresses. A refactor of the lock handling needs its
own test of a lost lock before it starts.

**Found while building them:**

- Head to Head posts made before 2026-08-08 name their replay
  `MINIRACER-CHALLENGE-REPLAY-V1`. Today's reader accepts only
  `MINIRACER-HEAD-TO-HEAD-REPLAY-V1`, so it cannot read those posts. The code cannot tell
  if any such post is still live.
- The Daily lost-post lookup takes a newer podium post of the same day. The podium lookup
  checks the post type. This is the 09-23 drift, now fixed in a test.
- The server's replay check ignores input after the finish line.
- A Merge does not move a guest's personal best in an old ghost format (schema 1). The
  clean-up then deletes it with the guest's other rows.

**Still to do at refactor time:**

- The grounds are still being tuned, so no test fixes ground runs. Before a change to the
  race code, record the autopilot runs on every ground track, and compare them after the
  change.
- Check "done" on the analytics page of each subreddit before the fill removal.
- Decide the two "faster time wins" differences (§3.1) before the rules become one.

## Checked, not reported

- **Tables.** The drawn car skins, the trackside items, the grounds, the track art, and the
  car sound profiles give many clone hits. Each hit is table rows with other values.
- **Songs.** The space and Circuit songs share one drum block. Each song is its own music.
- **Garage cleanup and discard.** They look alike but differ: discard writes the promotion
  mark.
- **Element tables.** The HUD and the Mapmaker playtest look up their elements in lists that
  look alike.
- **Debug stubs.** Their exports have no readers by design; the build swaps them in.
- **The uncommitted ground tuning.** Not audited.

## Method and limits

- Reused the 09-26 scripts: the module graph and export use, the member and field check,
  the stylesheet and element id checks, and the data file check.
- Reused the 09-23 scripts: exact token copies of 60 tokens or more, copies of 80 tokens or
  more with names and values ignored, and groups of functions with the same body. Scanned
  288 production files. Did not scan the track definitions or the medal times.
- Compared each result with the earlier runs. Matched files by name, because many files
  moved to new folders after 09-23.
- For the transfer, traced every production caller of each step and listed the options it
  passes.
- Ran `npx tsc` with the unused-name checks on `src/`, and on `game/`, `pages/` and
  `tools/` with `checkJs`.
- Read each finding in the code before this report names it.
- Did not run the test suite, a production build, or a removal. These are verified
  candidates, not a tested removal.
