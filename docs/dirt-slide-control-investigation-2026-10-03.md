# Dirt slide and control investigation — 2026-10-03

Scope: investigate the reported short slide followed by braking-like slowdown
and difficult correction. No gameplay code, ground settings, or tests changed.
The current checkout is `codex/restore-v240-tracks` with unrelated existing WIP.
This report supersedes the preset assessment in the October 1 handling review.

## Current preset

`game/track/grounds.js:39` currently defines:

| Setting | Dirt |
| --- | ---: |
| `accel` | 0.7 |
| `maxSpeed` | 0.87 |
| `grip` | 0.7 |
| `steerGripScale` | 0.6 |
| `turnRate` | 0.78 |
| `angularResponse` | 0.45 |
| `highSpeedSteerTrim` | 1 |
| `yawCarry` | 0.2 |
| `slideScrub` | 0 |

These are also the committed driving values from `1d24d4d6`; the existing
working-tree diff in this block changes indentation only. With default physics,
dirt's top speed is 269.7 displayed km/h. The Mapmaker Test Drive directly calls
the shared simulation with `CONFIG` and the draft track's ground
(`tools/mapmaker-playtest.js:275`). Car skins do not supply separate handling.

## Why recovery slows the car

The simulation splits velocity into forward and sideways components, damps
the sideways component, then reconstructs velocity
(`game/race/simulation.js:619-665`). The removed sideways momentum is discarded;
it is not redirected forward. Therefore catching a slide also removes speed,
even with `slideScrub: 0`.

Releasing steering immediately switches the damping multiplier from
`0.97 * 0.6 = 0.582` to `1` (`simulation.js:652-656`): a 71.8% increase at the
same speed. At full dirt speed, lateral damping changes from 3.01/s to 5.18/s.
The velocity remains continuous, but the rate at which sideways speed is
removed changes on that input frame. Grip also rises with squared speed due
to the shared downforce rule, so the effect is strongest near top speed.

Automatic acceleration is zero at the speed cap and small near it, because
its factor is `1 - speedRatio ** 2` (`simulation.js:633-635`). Dirt additionally
has 70% of Street's base acceleration. It does not immediately replace the
momentum lost to grip. The explicit brake branch applies only when the forward
velocity projection is negative (`simulation.js:638`); it did not activate in
the steering probes below. No timed post-slide brake was found in this path.

## Why catching the slide is difficult

Dirt turns at 78% of the base rate and responds at 45% of the base response:
9.9/s rather than Street's 22/s. Existing rotation consequently takes longer
to stop or reverse. `yawCarry: 0.2` prolongs rotation after steering release
(`simulation.js:594-612`), while the higher release grip simultaneously removes
sideways speed.

The yaw target depends on steering and total speed, not the slide direction
or angle (`simulation.js:592`). Opposite steering receives the same reduced
lateral grip as steering into the corner. There is no special slide-catch
response. An equal-speed one-frame probe starting with 0, -25, and +25 degrees
of slip produced identical yaw response to left input: -0.37331 rad/s.
Countersteering can still reduce slip through ordinary heading rotation; the
model simply does not recognize it as a distinct correction state.

## Reproduced behavior

Probes called the actual shared `updateSimulation` at 60 Hz with default
`CONFIG`. A large open test track kept walls and checkpoint/finish lines away
from the car. Each steering run accelerated straight for 600 frames, then
steered right for 12 frames or until heading changed by at least 45/90 degrees.
Inputs were released for recovery. Speed means velocity magnitude multiplied
by 20; slip means the shortest angle between heading and velocity direction.
No wall impacts occurred.

| Dirt steering sequence | Speed at release | Lowest speed after release | Additional heading change after release |
| --- | ---: | ---: | ---: |
| 0.2-second tap | 267.3 km/h | 259.0 km/h | 7.7 degrees |
| Approximately 45-degree turn | 246.5 km/h | 224.4 km/h | 9.0 degrees |
| Approximately 90-degree turn | 196.0 km/h | 165.3 km/h | 10.2 degrees |

The 45-degree turn took 26 frames (0.433 s); slip at release was 28.6 degrees.
Speed fell another 17.7 km/h in the first 0.1 s after release and reached its
minimum at 0.2 s. Recovering 95% of dirt's top speed took 0.933 s after release;
slip fell below one degree at 0.783 s. Street's corresponding 45-degree probe
fell from 279.5 to 271.0 km/h after release and added about four degrees of yaw.

Reversing steering after the 45-degree turn reversed yaw in four frames on
dirt versus two on Street. Slip crossed zero in seventeen frames (0.283 s)
versus eight. Those are controlled probe results, not response times for every
possible corner.

Diagnostic runs from the same 45-degree release state separated the effects.
Keeping neutral lateral grip at its pre-release multiplier required an
in-memory config override; removing residual yaw meant zeroing angular velocity
at release. Neither diagnostic was written to the game or proposed as a preset.

| Recovery diagnostic | Speed after 0.1 s | Lowest speed |
| --- | ---: | ---: |
| Current behavior | 228.8 km/h | 224.4 km/h |
| Keep pre-release grip | 235.3 km/h | 229.6 km/h |
| Remove residual yaw | 234.2 km/h | 233.3 km/h |
| Both diagnostics | 239.1 km/h | 237.8 km/h |

There is an angle-dependent effect, not a universal severe slowdown after any
small slide. With heading held fixed, no initial yaw, normal auto-acceleration,
and an initial 10-degree slide at top speed, neutral recovery lost only about
2.7 km/h after 0.25 s. At 30 degrees it lost about 23.9 km/h; at 45 degrees,
about 52.3 km/h. Continued yaw in normal turns increases the problem.

## Design implication

The user's target is a modest, controllable slide with most speed retained.
The current model couples regaining lateral grip to losing speed. Settings
can soften this behavior, but cannot control those effects independently.
Reducing grip further would extend slide duration; additional yaw carry would
extend overshoot. Faster steering response and less residual yaw are relevant
tuning directions, but are not established fixes for momentum loss.

If implementation is requested, first evaluate a small dirt-specific change
that makes recovery gradual, preserves most momentum while aligning the path,
and improves opposite-steering correction. A full tire or suspension model is
not necessary to investigate that direction. Acceptance needs human Test Drive
checks of short taps, releases, consecutive opposite corners, and slide exits;
numerical slip or slower lap times do not establish convincing feel.

## Concrete candidate from the follow-up question

**Superseded as a recommendation by the sideways-carry clarification below.**
This experiment addressed total speed retention, but did not independently
define how long sideways motion should persist. Its numerical results remain
diagnostic evidence, not a settled handling proposal.

The user asked what changes would be needed. A second in-memory probe compared
a settings-only candidate with the same candidate plus a small recovery rule.
These are proposed starting values, not accepted driving settings:

| Dirt setting | Current | Candidate |
| --- | ---: | ---: |
| `grip` | 0.7 | 0.8 |
| `steerGripScale` | 0.6 | 0.85 |
| `turnRate` | 0.78 | 0.9 |
| `angularResponse` | 0.45 | 0.85 |
| `yawCarry` | 0.2 | 0 |

Keep `accel: 0.7`, `maxSpeed: 0.87`, `highSpeedSteerTrim: 1`, and `slideScrub: 0`
for this initial comparison. The steering-to-neutral damping increase falls
from 71.8% to 21.3%; reversal responds faster and release rotation decreases.

The proposed dirt-only recovery rule retains part of the sideways speed
removed by grip as forward speed. A provisional scalar of 0.8 gives:

```js
forwardSpeed = Math.sqrt(
    forwardSpeed * forwardSpeed
    + 0.8 * Math.max(0, latBeforeGrip * latBeforeGrip - lateralSpeed * lateralSpeed)
);
```

Apply only when moving forward, after lateral damping and before reconstructing
velocity. Keep the existing total-speed cap. This returns 80% of the removed
lateral squared-speed contribution, not 80% of each frame's total speed loss.
A ground-specific value defaults to zero for other grounds. Do not apply the
recovery rule to reverse motion or wall-impact losses. The probe loaded a
transformed copy of the actual simulation source in memory; repository gameplay
files were not modified.

| Approximately 45-degree dirt turn | Speed at release | Lowest after release | Additional heading change |
| --- | ---: | ---: | ---: |
| Current | 246.5 km/h | 224.4 km/h | 9.0 degrees |
| Settings only | 244.2 km/h | 231.6 km/h | 4.4 degrees |
| Settings plus 0.8 recovery | 264.1 km/h | 261.9 km/h | 4.2 degrees |

With settings plus recovery, release slip was about 22.8 degrees rather than
28.6 degrees. Reversal took two frames and slip crossed zero in ten rather than
the current four and seventeen. The 90-degree probe bottomed at 253.0 km/h,
compared with current 165.3 km/h and settings-only 180.3 km/h. Threshold crossing
can overshoot the nominal heading by a few degrees because the timestep is fixed.

This candidate supports the numerical direction but has not been audited as a
production implementation or accepted by a human playtest. Start with this
small rule and response tuning before deciding whether a separate slip-aware
countersteering assist is necessary. It would materially change attainable dirt
times, so implementation requires the existing compatibility review.

## Clarified target: rally slide with sideways momentum

The user clarified that the goal is a proper, moderate rally slide carrying
sideways momentum, rather than simply retaining total speed. The earlier
forward-recovery proposal also raised grip, shortening side carry; it did not
fully specify this goal. Carry duration, slide angle, and correction response
must be tuned separately.

Use the existing distinction between car heading and velocity direction:

1. Steering turns the nose promptly without instantly redirecting velocity.
2. Dirt gradually rotates velocity toward the nose while retaining most of
   its magnitude. A small separate drag controls speed loss, instead of
   automatically discarding the whole sideways component during grip recovery.
3. Use a continuous ordinary alignment rule through steering release. The
   current button-dependent increase in damping must not end the carry abruptly.
4. Let opposite steering bring the nose toward the existing direction of
   travel promptly. It must not erase sideways velocity as soon as correction
   begins. Add a separate response assist only if the basic rule needs it.
5. As excessive slip develops, progressively strengthen alignment or soften
   steering that increases slip. Keep correction available; avoid a hard angle
   clamp that visibly snaps the car or path.

Constant body-relative sideways speed is not the goal: that component changes
when the nose rotates. Preserve momentum through the sideways phase, then let
heading and trajectory reconnect smoothly. At 100% recovery the earlier
forward-energy formula is mathematically equivalent to speed-preserving
velocity rotation; changing notation alone does not fix carry duration. The
alignment curve and steering response are the essential independent controls.

An in-memory sketch replaced the dirt lateral-damping step with slip-angle
alignment at 4.5/s, adding a smooth increase of up to 6/s across the 30–45 degree
slip region. It used the same alignment rule while steering and neutral,
`turnRate: 0.9`, `angularResponse: 0.9`, `yawCarry: 0`, and separate speed drag
`0.15 * sin(slip)^2` per second. This is an arcade candidate, not a full rally
tire model or a production implementation.

The same wall-free track and 600-frame warmup produced:

| Steering hold | Current peak slip | Sketch peak slip | Sketch lowest speed during one-second recovery |
| --- | ---: | ---: | ---: |
| 0.2 s | 12.7 degrees | 16.6 degrees | 269.1 km/h |
| 0.5 s | 32.5 degrees | 28.0 degrees | 267.3 km/h |
| 2 s | 75.5 degrees | 29.8 degrees | 263.5 km/h |

In the 0.5-second turn, sideways speed relative to the nose was 125.9 displayed
km/h at release, 93.3 after 0.1 s, 48.7 after 0.25 s, and 15.9 after 0.5 s.
It decayed progressively while total speed stayed near 267–268 km/h. These
figures quantify this sketch only; they do not establish the right carry
duration for the player. The existing speed cap held during the probes, and
the sketch produced bit-identical tarmac positions, velocity, heading, speed,
and yaw over a 1,200-frame mixed-input check. No gameplay files changed.

For initial human acceptance, ordinary corners should show approximately
15–30 degrees of visible slip, useful momentum after release, prompt correction,
and a smooth return to traction. Those are design starting points, not rally
specifications or fixed final numbers. Test consecutive opposite corners and
actual track widths; retaining speed may make existing corners wider.

Real rally guidance describes sideways momentum, continued slide during grip
recovery, and smooth countersteering matched to the slide:
[DirtFish, How to throttle steer](https://dirtfish.com/learn/how-to/how-to-throttle-steer/).
Its actual technique depends on pedal control and weight transfer. The rules
above are an inference for this steering-only game, whose controls cannot
perform the same pedal-driven maneuvers.

## Validation and limits

Ran the existing focused suites directly, without the npm pretest pipeline:

```sh
./node_modules/.bin/vitest run tests/track-grounds.test.js tests/car-handling.test.js tests/physics_verification.test.js tests/simulation-mechanics.test.js
```

Result: four files, 79 tests passed. This includes dirt client/server replay
agreement. Vitest's global asset generator ran; its output has no working-tree
diff. Tests were not modified. These suites verify existing mechanics, not the
requested driving feel. No human driving audition, browser reproduction of the
reported session, or hosted Reddit/runtime check was performed.

The local live-ground list still exposes only tarmac (`game/track/live-grounds.js`).
The server reuses shared simulation, and non-tarmac ground is fingerprinted.
Any future implementation must assess rules/replay compatibility using
`docs/track-authoring.md:444` and `docs/system-change-map.md:623`; this report
does not establish which dirt versions may have been deployed historically.
