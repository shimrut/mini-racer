# Changelog

- Added independently enabled final podium posts at 00:01 UTC. Each post freezes the global top three verified results for the track leaving the seven-day window, respects each finalist's username/private-name setting at publication time, and safely fills empty places when fewer than three racers finished.
- Pressing plain `R` now restarts the race while playing, paused, or on the finish screen. Modifier combinations such as Ctrl/Cmd/Alt/Shift+R keep their normal browser behavior and do not restart.
- Fixed PB ghost motion using the raw 60 Hz simulation clock instead of the live car's interpolated render timeline, which made the ghost visibly step when first-run frame pacing was uneven.

How the game works: [README.md](README.md#how-the-game-works).

## 0.7

- Added persistent personal-best ghosts per player and track. Verified lifetime
  track PBs now survive daily challenge dates, return when a track is featured
  again, and can be followed as a highly transparent, collisionless copy of the
  player's selected car; the default-on ghost can be disabled in Settings.
  Custom-post startup now prepares the resolved track's ghost before the lobby
  appears, including historical posts and today's fallback for expired posts,
  and the first race reuses that prepared asset instead of rebuilding it.
- Selecting a race from Tracks now transitions directly into track preparation
  and the countdown instead of briefly restoring the home screen; PB ghost
  retrieval runs concurrently and no longer delays race startup.
- Added Number One and Number Two to the Daily GP schedule with dedicated
  geometry modules and medal targets, while preserving the existing 45-track
  registry unchanged.
- Split the large track registry into lightweight catalog metadata, explicit Daily GP schedule order, and one geometry module per track. Metadata-only consumers no longer load full geometry, while rendering, collision, previews, and server replay validation retain the same assembled `TRACKS` contract.
- Mapmaker can now save and integrate a track directly through the local development server. New tracks append to the Daily GP schedule, existing tracks update in place, and confirmed renames replace the old source and registry entries.
- Split the Devvit server into a boot-only entrypoint, an import-safe composition root, capability-specific route registrars, and focused Reddit/Redis workflow modules without changing endpoints, response shapes, Redis records, or moderator behavior.
- Guest submission throttling now uses a hashed server-provided Reddit request identity, so generating a new signed guest profile no longer resets the rate-limit window.
- Fixed Android Reddit app sessions that could show only the car over a white background. Android now uses the reliable main-thread track renderer, while iOS and web clients retain the worker-rendered track path.
- Every wall collision now costs momentum but lets the lap continue, including severe head-on impacts; the collision body follows the car's visible orientation so nose, side, and rear contact resolve consistently.
- Removed the terminal crash screen. The former crash auto-restart setting is now optional `Collision Auto-Restart`, defaults off, and restarts the attempt after a scrape only when the player enables it.
- Players can now preview and confirm a Reddit-attributed result comment from the finish screen, or share a verified best from the selected day in Standings. The server validates the result, derives the medal and copy, and prevents duplicate shares of the same time.
- Daily post creation now reuses one canonical post per subreddit and challenge day and does not report success until its Mini Racer score thread is pinned. Older posts are repaired lazily so result sharing also works for available historical days.
- Result sharing fails closed if Reddit cannot attribute the comment to the acting player; the app removes the fallback comment instead of silently posting it from the app account.
- Guest profiles are now claimed atomically on first bootstrap and require their signed token for later profile reads, preference or identity changes, personalized standings, and submissions. Browsers that lose the credential rotate to a new guest identity once without clearing local settings or run data.
- Player profiles now use individually expiring Redis records, so one active player no longer refreshes the retention window for every historical profile. Retired shared-hash records are ignored and expire naturally rather than being migrated over current preferences.
- Standings now read Reddit's public subscriber count through one supported community-info request and cache it for five minutes, replacing repeated moderator/approved-user listings and redundant fallback calls on every leaderboard page.
- Player car, trail, audio, music, and collision-restart preferences now persist in the existing Reddit Redis profile and are restored during startup, rather than relying only on browser storage that can reset after an app update.
- The complete Vitest suite is now tracked in Git instead of being excluded by `.gitignore`.
- Opening standings or Tracks from an older Reddit post now shows that challenge's original UTC date instead of incorrectly calling the post-bound track `Today`.
- Standings now load every scored racer in 50-row pages as the list is scrolled, while the current player's rank and best time remain visible in the header regardless of which ranks have loaded; the initial rank-loading state is compact and aligned with that header.
- Mobile standings can now switch between available days by swiping left or right, while the existing horizontally scrollable date strip remains visible and tappable and vertical standings scrolling continues to work.
- Upgraded the Devvit toolchain to 0.13.7 with Vite 7.3.6, aligned server imports with declared Devvit packages, and removed the deprecated no-op inline entrypoint flag.
- Standings now show cached results immediately and then force-refresh the selected day from the server each time standings are reopened, keeping web and mobile entry counts aligned without replacing usable cached results when a refresh fails.
- Returning to a retained mobile WebView now refreshes visible standings, or marks the current challenge stale so its next standings open cannot reuse an outdated racer count.
- Daily Reddit posts now use the concise `Mini Racer, {D MMM}: {track name}` title format, while the text fallback supplies indexable product, control, medal, leaderboard, and availability information without requiring track-specific descriptions.
- Reduced the production game bundle by canonicalizing module imports, removing unused helpers, and deleting legacy proxy configuration scaffolding.
- Removed disabled analytics pageview, player-type, map-selection, menu, and mode-selection plumbing while preserving the active game lifecycle and race event set.
- Removed the retired intermediate standings track-picker and its rank-card styling, plus an unused modal icon/keyboard-hint renderer; current Tracks, Standings, swipe navigation, and combined action buttons are unchanged.
- Consolidated client leaderboard snapshot normalization and moderator menu-action error handling without changing public routes or response shapes.
- Removed unused JS helper exports and an unused player-status store left behind after earlier flow changes.
- Removed an orphaned leaderboard next-target helper that was never wired into the tracked app UI.
- Removed stale HTML IDs and modifier classes that no longer drive gameplay, modal, garage, analytics, or tool behavior.
- Removed stale result-modal, playlist, preview, and moderator-tool CSS selectors that no longer match the shipped UI.
- Start overlay spacing is tighter on the common Reddit desktop and mobile window sizes, so the title, utility actions, and primary CTA stay visible without feeling oversized.
- Restored lobby menu width, utility icon/label sizing, and the three-column Garage car grid after a UI rollback.
- Garage car names now omit Mini, Cyber, and Steam family prefixes.
- Flatter car visuals and expanded garage assets
- Sharper track rendering and canvas layout across screens
- Daily challenge ranking, caching, and restart fixes
- Daily challenge submission stages now surface live player status: submitting, verifying, pending, retrying, and terminal errors
- Daily GP track rotation now walks `game/track/tracks.js` in key order, one track per day, with a server-side ledger freezing each published day so adding or reordering tracks never reshuffles days already published
- Daily GP playlist rows now come from server-side published history instead of recalculating past days from the current track file
- Added server/shared backfill for the June 2-11, 2026 published Daily GP history
- Local Daily GP runs now use the server/post-bound featured challenge path unless an explicit mock or standalone preview mode is requested
- Wall collision and post-run flow fixes
