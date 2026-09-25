# Track Authoring

## Purpose

Mini Racer separates lightweight track metadata from full race geometry.
This keeps names, validation, and Daily GP scheduling available without making
every consumer load the large geometry registry.

## Track Files

- `game/track/catalog.js`
  Owns every playable track's player-facing name plus `TRACK_SCHEDULE_KEYS`,
  `DEFAULT_TRACK_KEY`, `hasTrack()`, and `getTrackName()`.
- `game/track/definitions/<track-slug>.js`
  Owns one track's boundaries, start position, start line, checkpoints, and
  geometry-specific options.
- `game/track/tracks.js`
  Assembles every catalog definition into the compatibility `TRACKS` registry,
  including Campaign tracks that are not in the Daily schedule.
- `game/campaign/series.json`
  Owns the Campaign series and their stages: the track, the laps and the medal
  target of each stage. The Mapmaker writes it. See **Campaign Series**.
  Rendering, collision, previews, and replay validation use this registry.
- `game/track/geometry.js`
  Owns the shared point and line-intersection helpers.
- `game/track/runtime.js`
  Converts a definition into smoothed geometry and collision data.

## Scale Reference

Mapmaker draws a race-style track preview using the same corner rounding,
asphalt fill, curbs, and start/finish paint as the game. Sharp outer/inner
construction walls stay faintly visible on top so editable corners remain
easy to see.

Mapmaker draws a ghost car at the finished start position using the real race
collision size (`0.55u` wide × `1.23u` long).

Brush size is fixed at **7 car-widths** (`3.85u`). That is the
usual racing lane width for Line Build.

Line Build keeps the full-width road **open** while placing points. The pointer
extends the road, and bends are rounded in the draft preview. It never draws
an implied closing edge. Hover over the first point to see the exact road that
clicking it will build; the close target is kept small so a nearby click can
still add a point. The draft view has no length labels or centerline so the
road footprint stays clear. The editor keeps the same camera scale and
position after closing; **Reframe** fits the finished track whenever needed.

Line Build fillets each sharp bend on the drawn centerline by half the lane
width, then offsets both walls by that same half-width. Bends tighter than
half the lane are widened first so the inside wall cannot cross itself.
That keeps the road the same width through corners. It does not rewrite
the sketch: a square stays a square.

Existing saved tracks are unchanged until you redraw them with Line Build.

Wall Corners controls how rounded wall corners look in race
(Sharp, A bit rounded, Rounded, Soft). It is not the driven turn radius.
Changing Wall Corners updates the Mapmaker race preview immediately.

Line Build places its start line and checkpoints against the final road after
tight bends are widened and corners are filleted. It spaces three to five
checkpoints by road length, in driving order. Start line and checkpoint edits
snap across the lane, stay perpendicular to the nearer track wall, and extend
a bit past both walls so wall-hugging cars still trigger them. The start car
always faces perpendicular to the start/finish line and snaps onto that line's
center axis when moved. Moving or reversing the start on a newly built road
updates its automatic checkpoint order while its walls and checkpoints remain
unedited; manual checkpoint edits keep their authored positions.

The **Track Checks** panel checks the smoothed race walls, road clearance,
start position, gate coverage, and checkpoint order. It marks problem locations
on the map and shows approximate lap length plus the narrowest wall gap.
New structural errors block export and **Save & Integrate**;
warnings invite a driving check. Existing integrated tracks with a known
baseline issue can still be renamed or have metadata saved while their race
geometry is unchanged. Geometry edits must resolve any remaining hard error.
Use **Drive Draft** to test the current unsaved track with the real race
simulation before integration. The draft drive runs only in the browser and
does not publish or save a definition. It reports checkpoint progress, lap
completion, and wall contacts. **Runner Lab** remains useful for its approximate
bot swarm and hotspot report after integration.

### Flow checks

The **Flow** part of Track Checks measures how the road drives. It uses the
fastest smooth line through the lane and the car's real steering limits. It
checks five rules:

1. **Steer at least every second.** No stretch without steering lasts 1 s or more.
2. **Keep 40% speed in every corner.** The slowest point keeps 40% of top speed.
3. **Keep a steady beat.** A new steering input comes at least every 1.4 s.
4. **Alternate left and right.** At least 75% of steering inputs change side.
5. **Keep the same width.** The road width varies by 8% or less.

Of the 124 Daily tracks on 2026-09-24, exactly six pass all five rules:
Double Crest, Anvil Circuit, Shark Bite, Oven Mitt, Whistle Ridge and Safari
Circuit. These are the tracks that play as flowy. A blue **F** marker shows
where each missed rule breaks the flow. Flow results are hints. They never
block export or **Save & Integrate**. The check runs only when the track has no
structural errors.

While you draw in Line Build, each straight longer than 14 units is marked with
its length. A straight of that length takes about 1 s at top speed. A bend
counts only when the fast line must turn tighter than a 15-unit radius.

After a finished lap, **Drive Draft** also shows **Flow on this lap**. This is
your slowest speed, your longest time without steering, your steering beat and
your left-right changes. The numbers describe your own lap, so a wall hit
shows as a slow point.

**Drive Draft** looks like a lap in the game. The drive view fills the space left on the screen and stays inside it. It uses the race camera
(`game/race/race-camera.js`): the same zoom and look-ahead as the race, with
the phone camera on a touch screen or a narrow window. It draws the default car
of the track's ground and the race HUD (time, best lap and speed bar).
**Show whole track** still shows the full map. Drive Draft keeps your 10 best
laps for each layout in the browser. A change to a wall, gate, start point,
corner or ground starts a new list.

**Undo** and **Redo** cover wall, gate, start, name, and corner edits; a pointer
drag is one undo step. While Line Build is open, Undo removes the last sketch
point. The browser keeps unsaved maps and open sketches locally and offers to
restore them after a reload. Returning from **Drive Draft** restores the map
automatically in the same tab.

## Adding A Track

1. Build and validate the layout in `tools/mapmaker.html`.
2. Run `npm run mapmaker`, open
   `http://127.0.0.1:5173/tools/mapmaker.html`, and choose
   **Save & Integrate**. It writes the definition module and updates
   `TRACK_CATALOG`, the static definition imports, and the compatibility
   registry. Choose **Use For** before saving:
   - **Daily Challenge** also appends or keeps the track in
     `TRACK_SCHEDULE_KEYS`.
   - **Campaign · <series>** keeps the track out of the Daily schedule and
     makes it a stage of that series. See **Campaign Series**.
   - **Not used** appears only for a track that is already out of Daily and
     out of every series.
3. New Daily Challenge tracks are appended as the final
   `TRACK_SCHEDULE_KEYS` entry. Existing Daily tracks keep their position.
   When extending an existing branch, keep the existing catalog and schedule
   prefixes in their original order, then append new catalog and Daily entries.
   Renames replace the old key at its existing position after confirmation
   and remove the old definition file. Series saves never add the track to the
   Daily schedule.
4. Set the medal times in **Medal Times** (see below). **Save & Integrate**
   writes them to `game/medals/medal-times.json`.
   New Daily GP publication selects 1–2 laps when Author time is under 10s,
   and one lap at or above 10s. Missing or invalid Author times conservatively
   publish as one lap. Campaign lap counts are set for each stage and may be
   1, 2, or 3.
5. Add or adjust `game/track/presentation.js` only when the track needs a
   non-default preview or race presentation.
6. Update the intentional full-registry fingerprint in
   `tests/track-runtime-integrity.test.js`. Preserve the preceding registry
   fingerprint as a subset assertion so adding a track cannot hide changes to
   existing track geometry. The current approved fingerprint includes the
   intentional Mistfall Circuit outer-boundary shape committed in `c4da688`,
   the reshaped Double Trouble, Monkey Wrench, and Shark Bite, and the
   appended Daily tracks through Anvil Circuit.
7. Run the track, Daily GP, medal, simulation, Mapmaker, and build checks.

## Campaign Series

The Campaign is a set of series, for example Numbers and Dirt. Each series has
its own stages. `game/campaign/series.json` holds them, and
`game/campaign/manifest.js` builds the stages from it.

- A stage ID is the series name and the stage number, for example
  `numbered-v1-03` or `dirt-v1-00`. The Redis keys of a stage use its series
  name. Numbers keeps the name `numbered-v1`, because every saved Numbers
  record uses it. Do not rename a series, and do not change its stage order.
- A series stays hidden from players until it has 2 stages
  (`CAMPAIGN_SERIES_MIN_STAGES` in `game/campaign/series-rules.js`). Before
  that, you can add, move and remove its stages freely.
- A live series (2 stages or more) is fixed. A track cannot leave it, and its
  position, laps, medal target and medal times cannot change. Players' saved
  results were checked against them. New tracks go after the last stage.
- The first stage of every series is open. Each later stage needs any medal on
  the stage before it and a **Medal Target**: the medals from that series that
  the player holds (bronze 1, silver 2, gold 3, author 4). The target must go
  up from stage to stage, and it can be 3 × the stage number at most, so Gold
  on every stage always opens the next one.
- Medals from every series count toward the Gold and Author car skins.
- Campaign opens a series screen that lists every series in `series.json`.
  A series with fewer than 2 stages shows there as **Coming soon**.

In the Mapmaker, choose **Use For** → **Campaign · <series>**. The panel under
it shows the stage number, **Laps** and **Medal Target**. For a series that is
not live, the stage list has **Up** and **Down** buttons; they write
`series.json` at once. The panel warns when the track's ground is not the
series ground.

## Medal Times

The **Medal Times** panel sets the four medal times of one lap: author, gold,
silver and bronze.

- The panel lists your 10 best **Drive Draft** laps on the current layout, and
  their average. Click one to use it as the author time. It is rounded up to
  0.01 s, so that lap earns the author medal.
- You can also type the author time.
- A new author time fills gold, silver and bronze with the median gaps of the
  current tracks (× 1.025, 1.055 and 1.088). You can change each one.
- The times must go up: author, gold, silver, bronze. The panel warns when
  bronze is 25 s or more.
- A Campaign stage needs all four times. The times of a stage in a live series
  are fixed.

## Choosing A Ground

Each track has one ground for the full lap. Choose it with **Ground** in the
Mapmaker track settings. The choices come from `TRACK_GROUNDS` in
`game/track/grounds.js`.

- **Tarmac** is the default. The Mapmaker does not write a `ground` field for
  a tarmac track.
- **Dirt** writes `ground: 'dirt'` in the definition file. On dirt, the car has
  less grip, a lower top speed and less acceleration. It starts and stops
  turning more slowly, and it turns a little less sharply. A dirt lap is about
  25% slower than tarmac. The road is clay with soft patches, loose soil at the
  edges and small stones, with cream and clay kerbs. The lobby shows "Dirt"
  after the lap count. The dirt engine is lower and rougher than the circuit
  car, with a hard bang and a bigger rev drop on each gear change. It crackles
  when the car slows down. Gravel stays quiet on a straight and gets louder in
  a slide, as a low roar of stones rather than a hiss. The dirt car is a
  little louder than the circuit car.
- **Snow** writes `ground: 'snow'`. On snow, the car has much less grip, a
  lower top speed, less acceleration, and it turns more slowly. A snow lap is
  about 38% slower than tarmac. The road is pale blue-white, with white and
  ice-blue kerbs. Snow suits short, tight tracks.
- **Grip** writes `ground: 'grip'`. It is a race-circuit road with three times
  the tarmac grip. The car holds its line and almost never slides: in corners,
  it slides about 3.5 degrees (9 degrees on tarmac). On tarmac, the slide makes
  the car's line change smoothly. On grip, the car starts and stops turning
  more slowly instead, so the line and the camera stay about as calm as on
  tarmac. A turn takes some speed, so a long turn is only about 10% wider than
  on tarmac. A grip lap takes about the same time as tarmac. Acceleration and
  top speed are the same as tarmac. The road is a little darker than tarmac.
- Dirt and snow each have their own look, tyre tracks, spray, car sound, race
  song and cars. The snow song is a cold B minor synth track. Grip has its own
  look, car sound and race song, and uses the tarmac cars. The grip engine is
  a little higher, brighter and cleaner than on tarmac, with more high whine.
  The tyres squeal as on tarmac. The grip song has the tarmac song's driving
  synth sound: eighth-note bass, four-on-the-floor drums, and a continuous
  sixteenth-note arp with echo. Its own E minor, G, D and A progression and
  alternating melodies run at 128 BPM, a little faster than tarmac.
- **Drive Draft** drives with the chosen ground.

The game and the server replay check read the same definition file, so the
server drives every run on the same ground. The server's "same track" hash
also includes a non-tarmac ground.

Rules:

- Do not give a ground to a track that already has leaderboard times. Those
  times were set on tarmac, and the server can no longer confirm them.
- A ground's numbers in `game/track/grounds.js` are race rules. Once a track
  with that ground is live, do not change them. A change breaks runs that are
  waiting to submit, leaderboard times, ghosts, and Head to Head challenges on
  that ground. To change the feel, add a new ground key.
- Keep a bronze lap under 25 seconds. The server rejects a replay longer
  than 41.7 seconds for each lap, and a slow ground makes laps longer.
  `tests/track-grounds.test.js` checks this for every ground track.

The repository-writing endpoint exists only in the dedicated local Mapmaker
Vite configuration and accepts requests only from localhost. It is not part of
the Devvit playtest or production build. **Download Module**, **Copy Module**,
and **Copy Integration** remain available as manual fallbacks.

## Removing A Track

**Remove Track** in the local Mapmaker discards a new, unsaved track from the
editor. For an integrated track, it asks for confirmation and removes the
definition module, catalog entry, Daily schedule entry, registry import, and
medal-times row. The repository operation refuses the default track, tracks
used by a Campaign series stage, and tracks named in the fixed published Daily GP
backfill. Review any track-specific presentation or test references before
shipping a removal.

The local Mapmaker cannot query hosted Redis or Reddit to determine whether a
track appeared in a published Daily race or Head-to-Head post. Removing such a
track from the catalog makes those existing records unusable. Check hosted
history and posts before permanently removing an integrated track. To stop
future Daily scheduling while retaining old races, select a Campaign series
and use **Save & Integrate** instead.

The removal confirmation is an in-page dialog, so it works in browsers that
do not support native JavaScript confirmation prompts. Dependency checks read
the current repository files only when a removal is requested; the Mapmaker
Vite configuration does not import the live track catalog, so saving a track
does not restart the local server.

## Dependency Rules

- Use `getTrackName()` for a name.
- Use `hasTrack()` to validate a track key.
- Use `DEFAULT_TRACK_KEY` for the standard local fallback.
- Use `TRACK_SCHEDULE_KEYS` when order controls Daily GP publication.
- Use `game/campaign/manifest.js` when order or fixed lap count controls the
  permanent Campaign. Every Campaign stage track is kept out of Daily; do not
  add any of them to the Daily schedule.
- Import `TRACKS` only when the caller needs boundaries, checkpoints, start
  geometry, rendering, collision, or replay validation.
- Do not put track lists back into `game/config.js`.
- Do not infer schedule order from definition filenames or object import order.

Daily GP history is append-only in Redis. Reordering `TRACK_SCHEDULE_KEYS`
changes only unpublished future days; it does not rewrite already published
challenge records.

## Validation

The regression suite checks:

- schedule keys are unique and form a valid subset of the catalog;
- the compatibility `TRACKS` registry contains every scheduled track;
- the compatibility `TRACKS` registry also contains every Campaign track;
- player-facing names match between catalog metadata and the assembled
  geometry registry;
- existing track data remains unchanged when the registry is extended;
- the full registry fingerprint matches the intentionally reviewed track set;
- every definition has usable boundaries, start data, checkpoints, and
  collision geometry;
- published Daily GP history refers only to catalog tracks;
- every catalog track has medal thresholds.
- every scheduled track has a valid Author threshold for medal calibration.

Run the focused checks:

```bash
npx vitest run \
  tests/track-runtime-integrity.test.js \
  tests/reddit-daily-gp-model.test.js \
  tests/medals.test.js \
  tests/mapmaker-track-source.test.js \
  tests/simulation-mechanics.test.js \
  tests/simulation-daily-challenge.test.js \
  tests/server-daily-gp-store.test.js \
  tests/daily-gp-store.test.js
```

Then run:

```bash
npm run build
```
