# Changelog

- Expanded mutation tests for `game/daily-challenge/service.js`, `daily-gp-store.ts`, `daily-gp-share.ts`, `simulation.js`, `result-flow.js`, `verification-queue.js`, and `pb-ghost-trace.ts` with active-cache endsAt boundaries, playlist/snapshot expiresAt >1s filtering, formula-based simulation assertions, hasSeenGame=false bootstrap reads, rate-limit TTL-once behavior, combined-rank formatting, and share post recovery guards.
- Expanded `game/daily-challenge/service.js` mutation tests with 39 focused cases for mock URL params, cache trim/clear paths, playlist expiry boundaries, hydrate-once guards, snapshot expiry persistence, best-result tie handling, fetch route/method assertions, and submit/share payload edges.
- Expanded mutation tests for `daily-gp-store.ts`, `daily-gp-share.ts`, and `daily-challenge/service.js` with guest-token mismatch guards, podium minute formatting, preview/shared-record field validation, post-recovery fallbacks, local-vs-snapshot best-time merge, and daily submit/time-label boundaries.
- Added 18 precision mutation tests in `tests/simulation-branches.test.js` targeting `game/race/simulation.js` survivors on acceleration drag (L574, L578, L582-L583), reverse braking (L586-L587), steer grip and slip-gate hysteresis (L603, L614, L619, L621, L630), skid thresholds (L735, L737), run-history rounding (L761), wall-radius overlap (L229), swept half-length (L255), scrape velocity (L435, L438-L440, L443), repeat-suppression (L704, L706), downforce (L596), steer trim (L538), contact tie-break (L302, L304, L305), and event-singleton reset (L8-L19).
- Expanded server mutation tests for Daily GP store/share flows, PB ghost retention, and post-bound challenge resolution, covering ledger maintenance, track-rotation fallbacks, corrupt Redis records, share/score-thread lock-loss paths, and additional parsing edge cases.
- Expanded mutation tests for daily-challenge service mock/cache fallbacks, simulation contact-normal branches, Daily GP store submission guards, share confirm idempotency, verification snapshot stages, and result-flow empty-run stats.
- Expanded mutation tests for verification-queue expiry normalization, result-flow rank/delta branches, PB ghost trace pose validation, daily-challenge storage rollback guards, player-bootstrap payload fallbacks, PB ghost-store schema rejection, Daily GP model boundaries, and scoreboard-service inflight recovery.
- Expanded `tests/simulation-branches.test.js` with 21 additional branch tests for event-snapshot reset, physics-config fallbacks, slip-gate hysteresis, checkpoint array repair, negative collision-hash buckets, swept nose contacts, overlap resolution, scrape-config defaults, and route-trace/run-history precision.
- Raised `game/race/simulation.js` mutation coverage with 37 branch-focused unit tests for checkpoint splits, collision broadphase fallbacks, driving-physics gates (downforce, slip clamp, steer trim), swept/degenerate wall contacts, and scrape-severity weighting.
- Expanded `game/daily-challenge/service.js` mutation tests for active-cache hydration/clearing, playlist prune/hydrate/dedupe/cap paths, snapshot sync and corrupted-cache reads, in-flight snapshot cleanup, card-status timing boundaries, and submit/fetch guard rails.
- Raised mutation coverage on weak modules with targeted unit tests: guest player tokens, car handling, moderator access, checkpoint-time normalization, PB ghost traces, result-flow rank/stats helpers, and verification-queue legacy expiry.
- Expanded `daily-gp-store.ts` mutation tests for snapshot player-rank windowing, empty leaderboard states, stored-challenge type coercion, profile timestamp fallbacks, challenge-history maintenance edges, and submission identity rejection paths.
- Raised `daily-gp-share.ts` mutation coverage from ~56% to ~72% and `daily-challenge/service.js` from ~57% to ~68% by covering historical Reddit-post recovery, post-registration race conditions, score-thread anchor reuse/rebuild/lock-loss paths, corrupted share/preview records, localStorage cache read/write/hydration failures, in-flight playlist and snapshot request dedupe, and remaining formatting/boundary mutants.
- Expanded daily-challenge service tests for card-status boundaries, best-result merge, snapshot prefetch, mock playlist fallback, expired post handling, and local share/submit guards.
- Expanded mutation soft-spot tests for player bootstrap storage, daily-challenge mock/cache normalization, and Daily GP share validation, rate limits, and comment formatting.
- Tightened replay-validator tests against remaining mutation survivors: crash signal variants, non-finite failure details, missing winData, fixedDt fallback, and initial simulation state.
- Expanded server replay-validator tests for payload schema, frame-cap boundaries, failure details, ghost output, checkpoint splits, and hard-to-reach rejection branches.
- Added unit tests for client scoreboard replay recording so input compression, frame caps, overflow discard, and payload copying are covered.
- Made submission, PB, score-thread, sharing, and post-creation Redis locks ownership-safe. Submission and PB leases now last 30 seconds, long Reddit operations renew their lease, and stale requests cannot delete a successor's lock or commit protected writes.
- Restored the instant lobby reveal after loading by preparing its title and controls behind the loading-screen fade while keeping Start input and Devvit `App.Ready` gated until dismissal completes.
- Leaderboard rows and the pinned player time now show the full stored millisecond precision by default.
- Added official Devvit Journeys for the expanded race flow: interactive readiness, explicit attempt starts, monotonic checkpoint progress, pause/resume interactions, and complete or incomplete attempt endings. Journey failures never block gameplay, and no player, track, replay, or custom Redis data is attached.

- Replaced lifetime PB and ghost storage with challenge-scoped records that expire six hours after the track leaves its seven-day availability window. Daily leaderboard keys and response formats are unchanged, but now share that fixed deadline.
- Reduced inactive player-profile and preference retention to 7 days for guests and 30 days for signed-in players without changing the stored profile format.
- Bounded published challenge history to 30 days and added resumable maintenance that corrects known live leaderboard deadlines while preserving active entries.
- Changed final podium automation to retry hourly during the six-hour post-expiry window. The first attempt freezes the public top-three payload so retries remain consistent and idempotent.
- Removed custom gameplay and moderator analytics collection, APIs, Redis cleanup code, menu action, dashboard assets, and dependencies. Historical counters expire naturally.
- Reduced verified PB ghost traces by replacing timestamped millimetre JSON tuples with a fixed-20-Hz schema-v2 origin/delta representation using centimetre positions and shortest-angle deltas. A representative 12-second trace is 56.8% smaller raw and 64.3% smaller after gzip without changing playback interpolation or finish timing.
- Started verified score submission at the finish event and returned the canonical challenge-PB ghost in the accepted response, allowing immediate Improve attempts to use the correct verified ghost by GO without a second download.
- Prevented stale ghost responses and rapid track switching from clearing or preparing the wrong track. When an expected verified ghost is not ready at GO, racing starts on time without a ghost and shows a two-second `GHOST UNAVAILABLE` HUD notice.
- Isolated daily result acceptance from challenge-PB Redis failures by persisting both concurrently after one replay validation. PB-only failures now keep the valid daily result accepted, while daily transaction interruptions remain retryable.
- Made the gold podium row larger and added matching silver/bronze side gradients.
- Split final podium places into separate rounded rows with spacing and no borders.
- Restyled final podium posts to match the rounded results panel reference while keeping Mini Racer type, color, and accent rules; removed the red trail divider in favor of the faint track watermark.
- Tightened final podium spacing and lowered the track watermark so results read clearer against the backdrop.
- Removed the dashed empty-time box and gold-place star accents from final podium posts for a quieter layout.
- Added a **Play Now** control on final podium posts that opens today's featured Mini Racer track.
- Fixed the final podium custom post so the red finish-line trail meets the car (dash mask no longer blanks the right side) and the daily track schematic shows as a faint background immediately on load instead of after avatar or car-asset waits.
- Replaced the podium's hand-drawn fallback with Reddit's official hosted default Snoo. Reddit accounts whose standard profile icon is not exposed by Devvit now use that official fallback, and the legacy avatar cache is versioned so existing podiums adopt it immediately.
- Fixed podium public racers incorrectly showing the generic Snoo on posts created before avatar payloads existed. Legacy posts now resolve and cache only their already-public Reddit identities, new posts retain the Reddit-hosted avatar URL directly, and podium names no longer include `u/`.
- Added identity-aware podium avatars: finalists displaying a Reddit username show their publication-time Snoovatar, while private identities and unavailable avatars use a bundled generic Snoo without exposing additional profile data.
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
