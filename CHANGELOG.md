# Changelog

How the game works today: [README.md](README.md#how-the-game-works).

## 0.7

- Daily Reddit posts now use `Mini Racer TOTD` consistently in the post title and plain-text fallback.
- Reduced the production game bundle by canonicalizing module imports, removing unused helpers, and deleting legacy proxy configuration scaffolding.
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
