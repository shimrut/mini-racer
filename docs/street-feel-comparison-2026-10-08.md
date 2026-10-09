# Street feel comparison and manual previews — 2026-10-08

## Request and historical baseline

The user identified the September 24 Claude exchange asking whether physics
changed because the drawn cars felt more integrated with the game. They now
report a grippier Street feel and requested a check of the changes and whether
both versions can be driven manually in separate browsers.

**Current user scope: Legacy skins only, on Street only, with keyboard input.**
Drawn Formula animation findings and other-ground effects below are separate
historical/background findings and are excluded from the Legacy/Street cause
assessment. Reporting them as candidates for the user's captured difference
went outside the requested scope.

The old playable baseline is `cf7773e1` (September 24, 00:07 Europe/Bucharest),
before drawn-car runtime wiring and grounds. The exact last commit before
ground introduction is `6a798ee8`; its simulation and playable car renderer
match this baseline. Commit `22bfe021` on September 25 added grounds and wired
the drawn cars into the race. The September 24 discussion ran uncommitted work;
the available Git snapshots do not preserve its exact intermediate state.

The current comparison uses the working checkout, based on `36d44bbf` plus its
existing uncommitted work. None of that work was reset or rewritten.

## Findings

- Street driving is unchanged when geometry and steering inputs match. The
  historical simulation and current simulation produced **zero differences
  over 147,206 frames on 156 current Street layouts**, including 1,266 wall
  impacts. This compares driving state and race events, not human perception.
- `game/car/handling.js` keeps grip `4.3`, steering grip `0.97`, downforce grip
  `0.72`, angular response `22`, and the remaining original tuning. The Street
  preset in `game/track/grounds.js` scales driving values by `1`, with yaw carry
  and slide scrub `0`.
- Camera math, car-body orientation/interpolation, 60 Hz simulation stepping
  and stall limits remain unchanged.
- Touch input changed September 27 in `216176a8`: finger sets and cleanup of
  a previously lost release replaced the earlier pointer flag. A new touch can
  clear a stuck turn sooner. This is a real control change, but has not been
  established as the cause of the reported grippier feel. Keyboard steering
  remains unchanged.
- The drawn car adds animated front wheels, rolling tyres and brake lights.
  Rendering and raster caching have changed. These can affect perceived feel
  or device timing, but they are outside the clarified Legacy/Street scope and
  were not active in the user's captured runs.

## Manual previews

Both local Vite servers were started and left running for the user:

| Version | URL |
| --- | --- |
| Old, `cf7773e1` | <http://127.0.0.1:5186/pages/game.html?mode=daily&mockDaily=circuit&mockLaps=1> |
| Current working copy | <http://127.0.0.1:5187/pages/game.html?mode=daily&mockDaily=circuit&mockLaps=1> |

Classic Circuit (`circuit`) has an identical definition in both versions and
is a Street track. Separate ports keep browser storage/preferences separate;
separate browsers are also possible. These loopback URLs work on this Mac.

For a controlled check:

1. Use the same browser and window size initially. Fresh storage on both ports
   selects the same stock Red raster car. If a preference was changed, choose
   Red in the old Garage and the matching Red car under Legacy in the current
   Garage. Match restart, ghost, audio and other settings.
2. Compare steering holds, short taps and release from a corner. `R` restarts.
   Keep the other preview paused while driving so two render loops do not
   compete for the same device resources.
3. In the current Garage choose Street's Formula car, then repeat. This changes
   the visual model while retaining the same driving rules.
4. If using different browsers, swap which version each browser runs before
   attributing a difference to the game version rather than browser timing.

These are local driving previews. The static servers have no Reddit/Redis
backend: Daily uses the existing `mockDaily` fallback; online standings,
analytics and Campaign warmup requests return 404. The current version logs
its failed background Campaign warmup. No exception blocked Daily starting or
steering, and no hosted rankings were written. This is not physical-phone or
hosted Reddit evidence.

The old source and temporary Vite configs are under
`/private/tmp/dailygp-street-ab-20261008`. The current server reads the live
checkout, so subsequent edits appear in that preview. No game implementation
was changed to create the previews.

## Validation and reproduction

- 22 existing focused tests pass: 14 tarmac golden-time checks, three camera
  checks and five stall checks.
- Both local previews load the matched track, start and move, and respond to
  keyboard steering. Headless Chromium screenshots were inspected.
- The standard web-game client ran steering bursts on both versions; its
  screenshots and `render_game_to_text` state were inspected. This browser
  smoke check is not a deterministic old/current timing comparison.
- Exact simulation comparison:
  `/private/tmp/dailygp-street-feel-audit-2026-10-08/probe.mjs` and `result.json`.
  Run from the repository with
  `node /private/tmp/dailygp-street-feel-audit-2026-10-08/probe.mjs`.
- Browser evidence:
  `/private/tmp/dailygp-street-ab-20261008/initial-browser-results.json`,
  `old-driving.png`, `current-driving.png`, `old-game-client/` and
  `current-game-client/`.

The specific cause of the user's perceived grippier feel remains open for the
manual comparison. No handling fix, deployment or Git publication was made.

## Manual comparison follow-up

The user drove both previews and reported that the previous version feels a
little more slippery. Treat this as a reported difference in live driving feel;
the deterministic simulation comparison does not establish equal input latency
or frame presentation on the user's browser.

A read-only inspection of the two in-app browser tabs found matching canvas
dimensions (1584 by 1532 backing pixels), sound and music enabled, PB ghost
enabled, HUD visible, and collision auto-restart disabled. Current Quick Restart
was also disabled. Neither run was restarted or altered by the inspection.
The equipped car could not be confirmed from the hidden, unpopulated Garage or
the blurred finish-screen canvas, so the same Red/Legacy car remains a useful
manual control. The user subsequently confirmed keyboard steering and asked
for both manual playthroughs to be recorded and compared.

Further source inspection found no change to `SteeringInput`, the ordinary
keyboard steering path, the fixed-step accumulator, or the default Street skid
threshold/style. A keyboard reproduction would therefore need live input and
frame-timing measurement before assigning a cause. The touch-control change is
a candidate only for touch input, so it does not explain this keyboard report.
No cause is confirmed yet.

## Live keyboard recording

On the user's request, both temporary Vite configs now load a shared diagnostic
plugin from `/private/tmp/dailygp-street-ab-20261008/capture-plugin.mjs`. It wraps
the served simulation and development hooks without editing either game's
source or handling. Runtime code is in `capture-runtime.mjs` in the same folder.
Both user tabs display a small `OLD/CURRENT recorder: ready` label.

- A run records steering key down/up events and timestamps, the actual key
  state consumed by every 60 Hz simulation step, full-precision motion before
  and immediately after physics, wall/checkpoint events, RAF intervals and CPU
  rendering durations. Metadata captures the actual equipped car and viewport.
- Only steering keys are recorded. The snapshot omits account identifiers,
  tokens and arbitrary browser storage. On finish or restart, recordings are
  saved through the same loopback server to `recordings/*.json` in that temporary
  folder. Nothing is sent to a hosted service.
- The user needs to drive fresh runs; earlier playthroughs cannot be recovered
  with these timestamps. Completing a run or pressing `R` saves it. Pauses and
  tab changes are logged. Diagnostic snapshots add small CPU/allocation work to
  both versions; rendering durations are CPU measurements, not screen latency.
- `/private/tmp/dailygp-street-ab-20261008/analyze-manual-runs.mjs` replays each
  recording's own geometry, config and consumed inputs through both historical
  and current physics. It distinguishes motion parity from key-to-next-step
  delay, frame pacing and observed slip. Different human steering histories
  cannot establish a handling change just from different lap times or paths.

Validation used a separate in-app-browser tab marked `captureSource=validation`:
both previews recorded ArrowLeft/Right holds and released keys, then saved
successfully on `R`. The verifier checked 657 old and 902 current simulation
steps. Old/current predictions matched exactly; logged browser motion matched
both within `1e-9` (largest numerical discrepancy `3.55e-15`). These validation
captures are distinct from user playthroughs and are not evidence of the user's
reported feel. The additional test tab was closed; both user tabs remain armed.

Run the analyzer from the checkout with:

```sh
node /private/tmp/dailygp-street-ab-20261008/analyze-manual-runs.mjs
```

Its detailed output is `manual-run-analysis.json` in that same temporary folder.

## Recorded human takes and conclusion

The user completed three old takes and four current takes, including sustained
donuts. The recorder saved all seven as `human-keyboard`, separately from the
two validation recordings. These contain **2,725 simulation steps** (1,134 old,
1,591 current), and **144 non-repeat steering transitions** (56 old, 88 current).

Each recording was replayed through both historical and current simulation
using its own initial state, geometry, config and exact per-step inputs:

- **Zero old/current motion differences**, including pose, velocity, yaw,
  race/checkpoint state and wall events. Each replay also matches its recorded
  browser motion within `1e-9`; the largest browser/Node numerical discrepancy
  is `9.95e-14`, with no external-state resync needed.
- All seven takes use identical track/config/environment metadata: Classic
  Circuit, stock Red raster car (`assets/cars/mr_mr_red.webp`, `drawnCar=false`),
  viewport 675 by 766 at DPR 2, and the same browser/camera mode. Thus drawn-car
  appearance does not explain the difference reported during these takes.
- All 144 key-state changes were consumed by a later simulation step. No key
  changes were overwritten before sampling, and no release was lost in the
  recordings. Repeated keydown events during holds did not alter steering.

| Observed metric | Old | Current |
| --- | ---: | ---: |
| Key-handler to next simulation step, median | 13.25 ms | 14.20 ms |
| Same delay, p95 | 26.25 ms | 31.69 ms |
| Same delay, maximum | 32.80 ms | 32.40 ms |
| Key release to next step, median | 12.40 ms | 11.95 ms |
| RAF interval, median | 16.70 ms | 16.70 ms |
| RAF interval, p95 | 17.30 ms | 17.40 ms |
| RAF interval, maximum | 17.70 ms | 17.70 ms |
| CPU car/track render time, median | 0.20 ms | 0.20 ms |
| CPU car/track render time, p95 | 0.30 ms | 0.30 ms |
| Stable donut speed, last 30 steps median | 126.801 km/h | 126.804 km/h |
| Stable donut slide angle magnitude, same samples | 38.836 degrees | 38.834 degrees |

The stable donut comparison uses the long, wall-free right-steering segment in
the third take of each version. Holds lasted approximately 3.97 and 5.40 seconds.
The current third take also has an earlier wall-interrupted turn, which is
excluded from the steady-donut comparison. Different hold durations and
entry states explain tiny remaining differences in the sampled endpoints;
the cross-replays themselves are exact.

There are no recorded RAF stalls above 33 ms. The modest differences in key
latency percentiles are descriptive for these seven human takes and their
frame alignment, not proof of a version-dependent latency regression. They
measure browser software response, not keyboard hardware or compositor/display
latency. These measurements also include identical recorder overhead.

A separate reconstruction of the live key state found zero mismatches in all
2,725 frames. Every input-delay tail above 24 ms (nine old, eleven current)
coincides with the next RAF having no simulation step and the subsequent
catch-up step; this is shared fixed-step timing, with no detected missed key
or version-specific frame stall. The shortest captured tap, 44 ms in an old
take, was still sampled. No focus/visibility changes occurred during the takes.
The first eight neutral steps after the donut release also match closely:
maximum speed difference `0.0032 km/h`, slip-ratio difference below `0.000005`.
The old take then countersteers, so the remaining neutral recovery durations
cannot be directly compared between those two human input histories.

**No increased Street grip or altered slide recovery is demonstrated in the
tested builds.** The historical code produces the same current take, and the
current code produces the same historical take, when fed the recorded inputs.
The user's perceived extra slipperiness remains unexplained by these captures;
it should not be dismissed as imagined or assigned to drawn visuals. The exact
uncommitted September 24 implementation remains unavailable in Git.

Evidence: `old-muzgf87c-1.json`, `old-muzgfdsq-2.json`, `old-muzgfj3x-3.json`,
`current-muzgfu63-1.json`, `current-muzgfzbp-2.json`, `current-muzgg4fh-3.json`,
and `current-muzggepf-4.json` under the temporary `recordings/` folder above.
The analyzer was rerun after all seven saves; docs-only whitespace validation
passed. No gameplay tuning, deployment, commit or push was made.
Independent input/release evidence is in `check-human-runs.mjs` and
`human-run-targeted-check.json` under the same temporary comparison folder.

## Visual comparison follow-up

The user asked whether the difference could be visual. Both actual tabs have
matching canvas scaling, with no CSS filter or transform and full opacity.
Their captured quality level, frame skip, trail colour and legacy Red car match.
The Red WebP files are byte-identical; both versions draw the sprite in a
52-by-52 world-pixel box, or 39-by-39 CSS pixels at the captured 0.75 camera zoom.
Camera interpolation, Street skid thresholds/style and track-layer scaling
also match in the inspected source.

`/private/tmp/dailygp-street-ab-20261008/compare-rendering.mjs` replays the same
recorded old donut through each version's simulation and actual race renderer,
using each version's geometry, presentation, track canvas and layer renderer.
The independently built Circuit canvases have **zero differing pixels**.
Eight paired 1350-by-1532 snapshots also have **zero differing pixels**, from
turn entry through sustained donuts, release and countersteering. The paired
steady-donut images were inspected. Car, shadow, camera, skids and route trace
match in this controlled comparison.

This is source-render evidence using a shared Node `@napi-rs/canvas` backend,
fixed render timing and interpolation alpha 0.5. It does not reproduce actual
browser/compositor output, input-to-screen latency or DOM HUD overlays. Random
wall particles are absent in the selected wall-free take. The identical track
engine adapter was reproduced locally because its module imports Vite-only
registry code; the actual old/current layer renderers remain unmodified.
Results, paired PNGs and full method/limits are under `matched-rendering/` in
the same temporary comparison folder.

No changed visual cue was found for the tested Legacy-car Street comparison.
The new drawn Formula cars do add moving front wheels, rolling tyres and brake
lights; those could plausibly change perceived grip or integration in the
original September 24 exchange, but they were not active in these captures.
Neither explanation is established as the cause of the user's current report.

Two more human takes saved during this follow-up bring the replay total to
nine takes and **3,321 simulation steps**. Rerunning `analyze-manual-runs.mjs`
still finds zero old/current differences. The seven-take timing table above
describes the original completed comparison and is not silently recomputed
from these later takes. No gameplay source, browser settings or car selection
was changed for the visual probe.

## Shadows, added visuals and indirect consequences

The user requested a deeper review of shadow differences, added/removed
visuals and unintended effects of surrounding code changes.

### Shadow and active-path findings

- **Legacy on Street:** no change to the shadow. `game/config.js:42-45`
  retains black at alpha 0.75, blur 2, offsets 0/0. The renderer still applies
  it only at `qualityLevel <= 0`. Street has no presentation shadow override.
  The same car silhouette and draw size are used in the captured runs.
- **Other grounds:** Dirt/Snow gained their own shadow values in the first
  grounds commit, `22bfe021`; Water/Space later gained other values. The current
  renderer reads those overrides before falling back to the unchanged config.
  These override branches are not active on Street.
- **Drawn Formula:** adds a new silhouette/material rendering, steering front
  wheels, rolling/blurred tyre grooves, deceleration brake light and red ground
  glow. The ground glow uses its own saved/restored canvas context; it does
  not leave a filter, alpha or composite mode behind for the rest of the race.
  Wheel animation reads the latest steering keys, while body orientation uses
  the shared interpolated physical angle. Thus the new car supplies additional
  steering/braking cues without changing the driving body.
- **Drawn-frame caching:** moving car artwork repaints at most once per
  1/40 second (typically every second frame at 60 Hz), or 1/15 second in low
  quality. Body movement is still rendered each frame. This optimization was
  already present in `22bfe021`; the September 24 saved session also records
  a choppiness report and subsequent drawn-car raster/repaint optimization.
  Those historical measurements do not establish a current frame-time issue.
- **Ground effects:** tyre ruts, dust/snow/water spray and scrape debris were
  added for other surfaces. `recordGroundEffects` returns without producing
  these effects on the default Street presentation (`ground-effects.js:274-285`).
  Street skid colour, width, spacing and threshold retain the original values.

Camera extraction, geometry/cache preparation and background mode loading were
also reviewed. Camera math, narrow-viewport threshold, frame accumulator,
60 Hz physics stepping, rendering interpolation and stall limits retain their
old behavior. New track-specific corner radii can change geometry when a point
explicitly carries that property; the captured Circuit geometry/config match.
Race asset caches now include definition identity rather than only track key.
Those preparation/cache changes do not change the captured live motion.
Tarmac engine/squeal and music defaults remain the original values; additional
ground audio is selected for the other surfaces.

Two further appearance/selection paths were checked. Asset-load failure can
retain the previous artwork/model; retaining artwork predates grounds, and no
such failure appears in the captures. Garage's Street cosmetic preview can
show Formula while Legacy is equipped, and selecting paint, decal or trail
equips that preview skin. This is a documented selection behavior, not a
physics change; all captured takes remained Legacy. Static preview and Garage
callers were checked for interference with the race's cached mutable drawn
animation object, with no observed caller advancing or resetting it.

### Rendering with the actual recorded cadence

`/private/tmp/dailygp-street-ab-20261008/compare-render-cadence.mjs` extends the
earlier snapshot check with the old donut's recorded RAF intervals, simulation
step grouping and accumulator interpolation. It runs each version's actual
renderer, invokes current ground effects after simulation, and asserts that
rendering preserves physics-bearing state. It compares full-canvas pixels
after every driving render, including frames with no physics step and frames
with two steps.

All four checked branches pass: captured normal Legacy/Street settings,
Path2D fallback, low-quality/frameSkip, and desktop camera mode. Each branch
compares **545 driving renders**, including **141 zero-step renders** and
**140 two-step renders**, with alpha spanning approximately 0 to 0.998.
There are **zero differing frames and zero checked driving-state mutations**.
The static Circuit canvas also matches in every case. The normal-cadence PNG
was inspected. Results and method are in the temporary `cadence-rendering/`
folder. The three extra branches are hypothetical checks, not user settings.

The probe still uses a shared Node canvas backend and camera look-ahead starts
at zero in both versions. It does not measure live compositor presentation,
HUD/CSS overlays, actual browser resource contention or input-to-screen latency.
The selected run has no wall impacts, so random sparks are outside this probe.

### Confirmed drawn-car animation issue

A specific unintended visual effect is reproducible in the drawn Formula
brake animation. `engine-methods.js:1055-1064` passes the latest physics speed
and render-frame `dt` into `DrawnCar.update`. `drawn-car.js:144-150` computes
deceleration from those two render samples. When one render has zero physics
steps and the next catches up two steps, the speed change for two physics
steps is divided by one render interval. This can cross the brake threshold
even when every individual physics step is below it, triggering or extending
the brake light and its red ground glow.

The exact current animation code was tested in
`/private/tmp/dailygp-street-ab-20261008/check-drawn-cadence.mjs`:

- Constant physical deceleration 45 km/h/s is below Formula's 60 km/h/s brake
  threshold. One physics step per render leaves the brake off in all 30 frames.
  Alternating zero/two steps at the same 60 Hz produces an apparent 90 km/h/s
  slowdown and a positive brake animation in 29/30 frames, reaching full light.
- Feeding the nine actual recorded speed/cadence histories into Formula's
  animation produces 25 false-threshold candidates (15 current histories,
  10 old histories). Example current take 1, RAF 204: physical decelerations
  are 38.43 and 57.76 km/h/s, but the animation sees 95.43 km/h/s.
- This latter check is **counterfactual Formula animation**, not evidence that
  the user's car showed a false brake light: all nine captures use Legacy Red
  with `drawnCar=false`. It demonstrates that the susceptibility occurs under
  the observed frame cadence if a drawn Formula is selected. It does not alter
  position, velocity, grip or slide recovery.
- The same render-sampled brake math is present in the first grounds runtime,
  `22bfe021`, and the original drawn-car implementation. It is not evidence of
  a recent Street handling change. It is a credible additional visual cue for
  the historical drawn-car feel, without proving causation.

Detailed results are in `drawn-cadence-check.json` in the same temporary folder.
The diagnostic assertions pass. Existing focused validation also passes:
**114 tests across eight files** for grounds, effects, sprite loading, drawn
cars, trails, audio, camera and stalls. No regression expectations were edited.
The Vitest asset-generation hook produced no tracked asset changes. No game
implementation was changed; the discovered visual issue remains unfixed in
this read-only investigation.

## Clarified Legacy-only Street conclusion

All **23 Legacy WebP assets** in the selectable-asset manifest were compared
against the old preview: their bytes are identical, with zero changed assets.
The manifests also match. The exported legacy image-sanitization function has
identical source in both versions. Evidence is in the temporary
`legacy-assets-check.json` file; this extends asset coverage beyond the Red
skin used in the captured driving/rendering comparison.

For this scope, no changed car shadow, artwork, draw size, body interpolation,
camera behavior, Street skids or driving response has been identified.
The previously documented exact physics and matched rendering results apply
to the captured Legacy Red/Street runs. They do not measure compositor or
input-to-screen latency.

There are code changes around the Legacy path: sprite loading/cache management
was extended, camera/skid helpers were extracted, and trails can now be stored
per car instead of only globally. Legacy loading still calls the same image
sanitizer and draws at the same size. Per-car trails fall back to the original
global preference; a saved per-car override can change a Legacy car's trail.
Both recorded versions have the same Sky trail, so that changed preference
behavior did not produce a visual difference in these takes. No resulting
driving-state or measured frame-pacing regression was found.

The cause of the reported Legacy-on-Street slipperiness difference remains
unconfirmed. Drawn-car brake/wheel findings are not an explanation for it.
No gameplay source or user settings were changed for this scope correction.
