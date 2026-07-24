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

Mapmaker draws a ghost car using the real race collision size
(`0.55u` wide × `1.23u` long):

- always at the start position
- under the cursor while Line Build is active

Brush size is fixed at `4u`, about **7 car-widths** across. That is the
usual racing lane width for Line Build.

Wall Corners controls how rounded wall corners look in race
(Sharp, A bit rounded, Rounded, Soft). It is not the driven turn radius.

Start line and checkpoint edits snap across the lane, stay perpendicular
to the nearer track wall, and extend a bit past both walls so wall-hugging
cars still trigger them.

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
   Renames replace the old key at its existing position after confirmation
   and remove the old definition file. Campaign-only saves never add the
   track to the Daily schedule; wiring stages still happens in
   `game/campaign/manifest.js`.
4. Add medal thresholds in `game/medals/medal-times.json`.
   The Author threshold is also the Daily GP lap-band input: author times over
   10.95 seconds allow 1–2 laps; author times at or below 10.95 seconds allow
   1–3 laps. Missing or invalid Author times conservatively publish as one lap.
5. Add or adjust `game/track/presentation.js` only when the track needs a
   non-default preview or race presentation.
6. Update the intentional full-registry fingerprint in
   `tests/track-runtime-integrity.test.js`. Preserve the preceding registry
   fingerprint as a subset assertion so adding a track cannot hide changes to
   existing track geometry.
7. Run the track, Daily GP, medal, simulation, Mapmaker, and build checks.

The repository-writing endpoint exists only in the dedicated local Mapmaker
Vite configuration and accepts requests only from localhost. It is not part of
the Devvit playtest or production build. **Download Module**, **Copy Module**,
and **Copy Integration** remain available as manual fallbacks.

## Dependency Rules

- Use `getTrackName()` for a name.
- Use `hasTrack()` to validate a track key.
- Use `DEFAULT_TRACK_KEY` for the standard local fallback.
- Use `TRACK_SCHEDULE_KEYS` when order controls Daily GP publication.
- Use `game/campaign/manifest.js` when order or fixed lap count controls the
  permanent Campaign. Do not add Campaign-only tracks to the Daily schedule.
- Import `TRACKS` only when the caller needs boundaries, checkpoints, start
  geometry, rendering, collision, or replay validation.
- Do not put track lists back into `game/config.js`.
- Do not infer schedule order from definition filenames or object import order.

Daily GP history is append-only in Redis. Reordering `TRACK_SCHEDULE_KEYS`
changes only unpublished future days; it does not rewrite already published
challenge records.

## Validation

The regression suite checks:

- schedule keys are a valid subset of the catalog;
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
- every scheduled track has a valid Author threshold so its multi-lap eligibility is intentional.

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
