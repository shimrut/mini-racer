# What's New

Updates and fixes for Mini Racer. Check back after each release to see what's changed.

For **current behavior** (not past releases), see [README.md — How the game works today](README.md#how-the-game-works-today).

### Current product (authoritative)

- **Daily GP only in the main lobby** — players start today’s challenge from the start overlay; there is no track carousel or per-track Time Trial / Session picker in `game.html`.
- **Track is chosen by the daily challenge** — the client loads `challenge.trackKey` from the API (server default: `cedarRidgeCircuit` in `src/server/daily-gp-model.ts`).
- **`CONFIG.visibleTrackKeys`** — server-supported track allowlist and test guardrails; not a player UI list.
- **All layouts** live in `game/track/tracks.js`; dev tools (mapmaker, runner, TikTok studio) can load any key for editing or bots.

Older entries below describe features that may no longer exist in the client (for example track picker, mode select, or multi-mode lobby).

---

## Latest

Version: `0.7`

### Visual refresh and polish

- **Flatter car visuals** — the car presentation has moved to a cleaner flat-graphic style, and the garage now includes a broader set of car assets to support more visual variety.
- **Sharper track rendering** — track and canvas handling were refined so previews and live runs render more cleanly, hold their layout better, and stay more consistent across screens and resolutions.
- **Bug fixes** — improved daily challenge ranking, caching, and restart flow.
- **Bug fixes** — improved wall collisions and result-screen behavior around returning to the next run.

---

## Previous

Version: `0.6`

### Daily GP

- **New daily event lane** — Daily GP now sits beside Time Trial and Session, with its own card, reset timer, best result, and rank access.
- **Three daily challenge types** — daily events can be fastest 1-lap runs, multi-lap total-time races, or crash-budget survival runs where the goal is to bank the most laps before the final allowed crash.
- **Four car presets** — daily modifiers can now ship as **Stock**, **Muscle**, **Tuner**, or **Hyper** setups.
- **Bug fixes** — improved daily challenge ranking and caching.
- **Bug fixes** — improved wall collisions and mode select copy.

---

Version: `0.51`

### Smoother runs & clearer PBs

- **Steadier feel under load** — camera and pacing were tuned so the frame rate wobbles less, especially on slower devices and in busier corners.
- **Cleaner skid marks** — skids now render as twin tire lines and no longer visually connect across straights between separate slides.
- **PBs stay personal** — tapping **LAP / BEST** opens your own top laps only, while the global leaderboard still lives behind **Rank**.

---

Version: `0.5`

### Global leaderboards

- **Ranked laps go worldwide** — flip a track to **RANKED** when you want your best on the global board; leave it **LOCAL** to keep times private. Time Trial and Session each have their own list.
- **Open the board from Rank** — tap **Rank** on the track card or after a run to see the leaders and where you sit. Other racers show as anonymous names.

Version: `0.47`

### Track visibility & UX refresh

- **Clearer multi-track presentation** — visual updates now make it easier to understand that multiple tracks are available while browsing the selection flow.
- **Refined onboarding and How to Play** — new-player onboarding and the How to Play modal were updated to read more clearly.
- **Updated About and Changelog pages** — the support pages were refreshed for cleaner presentation and navigation.
- **Bug fixes and vulnerability hardening** — various stability fixes and security-related hardening landed across the experience.

---

Version: `0.46`

### Session mode + flow update

- **Mode select before each run** — each track now lets you choose between Time Trial and Session before you start.
- **Longer practice sessions** — Session mode now supports ongoing laps, pausing, session-best tracking, and recent-lap review.
- **Cleaner pause and results actions** — retry, change-track, resume, finish, and share actions are easier to read and faster to use.
- **Smoother onboarding and controls** — the intro and track-select flow were cleaned up, with more reliable keyboard and touch steering.

---

Version: `0.45`

### Sakura Weave & performance update

- **New track: Sakura Weave** — Sakura Weave joined the main track rotation.
- **Smoother heavy-corner performance** — skid marks and particle updates were optimized to reduce frame drops.
- **Sharper display handling** — the canvas now aligns better with device pixel ratio for cleaner high-resolution rendering.
- **More reliable state carry-over** — progression and session state now stay intact more consistently when moving between tracks.

---

Version: `0.44`

### Track select polish

- **Track count is now visible** — the track picker shows where you are in the lineup, so it is easier to see how many tracks are available.
- **Cleaner preview panels** — track previews now sit more cleanly inside the selector and result screens.
- **More reliable PB cards** — personal bests shown on track cards now stay in sync more reliably while moving between tracks and runs.

---

Version: `0.43`

### Results & flow

- **Cleaner post-race screens** — result screens have been tightened up so getting back into another lap feels faster and more direct.
- **Retry wording updated** — the restart button now reads **Race Again**.

### Countdown & visuals

- **Cleaner GO moment** — the green light phase has been removed so the launch cue reads more clearly.
- **Speed streaks removed** — the old speed-line effect around the car is gone for a cleaner look in motion.

### New vs returning players

- **Welcome screen is now truly first-lap only** — once you have a lap saved, the intro welcome screen stays out of the way on future visits.

---

Version: `0.41`

### New track

- **Cedar Ridge Circuit** — Cedar Ridge rotates into the main track slot, replacing Harbor Park Loop.

### Personal bests

- **PB list moved to the HUD** — click or tap the stats bar to open your 5 best laps for the current track after a run ends.
- **Cleaner modal flow** — opening PBs from a win or crash screen now returns to that same result modal when you back out.

### Gameplay & feel

- **Cedar Ridge refinement** — the new track layout has been tightened up for cleaner lines and checkpoint flow.
- **Camera follow restored** — follow behavior is back to the intended feel after the recent mobile camera experiments.

### Mobile & input

- The HUD PB button stays disabled during live runs, then becomes available again once you finish or crash.
