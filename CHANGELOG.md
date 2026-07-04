# Changelog

How the game works today: [README.md](README.md#how-the-game-works).

## 0.7

- Start overlay spacing is tighter on the common Reddit desktop and mobile window sizes, so the title, utility actions, and primary CTA stay visible without feeling oversized.
- Restored lobby menu width, utility icon/label sizing, and the three-column Garage car grid after a UI rollback.
- Garage car names now omit Mini, Cyber, and Steam family prefixes.
- Flatter car visuals and expanded garage assets
- Sharper track rendering and canvas layout across screens
- Daily challenge ranking, caching, and restart fixes
- Daily challenge submission stages now surface live player status: submitting, verifying, pending, retrying, and terminal errors
- Daily GP track rotation now uses all tracks from `game/track/tracks.js` automatically when generating new challenges
- Daily GP playlist rows now come from server-side published history instead of recalculating past days from the current track file
- Added server/shared backfill for the June 2-11, 2026 published Daily GP history
- Local Daily GP runs now use the server/post-bound featured challenge path unless an explicit mock or standalone preview mode is requested
- Wall collision and post-run flow fixes
