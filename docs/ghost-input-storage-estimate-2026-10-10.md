# Ghost size: poses vs inputs (2026-10-10)

## Question

How much smaller would ghosts be if we stored the player's key presses (inputs) instead of the car's recorded positions?

## Today

- A ghost is the car's position and angle 20 times per second (`game/shared/pb-ghost-recorder.js`), gzipped in Redis.
- The game already sends the key presses with every run (`game/race/replay.js`). The server replays them to verify the time and builds the ghost from them (`src/server/competition/replay-validator.ts`). The key presses are then thrown away.

## Method

The test autopilot (`tests/helpers/autopilot.js`) drove every track for 1 and 3 laps (163 tracks each). Each run went through the real validator. We measured the stored Redis size (gzip + base64 envelope) of the ghost and of the inputs.

## Results (average per ghost)

| | 1 lap (~14 s) | 3 laps (~42 s) |
|---|---|---|
| Ghost today | 1.7 KB | 4.4 KB |
| Inputs, current format | 0.48 KB (-72%) | 0.93 KB (-79%) |
| Inputs, compact format | 0.25 KB (-85%) | 0.52 KB (-88%) |

- Ghost size grows with race time. Input size grows with how often the player changes keys.
- The autopilot changes keys about 8 times per second. Players who hold keys longer will save more.
- Ghosts are about 75% of storage (see `mobile-backend-hosting-costs-2026-10-04.md`). An 80-88% ghost cut would shrink total storage by roughly 60-65%.
- Head-to-head and podium posts embed ghosts too, so their post data would shrink the same way.

## Trade-offs

- Playback must re-run the race physics on the device. The server already does this, so the code exists.
- Any physics change breaks old input ghosts. Stored records are already dropped when `PB_GHOST_SIMULATION_REVISION` changes, so this is not a new loss.
- Needs a new ghost format version and a migration or a gradual switch for stored ghosts.

## Not yet checked

- Real player key-change rates. Measure on live runs before committing.
- Client CPU cost of re-simulating a ghost on low-end phones.
