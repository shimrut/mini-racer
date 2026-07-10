# Dead And Redundant Code Cleanup

Reviewed and cleaned July 10, 2026.

## Completed cleanup

### 1. Public assets copied into every production build

Vite copies everything under `public/` into `dist/client`, even when no page or module refers to it.

- Tracked and unreferenced: `public/car_sprite.png` plus the three `public/assets/medals/medal_line*.png` files (about 1.5 MB total).
- Local draft logos under ignored `public/assets/logo/` are also copied by local deploy builds (about 8.3 MB in the reviewed checkout).
- `.DS_Store` files under `public/` are copied as well.

The unused tracked assets were removed. Local draft logos and the duplicate medal draft were preserved under ignored `local-assets/`, outside Vite's public copy path. Stray `.DS_Store` files were removed from the shipped asset tree.

### 2. No-op HTML entrypoint rewrite

`fixDevvitHtmlEntrypoints()` in `vite.config.js` searches for old HTML strings such as `?v=1.90`. The current source uses different versions, and the Devvit Vite plugin already emits `/default.js`, `/default.css`, `/game.js`, and `/game.css`. The custom plugin now reads and rewrites the files without changing them.

The custom rewrite plugin was removed. The production build still emits the correct three HTML entrypoints and generated asset names.

### 3. Unused JavaScript functions

Static reference checks across tracked source, local tools, and the test suite found these definitions with no callers:

- `game/storage.js`: `hasAnyTrackData`
- `game/medals/medals.js`: `renderMedalTierStack`
- `game/medals/medals.js`: `renderCombinedHeroMedalPile`
- `game/medals/medals.js`: deprecated `playCombinedHeroPileEntrance`
- `game/medals/medals.js`: `playWinCombinedMedalOverlayEntrance`
- `game/medals/medals.js`: `scheduleMedalStackEntranceAfterModal`

These six definitions were removed. The active medal result flow still uses `renderWinCombinedMedalOverlay` and `scheduleCombinedMedalEntranceAfterModal`.

### 4. Unused CSS branches

The 11 selectors with no HTML or JavaScript producer were removed, including the old `.combined-stat--this-lap` / `.combined-stat--next-medal` result layout, `.daily-playlist-hero-meter*`, `.leaderboard-summary__label`, and `.reusable-modal-close` text-button styling. Active dynamically constructed preview status classes were preserved.

### 5. Font output intentionally retained

The same two WOFF2 files appear both at `dist/client/fonts/*` and at the client root. This looks redundant in a local build, but the CSS-generated root assets are required by the deployed Devvit entrypoints.

The attempted `/fonts/*` consolidation broke font loading in the hosted game and was reverted. Preserve the existing CSS URLs unless font behavior is verified in the actual Devvit hosting path.

### 6. Stale audit and recovery artifacts

The unused `step66.txt`, `diff_recovery.patch`, stale `knip-report.json`, and generated `unused-css-report.json` were removed from the tracked product surface.

## Validation performed

- `npm test`: 52 files and 321 tests passed.
- `npm run build`: passed.
- Current production output was inspected to confirm the removed public assets are absent and the working root-level font files remain.
- The client package excluding source maps is about 1.3 MB in this checkout, down from about 15 MB before cleanup.
- Runtime browser automation was not available because the local `playwright` package is not installed.

## Ongoing rule

Keep local source artwork outside `public/`. Git ignore rules do not prevent Vite from copying ignored files into a build made from a developer checkout.
