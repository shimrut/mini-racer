# Street grip investigation — 2026-10-08

Players say the Street car feels grippier since grounds (surfaces) came out.

Compared: `22bfe02^` (2026-09-25, the last commit before grounds) to `90c3d89` (today).

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
4. **Two Street tracks have new walls.** Monkey Wrench and Double Trouble are about 6–7%
   narrower, which makes them harder, not easier. New Street tracks are about 3% wider at the
   median. Budapest Run is the widest (4.77u) with round corners (5).

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

## Not checked

Track shapes stored only in Redis (Creator edits, the live Daily list). They cannot be read from
the repo.
