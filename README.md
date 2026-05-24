# Mini Racer

Browser arcade racing game (Daily GP). This repo is the **game client** only: rendering, physics, UI, tracks, and assets.

The host app (not in this repo) serves `/api` for today’s challenge, leaderboard, and rank. See `game/scoreboard/api-client.js` and `game/runtime-config.js`.

## Play locally

1. `npm install`
2. `npm run generate:car-assets` (also runs before tests)
3. Serve the project root with any static file server and open `game.html`
4. Optional: `?mockDaily=true` for a random track, or `?mockDaily=<trackKey>` (e.g. `circuit`) — UI only; rank stays `--` without the host API

## Commands

- `npm test` — unit tests
- `npm run test:watch` — watch mode
- `npm run mutation` — Stryker mutation tests

## Project layout

| Path | Purpose |
| --- | --- |
| `game/` | Game logic, UI, audio, tracks |
| `game.html` | Main entry |
| `public/assets/` | Cars, medals, fonts |
| `tools/` | Map maker, runner, TikTok studio, asset generators |
| `tests/` | Vitest |

## How the game works

### Lobby

The start overlay loads today’s challenge from `GET /api/daily/active` and shows the track, your best time, and **Rank** (today’s leaderboard).

**Start Race** loads that track. **Garage** and **Settings** are also on the overlay.

### A run

- **One lap** — crossing the finish line ends the run.
- **Crash** — run fails; that attempt does not submit a new best.
- **Win** — your lap time is recorded.

### Personal best vs rank

| | Where it lives | Rule |
| --- | --- | --- |
| **Personal best** | Browser storage (`game/daily-challenge/storage.js`) | Lower lap time wins; only your best is kept for today’s challenge |
| **Rank** | Host API | Shown as `#N` and optionally “of total”; **#1 is fastest**. The client does not calculate place |

When you beat your stored best, the client sends the lap time and replay to `POST /api/daily/submit`, then refreshes `GET /api/daily/snapshot` for rank and the leaderboard list. While that runs, the UI may show “Submitting…” or “Verifying…”.

### Medals

Medals (bronze → author) are **not** leaderboard rank. They use fixed time targets per track in `game/medals/medal-times.json`.

### API (client)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/daily/active` | Today’s challenge |
| `GET /api/daily/snapshot` | Leaderboard and your rank |
| `POST /api/daily/submit` | New personal best (with replay) |
| `GET /api/player/bootstrap` | Player identity bootstrap |

Tracks are defined in `game/track/tracks.js`. `CONFIG.visibleTrackKeys` is an allowlist for the host and tests, not a track picker in the game UI.
