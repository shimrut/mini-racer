# Track difficulty investigation — 2026-10-04

## Finding

An automatic **estimated track difficulty** is feasible from the current
geometry and handling data. Use the finished road and its surface together;
the authoring labels alone are insufficient.

This should initially describe technical/control difficulty for one lap,
not the difficulty of earning a particular medal. Lap count, track length,
and medal targets can change challenge difficulty independently.

Investigation only: no scorer, UI, geometry, physics, storage, or tests were
changed. This document records the findings required by the repository
instructions. Evidence is from the current dirty checkout on
`codex/restore-v240-tracks`, including the existing Dirty Dancing addition.
No hosted database inventory or human driving validation was performed.

## The four proposed inputs

| Input | What is available | What the rating should measure |
| --- | --- | --- |
| Sharp–soft corners | Track-wide `cornerRadius`, optional wall-point overrides, and runtime-smoothed boundaries. | Effective turn radius/curvature along an in-lane route. Wall rounding is only one contributor. |
| Narrow–wide road | Finished inner/outer walls; new Creator records can also retain an authoring road line and section widths. | Actual local width and usable vehicle clearance, particularly sustained narrow sections and pinches within bends. |
| 90°, 180°, etc. | Boundary points and an inferred route, rather than an authoritative list of driven corners. | Heading change across a complete bend, together with its radius and spacing to the next bend. |
| Surface | A track-wide `ground` and shared handling presets. | The turn, slide, and recovery demands of that surface on this particular layout. |

`docs/track-authoring.md:98` explicitly states that Wall Corners is not the
driven turn radius. `game/track/runtime.js:30` applies per-point overrides and
limits smoothing by adjacent segment lengths. Consequently, a high global
rounding setting does not establish an easy road.

Measure turn angle as **change of driving direction**: approximately 90°
for a right-angle turn and 180° for a reversal. Group route samples into bends;
counting raw wall vertices would count curve construction points as corners.
A broad 180° sweep and a tight 180° hairpin should receive different demands.
Angle and tightness are related measurements, so avoid blindly adding two
independent penalties for the same feature.

Width should use finished race walls, rather than treating the editor's
Tight/Narrow/Normal/Wide label as a universal measurement. Those labels use drawn
vehicle artwork, while collision width is `0.55u` and capsule length is
`1.23u` (`game/config.js:37`, `docs/track-authoring.md:39`). Turning clearance
also depends on vehicle orientation and length.

Local inventory: all **168 built-in definitions** have no `roadLine` or
`drawWidth`; four have wall-point rounding overrides. New Creator records
store `roadLine` separately from the runtime track shape
(`src/server/tracks/track-store.ts:38`), and older records may lack it. A scorer
therefore needs to work from walls; requiring authoring metadata would exclude
the current built-in catalog and older stored tracks.

## Existing measurements we can reuse

`tools/mapmaker/track-flow.js:425` already:

1. Builds the same smoothed walls used by the race.
2. Reconstructs a middle path from wall geometry.
3. Measures width along local perpendicular rays.
4. Solves a smooth path within the available lane.
5. Calculates signed curvature, estimated corner speed, and steering sequences.

The related structural checker in
`game/track/authoring/track-quality.js:263` already detects crossings and
unsafe pinches. Preserve that validation before attempting a rating; invalid
geometry should not be assigned an ordinary difficulty.

However, **Flow's five pass/fail rules are not difficulty rules**. A long
straight fails the steering-frequency rule, while frequent left/right bends
help its alternation rule. Its width metric measures variation, not absolute
narrowness. A uniform narrow road and a uniform wide road can both pass.

The current flow speed model also uses base `CONFIG`, ignoring surface,
grip, angular response, yaw carry, and slide scrub. It clamps speed immediately
to each local corner limit; that is not a simulated player lap.

Read-only probes confirmed that Number Zero copied onto Dirt, Snow, Track,
Water, and Space produced **identical complete Flow reports**. Surface support
would require additional measurement/scoring work.

## Concrete geometry evidence

These are outputs of the existing approximation, **not difficulty ratings or
observed racing speeds**. Widths were obtained from its existing centerline,
normal-ray, and lane-room functions without editing the module. Corner speed
uses its base Street model even for tracks assigned another ground.

| Track | Wall rounding | Approximate median width | Approximate narrowest width | Lowest estimated speed / base top speed |
| --- | ---: | ---: | ---: | ---: |
| Number Zero | 3 | 4.62u | 3.22u | 88.4% |
| Number Eight | 3 | 4.14u | 3.20u | 37.4% |
| Desert Bridge | 0.6 | 4.94u | 3.09u | 27.2% |
| Turbo Shell | 5 | 4.00u | 3.19u | 18.8% |
| Dirty Dancing | 3 | 4.11u | 4.07u | 70.9% |
| Snow Circuit | 3 | 3.92u | 3.85u | 46.4% |

Number Zero and Number Eight demonstrate why identical rounding values are
insufficient. Turbo Shell demonstrates why a soft wall setting does not
necessarily produce broad driven corners. These measurements do not establish
the tracks' relative difficulty for players.

## Surface interaction

`game/race/simulation.js:576` resolves the selected ground and applies
acceleration, speed, grip, turn rate, steering response, high-speed trim,
yaw carry, and slide scrub. Use the current values in
`game/track/grounds.js`, rather than older handling investigation values.

There is no dependable universal ordering such as Street < Dirt < Snow:
lower speed gives more time between inputs, while lower grip and slower
turn-in/recovery change the trajectory and required timing. Track has both
higher grip and higher top speed in the current preset. Width, turn radius,
and closely spaced direction changes determine how those differences matter.

A basic geometric demand is `speed × |curvature| / available yaw rate`.
It is useful as one signal, but it does not capture lateral slide, transient
response, or the swept collision capsule. Those need surface-aware estimates
and calibration; do not present that expression as an exact physical model.

## Smallest useful approach

1. Reuse the existing geometry measurements behind a shared helper. Measure
   local widths and effective bend radii from runtime geometry, in driving order.
2. Group samples into complete bends and measure heading change, bend duration,
   and spacing between significant opposite-direction inputs. Resample by
   distance so extra construction vertices do not increase difficulty.
3. Estimate corner demand using the selected ground's speed, turn capacity,
   grip, and response/recovery. Couple narrowness to the demand in that same
   section, rather than adding unrelated track-wide averages.
4. Combine typical/sustained demand with a contribution from the hardest
   sections. Use narrow-width percentiles plus genuine pinch detection so one
   noisy sample cannot dominate and one difficult bend cannot disappear into
   an easy average. Keep length and lap count separate.
5. Calibrate **Easy / Medium / Hard** against representative human Test Drive
   results, including phone controls and the surfaces intended for release.
   Exact weights and label boundaries are not established by this investigation.

Compute once per authoritative definition/handling/scorer version and cache
the result. If shown in a lobby, expose lightweight derived metadata; avoid
loading every full track merely to obtain a rating. Stored overrides must win
over built-ins just as they do for actual racing. Rating metadata should not
change physics, medal thresholds, or replay rules.

## Limits to resolve before player-facing use

- The inferred middle pairs outer-wall samples to the nearest inner-wall point
  and smooths the result. Hairpins and closely spaced lobes need verification;
  this is not an authoritative centerline.
- Width rays stop at 8u per side, while stored authoring widths can reach 20u.
  One missed ray can silently contribute the capped distance. Widen this limit
  or explicitly reject/mark uncertain measurements.
- The path solver constrains sampled points along normals; it does not prove
  full continuous path or capsule clearance. Check ambiguous routes before
  using their curvature as a confident rating.
- A finite result is not proof of accurate geometry reconstruction or player
  difficulty. The existing analyzer produced finite metrics on all 168 local
  built-ins, but that does not validate its estimates against driving.
- Validate transformation/sampling stability, tight vs broad bends, narrow vs
  wide versions, surface differences, rapid chicanes, and stored overrides
  if implementation is authorized. Human laps should calibrate the rating;
  an automated ideal line alone cannot establish perceived difficulty.

## Validation

Read-only Node probes inspected all 168 local built-ins, exercised six sample
tracks, compared the same geometry across surfaces, and checked finite Flow
outputs across the catalog. No hosted records were queried.

Existing focused checks:

```sh
npx vitest run tests/mapmaker-track-flow.test.js tests/mapmaker-track-quality.test.js tests/mapmaker-corner-edit.test.js tests/mapmaker-ribbon-walls.test.js tests/track-grounds.test.js tests/water-space-grounds.test.js
```

Result: **96 passed, 1 failed**. The failure is the existing Dirty Dancing
addition missing medal times at `tests/track-grounds.test.js:341`. No production
or test changes preceded the run, and the asset-generation hook left no Git
diff. The unrelated WIP was preserved.
