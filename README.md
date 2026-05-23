# Mini Racer

Mini Racer is a Reddit-native arcade racing game built with Devvit Web.

Internal Reddit app slug: `mini-racer`

## How the game works today

The live client is **Daily GP–first**. There is **no in-game track picker** (no carousel, no per-track mode select).

| What players see | What happens |
| --- | --- |
| **Lobby** (`#start-overlay`) | Leaderboard, Achievements, Garage, Settings, and **Start Race** for today’s Daily GP |
| **Start Race** | Loads the track from the active daily challenge (`trackKey` from the API), then runs the lap |
| **After a run** | Retry / Done returns to the lobby or restarts the daily run |

Older releases had a returning-player track carousel and Time Trial / Session picks per track. That UI was removed; `CHANGELOG.md` still describes those versions historically.

### Where the track comes from

- **Production:** `src/server/daily-gp-model.ts` builds each UTC day’s challenge. The track is currently fixed to `cedarRidgeCircuit` (with fallback to the first entry in `CONFIG.visibleTrackKeys` if that key is missing).
- **Client:** `game/daily-challenge/service.js` fetches `/api` daily challenge data; `handleStartDailyChallenge()` in `game/daily-challenge/engine-methods.js` calls `loadTrack(challenge.trackKey)`.
- **Local dev:** `?mockDaily=true` (or `localDev`) uses a mock challenge—random track from all of `TRACKS`, overridable with `?mockTrack=<key>`.

### Track data (not the same as “pickable tracks”)

| Location | Role |
| --- | --- |
| `game/track/tracks.js` → `TRACKS` | All circuit definitions (geometry, start line, checkpoints) |
| `CONFIG.visibleTrackKeys` in `game/config.js` | **Server allowlist** for Daily GP fallbacks and tests—not a player-facing list |
| `tools/mapmaker.html`, `tools/runner.html`, `tools/tiktok-studio.html` | Dev dropdowns over **all** `TRACKS` keys |

Adding a track to `tracks.js` does **not** put it in front of players until the daily challenge (or mock URL) uses that `trackKey`.

## Current release shape

- Inline post preview (`preview.html`) that opens the full game in expanded mode
- Playable Daily GP session inside Reddit
- Leaderboard and daily challenge proxied through the Reddit-hosted server (`src/server/`)

The application uses a Reddit-native architecture. The backend uses the Reddit Dev Platform (Devvit) with Redis for persistence; Supabase is not used.

## Commands

- `npm run login` to authenticate the Devvit CLI
- `npm run dev` to run a playtest build on Reddit
- `npm run build` to produce the Devvit client and server bundles
- `npm run deploy` to upload a new private app version
- `npm run launch` to upload and publish the current version for Reddit review
