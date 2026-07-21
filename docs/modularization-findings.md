# Modularization Findings

**Date:** 2026-07-21  
**Scope:** `game/`, `src/server/`, shared gameplay contracts (ignore `.stryker-tmp`, `node_modules`, `dist`)  
**Goal:** Smallest changes that give the biggest gains in modularization and separation of concerns

Related: [system-change-map.md](./system-change-map.md) (what owns what today).

---

## Verdict

Do **not** rebuild the architecture.

Feature folders and the “plug methods onto the engine” pattern already work. The main problem is a few oversized files that mix several jobs. Highest payoff is **splitting those files along seams that already exist**, not inventing a new framework.

---

## Current Architecture Snapshot

### How the game boots

1. `game.html` — DOM shell (canvases, HUD, modals, menus)
2. `game/index.js` — boots the app (~57 lines)
3. `game/engine.js` — creates `RealTimeRacer`, wires UI objects, audio, ghosts, journeys
4. Behavior is mixed onto the engine with:

```js
Object.assign(
  RealTimeRacer.prototype,
  trackEngineMethods,
  raceEngineMethods,
  dailyChallengeEngineMethods,
  scoreboardEngineMethods
);
```

### What is already clean

| Area | Why it is healthy |
| --- | --- |
| Feature folders | `race/`, `daily-challenge/`, `track/`, `scoreboard/`, `settings/`, `ghost/`, `audio/`, `ui/` |
| Pure simulation | `game/race/simulation.js` — no DOM / network |
| Pure result helpers | `game/race/result-flow.js`, `game/race/run-policy.js` |
| Track metadata vs geometry | `catalog.js` vs `tracks.js` + `definitions/` |
| Scoreboard pipeline | `api-client.js` → service → `verification-queue.js` → thin scoreboard engine-methods |
| Server route DI | `src/server/server-app.ts` injects store functions into `routes/*` |
| Import graph | No circular imports found; server imports from `game/`, never the reverse |

### What is tangled

| Concern | Where it mixes | Problem |
| --- | --- | --- |
| Daily challenge | `daily-challenge/{service,storage,ui,engine-methods}.js` + server store/model | Activation, finish, verify, ghost, lobby, share, and UI share one fat surface |
| UI modals | `race/ui-modal-shell.js` (+ content / handoff helpers) | Shell knows menus, leaderboard, share, garage, settings — not just open/close |
| Identity + API | `scoreboard/api-client.js` | Player ID / guest token live next to every `/api` route |
| Server Redis facade | `daily-gp-store.ts` | Challenge ledger, player prefs, snapshot, and submit/lock in one file |
| Medals | `medals/medals.js` | Timing rules mixed with SVG / overlay presentation |
| Engine `this` | All `*-engine-methods.js` | Runtime god-object: any mixin can reach any other via `this` |

### Size hotspots (approx. lines)

| File | ~LOC | Role |
| --- | --- | --- |
| `game/race/ui-modal-shell.js` | 2077 | Modal FSM + panels + keyboard |
| `src/server/daily-gp-store.ts` | 1754 | Redis competition / player / submit |
| `game/daily-challenge/engine-methods.js` | 1292 | Win / PB ghost / lobby orchestration |
| `game/daily-challenge/service.js` | 1054 | Network + cache + labels |
| `game/race/engine-methods.js` | 879 | Loop / update / render |
| `game/engine.js` | 579 | Composition root |

---

## Layers At A Glance

```mermaid
flowchart TB
  subgraph client["Client (Devvit post WebView)"]
    HTML["game.html"]
    Boot["game/index.js"]
    Eng["game/engine.js RealTimeRacer"]
    Feat["Feature modules"]
    HTML --> Boot --> Eng --> Feat
  end

  subgraph shared["Shared gameplay contracts"]
    Cat["track/catalog.js"]
    Tracks["track/tracks.js + definitions"]
    Sim["race/simulation.js + run-policy.js"]
    Cfg["config.js + car/handling.js"]
    Med["medals timing rules"]
  end

  subgraph server["Server (Express on Devvit)"]
    App["server-app.ts"]
    Routes["routes/*"]
    Store["daily-gp-store.ts"]
    Val["replay-validator.ts"]
    App --> Routes --> Store
    Store --> Val
  end

  Feat -->|"fetch /api/*"| Routes
  Val --> Sim
  Val --> Tracks
  Store --> Cat
```

**Rule to protect:** shared physics/track modules may be imported by the server. UI/DOM modules must never be.

---

## Recommended Moves (ranked by leverage)

### 1. Split daily-challenge service: labels vs network/cache

**Files:** `game/daily-challenge/service.js`  
**Effort:** S–M · **Risk:** Low

**Today:** One module owns HTTP, localStorage caches, and pure label/copy helpers (`formatDailyChallenge*`, `getDailyChallengeCopyLabels`, modifier badges, card status).

**Change:**
- Move formatters / copy / badges into e.g. `game/daily-challenge/labels.js` (or `copy.js`)
- Leave fetch, playlist/snapshot/submit/share, and caches in `service.js` (optionally later `api.js` + `cache.js`)

**Benefit:** UI and engine methods can use wording helpers without pulling network/storage. Clearest small win.

**Success:** Label helpers have no `fetch` / `localStorage`; importers of labels no longer need the full service for copy-only use.

---

### 2. Split modal shell by panel / concern

**Files:** `game/race/ui-modal-shell.js`, existing `ui-modal-content.js`, `game/ui/menu-keyboard-nav.js`  
**Effort:** M · **Risk:** Medium (focus / keyboard traps)

**Today:** Largest client file; owns open/close plus leaderboard swipe/paging, share panel, garage nav, settings/tracks/standings keyboard behavior.

**Change:**
- Keep `ModalShell` as a thin facade (open, close, focus, pause handoff)
- Move each panel into sibling modules under `game/race/` or `game/ui/modal/`
- Extend the existing shell vs content split rather than inventing a new UI framework

**Benefit:** Menu bugs stop touching race-loop code. Review surface shrinks for UI work.

**Success:** Shell file no longer contains leaderboard paging / share / garage implementation details; `game.html` DOM IDs stay the contract.

---

### 3. Carve daily-challenge engine-methods into mixin slices

**Files:** `game/daily-challenge/engine-methods.js`  
**Effort:** M · **Risk:** Medium–High (finish / verify path)

**Today:** One mixin blob for PB-ghost, lobby/prewarm, and finish/win/clear-run orchestration.

**Natural clusters (keep the same public mixin API):**
1. PB ghost — `markTrackPersonalBest*` … `applyVerifiedTrackPersonalBest`
2. Lobby / prewarm — `setDailyChallengeLobbySummary`, playlist prewarm
3. Finish path — `handleDailyChallengeWin`, `clearDailyChallengeRun`, lap/invalid handlers

**Change:** Split into 2–3 files; re-export one `dailyChallengeEngineMethods` object so `engine.js` barely changes.

**Benefit:** Hardest gameplay+persistence+UI path becomes reviewable and testable in pieces.

**Success:** Same `Object.assign` surface; finish/verify behavior unchanged under existing tests.

---

### 4. Split server `daily-gp-store.ts` by existing export domains

**Files:** `src/server/daily-gp-store.ts`, callers in `routes/*`, `server-app.ts`  
**Effort:** M · **Risk:** Medium (Redis keys / TTLs)

**Today:** ~1754-line Redis facade. Exports already group by duty.

**Suggested file split (same function names):**
1. Challenge / playlist
2. Player bootstrap / prefs / identity
3. Snapshot read
4. Submit + lock + leaderboard write (calls replay validator + PB ghost store)
5. Parsers / normalizers (optional shared module)

**Change:** File-split only; preserve DI injection of named functions into routes. PB is already partly in `pb-ghost-store.ts`.

**Benefit:** Prefs changes no longer sit next to submit concurrency/locks. Smaller review blast radius.

**Success:** HTTP routes and Redis key behavior unchanged; tests for store waves still pass.

---

### 5. Split `api-client.js` into identity vs API routes

**Files:** `game/scoreboard/api-client.js`  
**Effort:** S · **Risk:** Low

**Today:** Misnamed hub — owns player ID / guest token **and** every `/api` URL / fetch helper.

**Change:**
1. `player-identity` (or similar) — localStorage player id + guest token
2. `api-routes` + thin `fetchJson` helper

**Benefit:** “Who is the player?” stops looking like “leaderboard networking.” Call sites already split along those lines (`storage.js`, `preferences.js`, daily-challenge service, PB ghost service).

**Success:** Identity consumers do not import route tables; HTTP consumers do not own token rotation logic.

---

### 6. (Bonus, almost free) Formalize the shared gameplay contract

**Effort:** S · **Risk:** Very low

**Treat as server-safe package surface (document / enforce):**
- `game/track/catalog.js`, `runtime.js`, `tracks.js` (+ definitions)
- `game/race/simulation.js`, `run-policy.js`
- `game/config.js` physics subset / `game/car/handling.js`
- `game/shared/checkpoint-times.js`, `leaderboard-identity.js`
- Medals **timing** rules + `medal-times.json` (not SVG overlays)

**Benefit:** Stops accidental UI/DOM imports into validation; clarifies change blast radius for physics/track edits.

Optional later: thin `shared/` re-export barrel — only if it reduces confusion, not as a big move.

---

## Suggested Follow-Ons (after the top moves)

| Move | Notes |
| --- | --- |
| Split `race/engine-methods.js` render vs lifecycle | Extract Path2D / `render` (+ camera look-ahead) to `race/render.js` or `engine-render-methods.js`; leave `loop` / `update` / `reset` alone. Do **not** touch `simulation.js`. |
| Thin engine via explicit ports | Pass small objects (`{ getChallenge, getRun, journeys, pbGhost, ui }`) into daily/scoreboard flows instead of growing `this.*` soup. Start with verification queue + share preview/confirm. |
| Medals: rules vs presentation | Keep `getMedalForLapTime` / thresholds importable by server/tools; keep SVG overlays client-only. |
| Storage policy module | One place listing keys + read/write policy for guest vs signed-in vs challenge caches — without merging Redis and localStorage. |

---

## What Not To Do

| Expensive move | Why weak payoff |
| --- | --- |
| Replace mixin / `RealTimeRacer` with ECS, full DI, or deep inheritance | Composition root works; pain is file size, not the pattern |
| Big-bang clean-architecture layers across `game/` | Thrash finish/verify/share for little player value |
| Further split `simulation.js` or track `definitions/` | Already well separated; must stay aligned with `replay-validator.ts` |
| Multi-scene framework rewrite of boot | `index.js` + engine constructor is fine |
| Circular-dependency tooling as a priority | Graph already has zero cycles; real issue is fat `this` surface |
| Aggressively sharing runtime modules client↔server beyond pure contracts | Current one-way `server → game` imports are enough |

---

## Patterns To Extend (do not invent new ones)

1. **`*-engine-methods.js` + `Object.assign` onto `RealTimeRacer`** — split *into* this pattern, not away from it.
2. **UI objects with injected callbacks** — `ModalShell`, `SettingsUi`, `LeaderboardsUi`, `RaceHud`, `DailyChallengeUi` constructed in `engine.js`; UI should not import the engine class.
3. **Pure gameplay / data modules** — simulation, result-flow, run-policy, catalog, scoreboard snapshot, `daily-gp-model.ts`.
4. **Thin persistence modules** — `daily-challenge/storage.js`, `game/storage.js`, `settings/*-preference.js`, `last-lap-medal-storage.js`.
5. **Scoreboard pipeline** — service owns I/O; mixin owns orchestration (model for other features).
6. **Server route registration with injected deps** — preserve when splitting the store.

---

## Practical Execution Order

If only a few steps get done, do them in this order:

1. Labels out of `daily-challenge/service.js`
2. Identity out of `api-client.js`
3. Modal shell by panel
4. Daily-challenge engine-methods clusters
5. Server `daily-gp-store` by duty
6. Document shared server-safe imports

Each step should be shippable alone with existing tests green.

---

## Integration Risks To Keep In Mind

1. **Single runtime god object** — after `Object.assign`, any feature can reach any other via `this`.
2. **`daily-gp-store.ts` SPOF** — prefs edits next to submit locks are easy to break together.
3. **Physics shared by import path, not package** — changing `config.js` can affect validator and visuals in one edit.
4. **`tracks.js` mega-registry** — geometry consumers load all tracks; `catalog.js` helps metadata-only cases.
5. **`game.html` DOM contract** — modal refactors are always HTML + JS (+ CSS) triples.

---

## Assumptions

- Static import analysis understates modal/engine coupling (`window`, DOM IDs, callbacks).
- [system-change-map.md](./system-change-map.md) remains the product ownership map; this doc is about **modularity seams**.
- Keep the one-way dependency: server may import pure `game/` modules; `game/` must not import `src/server`.
