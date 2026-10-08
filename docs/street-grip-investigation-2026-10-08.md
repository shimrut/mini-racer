# Street grip investigation — 2026-10-08

Players say the Street car feels grippier since grounds (surfaces) came out.

Compared: `22bfe02^` (2026-09-25, the last commit before grounds) to `90c3d89` (today), and the
v2.3 and v2.4 release branches (same-taps races, below).

## Answer

The Street car drives exactly as before. Nothing in its physics changed. The likely causes are
the contrast with the new grounds and a phone steering fix.

## Checked: no change

| Area | Result |
| --- | --- |
| Driving numbers (`CONFIG`, `game/car/handling.js`) | Identical. |
| Street ground multipliers (`game/track/grounds.js`) | All exactly 1. Slide carry and slide scrub are off. |
| Physics step (`game/race/simulation.js`) | Same inputs on all 156 Street tracks, old code vs new code: position, speed and angle match bit for bit, every frame. |
| Game loop and fixed step | Same. |
| Server replay check | Uses the same physics, so the same result. |
| Street track copies in Redis | Must match the app track exactly before they are written (`src/server/tracks/track-copy.ts`). |
| Tyre squeal sound | Street keeps the old values. |
| Skid marks | Same color, width, spacing and trigger point on Street. |
| Camera zoom and look-ahead | Moved to `game/race/race-camera.js`, same numbers. |
| Car angle on screen | Same. |

## Changed: can change how it feels

1. **Contrast with the new grounds (most likely).** Dirt has 61% of Street grip, Snow 40%,
   Water 60%. Dirt and Snow also turn slower. After a few loose races, Street feels glued down.
   The Track ground has 2x grip, but it uses its own circuit car, not the Street car.
2. **Phone steering fix (`216176a`, 2026-09-27).** Before, a turn could stay on after the finger
   lifted, and lifting one of two fingers on the same side stopped the turn. Now a turn stops
   when the finger lifts, and holds while any finger on that side is down. The car goes where the
   player points it, which reads as more grip. Phones only.
3. **New drawn Street cars (Formula).** The front wheels turn with the steering. Looks more
   planted. Looks only.
4. **Street track shapes.** Against the released v2.4, no Street track that was in v2.4 changed
   shape (see the same-taps races below). Monkey Wrench and Double Trouble differ only from the
   development line of 2026-09-25, not from what players had. New Street tracks are about 3%
   wider at the median. Budapest Run is the widest (4.77u) with round corners (5).

## Visual changes on Street

Unchanged on Street: road, kerbs, tyre walls and background, skid marks, car shadow, camera,
the speed bar, the on-screen car angle, and the old picture cars. Dirt, Snow, Water and Space
effects (tyre tracks, spray, wall debris) do not appear on Street.

The only new thing a Street player can see is the **drawn cars** (Formula and the other drawn
Street cars, added with grounds on 2026-09-25):
- The front wheels turn up to 24° with the steering and follow it within 0.06 s. The car looks
  like it steers through the corner instead of sliding. This is the most likely visual cause.
- The tires roll with the speed, and a brake light comes on when the car loses speed quickly.

A player who kept an old picture car sees no visual change.

Car size and shape, in world units (1u = 40 px):

| | Length | Width |
| --- | --- | --- |
| Hit-box (capsule, unchanged since 2026-07-15) | 1.23 | 0.55 |
| Stock picture car (`mr_mr_red`) | 1.19 | 0.74 |
| Picture cars, median of 23 | 1.17 | 0.71 |
| Formula drawn car | 1.18 | 0.69 |

Both kinds are drawn in the same 52 px square with the same shadow. Formula is about 7% narrower
than the stock car, which leaves a little more visible road, but not enough to matter. Its
only ground mark is a red brake glow when the car loses speed quickly.

## Reports by platform

One Android, one iOS and one Windows (no touch screen) player. The phone fix explains Android
and iOS. Windows steers by keyboard, which did not change, so that report is the drawn cars or
the contrast with the looser grounds.

## Same-taps races: v2.3, v2.4 and latest

No release tags exist, so the release branches stand in: v2.3 = `racer-231` (2026-09-08),
v2.4 = `racer-v2-4` (2026-09-22, the last release before grounds), latest = this branch. Each
race runs that version's own physics, driving settings and track files, one lap, 60 steps a
second.

- Taps: the test autopilot drives each track once on the latest code. Its key presses are the
  tape played on every version. A second tape of random human-style taps (holds of 0.1 to 0.5 s,
  20 s per track) is played too.
- 126 Street tracks are in all three versions.

| Check | Result |
| --- | --- |
| Same track shape, autopilot taps | Identical every step in all 3 versions: 126 of 126 |
| Each version's own track files, autopilot taps | Identical: 126 of 126 |
| Random human-style taps | Identical: 126 of 126 |
| Grip setting | 4.3 in all 3 |

Six tracks, measured (each value is the same in v2.3, v2.4 and latest):

| Track | Lap (s) | Average slide | Time sliding | Corner speed (km/h) | Wall hits | Skid marks |
| --- | --- | --- | --- | --- | --- | --- |
| Circuit | 6.468 | 14.4° | 42.9% | 221.5 | 1 | 167 |
| Mountain Peak | 13.417 | 13.3° | 31.7% | 193.3 | 11 | 255 |
| Shark Fin | 19.106 | 7.6° | 12.7% | 218.1 | 8 | 146 |
| Hook Loop | 11.631 | 13.9° | 27.2% | 160.1 | 9 | 190 |
| Winding Road | 12.093 | 10.7° | 24.4% | 211.3 | 9 | 177 |
| Lightning Hook | 16.808 | 8.7° | 15.1% | 187.6 | 12 | 152 |

Slide is the angle between where the car points and where it moves. Time sliding counts the
steps past the skid-mark point (side speed over 28% of speed).

Result: the same taps give the same race, to the last digit, in all three versions. The Street
car's grip, slide and lap time did not change.

## Phone fix: races before and after

The real touch code from before the fix (`216176a^`) and after it (latest) gets the same finger
touches. Its left and right presses drive the latest physics, one lap on each of the 156 Street
tracks.

- The driver is the test autopilot. It puts a finger down or lifts it when its wish changes.
- Like a person, it notices when the car ignores its steering for 0.4 s, then lifts and taps
  both sides again.
- Faults, played the same way for both versions: a lost lift (the browser never reports that a
  finger lifted), and a thumb roll (a second finger lands on the same side, then the first lifts).

Medians over the tracks finished in both versions:

| Scenario | Wrong steering per lap, before → after | Lap time lost before the fix | Re-taps needed, before → after |
| --- | --- | --- | --- |
| Clean taps | 0 s → 0 s | 0 s (identical races) | 0 → 0 |
| One lost lift per lap | 0.38 s → 0.05 s | 0.13 s | 1 → 0 |
| Lost lift about every 5 s | 1.15 s → 0.17 s | 0.32 s | 2 → 0 |
| Thumb roll on 1 hold in 5 | 0.88 s → 0 s | 0.18 s | 1 → 0 |

- Wrong steering: time the car steers differently from the fingers. Before the fix, a lost lift
  keeps the turn on until the player taps that side again; pressing the other side meanwhile
  cancels out and the car goes straight. A thumb roll drops the turn when the first finger
  lifts. After the fix, a lost lift ends at the next touch anywhere on the screen, and a thumb
  roll keeps turning.
- Slide and grip do not change: average slide stays about 10.3° and time sliding about 21% in
  every scenario. The car's grip is the same. Before the fix, the car sometimes did not do what
  the finger said, either turning on its own or running wide. That reads as a loose car.
- With clean taps the two versions race identically, so the fix only matters on phones that
  lose a lift, or for players who use two fingers on one side.
- How often real phones lose a lift is not known. The 0.4 s reaction time is a guess; a slower
  reaction makes the old code worse.

## Not checked

Track shapes stored only in Redis (Creator edits, the live Daily list). They cannot be read from
the repo.
