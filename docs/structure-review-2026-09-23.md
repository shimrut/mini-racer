# Structure Review (2026-09-23)

Scope: module size, module boundaries, and separation of concerns in `game/` and
`src/server/`. This review does not repeat the dead-code and duplicated-code audits. For
those, see `docs/remaining-cleanup-2026-09-23.md`. No code was changed.

The earlier review is `docs/modularization-findings.md` (2026-07-21). Its moves 1, 5, and 6
are done. Its moves 2, 3, and 4 are not done, and the files it named are now larger.

## Summary

- The code does not need a new architecture. The feature folders, the mode loader, and the
  shared server competition layer work.
- The main problem is three large files. Each file does two or three unrelated jobs.
- Most of the fix is to move code, not to change it. A move does not make the code smaller.
  The line cuts that are left are the items in `docs/remaining-cleanup-2026-09-23.md`.

## Growth since July

| File | 2026-07-21 | 2026-09-23 |
|---|---|---|
| `src/server/daily/daily-gp-store.ts` | 1,754 | 3,472 |
| `game/race/ui-modal-shell.js` | 2,077 | 2,822 |
| `game/engine.js` | 581 | 980 |
| `game/daily-challenge/engine-methods.js` | 1,312 | 1,415 |

## What works (keep it)

- Server routes get their store functions from `server-app.ts`. The routes do not import
  the stores directly.
- Daily, Campaign, and Head to Head submit, leaderboard, and identity code all go through
  the shared `competition-*.ts` modules.
- `game/modes/runtime-loader.js` loads only the race code for the mode that runs.
- `game/race/simulation.js` has no screen or network code. The server uses it to check runs.

## Findings, ranked by gain for the risk

### 1. Split `daily-gp-store.ts` (server) — high gain, low risk

Only about 1,000 of its 3,472 lines are about the Daily GP. The file holds three jobs:

| Job | Approx. lines | Where |
|---|---|---|
| Guest progress transfer (evidence, selection, receipts, merge, clean-up, diagnostics) | ~1,950 | 199–560, 929–1036, 1211–2735 |
| Player account (bootstrap, preferences, identity, track PB summaries, PB ghosts) | ~480 | 2735–3211 |
| Daily GP (challenge schedule, snapshot, podium, playlist, submit) | ~1,000 | the rest |

Move the first two jobs to their own modules, for example `guest-transfer/daily-*.ts` and
`player-account-store.ts`. Do not change the code in the same commit. Keep every Redis key.

The Campaign and car-unlock stores hold the same kind of guest-transfer code (about 450
lines in `campaign-store.ts`, lines 882–1399). Move that code next to the Daily part. Then
the three merges are in one folder. That also makes the open "keep the best of both"
removal (section 3 of the remaining-cleanup file) easier to review.

### 2. Split `ModalShell` (client) — high gain, medium risk

`game/race/ui-modal-shell.js` is the largest game file. One class does five jobs:

| Job | Approx. lines | Where |
|---|---|---|
| Leaderboard view (day rail, header, paging, swipe, row share, opponent race) | ~700 | 2120–2815 |
| Result screens (pause, main, combined, win medal, next race) | ~550 | 1198–1750 plus 532–832 |
| Share panel | ~330 | 869–1198 |
| Menu keyboard navigation (Garage, Settings, Tracks, Standings) | ~320 | 131–450 |
| Focus trap and open/close | ~250 | 1749–2120 |

Keep `ModalShell` as the owner of open, close, focus, and pause. Move each of the other
jobs into its own module that the shell calls. `game/race/ui-modal-content.js` and
`game/ui/menu-keyboard-nav.js` already exist as places for this code.

Risk: keyboard focus and the pause hand-off. Play-check each moved view with the keyboard
and with touch.

### 3. Guest transfer code inside the client run queue — medium gain, low risk

`game/scoreboard/verification-queue.js` (1,131 lines) keeps runs that wait for a server
check. About 470 of its lines (359–826) are transfer blocks, quarantine, and owner moves.
Move these lines to a module such as `verification-queue-transfer.js`. The queue then only
stores, retries, and expires entries.

### 4. A misnamed file — small gain, very low risk

`game/storage.js` does not hold storage helpers. It loads the player's progress state from
the server and exports only `getPlayerProgressState`. Move it to
`game/player/progress-state.js`.

### 5. Flat server folder — medium gain, low risk, many import changes

`src/server/` has 67 files in one folder. The names already show the groups: `daily-*`
(13), `head-to-head-*` (10), `redis-*` (5), `competition-*` (4), `guest-*` (3), and more.
Move each group into a subfolder. Do this after finding 1, so that each file moves once.

### 6. The engine object — the root cause, do not rewrite

`RealTimeRacer` gets its methods from ten mixin files. Together they use 335 different
`this.` fields. The constructor in `game/engine.js` sets 156 of them. Any mode can read or
change the state of any other mode. This is why Daily and shared race code drifted apart.

A rewrite is high risk and gives the player nothing. Instead, when you work in a mode,
move that mode's fields into one object that the mode owns (for example `this.campaign`).
Do this one mode at a time, and only in code you already change.

### 7. Other items (low priority)

- Network calls: nine client modules call `fetch` on their own. Campaign and Head to Head
  already share one request helper. This is the open "Request timeouts" decision in the
  remaining-cleanup file.
- Repository root: seven page entries (HTML, JS, CSS) and loose files such as
  `page-snapshot.md`, `progress.md`, and `unused-css-report.json` are at the top level.
  A `pages/` folder would help. Check the Vite and Devvit entry paths first.
- `tools/tiktok-studio.js` is 4,809 lines in one file. It is a developer tool. Leave it.

## Progress

Branch `chore/structure-moves`, started from `chore/duplicate-cleanup` at `4ad66b4`.

- Finding 4 is done in `adff3f6`. The file is now `game/player/progress-state.js`.
- Finding 5 is done. The 64 server files are now in 12 folders: `daily/`, `podium/`,
  `head-to-head/`, `campaign/`, `competition/`, `player/`, `guest-transfer/`, `posts/`,
  `moderator/`, `redis/`, `request/`, and `shared/`. `index.ts`, `server-app.ts`, and
  `routes/` stay at the top. No file name and no code changed. It was done before finding 1,
  because finding 1 makes new files and does not move the old ones.

- Finding 7, repository root: done. The seven pages, their scripts, and their stylesheets are
  in `pages/`, and `fonts.css` is in `styles/`. Car pictures load from the site root, so a
  page works from any folder. `tests/page-links.test.js` fails on any page, stylesheet,
  font, or car picture link that points at a missing file. The local preview is now
  `http://127.0.0.1:8000/pages/game.html`.

- Finding 1, player account part: done. Bootstrap, preferences, identity, track PB
  summaries, PB ghosts, and the step that applies the guest progress choice moved to
  `src/server/player/player-account-store.ts` (641 lines). The Daily file is 2,872 lines.
  The new file imports from the Daily file; the Daily file does not import the new file.

## Order of work

1. Finding 4 (one file move).
2. Finding 1 (move-only commits, one job per commit).
3. Finding 3.
4. Finding 2 (one view per commit, a play-check after each).
5. Finding 5.
6. Finding 6 only as part of other work.
