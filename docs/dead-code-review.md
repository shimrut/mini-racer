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

The custom rewrite plugin was removed. The production build still emits the
configured HTML entrypoints and generated asset names; each named Devvit
entrypoint now has an explicit HTML input rather than relying on a rewrite.

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

### 7. Duplicate module identities and legacy proxy scaffolding

JavaScript module imports under `game/` mixed canonical paths with manual `?v=` suffixes. Vite treated those as distinct module identities, duplicating shared modules in the production bundle. Module imports now use canonical relative paths; HTML asset query strings remain available for direct-page cache busting.

The old proxy configuration layer also carried unused `serviceMode` state, empty request-header construction, and wrapper functions that only returned the same fixed `/api` routes. Those paths now read one immutable route map, omit empty GET headers, and keep explicit JSON headers for POST requests.

### 8. Additional uncalled helpers

Eight definition-only helpers were removed from the game preview and secondary runner/TikTok tools. They covered abandoned replay interpolation, centerline lookup, easing, and animation-beat calculations with no runtime or test callers.

### 9. Shared snapshot and menu contracts

The scoreboard and Daily GP services now use one client snapshot normalizer and clone path. Moderator menu routes use one registration wrapper for subreddit resolution and neutral error responses while preserving the existing endpoints, messages, navigation responses, and side effects.

## Validation performed

- `npm test`: 52 files and 321 tests passed.
- `npm run build`: passed.
- The full test suite passes with 326 tests across 53 files after the simplification work.
- Current production output was inspected to confirm the removed public assets are absent and the working root-level font files remain.
- The client package excluding source maps is about 1.3 MB in this checkout, down from about 15 MB before cleanup.
- The game entry and required JavaScript preloads are about 333 KB raw / 98 KB gzip, with no source-map duplicates caused by versioned module identities.
- Runtime browser automation was not available because the local `playwright` package is not installed.

## Ongoing rule

Keep local source artwork outside `public/`. Git ignore rules do not prevent Vite from copying ignored files into a build made from a developer checkout.

Keep `?v=` cache-busting suffixes out of JavaScript module import specifiers. Vite already owns production asset generation, and query variants can cause one source module to be bundled more than once.

## Follow-up CSS cleanup: July 15, 2026

The follow-up audit covered every tracked stylesheet and its matching HTML/JavaScript producer, including selectors inside media queries and dynamically constructed runtime classes. The confirmed dead batch was then removed.

Removed from `styles.css`:

- The `.modal-btn` rule family and its exception in the global `button:active` selector. No HTML or JavaScript created that class; active modal actions use `.combined-action-btn`.
- `.pause-race-stats` and `.pause-race-stats[hidden]`. Current pause content is built around `.pause-header` and `.combined-actions`.
- The mobile-only `.daily-leaderboard-entry` rule from an earlier standings-overview layout.
- The base `.combined-stat` and `.combined-stat-value` rules. Current result markup uses `.stat-floating-item`, `.combined-stat-label`, and modifier-specific value classes.
- Unread custom properties `--modal-stack-btn-min-height`, `--mobile-control-size`, and `--leaderboard-row-height`, including their responsive overrides.
- The invalid `padding: 0.6rem 1.var(--space-xl)` declaration on `.hud-pause-btn`, which browsers discarded.

Removed from secondary surfaces:

- Eight unread custom properties from `preview.css`.
- Four unread custom properties from `tools/mapmaker.css`, one from `tools/runner.css`, and four from `tools/tiktok-studio.css`.
- Ignored local `tools/daily-challenge-admin.css`, an orphaned stylesheet with no matching HTML or JavaScript entrypoint.

The dynamically constructed medal tier classes, preview challenge status classes, and runner result/severity classes remain active. The repeated `.hud-lap-cluster`, medal sizing/transition, and win-rank blocks also remain because their declarations are complementary rather than dead.

Validation after removal:

- The follow-up selector and custom-property scan reports only the known dynamically constructed class families and no unread custom properties.
- `npm test`: 57 files and 390 tests passed.
- `npm run build`: passed.

## Producer-aware UI cleanup: July 15, 2026

The selector scan could see producers for the `.daily-leaderboard-standing*` and `.daily-playlist-rank-btn*` classes, but those producers belonged to an unreachable intermediate standings track-picker. Current standings entry points open the selected-day leaderboard directly and switch days through the date rail or touch swipes; the separate Tracks playlist remains active.

The retired overview methods, its mode flag, rank-card CSS, and the unused leaderboard playlist-fetch branch were removed. The unrelated active playlist renderer and full standings flow were preserved.

The result modal also retained an uncalled SVG action-icon factory and button-content helper. Their icon and keyboard-hint payload fields, dedicated test, and `.modal-action-icon`, `.modal-action-label`, and `.modal-btn-kbd` CSS were removed. Current modal actions continue to use the active combined-action button path.

Validation after removal:

- Focused UI regression set: 8 files and 92 tests passed.
- `npm test`: 57 files and 388 tests passed.
- `npm run build`: passed.
- Targeted source and built-output scans found none of the retired methods, payload fields, or CSS classes, while active Tracks, selected-day Standings, swipe navigation, and combined action-button references remain.

## Achievements prototype removal: July 16, 2026

The hidden achievements prototype was removed from the shipped game surface. It
contained only hard-coded sample progress and had no persistence, server API,
analytics, or gameplay integration.

The cleanup removed its hidden lobby entry, modal markup, UI module, engine
wiring, focus-trap dismissal branch, stylesheet, and shared selector entries.
Active medals, rankings, personal bests, daily challenge progress, garage,
settings, and shared modal behavior remain unchanged.

Validation after removal:

- `npm test`: 60 files and 409 tests passed.
- `npm run build`: passed.
- Targeted source and built-output scans found no remaining achievements code,
  markup, or styling.

## Shipped-surface cleanup: July 30, 2026

The current game, server, tools, stylesheets, tests, and production asset tree
were reviewed together. Removal was limited to definitions with no production
or compatibility caller, selectors with no static or dynamic producer, and
assets with no source, stylesheet, HTML, test, or build reference.

The cleanup removed:

- 31 uncalled helpers and UI methods across the game, server, and local tools,
  plus compiler-confirmed unused imports.
- The retired StartOverlay keyboard-listener path. The active `LobbyUi`
  keyboard navigation remains the single owner of lobby navigation.
- Retired lobby text/detail/icon, action-status, modal-stat-center, and
  leaderboard-time CSS families.
- 12 unreferenced root-level car variants under `public/assets/` (about
  1.9 MB). All selectable cars under `public/assets/cars/` remain.
- A stale `temp_additions.css` branch in the CSS analyzer. The analyzer now
  recognizes the current carousel edge and medal-icon producers.

Compatibility and deployment boundaries were preserved: test-only APIs remain,
the `parseStoredPlayerProfile` re-export remains, live tool entrypoints remain,
dynamic selector families remain, and both root and `fonts/` WOFF2 outputs
remain in the production package.

Validation after removal:

- Focused regression coverage: 21 files and 623 tests passed.
- `npm test`: 2,084/2,088 tests passed, exactly matching the branch baseline.
  The four existing failures remain two expired playlist-cache fixtures, one
  stale Campaign medal expectation, and the track-registry fingerprint.
- `npm run build`: passed.
- The producer-aware CSS audit reports zero unused selectors or IDs in
  `styles.css` and `preview.css`.
- The production output contains all live car sprites and both required font
  paths, and contains none of the removed root-level car variants.
- Production-build Playwright smoke checks reached both Home and Campaign after
  keyboard input. The inspected canvas stayed correctly rendered; console
  output contained only the expected missing Devvit API requests from static
  hosting.
- `git diff --check`: passed.

## Comment cleanup: August 10, 2026

The existing comment-trimming work was extended across the remaining shipped
JavaScript, TypeScript, CSS, HTML, tools, and tests. Removed comments were
section labels, line-by-line explanations of readable code, stale helper
documentation, and multi-line narration. Remaining comments are limited to
legal attributions, type/tooling directives, and non-obvious compatibility,
security, persistence, rendering, or algorithm contracts.

Generated car-asset metadata now uses one line and the generator emits the
same format, so the next test or build cannot restore the removed block.

Validation:

- The code comment scan found no multi-line comments in JavaScript, TypeScript,
  CSS, HTML, tools, or tests.
- `npm test`: 2,239 of 2,240 tests passed; the one failure is the existing
  `track-runtime-integrity` registry fingerprint mismatch from the dirty track
  data, not this comment-only cleanup.
- `npm run build`: passed.
- `git diff --check`: passed.
