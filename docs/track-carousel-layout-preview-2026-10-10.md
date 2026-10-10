# Track carousel layout preview — 2026-10-10

The user requested a working preview of the refined carousel using the actual
game fonts, colors and sizes, then accepted version 2 (`rank-top`). That layout
is now implemented in the shared Daily/Campaign game carousel. The sections
below retain the preview history; the accepted implementation is described here.

## Accepted implementation

- Row 1: selected track name and native rank button. Row 2: laps/surface and native medal ladder. Start Race has a single line beneath them.
- Removed actual Daily/Campaign expiry, pagination counter and duplicate CTA
  markup, PB footer display and obsolete expiry/counter event wiring. The shared
  header selection is hidden in these modes; Challenge and Community retain it.
- The caption belongs to TrackCarousel's native footer. It refreshes on selection
  and same-ID model updates, clears when empty and repaints from its existing track preload when definitions arrive. No preview MutationObserver or PB adapter ships with the game.
- Native standings/medal callbacks, swiping, chevrons, readiness/retry labels,
  placeholders, verification errors and both Campaign unlock gates are preserved.
- 340 focused tests across 14 files pass, including new caption/state/hydration
  regressions. Typecheck and production build pass. The build reports the existing
  mixed JSON-import-attributes warning for Campaign's series manifest.
- Eight local Chromium layout cases pass across Daily and Campaign at 390×844,
  320×568, 1280×720 and 844×390: both row alignments, four medals, 20px CTA clearance,
  containment and no page/console errors. Campaign locked states also remain
  contained with two requirements and disabled Start. Native rank opens the
  selected track via Enter; medals open their existing target overlay.
- The standard game client starts Daily and advances/steers during gameplay;
  screenshot and text state inspected (`playing`, lap clock 3.5s).
- Evidence lives in ignored `output/carousel-layout-preview/production-*`.
  Local sample API/PB fixtures are used only for verification. Hosted Reddit
  WebViews and physical devices were not checked; no deployment or commit.

## Follow-up cleanup and Street label

The user questioned code growth and the missing Street label. The initial core
carousel JS was 46 lines smaller and page markup 22 lines smaller; layout CSS
was 19 lines larger. Added test/documentation/ignored preview files and unrelated
pre-existing worktree changes must not be counted as shipped carousel behavior.

The first implementation did leave duplicate lap/surface updates in TrackCarousel
and LobbyUi. TrackCarousel now owns the caption alone, using the existing preload
promise to repaint the current selected card after definition arrival. Removed
the second updater, unused Daily header metadata state and Campaign caption-only
getters. This follow-up removes another 63 net runtime lines. Challenge/Community
retain their existing presentation.

Street was suppressed because the storage helper returns null for the default
tarmac ground. The carousel now uses the existing presentation ground resolver,
so both explicit tarmac and legacy definitions without a ground field show Street.
Regression checks cover late loading, selection changes and both Street cases.
Validation: all 340 focused tests, typecheck and build pass again. Four Campaign
viewport cases show Street with both row alignments and locked states contained;
Daily switching to Number Zero also shows Street. Standard game-client start and
steering pass with screenshot/text inspected. Evidence: `street-campaign-qa.json`,
`street-daily-phone.png` and `street-game-client/` in the ignored artifact folder.

## Scroll regression and correction

The selected-only `visibility: hidden` rule introduced with the preview caused
outgoing maps to disappear before smooth scrolling finished. A local frame trace
confirmed intersecting map cards were hidden while the incoming card was still
partly outside the viewport. Static layout checks had missed this transition.

Removed that rule. Lobby cards now occupy the full measured viewport width, with
the existing diagram inset kept as internal padding; neighboring diagrams remain
clipped at rest and both remain paintable throughout motion. No new animation or
rendering system was added.

Locked Campaign footer height also triggered ResizeObserver's unconditional
instant recentering. The observer now refits previews for height changes and only
recentres for width changes. A regression test failed before this fix and passes
now. Added coverage for both cards remaining paintable on selection changes.

Validation: 342 focused tests pass. Six browser motion cases cover Daily phone,
small phone, desktop and short landscape plus Campaign phone/small phone. All
observed frames retain the cards, with no intersecting hidden cards or zero-visible-
card frames; both outgoing/incoming maps are visible during motion, including
locked Campaign transitions. Native touch swipes forward/back select the correct
Daily and Campaign tracks. No page/console errors in the motion cases. Evidence:
`scroll-before.json`, `scroll-after.json`, `scroll-touch.json`, `scroll-broken.png`
and `scroll-fixed-mid.png` in the ignored artifact folder. Hosted/device proof
remains unverified.
Typecheck/build pass; the final style/paintability/resize subset also passes
after retaining the original artwork inset at short heights. Standard game-client
Start/steering passes, with screenshot and `playing` text state inspected.

## Composition

- Keep the current wordmark, toolbar, mode switch and actual track renderer.
- Put the selected track name below the artwork with the native rank button on
  the same baseline at the right. Long names truncate while keeping rank visible.
- Put the existing lap/surface text underneath and retain the native medal ladder
  below it. The initial preview omitted Street; the accepted implementation now
  names every surface explicitly.
- Remove expiry, pagination count, personal-best time, repeated header selection
  and duplicate track details inside Start Race. Add no replacement status copy.
- Retain carousel swiping and previous/next controls when there are multiple
  tracks. Clip neighboring artwork outside the settled viewport; keep both
  diagrams paintable during scrolling. Start Race remains the
  existing primary action with a single visible line.
- Preserve native locked-stage requirements, verification errors, disabled Start
  states and placeholder behavior. Short landscape places artwork beside the
  caption and medals to preserve usable diagram height.

Typography uses `--header-font` (Outfit) and `--mono-font` (JetBrains Mono).
The title reads the actual Start button's computed size, currently 24 px in the
checked viewports. Rank icons, medal SVGs, palette, primary-button styling and
header dimensions come from the existing game. The preview changes composition,
not those assets or the game design tokens.

## Two-row comparison variants

The follow-up asks for the same essential content in two rows:

| Query | First row | Second row |
| --- | --- | --- |
| `layout=medals-top` | Track name · medals | Laps/surface · rank |
| `layout=rank-top` | Track name · rank | Laps/surface · medals |

Both reuse the real rank and medal buttons inside the caption. The empty footer
is removed only for ordinary open cards; locked requirements and verification
errors retain it. There is 1.25rem of clearance before the existing CTA.
The comparison keeps the original screenshots; the local game URL now shows
the implemented version 2 without visual overrides.

The rank-top variant lets its title span the space above the wider medal ladder.
Both variants truncate Country Road at 320 px to preserve the game's existing
font and medal sizes. Full names remain in the title attribute and existing
accessible controls.

## Run and inspect

The ignored artifact directory is `output/carousel-layout-preview/`. From the
repository root, run:

```sh
node output/carousel-layout-preview/server.mjs
```

Open `http://127.0.0.1:5192/pages/game.html?mode=daily&sample=played`.
Use `sample=unplayed` for empty progress, `cards=multi` for three selectable Daily
tracks, or `mode=campaign` and select Numbers for Campaign. `name=` supplies an
optional long-title fixture.

Open `http://127.0.0.1:5192/output/carousel-layout-preview/compare.html` for both
phone captures and links to their live previews. These comparison labels live
outside the game itself.

`entry.js` and `layout.css` load only through this dedicated server. The entry
moves the real rank button rather than recreating its callback, and reads the
existing selected-track race brief so asynchronous track hydration keeps the
caption accurate. Rank visibility follows the native footer state.

The local server supplies sample API data and absorbs API writes locally. It
does not proxy requests to a hosted game API. A preview-only PB adapter enables
sample earned medals despite the game's usual loopback PB restriction. The
displayed #12, #8 and medal progress are illustrative, not live player records.

## Validation

- 124 focused tests passed across Daily/Campaign carousels, engine Daily
  selection, track prefetch and menu keyboard navigation.
- Actual Chromium screenshots inspected at 390×844, 320×568, 360×640,
  1280×720 and 844×390, plus a long title. Caption, rank, medals and action remain
  contained; the title and rank share a line. Fresh contexts isolate fixtures.
- Selecting Number Zero updates the Daily caption, rank and lap count. Enter on
  its native rank button opens Number Zero standings. Medals open the native
  target overlay with totals for two laps; Escape closes both overlays.
- Campaign Number Zero shows rank and earned medals. Number Two retains its
  prerequisite checklist and disabled Locked action, with rank and medals hidden.
- The standard web-game Playwright client starts Daily and steers in gameplay;
  its screenshot and `render_game_to_text` state were inspected. No runtime
  console errors in the checked local cases.
- Both comparison variants pass eight local browser cases across 390×844,
  320×568, 1280×720 and 844×390: both row pairings, CTA clearance, containment,
  four medals, native 24 px title, and no runtime/console errors. Each phone
  variant opens standings with Enter and medal targets by tapping the native
  button. Both retain Number Two's Campaign requirements and disabled action.
  Standard game-client captures/state were inspected, including Start/steering
  for rank-top. Evidence: `variants-qa.json` and the variant screenshots in the
  ignored artifact directory.

Screenshots and responsive measurements are alongside the preview files.
Hosted Reddit WebViews, physical devices and the full suite were not checked.
Existing unrelated worktree changes were preserved.
