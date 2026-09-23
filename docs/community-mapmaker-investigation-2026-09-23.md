# Community Mapmaker: Investigation

Date: 2026-09-23. Status: investigation only. No code is changed.

## Answer

Yes. We can make a player mapmaker that stores maps in Redis.
The server can already check a run on a track that it gets as data.
The largest work is not the editor. The largest work is to let the game
load a track that is not in the built-in catalog.

## What Exists Today

These facts are traced in the code.

1. The current mapmaker is a local developer tool.
   It writes track files into the repository through a localhost-only
   Vite plugin (`tools/mapmaker/vite-track-authoring-plugin.js`).
   The Devvit build does not include it (`devvit.json`, `sourceIgnores: tools/*`).
2. The mapmaker helpers are in `tools/`: walls (`ribbon-walls.js`),
   gates (`lane-gate.js`), start pose (`start-pose.js`), and `tools/geometry.js`.
   The game and the server cannot use them in their current location.
3. The game loads a track only if its key is in the built-in catalog.
   `loadClientTrack()` returns `null` for other keys
   (`game/track/client-registry.js:51`).
4. The server run check takes the track as an argument.
   `validateDailyGpReplayDetailed({ challenge, replay, track })`
   (`src/server/replay-validator.ts:192`). It uses the same simulation
   and the same wall builder as the game. A community track can use it.
5. Medal times are a static file keyed by track key
   (`game/medals/medal-times.json`, read in `game/medals/medal-timing.js`).
   A community map needs a second source for medal times.
6. The track render and collision caches use the track key only
   (`game/track/assets.js`). If a draft changes but keeps the same key,
   the game shows the old geometry.
7. Race rules (`game/race/simulation.js:680-717`):
   - The car must cross the checkpoints in their list order.
   - The game does not check the crossing direction.
   - A crossing of the start line always sets the next checkpoint back to 1.
   - A lap counts only after 2.0 seconds.
   Thus, if checkpoint 1 is behind the car, the player cannot finish a lap.
8. In the current mapmaker, the player types the track key.
   The key does not come from the name.

## Why the Current Mapmaker Places Checkpoints Badly

1. **The gates use a different center line than the walls.**
   Line Build puts the checkpoints on the drawn center line
   (`tools/mapmaker.js:230-245`). The walls come from a changed center line:
   the builder widens tight bends and rounds the corners first
   (`buildRibbonWallsFromCenterline`, `ribbon-walls.js:273`).
   At a bend, the gate is not at the road center and is not square to the road.
2. **The gate length is fixed.** The gate is half the road width plus the
   overhang on each side. The builder does not cut it at the real walls.
   At a bend, one end can stop short of a wall.
3. **Checkpoints do not follow the start.** They are fixed points.
   If the player moves the start line, the checkpoints stay.
   The start car heading comes from the side of the line where the player
   drops the car (`snapStartPose`, `start-pose.js:47`).
   If the heading flips, the checkpoint order stays the same.
   Then checkpoint 1 is behind the car, and the lap cannot finish.
4. **The track check is too weak.** `validateTrack()` checks only that
   each number is finite (`tools/mapmaker.js:1125`). It does not check:
   - the checkpoint order against the car heading;
   - that each gate crosses the full road;
   - that a gate does not touch a different part of the road.

## Proposed Design

### Rule: the player draws only the road

The player draws one closed center line. The editor calculates all other
parts from it. The player cannot move a wall, a gate, or the start line
by hand. This removes all the faults in the section above.

Fixed values (the values that most current tracks use):

- Road width: `3.85` (7 car widths).
- Corner radius: `1.5`.

### Start and direction

- The player taps a point on the road. The editor moves the start to the
  nearest point on the road center line. The editor keeps this point as a
  distance along the loop.
- The player taps "flip" to turn the car around.
- The car must point along the road. Thus each start point has two
  headings. The example "car points up, checkpoint 1 is up" works.
  A car cannot point across the road.

### Checkpoints

The editor calculates the checkpoints again after each change to the road,
the start, or the heading.

1. Use the road center line after the corner rounding.
   This is the center line that the walls use.
2. Put the gates at equal distances along the loop from the start, in the
   car direction. Gate `k` of `N` is at `start + direction × length × k / (N + 1)`.
   `N` comes from the loop length (3 for a short loop, up to 5 for a long loop).
3. Make each gate square to the road at that point. Cut it at the real walls
   with the ray test in `lane-gate.js`. Then add the usual overhang.
4. If a gate touches a different part of the road, move it a small step
   along the loop and try again.

### Track checks before a test run

- The loop length is more than a minimum value.
- The walls do not cross.
- Two parts of the road do not come nearer than a minimum gap.
- Each gate crosses only its own part of the road.
- The start line obeys the same rules as a gate.

### Test run

- The player selects 1, 2, or 3 laps before the test run.
- The editor starts a normal race on the draft track with that lap count.
- The draft uses a key that comes from its geometry (a hash).
  This prevents the cache fault in item 6 above.
- The game records the inputs of each run. It already does this for
  Daily runs (`game/race/replay.js`).
- The editor keeps the best runs of the current draft.
  The player selects one run as the Author run.
- A change to the road, start, heading, or lap count deletes the test runs.

### Publish

1. The client sends: name, center line, start distance, heading,
   lap count, and the selected run inputs.
2. The server builds the track again from the center line with the same
   shared code. The server does not accept walls or gates from the client.
3. The server runs the check in `replay-validator.ts`.
   The server time is the Author time. A player cannot send a false Author time.
   For 2 or 3 laps, the Author time is the total time for all laps.
4. The server refuses the map if the Author time is more than the limit
   in "Run length limit" below.
5. The server calculates the medal times (see below).
6. The server claims the key with a set-if-not-exists write, then stores the map.
7. The server puts the Author run on the map leaderboard as the first entry.
   The run is already checked, so this costs no extra check.
8. A published map does not change. To change a map, the player
   publishes a new map.

### Run length limit (new finding)

The server check refuses a run that is longer than 2,500 frames for each lap
(`REPLAY_FRAMES_PER_LAP`, `src/server/replay-validator.ts:14`). At 60 frames
each second (`game/config.js:23`), this is 41.6 s for each lap.
The game client uses the same limit (`game/race/replay.js:2`).

A slow player on a long map can go past this limit. Then the server refuses
the run, and the player gets no leaderboard entry.

The current tracks are far below the limit. Their Author times are 5 s to 19.2 s
for one lap (median 11.03 s).

Proposal:

- The server refuses a map if its Author time is more than 20 s for each lap.
- The editor shows a warning when the loop is too long for this limit.
- Then a player who is two times slower than the author still finishes
  in the limit.

### Track key

- The key comes from the name, in the same style as the catalog:
  "Shark Bite" gives `sharkBite`.
- The server refuses a key that is the same as a catalog key or an existing
  community key. The test ignores letter case.
- Community keys must use their own name space in the game and in Redis.
  Many modules take a key and ask the catalog about it
  (`hasTrack`, `getTrackName`: 17 game files and 9 server files).
  A name space prevents a community key from reaching them by mistake.

### Medal times

The server calculates them from the Author time. It rounds each value up
to 0.01 s. The values are for the full race, with all laps.
The map record keeps them. The static medal file does not change.

| Medal  | Rule          | Median of the 130 current tracks |
|--------|---------------|----------------------------------|
| Gold   | Author × 1.03 | 1.026                            |
| Silver | Author × 1.06 | 1.058                            |
| Bronze | Author × 1.09 | 1.090                            |

The game shows the Author medal only when Author is less than Gold
(`getAuthorMedalSeconds`). These rules obey that condition.

### Drafts

- The editor keeps drafts in local browser storage.
  The game already does this for other data. Every read and write must
  tolerate a failure.
- Each draft keeps its test runs. The server does not see a draft.
- Local storage can be empty in some Reddit app views. Tell the player
  that a draft stays only on this device.

### Lobby

- Add one "Community" button to the existing home menu (`game.html:144`).
- The Community pane uses the existing track carousel.
- The editor opens as its own screen.

### Mobile and desktop

- Use pointer events for mouse, pen, and touch.
- One finger draws. Two fingers move and zoom the view.
- The loop closes when the stroke ends near its start point.
- Use large buttons: Draw, Undo, Start, Flip, Test, Save, Publish.
- The editor must obey the Reddit website frame limit: the game cannot see
  the controls that cover its bottom edge.

### Redis layout (proposal)

| Key                                   | Type   | Contents                                   |
|---------------------------------------|--------|--------------------------------------------|
| `community:map:{key}`                 | string | Map record, compressed                     |
| `community:maps:recent`               | zset   | Key by publish time                        |
| `community:maps:author:{user}`        | zset   | Keys of one author                         |
| `community:maps:removed`              | zset   | Removed keys, by remove time               |
| `community:{key}:leaderboard`         | zset   | Player by race time                        |
| `community:{key}:leaderboard:entries` | hash   | Leaderboard entry for each player          |
| `community:{key}:leaderboard:standings-revision` | string | Changes when the board changes  |
| `community:{key}:pbs`                 | hash   | Personal best and ghost for each player    |
| `community:guest-expiry`              | zset   | Guest entries, by expiry time              |
| `community:publish-limit:{user}:{day}`| string | Publish count, with expiry (only if we keep a limit) |

The leaderboard keys follow the Campaign pattern
(`toCampaignCompetition`, `src/server/competition.ts:90`).

A map record holds: name, key, author, center line, start distance,
heading, lap count, the built track, Author time, medal times,
rules revision, publish time, and status.

Sizes:

- A current track file is 2 KB to 6 KB. A community map is about the same size.
- Each player on a map adds one leaderboard entry and one personal best
  with a ghost. A ghost for a 40 s race is about 12 KB before compression
  (`docs/redis-devvit-api-opportunities-2026-09-21.md:45`).
  Thus the leaderboards cost more storage than the maps.
- The repository does not record the Redis quota of an install.
  I could not read the Reddit developer documents from here.
  Get the quota from Reddit before launch.
- Devvit Redis has no size command. Count the stored keys from the indexes.

## Code Moves

Move these helpers from `tools/` to `game/track/authoring/`:
`ribbon-walls.js`, `lane-gate.js`, `start-pose.js`, and the parts of
`tools/geometry.js` that they use. Then the editor, the game, and the server
use the same code. The developer mapmaker imports them from the new location.

## Decisions (2026-09-23)

### 1. Moderator panel

Decision: moderators use a separate panel, like the Analytics panel.

The Analytics panel works like this (traced in the code):

- A moderator menu item on the subreddit calls
  `/internal/menu/mod-analytics-open` (`devvit.json`).
- The server makes one custom post for the panel, then locks and removes it.
  The post is visible only through the menu (`src/server/moderator-analytics-post.ts`).
- The panel page is its own entry point, `mod-analytics.html` (`devvit.json`).
- Each data route checks moderator access again with
  `assertModeratorForSubreddit` (`src/server/routes/analytics-routes.ts:57`).

The community map panel can use the same pattern:

- New menu item: "Open Mini Racer community maps".
- New entry point: `mod-maps.html`, with its own hidden post.
- The panel shows the maps, newest first. For each map: a track picture
  (the existing preview renderer), name, author, laps, Author time,
  number of players, and publish date.
- Actions: Remove and Restore.
- Every panel route checks moderator access. The game must never call them.

Remove, proposed rules:

- Remove sets the map status to "removed". The map leaves the Community
  list at once. Its leaderboard stays, so Restore is possible.
- The key stays claimed after a remove. A new map cannot take the name
  of a removed map.
- A later "Delete" action can clear the leaderboard keys of a removed map
  to free storage. Decide if moderators need it.

Open point: the panel does not need player reports for the first version.
Moderators can find maps by date. Add reports later if the list gets too long.

### 2. A leaderboard for each map

Decision: each map gets a leaderboard.

The server already has a general "competition" model for Daily and Campaign
(`src/server/competition.ts`). It supports 1, 2, or 3 laps, permanent
boards, guest entries, personal bests, and ghosts.
A third mode, "community", fits this model. The keys follow the Campaign
pattern (see "Redis layout").

The work: the shared competition code gets the track from the built-in
registry in 5 places:

- `src/server/competition-leaderboard.ts:128`, `:213`
- `src/server/competition-opponent-race.ts:152`, `:194`
- `src/server/competition-submit.ts:228`

A community map is not in that registry. The competition record must carry
its track. Daily and Campaign keep their current behavior.

### 3. Laps

Decision: the author selects 1, 2, or 3 laps.

- The competition model and the server check already support 1 to 3 laps.
- The test runs use the selected lap count. The Author time is the total time.
- The medal times are for the total race.
- The run length limit applies to each lap (see "Run length limit").

### 4. Car physics

Decision: no car physics change.

The map record still keeps the rules revision (today 1, the same value as
Daily and Campaign). This costs nothing. The server check needs this value
(`replay-validator.ts:207`).

### 5. Publish limits: "no limits?"

My recommendation: no limit on the number of maps for each player,
but keep a small limit for each day, for example 5 maps each day.

Reasons:

- A normal player does not publish more than 5 maps in one day.
  The limit costs them nothing.
- Without a limit, one script can publish thousands of maps.
  Each map needs a moderator check. Each map claims a name for all time.
- Each map with a leaderboard uses more storage with each player.
  We do not know the Redis quota yet (see "Redis layout").
- Each publish runs the full server check. A flood of publishes can slow the server.
- A publish needs a signed-in Reddit account, not a guest.
  This is necessary for the author name and for the limit.

If you want no limit, the design still works. Then moderators are the only
protection, and the Remove action is more important.

## Other Risks

1. **Integration size.** The game assumes a catalog track in many places.
   Keep community play on its own path. Do not add community maps to the catalog.
2. **List size.** The lobby carousel shows all tracks in a row.
   A list of hundreds of maps needs pages or a sort (newest, most played).
3. **Word filter.** Players choose map names. The server needs a word filter
   before the map reaches the moderators.

## Suggested Phases

1. Move the shared helpers. Build the new checkpoint and track-check code
   with tests (all start points, both headings, tight bends, near-touching roads).
2. Build the editor screen with local drafts and the lap selection.
3. Load a draft track in the game and record test runs.
4. Add the server publish path: rebuild, run check, run length limit,
   medals, key claim, store, Author entry on the leaderboard.
5. Let the competition code take its track from the competition record.
   Add the "community" competition mode.
6. Add the Community pane in the lobby, with map leaderboards.
7. Add the moderator panel: menu item, hidden post, list, Remove, Restore.
