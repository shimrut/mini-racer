# Mini Racer System Change Map

## Purpose

This file is the fastest way to answer three product questions before a change starts:

1. What part of the product owns this behavior?
2. What else will this change affect?
3. Which files usually need to be touched?

## Scope And Assumptions

- This map covers the shipped game flow in `game.html`, `game/`, and `src/server/`.
- It also calls out supporting tools under `tools/` when they matter to content operations.
- It is written for planning and scoping, not as a line-by-line engineering spec.
- Shared gameplay logic matters more than folder ownership. Several "frontend" changes also affect server validation.
- For modularization seams and recommended file splits, see [modularization-findings.md](./modularization-findings.md).
- For the investigated multi-lap Daily GP and permanent Campaign design, see
  [multi-lap-campaign-architecture.md](./multi-lap-campaign-architecture.md).

## System At A Glance

```mermaid
flowchart LR
    A["game.html<br/>DOM shell + modal markup"] --> B["game/index.js<br/>boot"]
    B --> C["game/engine.js<br/>RealTimeRacer orchestrator"]

    C --> D["Track stack<br/>game/track/*"]
    C --> E["Race stack<br/>game/race/*"]
    C --> F["Car stack<br/>game/car/*"]
    C --> G["UI stack<br/>daily challenge, scoreboard, settings, garage"]
    C --> H["Audio<br/>game/audio/*"]
    C --> I["Browser cache<br/>localStorage/sessionStorage"]

    G --> J["API routes<br/>game/scoreboard/api-client.js"]
    G --> PI["Player identity<br/>game/scoreboard/player-identity.js"]
    J --> K["Devvit/Express server<br/>boot + app factory + route registrars"]
    K --> L["Redis-backed stores<br/>player profiles + races"]

    K --> M["Shared challenge model<br/>src/server/daily-gp-model.ts"]
    K --> N["Shared gameplay validation<br/>game/config.js + game/race/simulation.js + game/track/runtime.js + track definitions"]
```

## What Talks To What

### Boot And Runtime Ownership

- `game.html` provides the full DOM contract: canvases, HUD, overlays, settings modal, garage modal, results modal, and playlist modal.
- `game/index.js` boots the app and instantiates `RealTimeRacer`.
- `game/engine.js` is the top-level orchestrator. It creates the feature modules, owns current run state, and wires together UI, simulation, track rendering, audio, storage, and network flows.
- The static track and the moving car use separate canvas layers. Devvit's Android client keeps the track layer on the main thread because its embedded WebView can expose the worker APIs without reliably presenting that canvas; iOS and web clients retain the worker renderer when supported.

### Gameplay Loop

- `game/race/simulation.js` updates the car position, speed, steering response, checkpoint progress, finish detection, and wall-impact response. The car uses an oriented capsule collision body covering its nose, center, and rear; impact speed comes from velocity at the body contact point, including rotation. Every inward wall impact resolves the full corner contact set to the safe side of the barrier and becomes a momentum-losing scrape, including severe head-on impacts. Continuous contact cannot retrigger scrape feedback until the car separates.
- `game/race/engine-methods.js` is the gameplay controller layer around simulation: start sequence, reset logic, timer flow, replay recording, checkpoint handling, and render-side helpers.
- `game/race/replay.js` records steering and relaunch-delay inputs into run-length segments for scoreboard submission. Legacy revision-0 challenges retain the 3,000-frame cap; revision-1 races use 2,500 frames per required lap (up to 7,500), bind the payload to rules revision and target lap count, and discard the whole payload on overflow.
- `game/ghost/pb-ghost.js` is the isolated client playback/rendering feature. It decodes the server-issued schema-v2 trace once, reconstructs its fixed 20 Hz timeline plus exact finish pose, interpolates it for rendering, freezes the selected ghost for the duration of an attempt, and draws a highly transparent collisionless copy of the player's currently selected car before the player car. `game/ghost/pb-ghost-service.js` owns the authenticated summary/full-ghost requests and cache.
- `game/track/geometry.js` owns the small point and line-intersection helpers shared by track definitions and race simulation. Physics code does not import these helpers through the broader game configuration.
- `game/track/catalog.js` is the lightweight source for track names, existence checks, the default track, and explicit Daily GP schedule order. Metadata-only consumers should use it instead of loading full track geometry.
- `game/track/definitions/*` contains one geometry module per track. `game/track/tracks.js` assembles those modules into the compatibility `TRACKS` registry used by rendering, collision, replay validation, and other geometry consumers.
- `game/track/runtime.js` turns track shapes into smoothed geometry and collision segments.
- `game/track/assets.js` caches geometry, runtime collision data, and rendered track canvases.
- `game/track/engine-methods.js` owns track loading, resize behavior, and track presentation refresh.
- Track creation and integration steps are documented in `docs/track-authoring.md`.
- Local development exposes the deterministic gameplay state and time-step helpers through `window.__RACER_DEBUG__` plus the standard `render_game_to_text` / `advanceTime` browser-game test contract; hosted builds remove those hooks.

### Devvit Journeys

- `game/journeys/service.js` is the only client adapter for Reddit's official Devvit Journeys API. It serializes lifecycle calls, suppresses duplicate or non-increasing events, reports receipts only to the developer console, and contains SDK failures so they cannot affect loading, racing, finishing, or score submission.
- The lobby receives its visual `is-ready` state behind the loading-screen fade so its title and controls are already present when the loader clears. Start input remains separately gated until dismissal completes; only then does the expanded game report `App.Ready`. Each explicit player intent starts one Journey attempt (`initial_start`, `track_switch`, `restart`, `retry`, or `improve`); checkpoints provide monotonic progress, pause/resume use fixed interaction names, locally validated finishes end complete, and rejected finishes, explicit exits, or track switches end incomplete before the next start. Mid-run track switches replace the active Journey through `replaceActive` end-then-start sequencing. Automatic collision restart stays inside the active Journey because it is not an explicit player action.
- Journey payloads contain no player ID, Reddit username, guest token, challenge ID, track key, replay, device details, or lap score. The official `/api/telemetry` router enriches events in Devvit; Mini Racer adds no custom analytics route, Redis record, retention policy, or dashboard.

### UI And Modal Flow

- `game.html` contains the modal markup and the IDs/classes the UI modules depend on.
- `styles.css` is the single ordered stylesheet manifest loaded by the game. Its
  product-oriented partials cover gameplay screens, reusable sheets, garage,
  settings, playlist, standings and result states; their ownership and
  cascade-preservation rules are documented in `docs/css-architecture.md`.
- `game/race/ui-modal-shell.js` controls which modal view is open, focus trapping, pause/win/notice mode switching, and modal-to-garage handoff. Wall contact no longer has a terminal result screen. Active menus use shared spatial keyboard navigation; the `is-menu-selected` cue appears only after a directional key, while Enter activates the preferred modal action and is consumed when no modal action is available.
- `game/race/ui-start-overlay.js` owns the lobby start overlay and uses the same spatial keyboard navigation while no sheet is open on top. Enter defaults to Start Race without a visible cue until a directional key is used.
- `game/ui/menu-keyboard-nav.js` is the shared geometry-based menu navigator used by lobby, pause, finish, garage, settings, Tracks, Standings, and the share dialog. Arrow keys and WASD move to the nearest active control in the requested on-screen direction; overlapping control bounds keep wide actions reachable from narrower menu items. Standings keeps its date-rail underline and rounded-row visual language for keyboard selection instead of adding browser focus rings. Garage and Settings dismiss buttons are intentionally excluded because Escape owns dismissal, and Settings exposes the delay minus/plus buttons instead of selecting the meter display.
- `game/race/ui-modal-content.js` builds the result modal content blocks and score displays.
- `game/ui/reusable-modal.js` and `game/ui/modal-handoff.js` provide shared modal behavior used by settings, garage, playlist, and some results flows.

### Daily Challenge And Leaderboard Flow

- `game/daily-challenge/service.js` fetches the active challenge, playlist, snapshots, and daily result submission state. Preview/mockDaily fallbacks, active-cache normalization, and share-adjacent client helpers are covered in `tests/daily-challenge.test.js`.
- `game/storage.js` fetches player bootstrap state and falls back to local data when needed. Payload coercion, local short-circuit, and hosted failure fallback are covered in `tests/player-bootstrap-recovery.test.js`.
- `game/daily-challenge/ui.js` renders the start screen card, playlist modal, preview canvas, and challenge summary state, including local submission stages like submitting, verifying, retrying, and terminal errors.
- `game/scoreboard/service.js` fetches leaderboard snapshots and submits best times.
- `game/scoreboard/snapshot.js` owns the shared client-side snapshot shape, row/time normalization, empty state, and mutation-safe cache cloning used by both scoreboard and Daily GP flows.
- `game/scoreboard/engine-methods.js` starts verification from the finish event, handles retry behavior until the competition deadline, and consumes the canonical challenge-PB record returned by an accepted submission.
- Finish-screen RANK first paint and live updates share `applyCombinedRankValue` in `game/race/result-flow.js`, so loading shows Submitting/Verifying status text and failures keep RANK visible with the error. After the win modal opens, a synchronous queue sync paints Verifying when an entry still exists; if accept finishes with no standings snapshot, loading clears and RANK hides.
- Daily leaderboard rows and PB ghosts are separate challenge-scoped records with the same fixed deadline: six hours after `availableUntil`. Entries retain the verified completed-lap count, and ghosts additionally bind rules revision and lap count. One server replay simulation validates the complete daily race and produces the canonical ghost. Both writes run concurrently; the leaderboard write decides acceptance, while a PB-only Redis or lock failure returns an accepted result with PB status `unavailable`.
- Accepted submissions return the complete canonical `trackPersonalBest` record. The client validates and installs that record before GO without another `/api/player/pb-ghost` request. A pending faster lap makes the old prepared ghost ineligible for Improve; if the canonical result is unresolved, unavailable, or malformed at GO, the attempt starts normally without a ghost and shows `GHOST UNAVAILABLE` for two seconds after GO disappears. A late valid response is cached for the next attempt and never changes a ghost during an active run.
- Custom-post startup resolves the playable challenge before dismissing the loading screen and prepares that challenge's PB ghost as an initial race asset. A still-valid historical post therefore loads its historical track ghost, while an expired post resolves to the current featured challenge and loads today's ghost. The first `Race Now` start preserves this prepared asset instead of clearing and preparing it again; restarts continue reusing the same frozen record.
- PB ghost playback uses the same interpolated render timestamp as the live car. It does not render directly from the 60 Hz fixed-step clock, so uneven or higher-refresh display frames cannot expose the ghost as repeated positions followed by jumps.
- Tracks-to-race handoff hides the lobby immediately, resets the selected track without restoring the start overlay, and starts the countdown without awaiting PB ghost work. Ghost playback freezes when the countdown completes, allowing a canonical submission response received during the countdown to join that attempt without delaying GO.
- `game/race/ui-modal-shell.js` owns the shared result-confirmation UI used by both the finish screen and daily standings. `game/daily-challenge/service.js` sends preview and confirm requests; the browser never composes the public comment itself.
- Daily GP track selection walks the explicit `TRACK_SCHEDULE_KEYS` order from `game/track/catalog.js`, one track per day, using the most-recent published day as the playhead; `src/server/daily-gp-store.ts` persists each new day to the `dailygp:challenges` Redis ledger (first-writer-wins) so past days never change.
- Published Daily GP playlist rows come from server-side challenge history, not from recalculating old dates against the current track file.
- The independent podium scheduler runs hourly at minute 1 for challenges that expired during the previous six hours. The first attempt freezes a sanitized global top-three snapshot before avatar or Reddit work; later attempts reuse it until a canonical post exists or the deadline passes. Reddit identities use the Reddit-hosted Snoovatar URL returned by Devvit; accounts without an exposed Snoovatar, private identities, unavailable avatars, and missing places use Reddit's official hosted default Snoo. Podium posts do not share race-post records or score threads. A Play Now control requests today's featured challenge start override and opens the game entrypoint.
- Explicit mock modes and standalone preview pages use a local mock challenge (`DEFAULT_TRACK_KEY`, or a track forced via `?mockDaily=<trackKey>`); normal local game runs use `/api/daily/*` or Devvit post data so they match the server-published track.
- Daily labels are calendar-based: `Today` is used only when a challenge's stored UTC date matches the current UTC date. Opening an older Reddit post keeps that post's challenge active and playable, but its Tracks and standings labels continue to show the original date. The standings date rail itself always starts from today; loading an older track only selects that day in the rail.
- `leaderboardEntryCount` is the number of players with accepted times. `totalCount` can be larger because it may include the subreddit member total; the UI renders the difference as `No time yet` community placeholders, not as missing player scores.
- Daily leaderboard snapshots are persisted separately in each client's local storage for fast initial rendering. Opening a standings day shows its cached snapshot immediately, then force-refreshes that day from the server once per open standings session; closing and reopening standings starts a new session and refreshes again, while switching back to a day already refreshed in the same session reuses that server result. When a retained mobile WebView becomes visible again, the current challenge is marked stale: visible standings refresh immediately, while closed standings refresh on their next open. Submission responses include `improved`: a valid slower replay returns `accepted: true, improved: false` and causes no standings request, while `improved: true` force-refreshes only the submitted challenge after any older request for that challenge finishes. The last confirmed snapshot remains in memory and local storage until a successful refresh replaces it; while the selected day is refreshing, its cached rows stay readable with a compact header spinner, and a network failure only removes that spinner.

### Home, Campaign, And Player Challenges

- `game/lobby/ui.js` owns the Home, Daily, Campaign, and player-challenge
  panes. `game/modes/launch-target.js` resolves standalone Home, direct mode
  queries, Daily post context, and Campaign challenge post context. The shared
  lobby keeps the original compact `#start-group` footprint with title at the
  top and one bottom-pinned action cluster (`margin-top: auto` on the active
  pane only). Home, Daily, Campaign, and Challenge list secondary actions as
  compact right-anchored mode-action labels; Daily/Campaign/Challenge keep a
  full-width primary Race/Start/Accept button in that same cluster. Daily,
  Campaign, and Challenge mode names (and Daily's track name / Challenge's
  opponent line) sit in a tight `.lobby-subhead` directly under Mini Racer on
  every viewport. Challenge also shows a compact details panel (track, time to
  beat) above Accept.
- `game/campaign/manifest.js` is the immutable `numbered-v1` stage order:
  Number Zero through Nine with fixed `1,1,1,2,2,2,3,3,3,3` laps and Gold/Author
  gating on the preceding stage. `TRACK_CATALOG`/`TRACKS` contain all playable
  geometry; `TRACK_SCHEDULE_KEYS` is only the future Daily publication subset.
- `game/campaign/engine-methods.js` adapts the shared simulation, replay,
  cumulative medal flash, and PB ghost renderer to Campaign and isolated
  player challenges. Campaign and challenge finishes open the result sheet
  immediately (same pattern as Daily), then confirm the run in the background;
  a rejected or interrupted confirmation updates that sheet instead of showing
  a separate saving modal. Campaign finish also paints RANK immediately while
  submitting, then replaces it with the stage leaderboard place after
  confirmation. Follow-up PB ghost and lobby refreshes also stay in
  the background. Campaign client requests abort after 20 seconds so a stalled
  WebView request is terminal. Guest Campaign progress is browser-local.
  Campaign uses the same compact lobby actions and modal shells as Daily:
  Standings selects among unlocked stage-specific leaderboards, while Tracks
  renders permanent stage progress and starts any unlocked stage.
- `src/server/campaign-store.ts` owns signed-in Campaign start state,
  permanent progress, one permanent leaderboard and PB ghost hash per stage,
  replay validation, and server-derived medals. Campaign records do not share
  Daily keys or expiry policy.
- `src/server/campaign-challenge-*` owns verified-result source resolution,
  frozen opponent ghosts, isolated duel results, custom-post idempotency, and
  the three-new-posts per player/subreddit/UTC-day limit. Guests cannot create
  or accept challenges. The challenger cannot accept or submit against their
  own post (`own_challenge`); the in-feed Accept card shows an expired-style
  message and opens Campaign via a stored launch target that overrides challenge
  post data. Duel submissions never call the Campaign store.
- `campaign-challenge.html` is the dedicated in-feed custom-post entrypoint;
  its public post data includes only the immutable race target and no ghost,
  player ID, or private persistence data.
- The full standings modal requests scored racers in 50-row rank pages. `/api/daily/snapshot` and `/api/scoreboard/snapshot` accept `offset` plus `limit` and return `pageOffset`, `pageLimit`, `hasMore`, and `nextOffset`; scrolling near the end loads and appends the next page. Only the first page is persisted in the daily snapshot cache, while later pages are request-keyed by challenge, offset, and limit.
- Standings entry points open that selected-day modal directly. The date rail and touch swipe navigation switch available days inside it; there is no intermediate standings track-picker. The separate Tracks playlist remains the race-selection flow.
- Campaign adapts that same standings rail to unlocked stage numbers. Every
  selection requests `/api/campaign/snapshot` for exactly one `raceId`; results
  and pagination remain isolated per permanent stage. The shared Tracks modal
  swaps its Daily playlist renderer for Campaign progress when entered from the
  Campaign lobby. Opening Campaign paints the lobby immediately from provisional
  or cached progress while `/api/campaign/bootstrap` refreshes in the background;
  Start/Continue, Tracks, and Standings wait for that bootstrap when it has not
  finished yet (Start shows a small button spinner).
- Player standing is independent of loaded pages: every snapshot resolves `playerRank` and `currentPlayerRow`, and the standings header keeps that rank and best time visible even when the player's row is outside the loaded rank range.
- Leaderboard rows and the pinned player time always show three decimal places, matching the verified leaderboard's stored millisecond precision. Race HUD and result timing remain unchanged.
- On touch devices, the standings list accepts deliberate horizontal swipes as an alternative to the day rail: swipe left for an older available day and right for a newer one. The original date strip remains visible, tappable, and horizontally scrollable; swipe navigation does not replace it. Short or vertically dominant gestures, day buttons, links, and the shareable player row keep their existing tap/scroll behavior.

### Server And Shared Validation

- `src/server/index.ts` is the production boot entrypoint only. It creates the
  Devvit server from `src/server/server-app.ts`, whose import-safe app factory
  installs the JSON middleware and registers capability-specific modules under
  `src/server/routes/`.
- Player, competition, sharing, moderator-menu, and scheduler routes
  are registered separately. Route modules own HTTP parsing and responses, while
  `src/server/server-app.ts` only wires their dependencies.
- `src/server/request-context.ts` is the single adapter for request-scoped
  Devvit identity, subreddit, post, and rate-limit context.
- Focused workflow modules own the server behavior outside HTTP: post-bound
  challenge resolution, community context, daily autopost persistence, post
  creation, and moderator authorization.
  These workflows use the existing Daily GP stores and sharing services without
  changing their Redis keys or public contracts.
- `src/server/daily-gp-model.ts` defines the challenge schedule, IDs, playable window, and Redis key model.
- `src/server/daily-gp-store.ts` persists generated challenge records, player profiles, durable player preferences, snapshots, and accepted runs. The existing combined profile/preferences JSON remains in derived per-player keys, with rolling inactivity expiry of 7 days for guests and 30 days for signed-in players. A new guest profile is claimed once with an atomic Redis write; every later bootstrap, preference update, identity update, personalized snapshot, and submission requires the matching signed guest token. Public snapshots remain available without a token but do not expose or refresh player-specific state. Published challenge history is pruned in bounded batches after 30 days.
- `src/server/pb-ghost-store.ts` persists compressed challenge-scoped PB records in one hash per challenge, with hashed player fields. The whole hash expires at `availableUntil + 6 hours` for guests and signed-in players alike. Daily leaderboard keys and payloads are unchanged and receive the same fixed deadline on writes. A track-geometry fingerprint plus simulation revision still invalidates incompatible ghosts.
- Shared Redis locks are token-owned: renewal and release use short watched transactions, so an expired owner cannot extend or delete a successor's lease. Submission and PB locks use 30-second leases; the PB token check and compressed write share one watched transaction. Daily and podium post-creation claims retain their 15-minute crash-recovery TTL and use the same ownership-safe release behavior.
- Guest submission throttling is independent of the signed guest profile ID: the submit route hashes Devvit's server-provided LOID, falling back to the Reddit user ID, and uses that stable request identity for guest rate limits. Signed-in Reddit players remain throttled by canonical account identity, and guests fall back to their authorized profile ID only when Reddit provides neither request identifier.
- Daily GP submission transactions watch and verify the submitting player's owned Redis lock before queuing leaderboard mutations, rather than watching shared leaderboard keys, so different players can commit concurrently while stale owners cannot write. The server returns `accepted: true` only after `EXEC` returns a non-empty result; ownership loss, an empty result, or a missing result becomes a retryable `503`, and the browser keeps the replay in its local verification queue.
- `src/server/community-member-count.ts` reads the public `subscribersCount` through Reddit's community-info API and caches it in Redis for five minutes. Standings use accepted leaderboard entries when Reddit does not return a usable count.
- `game/shared/daily-gp-history-backfill.js` isolates the June 2-11, 2026 published-history seed used to backfill the server history store.
- `src/server/replay-validator.ts` replays submitted inputs against shared track/physics logic before the server accepts a run. Schema rejection, frame-cap checks, finish/ghost results, and failure branches are covered by `tests/replay-validator.test.js` and `tests/replay-validator-branches.test.js`.
- Replay validation samples the verified server simulation at 20 Hz and records an exact finish pose. Schema-v2 traces store a centimetre-quantized origin followed by flattened position/shortest-angle deltas; regular timestamps are reconstructed from the fixed 50 ms interval and only the exact finish time is stored. Ghost traces remain capped at 4,000 samples and 128 KB; the submitted client replay is never used directly for rendering.
- `src/server/daily-gp-post-store.ts` keeps one canonical Daily GP post record per subreddit and challenge day. New post creation does not report success until `src/server/daily-gp-share.ts` has created and pinned that post's score thread; lazy repair is reserved for historical posts created before this contract. Score-thread creation and result sharing hold renewable 30-second token-owned locks, extended every 10 seconds while Reddit calls are pending; ownership loss stops further side effects. The share service validates finish replays or reads the verified standings best, generates the exact comment, and submits player comments only as replies to that score thread after confirmation. Comment formatting, rate limits, and preview/confirm rejection paths are covered in `tests/server-daily-gp-share.test.js`.
- `src/server/daily-podium-service.ts` and its dedicated subscription/post stores keep podium automation independent from playable daily posts. The final reader bypasses only the playable-window filter, not leaderboard verification. The custom post receives a sanitized immutable three-position payload with no player IDs or profile data; only public Reddit identities trigger Devvit's supported Snoovatar lookup, and accounts using Reddit's separate standard profile icons fall back without blocking publication. `src/server/daily-podium-avatar-backfill.ts` and `/api/podium/avatars` repair pre-avatar immutable posts using only their already-public Reddit positions, caching results per post for 24 hours without touching private identities.
- Share previews expire after 10 minutes. Successful shares are idempotent by subreddit, challenge, Reddit user, and exact time for 45 days; a deleted comment clears that stale record and can be shared again. User attribution is checked after submission and a mismatched app-authored fallback is deleted.
- Important implication: track geometry, finish/checkpoint logic, wall-scrape response, and physics tuning are not frontend-only. The server uses the same contracts.

## Major Areas And Their Responsibilities

| Area | Main files | Owns | Depends on |
| --- | --- | --- | --- |
| Boot shell | `game.html`, `game/index.js` | Page structure and app startup | `game/engine.js`, `styles.css` |
| Runtime orchestrator | `game/engine.js` | State ownership and feature wiring | Almost every `game/*` feature module |
| Track system | `game/track/catalog.js`, `game/track/definitions/*`, `game/track/tracks.js`, `game/track/geometry.js`, `game/track/runtime.js`, `game/track/assets.js`, `game/track/engine-methods.js` | Lightweight metadata and schedule order, per-track geometry, collision, cached canvases, presentation | `game/config.js`, `game/track/presentation.js` |
| Race/physics | `game/race/simulation.js`, `game/race/engine-methods.js`, `game/car/handling.js` | Driving feel, wall scrapes, optional collision auto-restart, finish logic, replay capture | Track runtime, config, HUD, modal flow |
| Personal-best ghost | `game/ghost/pb-ghost.js`, `game/ghost/pb-ghost-service.js`, `src/server/pb-ghost-store.ts`, `src/server/pb-ghost-trace.ts` | Challenge PB state, verified trace generation, playback, selected-car rendering | Replay validator, player identity, Redis, settings |
| Car visuals/customization | `game/car/sprite.js`, `game/car/player-car-skin.js`, `game/car/player-trail.js`, `game/settings/garage-ui.js` | Car art, asset loading, garage selection, trail style | `public/assets/cars/*`, generated asset list, local cache, Redis player profile |
| Daily challenge | `game/daily-challenge/service.js`, `game/daily-challenge/labels.js`, `game/daily-challenge/ui.js`, `game/daily-challenge/storage.js` | Featured challenge state, playlist, local bests | Shared schedule, server APIs, preview renderer |
| Campaign and challenges | `game/campaign/*`, `game/lobby/*`, `game/modes/launch-target.js`, `src/server/campaign-*`, `campaign-challenge.html` | Permanent staged progression, Campaign standings/PBs, isolated verified player duels and custom posts | Shared simulation/replay/medal rules, Redis, Reddit post context |
| Leaderboards | `game/scoreboard/service.js`, `game/scoreboard/snapshot.js`, `game/scoreboard/ui.js`, `game/scoreboard/engine-methods.js` | Snapshot normalization, paginated standings display, submissions, verification retry flow, share entry point | API routes, daily challenge storage, server APIs |
| Settings | `game/settings/ui.js`, `game/settings/*.js`, `game/player/preferences.js` | Identity, audio toggles, collision auto-restart and delay, durable preference sync | Browser cache, player APIs, Redis profile, modal helpers |
| Audio | `game/audio/*` | Sound playback | Settings preferences |
| Server | `src/server/index.ts`, `src/server/server-app.ts`, `src/server/routes/*`, focused workflow modules, `src/server/daily-gp-store.ts`, `src/server/daily-gp-share.ts` | Server boot, HTTP contracts, Reddit workflows, persistence, validation, scheduling, canonical posts and result comments | Redis, Reddit API, shared gameplay modules |

## API Surface

These client-facing routes are registered under `src/server/routes/`:

- `/api/player/bootstrap`
- `/api/player/identity`
- `/api/player/preferences`
- `/api/player/track-pbs`
- `/api/player/pb-ghost`
- `/api/scoreboard/snapshot`
- `/api/daily/active`
- `/api/daily/playlist`
- `/api/daily/snapshot`
- `/api/daily/submit`
- `/api/daily/share/preview`
- `/api/daily/share/confirm`
- `/api/campaign/bootstrap`
- `/api/campaign/start`
- `/api/campaign/snapshot`
- `/api/campaign/submit`
- `/api/campaign/pb-ghost`
- `/api/campaign/challenge`
- `/api/campaign/challenge/preview`
- `/api/campaign/challenge/create`
- `/api/campaign/challenge/submit`

The browser-side API route table is `game/scoreboard/api-client.js`; player ID / guest token live in `game/scoreboard/player-identity.js`. Both leaderboard snapshot endpoints normalize their responses through `game/scoreboard/snapshot.js` before UI or cache use.

## Dependency Inventory

### Runtime Product Dependencies

| Dependency | Why it exists | Where it matters |
| --- | --- | --- |
| `@devvit/web`, `@devvit/redis` | Reddit/Devvit server runtime, context, Redis, shared request types, and posting flows | `src/server/*`, Devvit post/menu flows |
| `@devvit/analytics` | Official Devvit Journeys client and server route adapter | `game/journeys/service.js`, `src/server/server-app.ts` |
| `express` | API routing and import-safe app creation inside the Devvit server | `src/server/server-app.ts`, `src/server/routes/*` |

### Build And Quality Dependencies

| Dependency | Why it exists | Where it matters |
| --- | --- | --- |
| `@devvit/start` | Devvit integration for the Vite build | `vite.config.js` |
| `devvit` | Local Devvit CLI for playtest, upload, and publish workflows | `package.json` scripts, `devvit.json` |
| `vite` | Build and local packaging | `vite.config.js`, `tools/bust-client-asset-cache.js` (content-hash query on `dist/client` `game.css` / `game.js`) |
| `vitest` | Test runner | `vitest.config.js`, `npm test` |
| `@stryker-mutator/*` | Mutation testing | `stryker.config.mjs` |

## Change Impact Matrix

Use this table when scoping work. "Primary files" are the places most likely to change. "Review too" means likely ripple checks even if no edit is needed.

| Change request | Primary files | Review too | Why this area ripples |
| --- | --- | --- | --- |
| Car skin or new car art | `public/assets/cars/*`, `tools/generate-player-car-assets.js`, `game/car/generated-player-selectable-car-assets.js`, `game/car/sprite.js`, `game/car/player-car-skin.js`, `game/settings/garage-ui.js` | `styles.css`, `game.html` | New art affects asset discovery, garage options, and fallback loading |
| Car trail options | `game/car/player-trail.js`, `game/settings/garage-ui.js` | `styles.css`, `game/engine.js`, `game/player/preferences.js` | Trail choices are cached locally, persisted in the Redis player profile, and rendered from engine state |
| Car size or render look | `game/config.js`, `game/car/sprite.js`, sometimes `public/assets/cars/*` | `game/race/engine-methods.js`, `styles.css` | Car scale is visual, but shadow and draw sizing live in config/orchestrator flow |
| Car handling / physics tuning | `game/car/handling.js`, `game/config.js`, `game/race/simulation.js` | `src/server/replay-validator.ts`, `game/race/run-policy.js`, `game/race/engine-methods.js` | Server validation reuses shared gameplay logic, so tuning changes affect accepted runs |
| Collision rules, win rules, checkpoint behavior | `game/race/simulation.js`, `game/race/run-policy.js` | `src/server/replay-validator.ts`, `game/daily-challenge/engine-methods.js`, `game/race/result-flow.js` | Scrape and finish logic drive both local UX and server acceptance |
| Multi-lap race rules or medal scaling | `game/race/run-policy.js`, `game/race/simulation.js`, `game/medals/medal-timing.js` | `src/server/replay-validator.ts`, PB/ghost compatibility, checkpoint splits, Daily challenge parsing/caches, result UI | Client and server must use the same persisted lap count; bare track-key PBs and one-lap medal helpers are not safe for mixed race lengths |
| Campaign mode or permanent progression | Campaign manifest, Campaign client adapter, Campaign server routes/store | Shared race specification, simulation, replay validator, medals, track registry, home navigation | Campaign should reuse race mechanics but keep progress, unlocks, leaderboards, and retention separate from Daily GP |
| Track layout or new track | `game/track/definitions/*`, `game/track/catalog.js`, `game/track/tracks.js`, and `game/track/runtime.js` only if geometry handling changes | `game/medals/medal-times.json` (+ `medal-timing.js` if thresholds change), `game/track/presentation.js`, `src/server/daily-gp-store.ts`, `docs/track-authoring.md` | Geometry drives gameplay and replay validation, while catalog order independently controls future Daily GP scheduling and metadata |
| Personal-best ghost behavior | `game/ghost/*`, `src/server/pb-ghost-store.ts`, `src/server/pb-ghost-trace.ts` | `game/daily-challenge/engine-methods.js`, `game/scoreboard/engine-methods.js`, `src/server/replay-validator.ts`, settings and route tests | Daily ranking and challenge-PB writes are separate contracts with one fixed deadline; geometry or simulation revisions intentionally reset incompatible ghosts |
| Track visual treatment only | `game/track/presentation.js`, `game/track/canvas.js`, `styles.css` | `game/daily-challenge/ui.js`, `game/race/ui-modal-shell.js`, `game/track/preview-renderer.js` | One presentation system feeds race view, previews, and modal thumbnails |
| Daily challenge schedule or availability window | `game/track/catalog.js`, `src/server/daily-gp-model.ts`, `src/server/daily-gp-store.ts`, `game/daily-challenge/service.js` | `src/server/post-bound-challenge.ts`, `README.md` if player-facing behavior changes | New challenge generation walks explicit `TRACK_SCHEDULE_KEYS`; playlist availability reads persisted published history so past days do not shift |
| Start screen or daily card copy/layout | `game/daily-challenge/ui.js`, `game/daily-challenge/labels.js`, `game.html`, `styles.css` | `game/daily-challenge/service.js` | Copy helpers are pure in `labels.js`; the UI is driven by API summary fields and modal launch actions |
| Leaderboard snapshot or submit behavior | `game/scoreboard/service.js`, `game/scoreboard/snapshot.js`, `game/scoreboard/ui.js` | `src/server/routes/competition-routes.ts`, `src/server/daily-gp-store.ts`, `src/server/community-context.ts`, `game/scoreboard/engine-methods.js` | Client display and server payload shape must stay aligned; community size and submission rate-limit identity come from trusted server context |
| Result sharing or score-thread behavior | `game/race/ui-modal-shell.js`, `game/daily-challenge/service.js`, `src/server/daily-gp-share.ts`, `src/server/daily-gp-post-store.ts` | `src/server/daily-post-service.ts`, `src/server/routes/share-routes.ts`, `devvit.json`, finish and standings tests | The same confirmation contract serves finish and standings; Reddit user-action permission and post/comment identity are server-enforced |
| Modal redesign or modal flow changes | `game.html`, `styles.css`, `game/race/ui-modal-shell.js`, `game/race/ui-modal-content.js` | `game/ui/reusable-modal.js`, `game/ui/modal-handoff.js`, `game/settings/ui.js`, `game/settings/garage-ui.js`, `game/daily-challenge/ui.js` | There is one shared modal language, even though multiple features use it differently |
| Settings changes | `game/settings/ui.js`, specific `game/settings/*.js` preference files, `game/player/preferences.js` | `game/storage.js`, `src/server/daily-gp-store.ts`, `game.html`, `styles.css` | Settings use browser storage as a cache and the independently expiring Reddit Redis player profile as the durable source |
| Audio changes | `game/audio/*`, `game/settings/car-audio-preference.js`, `game/settings/music-preference.js` | `game/engine.js`, `game/settings/ui.js` | Audio lifecycle is tied to user gesture handling and settings state |
| Devvit Journey lifecycle | `game/journeys/service.js`, `game/engine.js`, `game/race/engine-methods.js` | `game/daily-challenge/engine-methods.js`, `src/server/server-app.ts`, `devvit.json` | Ready, explicit start, monotonic progress, interaction, and end events must remain non-blocking and free of custom persistence or identifiers |
| Replay verification / anti-cheat changes | `src/server/replay-validator.ts`, `game/race/simulation.js`, `game/track/runtime.js`, `game/config.js` | `src/server/daily-gp-store.ts`, `game/scoreboard/engine-methods.js` | This is the highest-risk area because client and server must stay logically identical |
| Moderator workflows, daily or podium autoposting, or public post discovery copy | `src/server/daily-post-service.ts`, `src/server/daily-podium-service.ts`, `src/server/moderator-access.ts`, `src/server/reddit-post-title.ts` | `src/server/routes/internal-routes.ts`, `devvit.json`, `README.md`, `CHANGELOG.md`, route/workflow tests | These flows are server-owned and tied to Devvit/Reddit context; race and podium subscriptions and canonical records remain independent |

## High-Risk Shared Contracts

These are the places where a "small" change can create regressions outside the visible screen:

1. `game/race/simulation.js`
   Changes driving feel, wall scrapes, checkpoints, finish detection, and replay outcomes.
2. `game/track/definitions/*` and `game/track/catalog.js`
   Definitions change race geometry, previews, and replay validation. Catalog order changes which tracks are eligible for future Daily GP publication.
3. `game/track/runtime.js`
   Changes collision smoothing and collision segment generation for both client and server.
4. `game/config.js`
   Changes baseline physics and render-related car constants used broadly across runtime behavior.
5. `src/server/daily-gp-model.ts`
   Changes challenge lifecycle, generated challenge shape, Redis key strategy, and scheduling rules.

## Secondary Tooling Areas

These are useful, but they are not on the critical player path:

- `tools/mapmaker.*`
  Track/content support tooling. Local **Save & Integrate** writes the selected
  definition and updates the catalog and compatibility registry. Authors choose
  whether the track is for **Daily Challenge** (also updates
  `TRACK_SCHEDULE_KEYS`) or **Campaign only** (catalog/registry only). Start
  line and checkpoint edits snap perpendicular across outer/inner walls.
  Manual module and integration exports remain available as fallbacks, as
  described in `docs/track-authoring.md`.
- `tools/runner.*`
  Auxiliary workflow tooling.
- `preview.html`, `preview.js`, `preview.css`
  Custom Reddit post preview entrypoint and standalone local review surface. The current challenge is labeled `Today`; the preview shows its lap count and scaled gold-medal threshold with shared gold medal artwork, and draws the stock in-game car clearly past the start line with a short trail. In-game schematic previews do not use that post-only treatment.

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

For visual changes, use `docs/css-architecture.md` to identify the owning
stylesheet while preserving the manifest's documented cascade order.
