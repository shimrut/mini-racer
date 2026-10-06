# Garage redesign — 2026-10-02

Implemented on `codex/garage-redesign`, based on `instant-race-start`.

## Player flow

The supplied reference guides the dark navy workshop, italic Garage title, red selected tab, large top-down car preview and three bordered paint rows. Each element has seven choices on one horizontal palette row, drawn from White, Orange, Blue, Red, Yellow, Lime and Black, with the nearest slots replaced when needed to include the exact preset and saved colors. One dot is selected on every row, including fresh presets. Selecting Preset removes that channel override and restores the original shading.

| Tab | Existing drawn model | Skin choice belongs to |
| --- | --- | --- |
| Street | Formula | Tarmac |
| Circuit | Circuit | Grip |
| Dirt | Rally | Dirt |
| Legacy | Previously visible car collection | Existing skin grounds |

Only Street, Circuit, Dirt and Legacy are visible for now (2026-10-03). Snow, Water and Space use the existing HTML `hidden` state; their Garage implementation, catalog and saved skin customization remain available for later. The shared tab rail and navigation omit hidden buttons without new visibility code.

A type tab shows its equipped drawn skin. If a Legacy car is equipped for that ground, the first compatible drawn skin is previewed; entering a tab alone leaves the Legacy choice equipped. The preview has no car name and no Use car control. A decal, paint, or trail choice equips that drawn skin, so a Street decal replaces a Legacy car. Decal style is the sole pattern selector; preview arrows and navigation dots are removed. The selected style retains independent body, accent, tertiary and trail choices. Legacy preserves all 23 previously visible raster skins, achievement locks and unlock requirement dialogs. The trail row remains below either car view. Appearance tabs do not change playable grounds, race rules or the held-back Campaign series.

## Persistence and rendering

`syncSkinSelection()` refreshes the selected cars, equipped-skin previews and
per-skin trail controls together. The preview reads the existing per-ground skin
choice directly; it no longer keeps a separate carousel index. Grid setup builds all controls before its one
unlock/selection refresh; custom tabs and saved-profile application use the same
selection refresh. Legacy keeps a direct trail refresh because
it does not run the custom-tab skin refresh. The 2026-10-03 cleanup removed the
immediate duplicate trail refreshes and the premature grid refresh without
changing saved choices.

Cleanup validation: the full suite passed 3,980 tests with the same two known
medal-threshold and registry failures; typecheck and production build passed.
Chromium measured one trail refresh for grid setup, custom tabs, Legacy and
saved-profile application. Per-skin trails, No Trail, all six custom types,
Legacy unlock dialogs, keyboard selection, reload persistence and profile
replacement passed. The static preview emitted only its existing backend errors.

`car-paint.js` bounds paint data by registered drawn asset, channel and valid normalized hex color. The optional `carPaints` profile field uses existing preference save/bootstrap and guest transfer. Merge fills unset paints with guest values; account values win. Object profiles with no paint clear cached paint; null bootstrap retains local defaults under the existing settings contract.

Saved asset identifiers remain unchanged. The sprite and lobby caches include paint in their visual identity, so repainting an existing skin updates its static preview, animated race car and ghost. Player race, own ghost, lobby and Garage pass paint explicitly to the existing sprite loader. Generic callers such as opponents and default post cars retain preset art without reading player paint. The loader retains one preset and the latest painted variant per asset. Explicit customization, including an empty override object, gives Formula/Circuit presets without a tertiary region painted rear wing ends so the third control is visible from the start.

## Validation

- Typecheck and production build passed. The build prints the existing inconsistent JSON import-attribute warning.
- Full suite after the reuse corrections: 3,955 passed, two failed across 319 files. Both failures (`medals.test.js` ordered thresholds and `track-runtime-integrity.test.js` registry extension) reproduced on the untouched starting commit in a temporary source checkout: 32 passed, the same two failed.
- Browser checks passed for all six custom types, 21 paint controls, live picture updates, carousel wrap/selection, Legacy locks, nested Escape, trail selection, keyboard cues and persisted choices after reload.
- Screenshots inspected at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. The car, paint rows and type rail fit the shared modal column; the shared content scrolls with space beneath the final controls for the Back action.
- The standard web-game test client ran and its state output reports the visible Garage tab, preview skin, equipped status and selected colors.
- Browser validation used a local static preview, where Daily/Campaign backend warmup emits existing 404 errors. No unexpected Garage browser errors occurred. Redis/Reddit-hosted validation is not established by these checks.
- The pre-existing ground formatting edit and four untracked race-start investigation notes were preserved.

## Part previews and controls

The original fixed crop distorted thumbnails and did not follow every preset's decal layout. Part bounds now come from the existing part renderer and its resolved paint channels, using white/black probes once per asset/decal layout. Mirrored elements with an empty center show one side. The chosen part and renderer-discovered main body mask a full-car image to preserve nearby body context and overlays while excluding adjacent tires/frame. Paint bounds include a small margin; the body uses a center close-up. One uniform scale fits the result into the 6:5 canvas. Every preset/channel is checked with actual rendered pixels.

Paint and trail swatches share the CSS `color-swatch` primitive; selection uses a circular CSS outline. The Garage no longer has preview arrows or dots. Arrow selectors and navigation belong only to the live track carousels; unused `.carousel-arrow` aliases have been removed. Prepared PNGs and thumbnails are cached by resolved car identity, so equip/status refreshes and returning to an unchanged type reuse artwork. Alpha trimming uses one shared bounds helper.

## Shared-layout correction

Removed the separate 42rem Garage width, background and enlarged heading overrides. Garage now inherits the existing 420px desktop modal cap and shared full-width phone behavior, header padding/typography and sheet spacing used by Settings and Tracks. The shared `reusable-modal-content` owns scrolling and the existing Back spacer; the extra workshop scroller and duplicate clearance rules are gone. Paint labels sit above their swatches inside the shared column, and trails reuse the existing section/grid styling. The old two-way Garage Car/Trail thumb rules were removed; Tracks keeps its existing two-way thumb. Workshop colors and borders use the existing game tokens.

Browser comparison confirmed identical Garage/Settings/Tracks card dimensions, heading styles, header/content padding and Back styles at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. Garage shares Settings' sheet spacing; Tracks retains its existing shorter gap on short screens. Final trail controls scroll clear of Back at all five sizes. The full Garage interaction checks and standard web-game client passed; typecheck/build passed. That layout pass had 3,889 passing tests and only the same two previously verified baseline track-data failures.

## Reuse audit — corrections

All six findings from the read-only audit were addressed:

- Part/channel associations follow the existing renderer and preset decals; no model-specific paint assignment or crop table remains.
- Seven choices always include the exact preset and saved value. Preset selection restores the original tone object; clicking the current color does not rewrite its shading.
- Paint ownership is explicit. Player race, own ghost, Garage and lobby use saved paint; opponents and default post art use generic preset rendering.
- One bounds helper handles trimming and uniform fitting. Geometry and prepared artwork are cached; unchanged status and previously prepared type previews avoid rescanning, PNG encoding and part redraws.
- Paint/trail circles and Garage/track arrows share existing visual primitives.
- `DrawnCar` resolves model, skin and explicit paint once. The UI, cache identity and part renderer consume that same livery/decal definition.

Persistence continues through the existing preferences POST/bootstrap/profile/salvage/guest-transfer paths. No new API or Redis store was introduced. Race updates retain the loaded `DrawnCar`, with no per-frame localStorage reads. The regression checks now cover every one of the 29 drawn presets and all three channels, fresh selected dots, restoration of original shading, isolated close-ups and reuse of unchanged artwork.

Final validation after the context correction:

- Full suite: 3,955 passed, two unchanged baseline failures across 319 files (`medals.test.js`, `track-runtime-integrity.test.js`). Typecheck and production build passed; the existing JSON import-attribute warning remains.
- Real-canvas checks and browser interactions cover all 29 presets, all 87 channel changes, exactly one selected dot per row on fresh presets, exact original shading after Preset restoration, and no artwork preparation on unchanged selected-dot/equipment actions.
- Browser regression passed type/style selection, carousel wrap, Legacy locks, nested Escape, trails, keyboard focus and saved colors after reload. Garage/Settings/Tracks dimensions, headings, padding and Back styles match at five viewports; circles remain square and final trail controls scroll clear of Back.
- Inspected final screenshots for default/custom car details, phone, small phone, landscape and desktop. The standard game client passed and reports three selected preset colors. Only expected local static-preview Daily/Campaign backend errors were recorded.
- Documentation updated; unrelated ground WIP and four race-start notes preserved. No commit, push or hosted deployment was performed.

## Follow-up review and fixes

The user asked whether anything else was missed. This pass reviewed the current branch and entrypoints, ran independent native-canvas/loader probes and 119 focused persistence/transfer tests, and reproduced the UI cases in Chromium. No application or test source was changed during that review. The three findings below record the pre-fix behavior; all three were subsequently fixed after the user requested implementation.

1. **P2 — stale preview after saved preferences arrive.** `GarageUi.bind()` initializes Street before authoritative bootstrap, and `setGarageTab()` only chooses the saved style when the tab has no remembered index (`game/settings/garage-ui.js:182`). Applying a new profile calls `syncSkinSelection()` without reconciling those indexes (`:642`). Browser repro: initialize Red, apply a profile with Formula Gold, refresh and reopen; Gold is equipped but Red remains previewed. Clicking a paint then equips Red. Reconcile remembered previews when authoritative preferences/owner change, while preserving intentional browsing within the active session.
2. **P2 — native Tab focus and shared menu selection diverge.** `resolveSelectedIndex()` in `game/ui/menu-keyboard-nav.js:93` prioritizes its remembered index over DOM focus. Browser repro: open Garage, Tab to the Blue body swatch, press Enter; Street receives the click and Blue remains unselected. An isolated probe also moves ArrowRight from focused Blue to Circuit. This shared-helper defect is present in the unchanged starting commit; the prior Garage keyboard checks only exercised the spatial cue, so they missed native Tab/Enter. Correct the shared focus-resolution contract and cover mixed Tab/spatial navigation.
3. **Phone usability — undersized paint tap areas.** `.garage-color-options` always has seven columns, and the square button is constrained to each column (`styles/garage-workshop.css:165–185`). Actual button areas measure about 17.4 × 17.4 CSS pixels at 320px viewport width and 27.4 × 27.4 at 390px. The dots are circular, but their click areas are too small for reliable phone selection. Preserve the shared modal width and give the controls larger tap areas through wrapping or row arrangement. This is a measured usability finding, not a reproduced pointer failure.

Evidence: `/tmp/dailygp-garage-lifecycle-audit.mjs`, `/tmp/dailygp-garage-followup-browser.mjs`, `/tmp/dailygp-garage-followup-browser-results.json`, `/tmp/dailygp-garage-followup-persistence-tests.log`. The real browser confirms both bugs and the tap-area dimensions; the saved-profile response was applied as a local fixture rather than obtained from hosted Redis.

No further rendering defect was confirmed: all 29 assets retained pristine generic art through customized cache switching; explicit-empty customization matched editable rendering; animation performed zero paint-storage reads; stale loads remained blocked and failures recovered. Existing preference save/bootstrap, field salvage and guest transfer paths retained paint in the focused local tests. Hosted Redis/Reddit and physical-device driving remain separate from this evidence.


### Completed follow-up fixes

- Saved profile application calls the existing Garage selection refresh with `resetPreviews: true`. Preview initialization and reconciliation share that refresh path; all six types follow the new ground choices, including previously visited tabs. Active tab/focus stay in place. Ordinary refreshes preserve intentional previews, and a null profile retains the existing local contract.
- The shared menu navigator resolves actual DOM focus before remembered selection for Enter/arrows. Tab clears the old spatial cue and retains native focus movement. A focused native action outside the spatial list keeps normal activation; the modal trap allows Enter on an enabled native button/link inside its active modal. No Garage-only keyboard handler was added.
- At this stage, paint choices spanned the full paint row beneath its part thumbnail/label, wrapping four plus three (superseded by the single-row correction below). Buttons have 44px square hit areas; visible dots still use the shared circular swatch primitive. Modal dimensions, headings, content scrolling and Back clearance remain owned by the existing shell.

Validation: all 3 new saved-profile regression tests and 44 focused navigation/modal tests passed. The final full suite passed 3,971 tests across 318 files, with only the 2 previously reproduced baseline failures in medal thresholds and the track registry. Typecheck and the final production build passed; the existing JSON import-attribute warning remains.

Chromium reproduced the fixed native Tab/Enter and mixed arrow/Tab paths, activated Back with native Enter, and used `RealTimeRacer.applyPersistedPlayerPreferences()` with local saved-profile fixtures. Gold remained previewed/equipped through reopen and paint, and replacing choices for all six visited types preserved active focus and showed each correct equipped style. At 320px and 390px, all 21 paint targets measured 44 × 44 CSS pixels and all visible swatches remained square/circular without horizontal overflow. Garage/Settings/Tracks dimensions and shared shell styles matched at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. All 29 presets and 87 channel changes still passed exact preset restoration and cache checks. Legacy locks/nested Escape, trail selection, carousel wrapping and reload persistence also passed in the interaction browser script. The standard game client also ran and its state/screenshot were inspected; console errors were the known missing Daily/Campaign APIs in the static preview. Hosted Redis/Reddit and physical-device driving were not exercised.

Evidence: `/tmp/dailygp-garage-followup-fixed-results.json`, `/tmp/dailygp-garage-shared-layout-results.json`, `/tmp/dailygp-garage-all-presets-results.json`, `/tmp/dailygp-garage-browser-results.json`, `/tmp/dailygp-garage-followup-fix-final-tests.log`, `/tmp/dailygp-garage-followup-fix-final-build.log`, `/tmp/dailygp-garage-followup-fix-game-client/`.


## Single-row palette correction

The user rejected the four-plus-three palette arrangement. All seven colors now stay on one horizontal row below each part thumbnail and label. Seven equal columns shrink within the existing shared modal width; buttons retain a square aspect ratio and a 44px maximum size, keeping both the dots and selection outlines circular. The palette does not wrap, scroll horizontally, or change modal dimensions.

Validation: 77 focused stylesheet, shared navigation/modal and saved-profile tests passed. Chromium confirmed one row per channel, seven non-overlapping circular controls, no horizontal overflow and the same Garage/Settings/Tracks dimensions at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. Shared scrolling and final Back clearance passed. Color selection across all six types, carousel wrapping, Legacy locks/nested Escape, trails and reload persistence passed. The standard game client ran; screenshots/state were inspected, with only the known static-preview Daily/Campaign API errors. The production build passed with the existing JSON import-attribute warning.

Evidence: `/tmp/dailygp-garage-single-row-layout-results.json`, `/tmp/dailygp-garage-browser-results.json`, `/tmp/dailygp-garage-single-row-game-client/`, `/tmp/dailygp-garage-single-row-build.log`.


## Scrollable car-type tabs

The user requested one horizontally scrollable row for Street, Circuit, Dirt, Snow, Water, Space and Legacy. The existing tab rail now uses column auto-flow with natural label widths and native horizontal overflow. The Legacy grid span is removed; shared typography, pill styling, modal dimensions and the single-row paint palettes remain in use. A focus listener uses native `scrollIntoView({ block: 'nearest', inline: 'nearest' })` so keyboard navigation fully reveals the focused tab. This fixes a measured narrow-screen case where native focus alone left Legacy partly clipped.

Validation: 163 focused Campaign/Garage binding, stylesheet, shared keyboard/modal and saved-profile tests passed. Chromium checked the seven tabs occupy one row at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. Native horizontal wheel scrolling, arrows/Tab through Legacy, Enter selection and 23 visible Legacy skins passed; a phone touch swipe moved the rail from zero. Garage/Settings/Tracks card widths stayed equal and the surrounding content did not overflow horizontally. The single-row color, shared shell/scrolling and final Back-clearance checks also passed at all five sizes. Standard game-client screenshots/state were inspected; console output contained only the known missing static-preview Daily/Campaign APIs. The production build passed with the existing JSON import-attribute warning.

Evidence: `/tmp/dailygp-garage-tab-strip-results.json`, `/tmp/dailygp-garage-single-row-layout-results.json`, `/tmp/dailygp-garage-tab-strip-game-client-final/`, `/tmp/dailygp-garage-tab-strip-build.log`.


## Per-skin trail row — 2026-10-03

Trail Color now reuses the paint panel, row, label, palette, button and swatch styles. All eight existing options (No Trail plus seven colors) stay on one horizontal row inside the shared modal width. The former labeled trail tiles and their separate grid/size rules are removed. Accessible labels and titles retain each color's name; No Trail keeps its diagonal swatch.

The row edits the previewed drawn skin, or the equipped tarmac skin in Legacy. Selecting a trail equips that target through the existing skin-selection path and schedules one preference save. Switching styles/types refreshes the selected dot without modifying other skins. The optional `carTrails` profile map is keyed by existing asset names, including raster skins, and cached at `MiniRacerPlayerCarTrails`. The shared normalizer accepts only catalog assets and existing trail IDs. An explicit `none` stays saved. The old `trailId`/`MiniRacerPlayerTrail` is retained as the fallback for uncustomized skins, preserving earlier global choices.

Existing preference save, Redis profile normalization/salvage, bootstrap and guest-transfer paths carry the map. Account choices win on Merge and guest choices fill unset skins. Applying an object profile replaces or clears cached per-skin trails; a null profile keeps the existing local-preference contract. The engine resolves the trail of the skin equipped for the current track ground on skin/profile changes and race reset, including cached starts. Customizing another ground leaves the active trace unchanged. Rendering and simulation use the cached engine stroke style rather than reading storage per frame.

Validation: 379 focused trail, preferences, profile/transfer, navigation and stylesheet tests passed. Typecheck and production build passed with the existing JSON import-attribute warning. The full suite passed 3,980 tests across 318 passing files; the same two previously reproduced baseline medal-threshold and track-registry failures remain.

Chromium confirmed all paint and trail palettes occupy one row with circular controls, no overlap/overflow, equal Garage/Settings/Tracks dimensions and final Back clearance at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. Native trail Enter/arrow selection, Red/Gold independence, No Trail, all six types, Legacy locks/nested Escape, Back, reload persistence, actual engine reset with local ground fixtures and authoritative profile replacement passed. Screenshots and standard game-client state/errors were inspected. Only the known missing Daily/Campaign APIs emitted static-preview errors. Hosted Redis/Reddit and physical-device driving were not exercised.

Evidence: `/tmp/dailygp-car-trail-focused-tests.log`, `/tmp/dailygp-car-trails-final-tests.log`, `/tmp/dailygp-car-trails-final-build.log`, `/tmp/dailygp-car-trail-layout-results.json`, `/tmp/dailygp-car-trail-browser-results.json`, `/tmp/dailygp-car-trails-phone-final.png`, `/tmp/dailygp-car-trails-game-client/`.

## Decal style — 2026-10-03

Added the accepted single Decal style row. Its choices pair body and wing paint mappings from compatible existing presets, with four Street choices and five choices for each other drawn model. Jet ski and spaceship choices use their own existing paint areas; Legacy raster cars have no decal row. Pattern thumbnails use the current skin's colors, materials and parts. Selection changes its pattern rather than its asset identity, and retains saved colors and trail. The row uses the shared paint panel/row/palette layout and existing skin-choice buttons; only its option count and compact dimensions differ.

`game/car/car-decals.js` derives and validates compatible styles from the existing skin catalog. `player-car-decals.js` stores the per-skin map in `MiniRacerPlayerCarDecals`; optional `carDecals` preferences follow existing profile save/bootstrap/salvage and guest Merge. Account choices win, including explicit original styles. Missing fields in an object profile clear the old owner's map; null preserves the existing local contract. A chosen style replaces the complete decal map, including null entries, without changing livery/materials/parts. Explicit styles suppress the tertiary wing-end fallback. Unused color channels are visibly marked, disabled and retain their stored values for a later style.

DrawnCar, the sprite cache and loader accept explicit `decalStyle` alongside paint. The inner variant identity and outer visual key both follow the style; player Garage/race/ghost/lobby calls pass saved choices, while generic art remains preset. Option thumbnails use transient instances of the same DrawnCar constructor, cached with prepared Garage artwork, so status refreshes do not churn the animated-car cache or regenerate PNGs.

Validation: 331 catalog/preference/server tests and 83 renderer/loader/part tests passed, with 3 additional race/lobby/unused-channel integration tests passing. Typecheck and production build passed (the existing JSON import-attribute warning remains). The full suite passed 4,059 tests across 322 passing files; the same two previously reproduced medal-threshold and track-registry baseline failures remain. Final stylesheet checks passed.

Chromium checked per-skin independence, preserved colors/trails/asset identity, immediate animated/ghost/lobby image consistency, cached artwork refresh, unused channels, native keyboard choices, all compatible patterns across six types, Legacy locks/nested Escape, reload and authoritative profile replacement. Four- and five-choice rows, one-line labels, paint/trail circles, equal Garage/Settings/Tracks dimensions, no horizontal content overflow and Back clearance passed at 1280×900, 390×844, 320×640, 844×390 and 1920×1080. Screenshots and standard game-client state/errors were inspected; the static preview emitted only its existing Daily/Campaign backend errors. Hosted Redis/Reddit and physical-device driving remain unverified.

Evidence: `/tmp/dailygp-decal-preferences-tests.log`, `/tmp/dailygp-decal-rendering-tests.log`, `/tmp/dailygp-decal-integration-recheck.log`, `/tmp/dailygp-decal-final-tests.log`, `/tmp/dailygp-decal-final-build.log`, `/tmp/dailygp-garage-decal-browser-results.json`, `/tmp/dailygp-decal-shared-layout-results.json`, `/tmp/dailygp-decal-game-client/`.

## Tab selection scroll correction — 2026-10-03

Selecting a car type after scrolling the rail correctly changed the panel but reset native focus to Street, which scrolled the rail back to zero. The Garage navigation refresh now passes the currently focused tab through its existing preferred-element path. That preference also wins when a keyboard cue is active; callers without a preferred element retain their existing fallback. This preserves the selected tab and rail position without storing/restoring scroll coordinates or changing layout.

Two regression cases failed before the fix and pass afterward. All 138 focused shared navigation/modal, Campaign/Garage and preference tests passed. Chromium reproduced the zero-offset jump before the fix and verified unchanged offsets after Space/Legacy selection at five viewports, native wheel/mouse and phone swipe/tap, arrows/Enter, Tab/Enter and touch after an active keyboard cue. Screenshots and the standard game-client state/errors were inspected; only the existing static-preview Daily/Campaign API errors occurred.

Typecheck and production build passed; the existing JSON import-attribute warning remains. Unrelated WIP was preserved.

Evidence: `/tmp/dailygp-tab-scroll-before-results.json`, `/tmp/dailygp-tab-scroll-after-results.json`, `/tmp/dailygp-tab-scroll-tests.log`, `/tmp/dailygp-tab-scroll-typecheck.log`, `/tmp/dailygp-tab-scroll-build.log`, `/tmp/dailygp-tab-scroll-game-client/`.

## Visible tab scope — 2026-10-03

Temporarily hide Snow, Water and Space with three existing HTML `hidden` attributes. All 168 focused Garage/Campaign binding, stylesheet, modal/navigation and profile tests passed. Chromium checked exactly Street/Circuit/Dirt/Legacy visible on one row, all selections, Legacy collection, Arrow/Tab navigation skipping hidden tabs, scroll retention and shared modal widths at five viewports. Screenshots and standard game-client state/errors were inspected; only the known static Daily/Campaign API errors occurred.

Production build passed with the existing JSON import-attribute warning. Unrelated WIP was preserved.

Evidence: `/tmp/dailygp-garage-visible-tabs-tests.log`, `/tmp/dailygp-garage-visible-tabs-results.json`, `/tmp/dailygp-garage-visible-tabs-build.log`, `/tmp/dailygp-visible-tabs-game-client/`.

## Single style selector — 2026-10-03

Removed the preview's left/right buttons, navigation dots, their methods/index state and desktop/mobile CSS. The stage now contains one centered image with no empty arrow columns. Decal style is the sole pattern selector and retains the current skin's colors, materials and trail.

The preview derives from the existing equipped drawn skin for its ground. If a Legacy car is equipped, it shows the first compatible drawn skin; entering a tab does not replace that Legacy choice. There is no car name or Use car control. A decal, paint, or trail choice equips the preview. Profile replacement follows the same derived choice without separate carousel state. Street, Circuit, Dirt and Legacy remain the four visible tabs.

All 215 focused Garage/rendering/navigation/modal/profile/style tests passed; final stylesheet and updated focus-fixture checks passed. Typecheck and production build passed with the existing JSON import-attribute warning. Chromium verified saved skin/paint/trail retention, every Street pattern, keyboard selection, Circuit/Dirt patterns, reload, matching animated/ghost/lobby art, Legacy fallback/Use car/locks and the shared layout at five sizes. Screenshots and standard game-client state/errors were inspected; only known static Daily/Campaign API errors occurred. Unrelated WIP was preserved.

Evidence: `/tmp/dailygp-garage-simplified-tests.log`, `/tmp/dailygp-garage-simplified-styles.log`, `/tmp/dailygp-garage-simplified-focus.log`, `/tmp/dailygp-garage-simplified-results.json`, `/tmp/dailygp-garage-simplified-typecheck.log`, `/tmp/dailygp-garage-simplified-build.log`, `/tmp/dailygp-simplified-garage-game-client/`.

## Removal completeness audit — 2026-10-03

The Garage DOM, listeners, methods, preview-index state, debug dependencies, desktop/mobile/focus CSS and obsolete fixtures were removed in the simplification. The follow-up audit found six unused `.carousel-arrow` selector arms plus an outdated Garage-sharing comment in the track stylesheet. These aliases were left behind when the Garage consumer was removed; they are now deleted. Active `.track-carousel__nav` rules and the track-used responsive size variable remain.

Source and rebuilt client/source-map searches find no old Garage arrow/dot methods, classes, labels or index state in runtime code. The only source-code mentions are tests asserting their absence; older documentation records historical implementations. All 128 focused stylesheet and Daily/Campaign carousel/prefetch tests passed, and the production build passed with its existing JSON import-attribute warning. Unrelated WIP was preserved.

Evidence: `/tmp/dailygp-garage-removal-audit-tests.log`, `/tmp/dailygp-garage-removal-audit-build.log`.

## Sharper Garage preview — 2026-10-03

The large preview was enlarging the low-resolution race sprite. Circuit Orange's cropped image was 317 × 198 pixels, displayed about 256 CSS pixels wide on a 3× phone viewport; roughly 768 source pixels were needed. The same preview is now 951 × 592 pixels. No layout or CSS sizing changed.

On the existing prepared-artwork cache miss, Garage uses the existing DrawnCar constructor with the current model, skin, paint and decal style at 9 pixels per unit. The existing crop helper converts that independent still to a PNG. Only the PNG survives in the artwork cache; equip/status/trail refreshes reuse it. The cached race car remains at 3 pixels per unit, with its original sprite, frame identity and adaptive animation resolution cap. Part details retain their existing preparation path. Legacy raster assets remain unchanged.

Validation: all 112 focused Garage-part, decal integration/rendering, DrawnCar and sprite-loader tests passed, including a new high-resolution PNG/cached-race-isolation regression. Typecheck and production build passed; the existing JSON import-attribute build warning remains. Chromium checked all 14 compatible styles across Street/Circuit/Dirt at 390×844, 320×640, 1280×900, 844×390 and 1920×1080 with device scale factor 3. Source resolution, selected style, color changes, trail/status PNG reuse, unchanged race density/layer cap, equal Garage/Settings/Tracks widths and no horizontal content overflow passed. Before/after, small-phone and standard game-client screenshots and state/errors were inspected. The static preview emitted only its known missing Daily/Campaign API errors. Race FPS and physical-device performance were not benchmarked.

Evidence: `/tmp/dailygp-sharp-preview-before-results.json`, `/tmp/dailygp-sharp-preview-after-results.json`, `/tmp/dailygp-sharp-preview-layouts.json`, `/tmp/dailygp-sharp-preview-tests.log`, `/tmp/dailygp-sharp-preview-typecheck.log`, `/tmp/dailygp-sharp-preview-build.log`, `/tmp/dailygp-sharp-preview-game-client/`. Reviewed phone screenshot: `/Users/bpopa/.codex/visualizations/2026/10/02/01a0fb29-01b7-7a61-918f-857f3c075bdb/garage-sharp-preview.png`.

## Pinned tabs and open customization sections — 2026-10-03

Street/Circuit/Dirt/Legacy now remain visible below the fixed Garage heading while the shared modal content scrolls. The existing rail uses native CSS sticky positioning and an opaque spread shadow to shield content below it, retaining its one-row horizontal scrolling, focus listener and selection handlers. A narrow-phone browser check found directional focus could land partly behind the rail; native scroll margins on car/decal/color/Legacy controls correct that without a new scrolling handler.

Decal style, Body, Accent, Tertiary and Trail color now use open rows separated by thin top dividers. Removed panel backgrounds, panel/row rounded borders, doubled container padding, the part-preview vertical divider and the decorative showcase frame/gradient. Existing semantic sections, preview action, style-choice buttons, circular swatches and selection/focus feedback remain in use. This is a CSS-only change in `styles/garage-workshop.css`; the shared shell, modal width, vertical scroller, Back clearance, markup and per-skin persistence paths stay in place. Removed the obsolete mobile panel/row padding overrides as part of the change.

Validation: all 168 focused stylesheet, shared keyboard/modal, Garage profile and Campaign binding tests passed. Typecheck and production build passed with the existing JSON import-attribute warning. Chromium verified the rail at the top/middle/bottom, all four type selections after scrolling, Legacy collection/locks/nested Escape, native Tab and directional focus visibility, one-row palettes and circular controls, shared modal widths, no horizontal content overflow, final Back clearance and retained per-skin paint/decal/trail choices at 390×844, 320×640, 1280×900, 844×390 and 1920×1080. Native wheel and phone touch scrolling followed by a pinned-tab tap also passed. Final screenshots and standard game-client state/errors were inspected; the static preview emitted only its known missing Daily/Campaign API errors. Hosted Reddit and physical-device checks remain outside this local evidence.

Evidence: `/tmp/dailygp-flat-garage-results.json`, `/tmp/dailygp-flat-garage-tests-final.log`, `/tmp/dailygp-flat-garage-typecheck.log`, `/tmp/dailygp-flat-garage-build.log`, `/tmp/dailygp-flat-garage-game-client-final/`. Reviewed design: `/Users/bpopa/.codex/visualizations/2026/10/02/01a0fb29-01b7-7a61-918f-857f3c075bdb/garage-pinned-tabs-open-sections.png`.
