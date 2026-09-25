# Track grounds plan — 2026-09-24

Branch `feat/track-grounds`, based on `cf7773e` (`chore/structure-moves`).

**Status, 2026-09-24:** Steps 0 to 8, 10 and 11 are built. Nothing is committed. Step 9 (new dirt
tracks) is for you, after this branch. `npm test` passes (246 files, 3,102 tests, typecheck clean).
Every client page and both Mapmaker pages bundle with esbuild.

The dirt numbers are a first setting, made by driving all 140 tracks with a test autopilot. On
dirt, a lap is about 12% slower (median), and the car slides about a third more in corners. Tune
them in the Mapmaker playtest before the first dirt track goes live (D6).

**Update, 2026-09-24:** dirt also starts and stops turning more slowly (`angularResponse` 0.6)
and turns a little less sharply (`turnRate` 0.9), because the steering felt as quick as on tarmac.
With the test autopilot on all tracks, a dirt lap is now about 14% slower than tarmac (median).

**Update 2, 2026-09-24:** dirt acceleration is now 0.75 (was 0.9), because the car still
pulled away almost as fast as on tarmac. Snow acceleration is now 0.7 (was 0.8), so snow
stays slower than dirt. Three new settings are off on every ground for now: `yawCarry`,
`slideScrub` and a `highSpeedSteerTrim` multiplier. With the test autopilot, a dirt lap is now about
19% slower than tarmac, and a snow lap about 29% slower (median).

**Update 3, 2026-09-24:** dirt acceleration is now 0.6, and snow acceleration 0.55, so snow
stays slower than dirt. 0 to 200 km/h takes 0.58 s on tarmac, 1.03 s on dirt and 1.25 s on
snow. With the test autopilot, a dirt lap is now about 25% slower than tarmac, and a snow lap
about 38% slower (median). Snow Circuit takes the autopilot 22.3 s, close to the 25 s bronze
limit.

**Update 4, 2026-09-24:** dirt `grip` is now 0.8 (was 0.6) and `steerGripScale` 0.75 (was 1).
Grip while steering stays about the same (0.6), so corners slide as before. When the player
does not steer, grip is higher, so the car stops sliding sooner on a straight: a 0.13 s
correction slides for 0.60 s (0.75 s before, 0.50 s on tarmac). The Mapmaker playtest no
longer has dirt feel switches.

## Goal

Some new tracks use dirt instead of tarmac. The first version has only dirt. One track has one ground
for the full lap. The ground changes how the car drives. The server check of each run stays exact.

## Words

- This plan and the code use the word **ground**.
- The code does not use "surface" for this. `game/track/presentation.js` already uses
  `TRACK_PRESENTATION_SURFACES` for the places that show a track (race, preview, track picker,
  share).
- The code does not use "terrain" or "biome" for this. The archived branches
  `archive/feat-track-biomes` and `archive/codex-world-first-terrain` use those words for scenery.
  Scenery does not change how the car drives.

---

## What the code does today

Each fact below comes from the code on `cf7773e`.

1. **One set of driving settings for every race.** `game/config.js` spreads
   `DEFAULT_PHYSICS_TUNING` from `game/car/handling.js` into `CONFIG`.
   - The game calls `setRuntimeConfig(null)` before each race
     (`game/daily-challenge/engine-methods.js:622`, `:670`,
     `game/challenge-run/engine-methods.js:272`, `:314`).
   - The server uses `{ ...CONFIG }` (`src/server/competition/replay-validator.ts:252`).
   - The car choice does not change the driving settings.
2. **One driving function.** `updateSimulation(state, dt, config, currentTrack, collisionSegments)` in
   `game/race/simulation.js` is the only driving code. Four places call it:
   - the game (`game/race/engine-methods.js:736`)
   - the server check (`src/server/competition/replay-validator.ts`)
   - the Mapmaker playtest (`tools/mapmaker-playtest.js:141`)
   - the TikTok studio (`tools/tiktok-studio.js:902`)
3. **The full track object reaches the driving function.** The game loader copies every field of the
   definition file (`normalizeTrack` in `game/track/client-registry.js`). The server registry also
   copies every field (`TRACKS` at the end of `game/track/tracks.js`). A new field in a definition
   file reaches all four callers with no loader change.
4. **The player sends only key presses.** Each replay frame holds `left`, `right` and
   `relaunchDelay`. The server drives the full race again and keeps its own time. The player cannot
   send a ground or a time.
5. **The server's "same track" check reads six fields.** `stableTrackShape` in
   `src/server/competition/pb-ghost-trace.ts:91` hashes `outer`, `inner`, `startLine`, `startPos`,
   `startAngle` and `checkpoints`. Head to Head (`head-to-head-runtime.ts`, `head-to-head-catalog.ts`)
   and the podium replay (`daily-podium-replay.ts`) use this hash.
6. **A rules version gates each run.** `DAILY_GP_RULES_REVISION = 1` in
   `src/server/daily/daily-gp-model.ts`. The server rejects a replay with a different rules version.
7. **A replay has a frame limit.** The limit is 2,500 frames for each lap (41.7 s at 60 frames each
   second). The game (`getScoreboardReplayMaxFrames` in `game/race/replay.js`) and the server
   (`REPLAY_FRAMES_PER_LAP`) use the same limit. A longer run fails with `replay_too_long`.
8. **The track look is the same for all tracks, except event looks.** `resolveTrackPresentation` in
   `game/track/presentation.js` takes only the track key and an optional event. The only override is
   the Daily desert look on Kettle Run. It changes colours only. `game/track/preview-renderer.js:341`
   uses a fixed road colour. The track picture cache key uses `presentation.key`
   (`game/track/assets.js`).
9. **The speed display and the engine sound use the top speed setting.** `game/engine.js:260`,
   `:267`, `:504` and `:897` read `runtimeConfig.maxSpeed`.
10. **Medal times are typed by hand** into `game/medals/medal-times.json`.
11. **The Mapmaker writes optional fields.** `generateTrackGeometrySource` in
    `tools/mapmaker/track-source.js` writes `cornerRadius`, `drawWidth` and `lineSmoothing` only when
    they are set. The track catalog parser in `tools/mapmaker/track-repository.js` accepts only
    `{ name: "..." }` entries.

---

## Decisions

**D1. Keep the ground in the track definition file.** Example: `ground: 'dirt'`. A file with no
`ground` is tarmac.
Why: the definition reaches all four driving callers with no change (fact 3). The "same track" hash
reads the track object (fact 5). The Mapmaker already writes optional fields (fact 11). The catalog
is a bad place, because its parser accepts only a name.

**D2. Apply the ground inside `updateSimulation`.** Do not apply it in `setRuntimeConfig`.
Why: one change covers the game, the server, the Mapmaker and the TikTok studio. The
`setRuntimeConfig` route needs four separate changes, and the Daily and shared race-run copies
already drift (`docs/duplicated-code-audit-2026-09-23.md`). If the game and the server differ, every
run on that track fails.

**D3. A ground is a set of multipliers on the driving settings.** Tarmac multiplies every setting by
exactly 1.
- In floating point, `x * 1` is exactly `x`. Tarmac tracks keep the same times, to the last bit.
- Apply each multiplier after the existing fallback and before the existing clamp. Do not change the
  order of the other operations.
- First set of settings: `accel`, `maxSpeed`, `grip`, `steerGripScale`, `turnRate`. Added
  later: `angularResponse`, how quickly the car starts and stops turning.
- Do not change `brakePower`. The car brakes only when it moves backwards.
- Do not change the wall contact settings in the first version.

**D4. Add the ground to the "same track" hash only when it is not tarmac.** `JSON.stringify` drops a
field whose value is `undefined`. Existing tracks keep their current hash. Head to Head challenges
and podium replays that exist now stay valid.

**D5. Give a ground only to new tracks.** Existing tracks stay tarmac. Their leaderboard times stay
valid. The rules version does not change.

**D6. Freeze the ground numbers when the first track with that ground goes live.** Before that, the
numbers can change freely. After that, they are rules, like the tarmac numbers.
- A change breaks runs that wait in the verification queue, because the server drives them again
  with the new numbers.
- A change also breaks leaderboard times, ghosts and Head to Head challenges on that ground.
- To change the feel later, add a new ground key, or raise the rules version.

**D7. An unknown ground name drives as tarmac, on both sides.** The game and the server ship
together, so both sides give the same result. A track test fails on an unknown name, so a spelling
mistake cannot ship.

**D8. Keep random values and device time out of the ground code.** The server must get the same
result as the game. `Math.random` in `simulation.js` is used only for sparks, which do not change
the drive.

---

## Answers and open questions

1. **Which grounds.** Decided: **dirt** only in the first version. The table can take more grounds later.
   - The car always accelerates, and the player only steers. So a ground must change how the car
     turns and slides. A ground that only makes the car slower gives longer times, but no new skill.
   - Dirt: less grip, a slightly lower top speed, a small slide in corners. The desert look on
     Kettle Run (brown road, canyon walls, no kerbs) is a start for its look.
   - Ice is left for later. The player cannot brake, so ice needs a much lower top speed, and it
     fits only wide tracks.
   - Not recommended: sand or mud that only slows the car. Not recommended: wet tarmac, because it
     is hard to see on a phone screen.
   - We set the numbers by playtest in the Mapmaker.
2. **No new tracks in this branch.** You build the tracks by hand. The Mapmaker must have a ground
   picker (Step 7).
3. **The player sees the ground.** Yes. One word on the track card and the start screen, for
   example "DIRT" (Step 10).
4. **Skid marks.** Yes. Each ground sets its own skid mark colour and slide limit. These values
   change only the look (Step 5).
5. **Speed bar and engine sound.** Decided: Option A. The speed bar has 20 marks. Today, all 20 marks come on at
   top speed. The engine sound goes up through its gears to top speed. On a ground with a lower top
   speed, the car cannot reach the tarmac top speed.
   - Option A: the bar and the engine sound use the ground's top speed. At full speed, all 20 marks
     come on, and the engine reaches its top gear. The km/h number still shows the true speed.
   - Option B: the bar and the engine sound keep the tarmac top speed. On dirt, the bar stops before
     the end, and the engine never reaches its top gear.
   - You chose Option A.

---

## Steps

Each step is one commit. Steps 0 to 3 are the fair-play core. Do them first and in this order.

### Step 0 — Pin the current times (before any change)

- Add a test that drives fixed key-press scripts on at least five existing tracks, one of them
  multi-lap. It runs both the game loop path and `validateDailyGpReplayDetailed`.
- The test records `bestTimeMs`, the checkpoint times and the end position as fixed values.
- Add a test that pins the "same track" hash of two existing tracks.
- Commit this on the current code. Later steps must keep it green without edits.

### Step 1 — Ground table

- New file `game/track/grounds.js`:
  - `TRACK_GROUNDS`, a frozen table with `tarmac` (all multipliers 1) and `dirt`.
  - `getTrackGround(track)`, which returns the ground of a track, or tarmac.
- Unit tests: tarmac is all 1, every ground has every setting, and an unknown name gives tarmac.

### Step 2 — Driving function

- `updateSimulation` reads `getTrackGround(currentTrack)` and applies the multipliers from D3.
- Lines to change in `game/race/simulation.js`: `accel` (575), `safeMaxSpeed` (576), `gripBase`
  (577), `turnRate` (586), `steerGripScale` (637).
- Tests:
  - Step 0 stays green, with no edits.
  - The same key presses on a copy of a track with `ground: 'dirt'` give a different time.
  - The game loop path and the server check give the same time on each ground.
  - A straight-line test shows the top speed and the acceleration of each ground.

### Step 3 — "Same track" hash

- `stableTrackShape` adds `ground` only when the ground is not tarmac (D4).
- Tests: the Step 0 hash values do not change. A dirt copy of a track gets a different hash.

### Step 4 — Frame limit check

- Add a track test: on a ground track, the bronze time plus a margin stays well under 41.7 s for
  each lap (fact 7).
- A slow ground makes long laps. If a lap goes over the limit, even a good run fails.

### Step 5 — Look

- `presentation.js`: add a look for each ground (road colour, kerbs, tyre walls, skid marks). Order:
  default, then ground, then event. An event look still wins.
- `resolveTrackPresentation` takes a `ground` option. The look key includes the ground, so the
  picture cache does not mix looks.
- Pass the ground from these callers:
  - `game/engine.js:148`
  - `game/track/engine-methods.js:24`
  - `game/ui/track-carousel.js:186`
  - `game/daily-challenge/ui.js:416`
  - `game/daily-challenge/engine-methods.js:428`
  - `tools/mapmaker.js:2409`
  - `tools/mapmaker-playtest.js:357`
  - `tools/generate-lp-assets.js:63`
- `preview-renderer.js`: take the road colour from the look, not the fixed value. Check the pages
  that use it: `pages/preview.js`, `pages/podium.js`, `pages/head-to-head.js` and
  `pages/podium-replay-view.js`. Also check `tools/generate-share-images.js`.
- Put new CSS only in the stylesheet that owns the area (`docs/css-architecture.md`).

### Step 6 — Speed bar and engine sound

- Option A (question 5). Use the ground's top speed at the four `runtimeConfig.maxSpeed` reads in `game/engine.js`.

### Step 7 — Mapmaker

- Add a ground picker to the track settings. This is required.
- `generateTrackGeometrySource` writes `ground` only when it is not tarmac.
- The playtest drives with the ground automatically, because it passes `draft.track` to
  `updateSimulation`. It needs only the look from Step 5.
- Tests: extend `tests/mapmaker-track-source.test.js`.

### Step 8 — Track checks

- `tests/track-runtime-integrity.test.js`: every `ground` value is a key in `TRACK_GROUNDS`.

### Step 9 — New tracks (not in this branch)

- You build the ground tracks by hand in the Mapmaker, after this branch.
- For each track: drive it in the playtest, set its medal times in `medal-times.json`, add it to the
  catalog, and add it to the schedule if it runs in the Daily.
- Update the new-track list in `tests/track-runtime-integrity.test.js`
  ("preserves existing track data while intentionally extending the registry").
- In this branch, the tests use copies of existing tracks with a ground.

### Step 10 — Ground label

- One word on the track card and the start screen, for example "DIRT". Tarmac tracks show no label.
- Keep it as short as the text near it.

### Step 11 — Docs

- `docs/track-authoring.md`: how to give a track a ground, and the frozen-numbers rule (D6).
- `docs/system-change-map.md`: add `game/track/grounds.js` to the "Shared gameplay validation" box
  (line 41). Add the ground to the `simulation.js` description (line 60).

---

## Fair-play checklist

- [ ] The server drives each run with the same `updateSimulation` and the same definition file.
- [ ] The replay format does not change. The player cannot send a ground.
- [ ] The ground code uses no random values and no device time.
- [ ] Tarmac times do not change, to the last bit (Step 0).
- [ ] The "same track" hash includes the ground, and existing hashes do not change (Step 3).
- [ ] No existing track gets a ground, so the rules version stays at 1 (D5).
- [ ] Ground laps stay under the frame limit (Step 4).
- [ ] Ground numbers are frozen after launch (D6).

## Checks before merge

- `npm test`. The typecheck runs first and must show 0 errors. Judge the result by the named FAIL
  set, not by the count.
- `npm run build`. Vitest does not catch Vite build errors.
- Drive one ground track in the game on the local server (port 8000) with `advanceTime`. Submit the
  run. The server accepts it, and its time is equal to the game's time.
- Open a Head to Head challenge and a podium replay on an existing track. Both still open.

## Risks

| Risk | Result | Prevention |
|---|---|---|
| A change in the order of operations in `updateSimulation` | Existing replays drive differently, and old runs fail | Step 0 test |
| The look key does not include the ground | A track picture shows the wrong colours | Step 5 key test |
| A ground is tuned after launch | Queued runs and board times fail | D6 |
| A slow ground makes a long lap | Good runs fail with `replay_too_long` | Step 4 test |
