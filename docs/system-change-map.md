# Mini Racer System Change Map

## Purpose

This file is the fastest way to answer three product questions before a change starts:

1. What part of the product owns this behavior?
2. What else will this change affect?
3. Which files usually need to be touched?

## Scope And Assumptions

- This map covers the shipped game flow in `game.html`, `game/`, and `src/server/`.
- It also calls out supporting tools under `tools/` when they matter to analytics or content operations.
- It is written for planning and scoping, not as a line-by-line engineering spec.
- Shared gameplay logic matters more than folder ownership. Several "frontend" changes also affect server validation.

## System At A Glance

```mermaid
flowchart LR
    A["game.html<br/>DOM shell + modal markup"] --> B["game/index.js<br/>boot"]
    B --> C["game/engine.js<br/>RealTimeRacer orchestrator"]

    C --> D["Track stack<br/>game/track/*"]
    C --> E["Race stack<br/>game/race/*"]
    C --> F["Car stack<br/>game/car/*"]
    C --> G["UI stack<br/>daily challenge, scoreboard, settings, garage, achievements"]
    C --> H["Audio + analytics<br/>game/audio/* + game/player/service.js"]
    C --> I["Browser cache<br/>localStorage/sessionStorage"]

    G --> J["API client layer<br/>game/scoreboard/api-client.js"]
    J --> K["Devvit/Express server<br/>src/server/index.ts"]
    K --> L["Redis-backed stores<br/>player profiles, races, analytics"]

    K --> M["Shared challenge model<br/>src/server/daily-gp-model.ts"]
    K --> N["Shared gameplay validation<br/>game/config.js + game/race/simulation.js + game/track/runtime.js + game/track/tracks.js"]
```

## What Talks To What

### Boot And Runtime Ownership

- `game.html` provides the full DOM contract: canvases, HUD, overlays, settings modal, garage modal, results modal, and playlist modal.
- `game/index.js` boots the app and instantiates `RealTimeRacer`.
- `game/engine.js` is the top-level orchestrator. It creates the feature modules, owns current run state, and wires together UI, simulation, track rendering, audio, storage, and network flows.

### Gameplay Loop

- `game/race/simulation.js` updates the car position, speed, steering response, checkpoint progress, finish detection, and crash detection.
- `game/race/engine-methods.js` is the gameplay controller layer around simulation: start sequence, reset logic, timer flow, replay recording, checkpoint handling, and render-side helpers.
- `game/track/runtime.js` turns track shapes into smoothed geometry and collision segments.
- `game/track/assets.js` caches geometry, runtime collision data, and rendered track canvases.
- `game/track/engine-methods.js` owns track loading, resize behavior, and track presentation refresh.

### UI And Modal Flow

- `game.html` contains the modal markup and the IDs/classes the UI modules depend on.
- `styles.css` contains nearly all visual rules for gameplay screens, reusable sheets, garage, settings, playlist, and result states.
- `game/race/ui-modal-shell.js` controls which modal view is open, focus trapping, pause/win/crash mode switching, and modal-to-garage handoff.
- `game/race/ui-modal-content.js` builds the result modal content blocks and score displays.
- `game/ui/reusable-modal.js` and `game/ui/modal-handoff.js` provide shared modal behavior used by settings, garage, playlist, and some results flows.

### Daily Challenge And Leaderboard Flow

- `game/daily-challenge/service.js` fetches the active challenge, playlist, snapshots, and daily result submission state.
- `game/daily-challenge/ui.js` renders the start screen card, playlist modal, preview canvas, and challenge summary state, including local submission stages like submitting, verifying, retrying, and terminal errors.
- `game/scoreboard/service.js` fetches leaderboard snapshots and submits best times.
- `game/scoreboard/snapshot.js` owns the shared client-side snapshot shape, row/time normalization, empty state, and mutation-safe cache cloning used by both scoreboard and Daily GP flows.
- `game/scoreboard/engine-methods.js` handles deferred verification and retry behavior after a local best run is recorded.
- `game/storage.js` fetches player bootstrap state and falls back to local data when needed.
- Daily GP track selection walks `game/track/tracks.js` in key order, one track per day, using the most-recent published day as the playhead; `src/server/daily-gp-store.ts` persists each new day to the `dailygp:challenges` Redis ledger (first-writer-wins) so past days never change.
- Published Daily GP playlist rows come from server-side challenge history, not from recalculating old dates against the current track file.
- Explicit mock modes and standalone preview pages use a local mock challenge (first track in `tracks.js`, or a track forced via `?mockDaily=<trackKey>`); normal local game runs use `/api/daily/*` or Devvit post data so they match the server-published track.
- Daily labels are calendar-based: `Today` is used only when a challenge's stored UTC date matches the current UTC date. Opening an older Reddit post keeps that post's challenge active and playable, but its Tracks and standings labels continue to show the original date.
- Moderator analytics "Players" and leaderboard entries measure different outcomes. Analytics counts a player after any accepted analytics event, while the leaderboard only gains a row after a finished run passes server replay validation and is accepted.
- `leaderboardEntryCount` is the number of players with accepted times. `totalCount` can be larger because it may include the subreddit member total; the UI renders the difference as `No time yet` community placeholders, not as missing player scores.
- Daily leaderboard snapshots are persisted separately in each client's local storage for fast initial rendering. Opening standings must always follow that cached render with a server refresh so web and mobile converge on the same accepted-entry count; if the refresh fails, an available cached snapshot remains visible.
- The full standings modal requests scored racers in 50-row rank pages. `/api/daily/snapshot` and `/api/scoreboard/snapshot` accept `offset` plus `limit` and return `pageOffset`, `pageLimit`, `hasMore`, and `nextOffset`; scrolling near the end loads and appends the next page. Only the first page is persisted in the daily snapshot cache, while later pages are request-keyed by challenge, offset, and limit.
- Player standing is independent of loaded pages: every snapshot resolves `playerRank` and `currentPlayerRow`, and the standings header keeps that rank and best time visible even when the player's row is outside the loaded rank range.

### Server And Shared Validation

- `src/server/index.ts` exposes all `/api/*` endpoints and Devvit moderator/internal actions.
- `src/server/daily-gp-model.ts` defines the challenge schedule, IDs, playable window, and Redis key model.
- `src/server/daily-gp-store.ts` persists generated challenge records, player profiles, durable player preferences, snapshots, and accepted runs. The published challenge history hash uses the same TTL as the installed Devvit server.
- `game/shared/daily-gp-history-backfill.js` isolates the June 2-11, 2026 published-history seed used to backfill the server history store.
- `src/server/replay-validator.ts` replays submitted inputs against shared track/physics logic before the server accepts a run.
- Important implication: track geometry, finish/checkpoint logic, and physics tuning are not frontend-only. The server uses the same contracts.

## Major Areas And Their Responsibilities

| Area | Main files | Owns | Depends on |
| --- | --- | --- | --- |
| Boot shell | `game.html`, `game/index.js` | Page structure and app startup | `game/engine.js`, `styles.css` |
| Runtime orchestrator | `game/engine.js` | State ownership and feature wiring | Almost every `game/*` feature module |
| Track system | `game/track/tracks.js`, `game/track/runtime.js`, `game/track/assets.js`, `game/track/engine-methods.js` | Track geometry, collision, cached canvases, presentation | `game/config.js`, `game/track/presentation.js` |
| Race/physics | `game/race/simulation.js`, `game/race/engine-methods.js`, `game/car/handling.js` | Driving feel, crashes, finish logic, replay capture | Track runtime, config, HUD, modal flow |
| Car visuals/customization | `game/car/sprite.js`, `game/car/player-car-skin.js`, `game/car/player-trail.js`, `game/settings/garage-ui.js` | Car art, asset loading, garage selection, trail style | `public/assets/cars/*`, generated asset list, local cache, Redis player profile |
| Daily challenge | `game/daily-challenge/service.js`, `game/daily-challenge/ui.js`, `game/daily-challenge/storage.js` | Featured challenge state, playlist, local bests | Shared schedule, server APIs, preview renderer |
| Leaderboards | `game/scoreboard/service.js`, `game/scoreboard/snapshot.js`, `game/scoreboard/ui.js`, `game/scoreboard/engine-methods.js` | Snapshot normalization, paginated standings display, submissions, verification retry flow | API routes, daily challenge storage, server APIs |
| Settings | `game/settings/ui.js`, `game/settings/*.js`, `game/player/preferences.js` | Identity, audio toggles, restart preferences, durable preference sync | Browser cache, player APIs, Redis profile, modal helpers |
| Audio/analytics | `game/audio/*`, `game/player/service.js` | Sound playback and analytics events | Settings preferences, `/api/analytics/event` |
| Server | `src/server/index.ts`, `src/server/daily-gp-store.ts`, `src/server/daily-gp-model.ts`, `src/server/replay-validator.ts` | Persistence, validation, challenge scheduling, APIs | Redis, shared gameplay modules |

## API Surface

These client-facing routes are defined in `src/server/index.ts`:

- `/api/player/bootstrap`
- `/api/player/identity`
- `/api/player/preferences`
- `/api/scoreboard/snapshot`
- `/api/scoreboard/submit`
- `/api/daily/active`
- `/api/daily/playlist`
- `/api/daily/snapshot`
- `/api/daily/submit`
- `/api/analytics/event`
- `/api/analytics/summary`

The browser-side API route and player identity entrypoint is `game/scoreboard/api-client.js`. Both leaderboard snapshot endpoints normalize their responses through `game/scoreboard/snapshot.js` before UI or cache use.

## Dependency Inventory

### Runtime Product Dependencies

| Dependency | Why it exists | Where it matters |
| --- | --- | --- |
| `@devvit/web`, `@devvit/redis` | Reddit/Devvit server runtime, context, Redis, shared request types, and posting flows | `src/server/*`, Devvit post/menu flows |
| `express` | API routing inside the Devvit server | `src/server/index.ts` |

### Product-Adjacent Dependencies

| Dependency | Why it exists | Where it matters |
| --- | --- | --- |
| `chart.js` | Moderator analytics dashboard charts | `mod-tool.js` |
| `flatpickr` | Date selection for moderator analytics | `mod-tool.js` |

### Build And Quality Dependencies

| Dependency | Why it exists | Where it matters |
| --- | --- | --- |
| `@devvit/start` | Devvit integration for the Vite build | `vite.config.js` |
| `devvit` | Local Devvit CLI for playtest, upload, and publish workflows | `package.json` scripts, `devvit.json` |
| `vite` | Build and local packaging | `vite.config.js` |
| `vitest` | Test runner | `vitest.config.js`, `npm test` |
| `@stryker-mutator/*` | Mutation testing | `stryker.config.mjs` |
| `tailwindcss`, `@tailwindcss/cli` | Analytics dashboard CSS build, not main gameplay styling | `tools/analytics-dashboard.tailwind.css` |

## Change Impact Matrix

Use this table when scoping work. "Primary files" are the places most likely to change. "Review too" means likely ripple checks even if no edit is needed.

| Change request | Primary files | Review too | Why this area ripples |
| --- | --- | --- | --- |
| Car skin or new car art | `public/assets/cars/*`, `tools/generate-player-car-assets.js`, `game/car/generated-player-selectable-car-assets.js`, `game/car/sprite.js`, `game/car/player-car-skin.js`, `game/settings/garage-ui.js` | `styles.css`, `game.html` | New art affects asset discovery, garage options, and fallback loading |
| Car trail options | `game/car/player-trail.js`, `game/settings/garage-ui.js` | `styles.css`, `game/engine.js`, `game/player/preferences.js` | Trail choices are cached locally, persisted in the Redis player profile, and rendered from engine state |
| Car size or render look | `game/config.js`, `game/car/sprite.js`, sometimes `public/assets/cars/*` | `game/race/engine-methods.js`, `styles.css` | Car scale is visual, but shadow and draw sizing live in config/orchestrator flow |
| Car handling / physics tuning | `game/car/handling.js`, `game/config.js`, `game/race/simulation.js` | `src/server/replay-validator.ts`, `game/race/run-policy.js`, `game/race/engine-methods.js` | Server validation reuses shared gameplay logic, so tuning changes affect accepted runs |
| Crash rules, win rules, checkpoint behavior | `game/race/simulation.js`, `game/race/run-policy.js` | `src/server/replay-validator.ts`, `game/daily-challenge/engine-methods.js`, `game/race/result-flow.js` | Finish and failure logic drive both local UX and server acceptance |
| Track layout or new track | `game/track/tracks.js`, `game/track/runtime.js` if geometry handling changes | `src/server/daily-gp-store.ts`, `src/server/daily-gp-model.ts`, `game/daily-challenge/service.js`, `src/server/reddit-post-title.ts` | Track data is used by gameplay, Daily GP scheduling (file-order walk), previews, and server validation |
| Track visual treatment only | `game/track/presentation.js`, `game/track/canvas.js`, `styles.css` | `game/daily-challenge/ui.js`, `game/race/ui-modal-shell.js`, `game/track/preview-renderer.js` | One presentation system feeds race view, previews, and modal thumbnails |
| Daily challenge schedule or availability window | `game/track/tracks.js`, `src/server/daily-gp-model.ts`, `src/server/daily-gp-store.ts`, `game/daily-challenge/service.js` | `src/server/index.ts`, `README.md` if player-facing behavior changes | New challenge generation walks the track file in order; playlist availability reads persisted published history so past days do not shift |
| Start screen or daily card copy/layout | `game/daily-challenge/ui.js`, `game.html`, `styles.css` | `game/daily-challenge/service.js` | The UI is driven by API summary fields and modal launch actions |
| Leaderboard snapshot or submit behavior | `game/scoreboard/service.js`, `game/scoreboard/snapshot.js`, `game/scoreboard/ui.js` | `src/server/index.ts`, `src/server/daily-gp-store.ts`, `game/scoreboard/engine-methods.js` | Client display and server payload shape must stay aligned |
| Modal redesign or modal flow changes | `game.html`, `styles.css`, `game/race/ui-modal-shell.js`, `game/race/ui-modal-content.js` | `game/ui/reusable-modal.js`, `game/ui/modal-handoff.js`, `game/settings/ui.js`, `game/settings/garage-ui.js`, `game/daily-challenge/ui.js` | There is one shared modal language, even though multiple features use it differently |
| Settings changes | `game/settings/ui.js`, specific `game/settings/*.js` preference files, `game/player/preferences.js` | `game/storage.js`, `src/server/daily-gp-store.ts`, `game.html`, `styles.css` | Settings use browser storage as a cache and the Reddit Redis player profile as the durable source |
| Audio changes | `game/audio/*`, `game/settings/car-audio-preference.js`, `game/settings/music-preference.js` | `game/engine.js`, `game/settings/ui.js` | Audio lifecycle is tied to user gesture handling and settings state |
| Replay verification / anti-cheat changes | `src/server/replay-validator.ts`, `game/race/simulation.js`, `game/track/runtime.js`, `game/config.js` | `src/server/daily-gp-store.ts`, `game/scoreboard/engine-methods.js` | This is the highest-risk area because client and server must stay logically identical |
| Analytics event changes | `game/player/service.js`, `src/server/analytics-store.ts` | `tools/analytics-dashboard.js`, `tools/analytics/schema.sql` | New event dimensions often need both collection and reporting updates |
| Moderator workflows, daily autoposting, or public post discovery copy | `src/server/index.ts`, `src/server/daily-gp-model.ts`, `src/server/reddit-post-title.ts` | `README.md`, `CHANGELOG.md`, `tests/reddit-post-title.test.js`, analytics tooling if reporting changes | These flows are server-owned and tied to Devvit/Reddit context; the outer post title and text fallback are the public search and Reddit Answers surfaces |

## High-Risk Shared Contracts

These are the places where a "small" change can create regressions outside the visible screen:

1. `game/race/simulation.js`
   Changes driving feel, crashes, checkpoints, finish detection, and replay outcomes.
2. `game/track/tracks.js`
   Changes race geometry, previews, future Daily GP generation eligibility, and replay validation.
3. `game/track/runtime.js`
   Changes collision smoothing and collision segment generation for both client and server.
4. `game/config.js`
   Changes baseline physics and render-related car constants used broadly across runtime behavior.
5. `src/server/daily-gp-model.ts`
   Changes challenge lifecycle, generated challenge shape, Redis key strategy, and scheduling rules.

## Secondary Tooling Areas

These are useful, but they are not on the critical player path:

- `mod-tool.html`, `mod-tool.js`, `mod-tool.css`
  Shipped moderator analytics UI and reporting support.
- `tools/mapmaker.*`
  Track/content support tooling.
- `tools/runner.*`
  Auxiliary workflow tooling.
- `preview.html`, `preview.js`, `preview.css`
  Standalone preview experience for local review, not the main shipped game shell.
- `mod-tool.*`
  Moderator/support tooling outside the main race runtime.

## Recommended Scoping Heuristic

Before approving any new request, sort it into one of these buckets:

- Visual-only
  Mostly `game.html`, `styles.css`, and UI modules.
- Gameplay-only
  Mostly `game/race/*`, `game/car/*`, `game/track/*`, plus server validation review.
- Data/API
  Mostly `game/*/service.js` and `src/server/*`.
- Cross-cutting
  Anything touching tracks, physics, challenge rules, or replay validation.

If a request lands in the cross-cutting bucket, plan for both gameplay validation and leaderboard acceptance checks before calling it complete.
