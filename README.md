# Mini Racer

Browser arcade racing game (Daily GP). This repository contains the **game client** only: rendering, physics, UI, tracks, and assets.

Scoreboards and daily challenges talk to a host app through `/api` (see `game/scoreboard/api-client.js` and `game/runtime-config.js`). That backend is not part of this repo.

## Play locally

1. `npm install`
2. `npm run generate:car-assets` (also runs automatically before tests)
3. Serve the project root with any static file server, then open `game.html`
4. For offline daily challenge testing: add `?mockDaily=true` to the URL (optional `?mockTrack=<trackKey>`)

## Project layout

| Path | Purpose |
| --- | --- |
| `game/` | Game logic, UI, audio, tracks |
| `game.html` | Main entry page |
| `public/assets/` | Cars, medals, fonts |
| `tools/` | Map maker, runner, TikTok studio, asset generators |
| `tests/` | Vitest unit tests |

## Commands

- `npm test` — run unit tests
- `npm run test:watch` — watch mode
- `npm run mutation` — Stryker mutation tests

## Daily GP flow

| Screen | Behavior |
| --- | --- |
| Lobby (`#start-overlay`) | Leaderboard, garage, settings, **Start Race** |
| **Start Race** | Loads today’s challenge track, runs the lap |
| After a run | Retry or return to lobby |

Track definitions live in `game/track/tracks.js`. The active daily track key comes from the API (or mock query params in local dev).
