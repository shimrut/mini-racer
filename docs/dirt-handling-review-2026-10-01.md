# Dirt handling review — 2026-10-01

**Historical preset review.** The dirt settings below have since changed. See
[the October 3 investigation](dirt-slide-control-investigation-2026-10-03.md)
for current values and the reproduced slowdown after steering release. The
"reasonable arcade starting point" assessment below was not supported by a
human driving audition and must not be treated as acceptance of the feel.

Scope: assess the current local dirt settings for Mini Racer. This review does
not change driving settings, tests, or race rules. The pre-existing edit in
`game/track/grounds.js` changes dirt acceleration from 0.65 to 0.6 and maximum
speed from 0.9 to 0.85; this review evaluates those working-tree values.

## Assessment

The dirt preset is a reasonable arcade starting point. Lower grip, a slower
exit recovery, and modestly lower top speed distinguish it from Street. The
most questionable part is combining weaker turning (`turnRate: 0.8`) with a
much slower steering response (`angularResponse: 0.6`). This makes brief
steering inputs less effective, even though sustained corners slide more.

Mini Racer is a top-down, steering-only time-trial game with automatic
acceleration (`LP/about.html:131`, `game/race/simulation.js:576`). Real gravel
driving uses limited traction, weight transfer, rotation on entry, and a
straight exit before acceleration. Players here cannot lift the throttle or
brake to produce that rotation. My design recommendation is to convey dirt
through a predictable separation between the car's heading and its path,
while retaining enough steering response to initiate and catch a slide.
Persistent large drifts or uniformly weak steering are not required.

## Current settings and their effects

All values below are multipliers except `yawCarry` and `slideScrub`.

| Setting | Dirt | Assessment for this game |
| --- | ---: | --- |
| `accel` | 0.6 | A substantial relative reduction. Reasonable for differentiation, but it also prolongs recovery after corners and wall scrapes. |
| `maxSpeed` | 0.85 | A defensible arcade speed cap: 263.5 displayed km/h versus Street's 310. These are game-scale numbers, not realistic rally specifications. |
| `grip` | 0.8 | Sensible: less lateral damping leaves momentum in the old direction longer. |
| `steerGripScale` | 0.75 | Sensible with the grip setting: about 60% of Street's lateral damping while steering, compared at the same fraction of each surface's top speed. Releasing steering raises dirt's damping by about 37%, helping recovery. |
| `turnRate` | 0.8 | Questionable: reduces the strength of the player's only driving control by 20%. |
| `angularResponse` | 0.6 | Main tuning concern: delays both turn-in and reversal. Some delay adds anticipation; this amount combined with weaker turning can feel heavy. |
| `highSpeedSteerTrim` | 1 | Keeps the existing speed-dependent steering reduction. No evidence here that dirt needs more reduction. |
| `yawCarry` | 0 | Reasonable. Dirt already continues rotating briefly after release because of angular smoothing; zero disables only the additional carry behavior. |
| `slideScrub` | 0 | Reasonable starting point. Lateral damping already dissipates speed during a slide, so zero does not mean sliding is free. |

The simulation prescribes yaw from steering and damps the velocity component
perpendicular to the car. It does not calculate separate front/rear tire
forces, wheelspin, suspension, or weight transfer. This is an arcade
approximation of loose-surface behavior, not physical rally oversteer.

## Numerical evidence

Probes use the actual shared `updateSimulation`, default `CONFIG`, 1/60-second
steps, and an open track with no nearby walls. Steering probes start at each
ground's own settled top speed. Slip angle is the difference between heading
and velocity direction. Results are specific to these inputs and are not
human lap-time or feel measurements.

| Probe | Street | Dirt |
| --- | ---: | ---: |
| 0 to 100 displayed km/h | 0.267 s | 0.450 s |
| 0 to 200 displayed km/h | 0.600 s | 1.100 s |
| Nose rotation during a 0.2 s steering tap | 28.68 degrees | 19.17 degrees |
| Peak slip during that tap/recovery probe | 15.73 degrees | 13.54 degrees |
| Time to rotate the nose at least 45 degrees | 0.300 s | 0.400 s |
| Slip at release after that 45-degree turn | 20.44 degrees | 24.57 degrees |
| Recovery to 95% of own top speed after that release | 0.550 s | 0.900 s |
| Time after that release until slip is below 1 degree | 0.467 s | 0.650 s |

The short tap produces less slip on dirt because its nose rotates much less.
For a matched heading change, dirt does slide more and recover more slowly.
Both findings matter: comparing only grip numbers misses the effect of the
two steering reductions.

A limited autopilot check on Classic Circuit, Carbon Bend, Kettle Run, and
Snow Circuit, each copied to both grounds, produced dirt laps about 26–40%
slower. The controller hits walls on some runs; this is not an optimal-time
comparison or verification of the old all-track median in the grounds plan.

## Suggested next playtest

Keep the current grip split, acceleration, and speed initially. Compare the
current steering against `turnRate: 0.9` and `angularResponse: 0.85`. An
in-memory probe of that candidate produced 24.56 degrees of nose rotation and
16.97 degrees of peak slip from the same 0.2-second tap. Reversing the steering
changed yaw direction in two frames, compared with three for current dirt.
This is a promising response change, but the 45-degree probe still took 0.9 s
to recover 95% of its top speed; the 90-degree probe lost slightly more speed
than current dirt. These are candidate values, not a finished preset.

Test brief corrections, consecutive
opposite corners, a hairpin, and acceleration out of a slide on desktop and
touch. The desired outcome is clear momentum and useful correction, without
requiring unavailable pedal controls. Check exit recovery before reducing
acceleration further or adding yaw carry or slide scrub.

The local live-ground list currently exposes only tarmac. Before implementing
any tuning, verify whether dirt has been used in a deployed ranked race:
ground settings participate in shared client/server replay rules. Follow the
compatibility rules in `docs/track-authoring.md:422` if they have.

## Validation

Ran:

```sh
./node_modules/.bin/vitest run tests/track-grounds.test.js tests/car-handling.test.js tests/physics_verification.test.js tests/simulation-mechanics.test.js
```

Result: 78 passed, 1 failed. Dirt client/server replay parity checks passed.
The existing snow ordering assertion fails at `tests/track-grounds.test.js:274`
because snow and dirt both have `maxSpeed: 0.85`. Its subsequent acceleration
assertion also conflicts with current values: snow 0.65, dirt 0.6. A lower snow
lap speed cannot be inferred from these individual multipliers alone. No
settings or tests were changed to make the assertion pass.

This verifies implementation behavior and replay agreement, not player feel.
No human in-game audition or hosted installation check was performed.

## Sources

- Current code: `game/track/grounds.js`, `game/car/handling.js`,
  `game/race/simulation.js`, `game/config.js`, `game/track/live-grounds.js`.
- Product and project context: `README.md`, `FAQ.md`, `LP/about.html`,
  `docs/system-change-map.md`, `docs/track-authoring.md`,
  `docs/track-grounds-plan-2026-09-24.md`, and `progress.md`.
- DirtFish instructor Eric Schofhauser,
  [How to drive on gravel vs asphalt](https://dirtfish.com/learn/how-to/how-to-drive-on-gravel-vs-asphalt/):
  limited traction and the rationale for rotation and a straight exit.
- DirtFish instructor Eric Schofhauser,
  [How to use the brakes](https://dirtfish.com/learn/how-to/how-to-use-the-brakes/):
  weight transfer and pedal control of cornering. The steering-only adaptation
  and tuning judgments above are design inferences from this game's controls.
