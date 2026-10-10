# Lobby header studies — 2026-10-10

Earlier studies are rejected. Three new content studies are unselected; no
production header code has been changed for these proposals. Preserve unrelated
dirty work.

## Current brief

Create three genuinely different header structures for the mobile Mini Racer
game, also playable on desktop in Reddit. Preserve the actual project fonts,
weights, italics, type scale, palette, rounded shapes, wordmark and icons.

Only the header may change. Keep carousel, series rows, captions, medals, rank
and Start Race identical. No footer relocation of brand/navigation, sidebar
around the track, or whole-lobby redesign. Race modes must grow beyond
Daily/Campaign without ever more permanent tabs; Garage, Shop and Settings are
destinations rather than race modes. Preserve current mode, selected Campaign
series, available contextual utilities and back depth.

Before rendering, reject every candidate that fails any hard constraint or
repeats a rejected structure. Compare at identical dimensions and identical lower
content. Show an expanded mode selector with future modes clearly illustrative.

## Rejected work and the latest failure

Earlier switch-size changes, app bars, angular placards and oversized active-mode
headings were rejected. The Side gate / Game lobby / Mode deck study also moved
navigation to the footer, put tools beside the track, or redesigned too much of
the lobby. It is not an implementation direction.

The next Split selectors / Home-led navigation / Play hierarchy board is also
rejected. It reused the project fonts/tokens/SVGs and froze lower screenshot
content, but that technical compliance did not make a coherent game-menu design.
The proposals still arranged controls into two toolbar bands; their visual
hierarchy and grouping were too weak. Narrow-width inspection also showed the
Campaign label truncating in the split selector. Geometry and token parity must
not be treated as the design acceptance gate.

The user specifically challenged whether available frontend and game-design
skills were being applied properly. The skills were consulted, but their
composition-first, subject-specific brainstorming and self-critique steps were
not applied effectively enough to reject weak drafts before presenting them.

The subsequent Context command / Game badge / Race controller candidates were
also rejected. They treated logo, current mode, Menu and utilities as a fixed
kit and recombined those elements. The latest requirement is to change the
visible content and interaction objects, not just composition of existing
controls. The old localhost5195 prototype is rejected evidence as well.

## Required design review before another render

Use the frontend-design process: subject/audience/job, an existing-token plan,
structural alternatives with wireframes, critique against the brief, then build
and critique the actual image. Each alternative needs a deliberate game-specific
visual thesis and a different navigation model; moving the same toolbar groups
is insufficient.

Use frontend-skill for restraint and first-viewport composition. Follow the
user's game brief rather than its generic landing-page or app defaults. The
accepted track/series content stays the visual anchor, and the native wordmark
must retain appropriate prominence. Avoid scattered small UI devices and
competing red controls.

Use game-ui-ux for container/anchor layout, reference sizing and short-viewport
policy, safe-area clearance, input/focus order, overlay/back stack and measured
responsive checks. Functional navigation grouping and current state must be
clear before visual polish. Never shrink controls or truncate the current mode
merely to force a composition to fit.

## Fresh content studies — unselected

Applied `frontend-design`, `frontend-skill` and `game-ui-ux` to a new content
plan, followed by separate art-direction and navigation critiques. Discarded
the Race/Garage/Shop launcher because it repeated the rejected Play hierarchy;
discarded Solo/Compete/Team and Trials/Career/Events because they resembled a
mode deck and introduced uncertain grouping. An always-visible five-mode list
cannot fit the narrow fixed header at native type/target sizes.

The new studies replace navigation chrome with three different racing objects:

- **Race programme:** native centered wordmark above a dated Daily event and a
  separate next-Daily countdown. The event opens the mode directory; Home owns
  global destinations. Campaign shows the four supplied series, and Numbers is
  an explicit series Back target.
- **Timing board:** a personal-best readout opens current-race Standings, with
  the native wordmark/current context to its right. The series screen shows one
  mastered series, derived from the supplied Hahah8/8 row, and opens the existing
  eligible finished-series Standings flow.
- **Pit lane:** actual orange Formula artwork is a direct Garage control;
  quiet current race context opens race options, and Home owns other destinations.

The art-direction review inspected complete390px Daily and series frames. It
accepted the new-content distinction provisionally and preferred Pit lane's
concrete racing subject. It requested clearer mode language and truthful
Campaign statistics. An initial83/116 catalogue summary was removed: native
Campaign Standings is per finished series with a rail of eligible series, not a
single board across the catalogue. `showGlobalLeaderboard` means all players
within that series. See `game/campaign/engine-methods.js:1442`.

Dates, countdowns and PBs are illustrative. The actual car asset is
`public/assets/cars/mr_mr_orange.webp`, but this study does not verify the player's
equipped skin. Four series and one mastered series describe only the supplied
screenshot snapshot. Stage context is a header-only illustration because no
stage screenshot was supplied. Next Daily refers to the upcoming global UTC
midnight, not a selected historical Daily's seven-day availability deadline.

## Fresh prototype and verification

The isolated content study is at `http://127.0.0.1:5196/`. It has Daily, Series
and Stage-context comparison controls, plus single-concept width/state links.
Its files and saved screenshots are outside the repository under the artifact
directory below, prefixed `content-`. No direction has been implemented.

Verified locally:

- Three390px comparison frames use exactly the same lower source image, width,
  height and crop for Daily and Series. Image and ancestor opacity are1, filters
  are none. Native Outfit900italic branding and local font files are retained.
- All three headers and Daily/Series/Stage states fit320px width, with full
  labels and header targets at least44px inside the original header bounds.
- Short390×490 Daily mode selection exposes Daily, Campaign and disabled future
  League, Tournament and Team play. Desktop comparison is1250px wide; Pit lane
  was additionally inspected at600px game width and320px mobile width.
- Prototype mode selection updates the reference state; nested and root
  Back/Escape restore the right layer and focus; keyboard focus stays in the
  menu; Numbers Back returns to Series; the car's Garage entry returns focus.
  Modes, current-race tools and global destinations are separate groups; Tracks
  is absent in the Series state and Shop remains disabled.
- JavaScript syntax checks passed and the prototype console had no errors.
  SHA256 comparison confirmed no changes to1283 tracked files relative to the
  study's starting inventory. Only this untracked research document was updated
  in the repository; unrelated dirty work remains intact.

Evidence: `content-daily-comparison.jpg`, `content-series-comparison.jpg`,
`content-stage-context.jpg`, `content-expanded-modes.jpg`,
`content-mobile-pit.jpg`, `content-desktop-pit.jpg`,
`content-header-verification.json` and `content-design-plan.md` in the artifact
directory. Native destination contents/callbacks and live data are not wired.
Hosted Reddit, physical devices, gamepad and platform safe areas remain
unverified. No production build, full game-suite pass, commit or deployment is
claimed for static visual proposals.

## Existing contracts and authoritative sources

The wordmark returns Home. Daily and Campaign stages expose Standings, Tracks,
Garage and Settings; the Campaign series screen hides Tracks and conditionally
shows Standings for completed series. Campaign stage context must name the
selected series. The visible Back button currently routes Home; stage-to-series
is a separate callback, also used by Escape. A proposal must account for both
depths rather than copying a glyph and assuming its callback.

Sources: `pages/game.html`, `game/lobby/ui.js`, `styles/foundation.css`,
`styles/lobby-modes.css`, `styles/lobby-and-garage.css`,
`docs/css-architecture.md`, `docs/system-change-map.md`,
`docs/track-carousel-layout-preview-2026-10-10.md`, and the two supplied screenshots.

## Artifact and proof boundary

Rejected studies remain outside the repository under:
`/Users/bpopa/.codex/visualizations/2026/10/10/01a124dd-1448-7560-98ff-3de82ca6c7dc/`.
The local5193 and5195 boards are rejected review evidence, not selected directions.

The earlier inspection confirmed identical390px Daily/series bitmap geometry,
local Outfit900italic branding, native12px700 labels, extracted SVGs and44px
controls at that comparison size. It also found the320px Campaign truncation.
Responsive, interaction and visual validation were interrupted and are not a
completed pass. Future modes/Shop are illustrative; actual game integration,
hosted Reddit, physical devices, gamepad and safe areas remain unverified.
No production build, full game test suite, commit or deployment is claimed.
