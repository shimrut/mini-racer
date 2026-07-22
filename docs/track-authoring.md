# Track Authoring

## Purpose

Mini Racer separates lightweight track metadata from full race geometry.
This keeps names, validation, and Daily GP scheduling available without making
every consumer load the large geometry registry.

## Track Files

- `game/track/catalog.js`
  Owns each track's player-facing name, `TRACK_SCHEDULE_KEYS`,
  `DEFAULT_TRACK_KEY`, `hasTrack()`, and `getTrackName()`.
- `game/track/definitions/<track-slug>.js`
  Owns one track's boundaries, start position, start line, checkpoints, and
  geometry-specific options.
- `game/track/tracks.js`
  Assembles definition modules into the compatibility `TRACKS` registry.
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

Brush presets also show approximate car widths. Default brush `4u` is about
**7 car-widths** across. Lanes under about `3u` (~5.5 cars) feel very tight;
`4u`–`5u` is the usual racing band.

Curve Radius controls wall corner smoothing, not the driven turn radius.

## Adding A Track

1. Build and validate the layout in `tools/mapmaker.html`.
2. Run `npm run mapmaker`, open
   `http://127.0.0.1:5173/tools/mapmaker.html`, and choose
   **Save & Integrate**. It writes the definition module and updates
   `TRACK_CATALOG`, `TRACK_SCHEDULE_KEYS`, the static definition imports, and
   the compatibility registry.
3. New tracks are appended as the final `TRACK_SCHEDULE_KEYS` entry by default.
   Existing tracks keep their position. Renames replace the old key at its
   existing position after confirmation and remove the old definition file.
4. Add medal thresholds in `game/medals/medal-times.json`.
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
- Import `TRACKS` only when the caller needs boundaries, checkpoints, start
  geometry, rendering, collision, or replay validation.
- Do not put track lists back into `game/config.js`.
- Do not infer schedule order from definition filenames or object import order.

Daily GP history is append-only in Redis. Reordering `TRACK_SCHEDULE_KEYS`
changes only unpublished future days; it does not rewrite already published
challenge records.

## Validation

The regression suite checks:

- catalog and schedule keys stay aligned;
- the compatibility `TRACKS` registry contains every scheduled track;
- player-facing names match between catalog metadata and the assembled
  geometry registry;
- existing track data remains unchanged when the registry is extended;
- the full registry fingerprint matches the intentionally reviewed track set;
- every definition has usable boundaries, start data, checkpoints, and
  collision geometry;
- published Daily GP history refers only to catalog tracks;
- every catalog track has medal thresholds.

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
