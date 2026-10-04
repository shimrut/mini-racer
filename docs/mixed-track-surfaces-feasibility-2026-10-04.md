# Mixed surfaces within one track — feasibility, 2026-10-04

## Scope and conclusion

This investigation concerns several surfaces within the same lap, such as
Street → Dirt → Street. Campaign stages using different whole-track grounds
are a separate, existing feature. No gameplay implementation was requested or
performed. Existing track and physics work in the dirty checkout was preserved.

The change is moderate in complexity. Shared physics and existing surface
presets provide a useful foundation; authoring, rendering and persistence are
the larger part. A rough engineering estimate is 1–2 working days for a
prototype with manually defined areas, and 4–7 working days total for a usable
Mapmaker/Creator flow, replay checks, effects and regression validation. These
are estimates from code inspection, not delivery commitments. They assume
existing land surfaces and one vehicle for the entire race.

## Smallest useful design

- Keep `ground` as the base surface and vehicle choice. Add an optional bounded
  list of surface areas, for example `surfaceZones: [{ ground, polygon }]`.
- Show **Mixed** when a track contains different effective surfaces. It is a
  display/authoring label; it does not need a new physics preset with its own
  multipliers.
- Use a shared resolver that samples the car's center in world coordinates
  once per physics step. Define edge membership and overlap priority explicitly
  and identically on the client and server. A small number of bounded polygons
  can use cached bounding boxes plus point-in-polygon checks initially.
- Draw area colors/textures clipped to the road, with the same overlap order
  as the resolver. Use the local ground for handling and tyre effects/audio;
  keep the vehicle, engine character and music fixed for the race initially.
- Add a simple area tool to the editor. A later section tool can generate the
  same polygons. Runtime tracks contain outer/inner walls rather than a stored
  centerline; percentage-based sections would add projection/geometry work.

The recommended initial scope is Street, Dirt and Track, with Snow supported
when its availability is intentionally enabled. Water and Space use different
vehicles and need an additional design decision about vehicle transformations
or a vehicle that can cross those surfaces. They increase the scope.

## Current code and required changes

| Area | Evidence and implication |
| --- | --- |
| Physics | `game/track/grounds.js:132` resolves a single track ground; `game/race/simulation.js:576` reads it on every simulation step. Replace that selection for tracks with areas, using the same shared code for replay validation. Existing tracks should retain their exact path. |
| Transitions | `game/race/simulation.js:667-673` clamps velocity immediately to the active ground's speed limit. A probe at Street top speed (310 km/h) using Dirt produced 269.7 km/h after one 16.7 ms step. Decide a controlled slowing rule for mixed tracks rather than accepting that abrupt transition. Grip switching and boundary behavior also need Test Drive acceptance. |
| Rendering | `game/track/canvas.js:1199-1200` fills/textures the entire road with one presentation. `game/track/preview-renderer.js:353` and `:498` also draw one presentation. Add clipped area drawing to the race, editor, previews and exported/share images. Keep static road work in the existing canvas cache. |
| Effects | `game/race/ground-effects.js:274` emits effects using one presentation, and `:392` draws the tyre history using one style. Store enough style information to preserve older marks/particles across transitions; changing a global presentation would recolor or hide history. Skid thresholds also need the local ground. |
| Vehicle/audio/HUD | `game/track/engine-methods.js:262-269` configures a track's HUD and car; `game/race/engine-methods.js:1320-1324` feeds track ground to music. Separate the race's vehicle/theme from local tyre feedback and speed-limit display. |
| Persistence/export | `src/server/tracks/track-shape.ts:95-113` whitelists track fields; `tools/mapmaker/track-source.js:156` emits existing geometry fields. Add bounded area validation and preserve areas through Creator saves, local export, copying, draft recovery and conflict comparison. |
| Authoring transforms | `tools/mapmaker/road-build.js:63` moves track geometry; `tools/mapmaker.js:1926` copies moved fields. Areas must move with geometry and survive undo/rebuild. `src/server/tracks/track-shape.ts:128-130` documents that the editable road line is separate from runtime walls. |
| Identity/replays | `src/server/competition/replay-validator.ts` reuses the shared simulation and authoritative track, so steering replay payloads need no surface field. Include canonical area data in `src/server/competition/pb-ghost-trace.ts:91` and `game/track/definition-identity.js:11` so ghosts, Head to Head and cached assets recognize the changed race. Preserve existing identities when areas are absent. |
| Metadata/admission | `src/server/tracks/track-store.ts:131` reports one ground today. Catalog/menu summaries and Daily admission need the complete set of included surfaces. `game/track/live-grounds.js:7` currently enables Street, Dirt and Track for Daily. |

New mixed layouts should use new track identities. Adding areas to an already
raced layout changes its race rules. Existing Creator locking and placement
fences should continue to apply. Existing single-surface tracks need no data
migration when the new area field is optional and absent from their identities.

## Validation needed for implementation

1. Existing single-surface simulation results and identities remain unchanged.
2. Areas survive export, save/reload, copy, translation, road rebuild and undo.
3. Exact edges, overlapping areas, reverse crossings, restart and multi-lap
   wraparound resolve consistently.
4. Client driving and authoritative replay checks agree for repeated crossings.
5. Area changes invalidate previews, prepared tracks, ghosts and race contracts.
6. Test Drive verifies slowing, grip transitions, readable surface boundaries,
   retained tyre history and tyre audio; local tests alone do not establish feel.
7. Daily admission checks all included surfaces and preserves held-back grounds.

Investigation evidence includes source inspection and the read-only speed-limit
probe above. `npx vitest run tests/track-grounds.test.js` produced 28 passes and
one failure: the existing uncommitted `dirtyDancing` track has no medal times.
The passing checks include uniform-ground client/server replay agreement on
Dirt, Snow and Track. No mixed-track implementation or hosted playtest exists
from this investigation; these tests do not validate the proposed area model.
