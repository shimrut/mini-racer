# Android and iOS port feasibility

Date: 2026-10-04

Scope: investigation of standalone Mini Racer apps for Google Play and the App Store. No game, server, dependency, or build configuration changes were made. Existing dirty work was preserved. The estimates below describe potential work, not an approved implementation plan.

## Assessment

Porting the racing game is moderate work. Shipping the current online product outside Reddit is substantially more work because Reddit currently supplies authenticated identity, hosting, storage isolation, scheduling, and social actions.

The lowest-effort route is a bundled web game inside Capacitor, keeping the existing JavaScript simulation, Canvas renderer, HTML/CSS interface, assets, and touch controls. Capacitor supports existing web projects and Canvas games: [installation guide](https://capacitorjs.com/docs/getting-started), [games guide](https://capacitorjs.com/docs/guides/games).

A fully native rewrite in Swift/Kotlin or another game engine would require reimplementing rendering, UI, audio, and possibly physics. There is no code finding that makes that necessary before a physical-device prototype. Preserving the existing simulation also makes it easier to preserve race times, medals, and verified ghosts.

## What can be reused

| Area | Current code evidence | Port implication |
| --- | --- | --- |
| Race simulation | `game/config.js` defines a 1/60 second physics step. `game/race/simulation.js` and `game/race/run-policy.js` implement driving, collisions, checkpoints, laps, and finishes. | Keep the current gameplay code. No new engine is required for packaging. |
| Server verification | `src/server/competition/replay-validator.ts:1-11` imports the same simulation, geometry, race policy, and track definitions as the client. | Keep the verifier on the standalone backend. Match rules and track versions between shipped clients and accepted submissions. |
| Rendering | `game/engine.js:127-137` gets an opaque Canvas 2D context and creates the track layer. `game/race/engine-methods.js` renders the track, car, trails, and ground effects. | Compatible in principle with mobile WebViews; frame pacing and memory still require device testing. |
| Input | `game/race/ui-interactions.js:90-200` already supports two touch steering sides, cancellation, lost fingers, and mouse/pen fallbacks. | Existing controls are a strong starting point. Verify simultaneous touches and OS gestures in the native shell. |
| Responsive UI | `pages/game.html` sets `viewport-fit=cover`; `game/ui/visible-viewport.js` tracks the visible height. Existing styles use safe-area insets and portrait/landscape rules. | Adapt system-bar behavior and confirm the existing layout on phones and tablets. |
| Audio | `game/audio/*` uses Web Audio with first-gesture preparation and visibility handling. `procedural-music.js:1021-1056` already handles gesture-based context resume. | Reuse the audio implementation, then test interruption/resume and device audio behavior. |
| Content/assets | `game/track/client-registry.js:5` uses Vite dynamic imports for built-in definitions; fonts and car assets are local. | Bundle built-in tracks and assets in the application for dependable startup. Remote tracks still need content APIs. |
| Existing independent gameplay surface | `tools/mapmaker-playtest.js` imports the production simulation, geometry, rendering, and HUD. `tools/build-site.js:20-34` builds that Test Drive outside Devvit. | Evidence that the gameplay modules can run outside the Reddit shell. This is not a standalone build of the complete product. |

No Capacitor configuration, Android project, or iOS project was found in the application source. `vite.config.js` currently uses the Devvit build plugin; the native target would need a separate Vite output with a root `index.html`, as required by Capacitor.

## What prevents a simple wrapper from being the complete port

### Backend hosting and authenticated identity

`src/server/index.ts:1-4` starts the Express application through Devvit. `game/scoreboard/api-client.js:6-37` points at relative `/api` routes, and `game/scoreboard/player-request.js:36-39` resolves them against the current page origin. A packaged local origin does not provide those services.

Signed-in ownership comes from trusted Devvit request context: `src/server/request/request-context.ts:1-12` reads username and Reddit user ID, and `competition-identity.ts:343-371` derives account identity from that context. A username submitted by a mobile client is not authentication. A standalone online release needs its own authenticated sessions and public API deployment.

The installed SDK injects a Devvit bearer token into same-origin requests (`node_modules/@devvit/web-view-scripts/fetch.js:1-15`). That platform credential is another reason not to assume that pointing a native app at today's hosted `/api` endpoints works.

Current [Reddit External Endpoints documentation](https://developers.reddit.com/docs/capabilities/server/external-endpoints) offers a possible server-to-server bridge. It is limited-access, requires secret tokens, and is for trusted services. Managed tokens execute as the app account rather than the individual player; the documented rate limit is currently five requests per second. No external endpoints are declared in this repo. This does not supply a ready mobile-account API or guarantee that a progress bridge will be approved. Shared Devvit credentials belong only on a trusted backend.

Rechecked 2026-10-04: the documented external storage path is `mobile app -> trusted CF backend -> approved Devvit external endpoint -> installation Redis`. This invokes our Devvit code rather than opening a direct Redis connection. It can support controlled progress export/linking; using it as the entire native backend would require confirmed access and sufficient request limits. The existing routes also derive player identity from Devvit context, so a managed app token cannot substitute for player authentication.

### Minimum-change home for leaderboards and replay validation

For the standalone target, the deployment that preserves the most existing storage code is one Node.js/TypeScript API service on a VPS or cloud container, backed by persistent Redis with backups. Android and iOS would use the same HTTPS API and boards. No hosting provider has been selected or deployed. The follow-up [hosting cost investigation](./mobile-backend-hosting-costs-2026-10-04.md) compares managed PostgreSQL plus object storage against an all-Cloudflare Workers + D1 + R2 option. D1 is viable while each relational database stays below its 10 GB cap; large ghost objects go in R2. Either SQL option requires additional storage-layer work.

- **Replay validation runs in the API service.** Reuse `src/server/competition/replay-validator.ts` and the shared JavaScript simulation. A finish uploads recorded steering inputs; the server selects the authoritative race contract and track, simulates the replay, and derives the accepted time and ghost. The replay is simulated as fast as the server can compute it; it does not wait for the real-world lap duration.
- **Leaderboards live in Redis.** The current implementation already writes ranked scores to sorted sets and entry metadata to hashes (`src/server/competition/competition-leaderboard.ts:277-284`). Redis officially documents this ranking use case in its [sorted-set guide](https://redis.io/docs/latest/develop/data-types/sorted-sets/). Port the existing storage semantics to the standalone Redis client.
- **Verified ghosts and personal bests remain server records.** `src/server/competition/pb-ghost-store.ts` currently stores them through compressed Redis. The first port can retain that design instead of introducing another storage service.
- **The phone renders and caches results.** It may retain pending submissions locally, but the server controls acceptance and persistent ranking. The apps never receive direct Redis credentials.

Today Devvit hosts the server execution and Redis. For the standalone version, our own backend takes over those responsibilities. Sharing the same boards with Reddit players remains a separate authenticated integration and race-version compatibility decision.

### Storage, content, and progress

The stores use Devvit Redis. `src/server/tracks/track-store.ts:30-31` documents installation isolation, and `:195-204` uses subreddit context for catalog scope. The standalone product must decide whether it has one global catalog/leaderboard or separate communities.

Using a conventional Redis deployment could preserve much of the service logic, but the storage boundary must preserve existing transactions, expirations, lock ownership, retries, and compressed values. For example, `competition-identity.ts:574-600` uses WATCH/MULTI/EXEC, and `src/server/player/player-token.ts:13-28` provisions the guest-token signing secret through Redis. Replacing package imports without checking those semantics is insufficient.

The current Campaign is server verified, rather than a complete local-only campaign. `game/campaign/service.js:126-180` obtains the catalog, progress, standings, and unlocks from bootstrap. `game/track/client-registry.js:72-85` requires authoritative track confirmation by default, including built-in keys. A local-only release therefore needs an explicit local Campaign/progress path and bundled content policy; disabling network calls alone would not preserve the current experience.

Browser `localStorage` currently holds identity, preferences, cached progress, and pending replays. For a native release, durable progress and the submission queue need persistent device storage with recovery after process termination. Lightweight settings and larger replay data need storage appropriate to their size. Capacitor's [Preferences documentation](https://capacitorjs.com/docs/apis/preferences) specifically cautions that mobile operating systems can clear WebView localStorage and provides native storage for small values; it is not a replay database or credential vault.

Existing Reddit progress will not automatically appear in a fresh native WebView. Today's guest-transfer coordinator authenticates a Reddit destination and operates within the current store (`src/server/player/player-account-store.ts:119-188`; `docs/guest-transfer-recovery-spec.md`). A mobile transfer or ongoing sync needs verified account linking, a trusted export/import bridge, explicit conflict handling, and an installation selection. Shared rankings also require compatible content and rules. Treat this as additional scope.

### Reddit-specific features

`game/journeys/service.js:1` imports Reddit analytics. Launch targets use Devvit post data (`game/modes/launch-target.js`). Sharing/navigation use `navigateTo`, `showShareSheet`, and expanded-post APIs (`game/race/ui-modal-shell.js:599,628`; `game/head-to-head/poster-access.js:79,88`). These need standalone equivalents or platform-specific adapters.

Head to Head is asynchronous ghost racing, not a real-time multiplayer server. Its race mechanics can be reused, but current challenge creation and discovery revolve around Reddit posts: `src/server/head-to-head/head-to-head-service.ts:785-827` creates user-authored custom posts and returns Reddit IDs/URLs. Standalone challenges need app links and independent discovery. Comment Time, Brag, pinned score threads, and podium posts need separate product decisions.

Daily contract generation itself is ordinary shared logic (`src/server/daily/daily-gp-model.ts:177-207`). It can run outside Reddit without publishing a Reddit post. Scheduled operations currently come from `devvit.json`, so the new backend needs scheduling where the product still requires it.

Creator and moderator analytics currently authorize through Reddit moderator membership (`src/server/moderator/moderator-access.ts:23-60`). Standalone authoring/admin access requires replacement roles or a deliberate content publishing bridge.

## Mobile integration details worth including in the estimate

1. **Foreground/background behavior:** `game/engine.js:607-632` clears input and changes audio on visibility changes, but that handler does not pause the race. The race loop marks a playing run unranked after a frame gap above 250 ms (`game/race/engine-methods.js:50-52,1267-1269`). Native lifecycle events must enter the intended pause/interruption state and reset timing safely. Capacitor exposes foreground, pause/resume, deep-link, and Android Back events through its [App plugin](https://capacitorjs.com/docs/apis/app).
2. **Local-origin detection:** `game/track/environment.js:1-21` treats localhost as development, exposing debug hooks and disabling delayed automatic verification retries (`game/scoreboard/engine-methods.js:146`). Capacitor's [configuration](https://capacitorjs.com/docs/config) defaults to a localhost hostname. A production native build needs explicit environment handling; it cannot rely on the current hostname test.
3. **Navigation and links:** map Android Back to the current menu/modal/pause state, and route app links into the selected challenge. Replace Reddit navigation and sharing APIs.
4. **Rendering and audio acceptance:** test a representative iPhone and a modest Android phone, both screen orientations, sustained races, high-refresh displays, cold launch, backgrounding, and audio interruptions. Main-thread Canvas rendering is portable in principle, but local unit tests do not prove smoothness or battery behavior.
5. **Distribution:** signing, icons, launch screen, screenshots, metadata, privacy declarations, and review are additional release work. Apple's [review guidelines](https://developer.apple.com/app-store/review/guidelines/) require adequate entertainment/functionality beyond a repackaged website and independent operation. The existing playable game is a useful starting point; store acceptance has not been tested.

## Rough effort ranges

These are engineering judgments for one experienced developer, covering both platforms with one shared web implementation. Each row is a total scope, not an amount to add to the row above. They exclude store-review queues, external access approvals, new monetization, and new gameplay features.

| Deliverable | Complexity | Active development estimate |
| --- | --- | --- |
| Physical-device prototype with a few bundled tracks, touch controls, rendering, and audio | Low to moderate | 3-7 working days |
| Polished local-first release with bundled Campaign, Garage, local PBs/progress, lifecycle handling, and release preparation | Moderate | 2-4 weeks |
| Independent online release with accounts, Daily, Campaign, saved progress, verified leaderboards, and ghosts | Medium to high | 6-12 weeks |
| Broad parity including existing Reddit progress or shared rankings, challenge links/discovery, social replacements, and content/admin operations | High, with external dependencies | 10-16+ weeks |

The server review alone suggests approximately 2-5 weeks for an independent online backend (add approximately 2-4 weeks if moving from Redis to Cloudflare D1; see [hosting costs](./mobile-backend-hosting-costs-2026-10-04.md#sizing-at-reported-traffic-2026-10-06)), or 4-8+ weeks for broad online/social/migration parity, before the rest of the mobile work. An engine/native rewrite would be a separate project measured in months, with extra work to preserve physics and verified times.

The main estimate uncertainty is the product boundary: independent mobile accounts and boards are simpler than sharing existing Reddit accounts, progress, and competitions. Phone performance is the other major unknown until the prototype runs on actual hardware.

## Recommended sequence

1. Create a separate native web build and Capacitor shell that imports existing game modules. Run a small bundled-track prototype on both physical platforms.
2. Verify control feel, frame pacing, audio, interruption/resume, and durable local progress. Use that evidence to commit to the wrapper approach.
3. Choose local-first or online scope. For an online version, deploy the existing service structure behind independent authentication and storage while retaining replay validation.
4. Add standalone challenge links and optional Reddit account/progress integration only after the independent game works reliably.

Keep changes at the existing build, service, identity, persistence, and platform-action boundaries. A wholesale engine or UI rewrite is not justified by this investigation.

## Validation performed

Read the README, system change map, CSS architecture, Campaign architecture, build configuration, relevant client runtime paths, and server identity/storage/validation paths. An independent read-only server review checked the backend boundaries. Checked current primary Capacitor, Reddit, and Apple documentation.

Ran:

```sh
node node_modules/vitest/vitest.mjs run tests/simulation-mechanics.test.js tests/simulation-run-policy.test.js tests/replay-validator.test.js tests/visible-viewport.test.js
```

Result: 4 files passed, 58 tests passed. Vitest's existing global setup regenerated the selectable-car module with no Git diff. No test expectations were changed. These tests validate selected existing behavior only; no Android/iOS build, emulator run, physical-device acceptance, hosted external-endpoint access, or store submission was performed.
