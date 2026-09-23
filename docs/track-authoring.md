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
  including Campaign-only tracks that are not in the Daily schedule.
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
   - **Campaign only** keeps the track out of the Daily schedule.
3. New Daily Challenge tracks are appended as the final
   `TRACK_SCHEDULE_KEYS` entry. Existing Daily tracks keep their position.
   When extending an existing branch, keep the existing catalog and schedule
   prefixes in their original order, then append new catalog and Daily entries.
   Renames replace the old key at its existing position after confirmation
   and remove the old definition file. Campaign-only saves never add the
   track to the Daily schedule; wiring stages still happens in
   `game/campaign/manifest.js`.
4. Add medal thresholds in `game/medals/medal-times.json`.
   New Daily GP publication selects 1–2 laps when Author time is under 10s,
   and one lap at or above 10s. Missing or invalid Author times conservatively
   publish as one lap. Campaign lap counts are declared separately in
   `game/campaign/manifest.js` and may remain 1, 2, or 3.
5. Add or adjust `game/track/presentation.js` only when the track needs a
   non-default preview or race presentation.
6. Update the intentional full-registry fingerprint in
   `tests/track-runtime-integrity.test.js`. Preserve the preceding registry
   fingerprint as a subset assertion so adding a track cannot hide changes to
   existing track geometry. The current approved fingerprint includes the
   intentional Mistfall Circuit outer-boundary shape committed in `c4da688`,
   plus the appended Daily tracks through Shark Bite.
7. Run the track, Daily GP, medal, simulation, Mapmaker, and build checks.

The repository-writing endpoint exists only in the dedicated local Mapmaker
Vite configuration and accepts requests only from localhost. It is not part of
the Devvit playtest or production build. **Download Module**, **Copy Module**,
and **Copy Integration** remain available as manual fallbacks.

## Removing A Track

**Remove Track** in the local Mapmaker discards a new, unsaved track from the
editor. For an integrated track, it asks for confirmation and removes the
definition module, catalog entry, Daily schedule entry, registry import, and
medal-times row. The repository operation refuses the default track, tracks
used by Campaign stages, and tracks named in the fixed published Daily GP
backfill. Review any track-specific presentation or test references before
shipping a removal.

The local Mapmaker cannot query hosted Redis or Reddit to determine whether a
track appeared in a published Daily race or Head-to-Head post. Removing such a
track from the catalog makes those existing records unusable. Check hosted
history and posts before permanently removing an integrated track. To stop
future Daily scheduling while retaining old races, select **Campaign only**
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
  permanent Campaign. Every `numbered-v1` stage track is Campaign-only; do not
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
