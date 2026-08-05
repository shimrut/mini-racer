# Game CSS Architecture

## Purpose

`styles.css` remains the single stylesheet entrypoint loaded by `game.html`. It is
an ordered manifest whose imports are bundled into the production `game.css`.

Standalone post surfaces (`preview.css`, `campaign.css`, `podium.css`,
`campaign-challenge.css`)
import `fonts.css` and reuse the same Outfit / JetBrains Mono + red accent
(`#ef4444`) tokens as the game. The Head to Head surface uses a responsive
race-poster composition: the duel/target brief owns the left reading path, the
verified track trace remains an open hero on the right, and the CTA anchors below
that trace. Its brand uses the shared stacked Mini/Racer lockup, and its format
line carries the lap count without adding ghost-status copy. Keep the existing
`challenge-*` IDs stable because
`campaign-challenge.js` hydrates them from immutable Reddit post data and
authenticated access responses.

The split is structural. Its first priority is preserving the original cascade:
the imported partials reproduce the previous stylesheet's rules in the same
top-to-bottom order.

## Ordered Stylesheets

| Order | Stylesheet | Product ownership |
| --- | --- | --- |
| 1 | `fonts.css` | Hosted Outfit and JetBrains Mono declarations |
| 2 | `styles/foundation.css` | Tokens, reset, body, focus and global states |
| 3 | `styles/race-hud-and-medals.css` | HUD, speed display and shared medal system |
| 4 | `styles/lobby-and-garage.css` | Game canvas, start menu and initial garage rules |
| 5 | `styles/lobby-modes.css` | Home, Daily, Campaign and Challenge lobby composition |
| 6 | `styles/track-carousel.css` | Shared Daily/Campaign selector rail, cards and medal ladder |
| 7 | `styles/race-controls-and-feedback.css` | Touch controls, countdown and lap feedback |
| 8 | `styles/modal-and-result-shell.css` | Modal foundation, pause and initial result rules |
| 9 | `styles/settings-and-track-shells.css` | Settings and track-list modal foundations |
| 10 | `styles/modal-components-and-standings.css` | Reusable sheets, modal components and standings foundation |
| 11 | `styles/responsive-layout.css` | Existing cross-product responsive overrides |
| 12 | `styles/results.css` | Main finish-result presentation |
| 13 | `styles/loading.css` | Startup loading screen |
| 14 | `styles/result-details.css` | Result details overlay and compact result layout |
| 15 | `styles/tracks-and-small-screens.css` | Track cards and later small-screen sheet overrides |
| 16 | `styles/standings-and-sharing.css` | Standings header, shareable rows and share panel |

Some files intentionally span more than one product surface. Those boundaries
reflect contiguous sections of the original stylesheet and avoid changing which
equally specific rule wins.

## Daily And Campaign Poster Contract

Daily and Campaign share one responsive poster composition rather than
maintaining mode-specific card layouts:

- `lobby-modes.css` owns the shared Daily/Campaign header in flow, the top-right
  toolbar, mode pane, bottom primary row, and the two-line Daily/Campaign Start
  Race action layout.
- `styles/lobby-and-garage.css` owns the shared primary-button typography,
  including the smaller header-font race-brief line with the bold selected track
  name, separator dot, and singular/plural lap count under Start Race.
- `track-carousel.css` owns the poster rail and its two-band card: bounded
  circuit schematic and player status. Identity belongs to the lobby header.
- `game/ui/track-carousel.js` generates the shared DOM. Daily and Campaign model
  builders supply different data without duplicating markup.
- `#start-group` remains the only width owner. The carousel reads its measured
  width and must not restate it with `100vw` or a second max width.
- The visible WebView is the height owner. `game/ui/visible-viewport.js`
  publishes `window.visualViewport.height` as `--app-visible-height` (falling
  back to `innerHeight` and then CSS viewport units), `html` and `body` use that
  value, and `#start-group` flexes inside the overlay's actual content box.
  Reddit's expanded-post header and footer are native siblings outside that
  measured WebView, so the app must not guess their height with an internal
  spacer. The existing overlay padding and reported safe-area inset are the only
  bottom clearance.
- Each Daily/Campaign pane is a two-row grid: the carousel gets
  `minmax(0, 1fr)` and Start Race gets its own intrinsic row. Neither is
  positioned, sticky, or layered. The pane, carousel, and mode-specific shell
  clip their own paint so transient WebKit resize states cannot draw poster
  content beneath the action. Inside each poster, the status footer owns a
  fixed `4rem` status band and the artwork is clipped to the card itself. The
  personal-best icon, standings value, and medal ladder remain present for open cards,
  while locked cards replace that context with a two-item prerequisite checklist.
- The Daily/Campaign header remains in normal flow above the rail. The actual
  `.lobby-title` is the fixed Mini Racer wordmark, and `.lobby-subhead` owns the
  mode label, divider, and right-side Daily date or Campaign track selection.
  Carousel movement
  updates only `[data-lobby-mode-selection]`; the wordmark, mode label, and
  divider keep their layout coordinates. Daily/Campaign reuse the compact
  carousel wordmark cap and mono billing scale; Home keeps its larger display
  treatment. Campaign repeats the selected track name in the right-side header;
  both modes also carry it in the Start Race action instead of repeating it in
  the poster.
- The header billing line spans the shell beside the Back/Standings/Garage/
  Settings rail. The preview and status footer remain clipped to the selected
  card and cannot paint into the adjacent track or Start Race row.
- The rail's lane is pinned, not scaled. `.track-carousel__viewport` is
  `position: absolute; inset: 0` inside the carousel, so the rail and every card
  are stretched to the row the pane actually granted. A percentage height there
  resolves through `#start-group` and the pane — heights that are only settled
  by flexing, and that flex again when `--app-visible-height` is published — and
  when the WebView treats that chain as indefinite the rail takes the poster's
  intrinsic height and the carousel's clip removes the scoreline. No height on
  the rail, the lane, or the card may depend on that chain.
- Cards, rail, and preview stay transparent and shadowless. The selected
  schematic is the visual anchor; neighboring schematics crop at the edges.
- Each poster is a two-band grid: bounded schematic hero and status. The preview
  canvas owns the first row rather than sitting behind the header or footer, so
  high-contrast road geometry cannot collide with either reading. The card's
  `overflow: hidden` remains the paint boundary; the separate Start Race row is
  never part of that canvas.
- The preview bitmap is fitted from the measured middle row. The track can grow
  into the available hero space, while a short WebView gives up artwork before
  it gives up the title, scoreline, or locked requirements.
- Daily and Campaign use one navy scrim with a restrained blur behind that
  transparent poster surface. The live canvas remains atmospheric, while the
  transition veil is reserved for the short mode handoff instead of being part
  of the settled selector treatment.
- Locked schematics remain fully opaque. Their muted state uses saturation and
  brightness only, so the live canvas cannot show through the track artwork.
- Locked Campaign cards show both independent gates: a medal on the previous
  stage and an `Additional medals needed` line when the campaign total is short.
  The exact remaining count sits inside the blue-gray medal placeholder at the
  left of that line. Satisfied gates use a white medal placeholder with the
  dark-blue check glyph; pending previous-stage gates use an empty blue-gray
  placeholder. The total placeholder becomes the same white check state when
  that gate is satisfied.
- The locked gate leaves only an opaque, medal-shaped lock plate over the
  schematic. Two plain prerequisite lines sit in the fixed status footer below
  the track, using natural-case display type so no copy is laid over the
  artwork or made to compete with the title. The large lock uses the medal SVG
  itself as the single opaque plate; it does not stack a second CSS shape behind
  the placeholder.
- The existing tokens remain the complete visual system: racing palette,
  `--header-font`, `--mono-font`, border colors, radius values, and motion
  durations/curves. The poster adds no parallel color, type, spacing, or
  breakpoint vocabulary.
- Billing and unplayed scoreline context use `--text-dim`; live values use
  `--text-color`; red is the lobby and poster wordmark structure — `RACER`, the
  active run, and Start Race — and nothing else on the poster.
- The lobby header owns the fixed Mini Racer wordmark above the schematic. Mode
  billing anchors left and `[data-lobby-mode-selection]` closes the same divider
  on the right; `game/lobby/ui.js` changes only that Daily date or Campaign track
  name when the carousel selection changes. The selected card's bold track name, separator
  dot, and lap count are rendered as the secondary race-brief line under the
  red Start Race action. A locked stage keeps that brief while the primary label
  changes to `Locked`.
- Daily and Campaign put Back, Standings, Garage, and Settings in one compact
  right-aligned icon-only rail. The buttons retain their accessible `aria-label`
  values and original compact minimum `2.75rem` tap area; Home and Challenge
  keep their existing navigation treatments.
- The lobby header keeps billing and the fixed Mini Racer wordmark in its own
  stable flow above the rail. At `max-height: 500px`, the middle hero and lock
  plate compact first, and the footer plus separate Start Race row remain
  contained without removing the open-card medal ladder.
- The personal-best stopwatch and standings ladder are inline SVGs with intrinsic
  `16 × 16` dimensions as well as the shared scoreline CSS size. Embedded clients
  can therefore not collapse either icon while refreshing or serving a partial
  stylesheet. The standings button keeps its accessible rank label while showing
  the same icon used by the top toolbar.
- The personal-best icon/time and standings icon/value share the same centered
  cross-axis in their score cells. The PB/standings meta group centers its
  children as one unit, and the medal ladder remains anchored to the footer's
  right edge.
- The status footer has no separating top border; the bounded track hero flows
  directly into the PB/standings/medal status line.

Selection is a behavior contract as well as a visual one. The centred card must
remain the source for Start Race and Standings, and measured pixel edge spacers,
positive-geometry guards, `ResizeObserver`, `touch-action: pan-x`, and gesture
interruption must remain intact for retained Reddit WebViews.

## Lobby Mode Transition Contract

`LobbyUi.showPane()` owns the Home, Daily, Campaign and Challenge handoff. On a
real mode change it adds `is-lobby-transitioning` to `#start-overlay`, swaps the
pane and body mode synchronously under the veil, then removes the class after
two animation frames. The overlay's opaque `::after` layer fades away with
`--dur-base`, so the live race canvas, old pane and independently changing
header cannot bleed through the swap.

The panes remain in one grid cell for stable measurement, but hidden panes leave
the layout immediately. Only the arriving pane runs `lobbyPaneIn`; the lobby no
longer relies on a delayed `display` transition or `allow-discrete` support in
an embedded WebView. Keyboard navigation and pointer input are blocked while
the veil is active.

The race HUD keeps a stable `12px` top position during the race-start handoff.
`RaceHud.anchorHudBar()` does not measure the generic lobby `header`, because
that header is inside the fading overlay and collapses when the overlay is
hidden; observing it would make the HUD jump after its entrance animation.

`TrackCarousel` builds the card DOM first and paints new preview canvases from
the following layout frame. It also completes all carousel geometry reads
before writing proximity properties, avoiding a forced layout between every
card during a swipe. Neighbor peeks remain a steady-state carousel affordance;
the transition veil, rather than card opacity, contains them during screen
navigation.

## Motion Tokens

`foundation.css` owns the timing vocabulary, and every partial transitions
against it rather than against a hand-typed number.

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120ms | Immediate feedback: hover and press colour, opacity |
| `--dur-base` | 160ms | The default — enters, exits, content swaps |
| `--dur-slow` | 200ms | The ceiling for anything the player waits through |
| `--dur-race-start-exit` | 100ms | Exact Daily/Campaign Start Race screen fade |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Neutral in-and-out |
| `--ease-settle` | `cubic-bezier(0.22, 1, 0.36, 1)` | Panels and cards arriving |
| `--ease-glide` | `cubic-bezier(0.16, 1, 0.3, 1)` | Long decelerating entrances |
| `--ease-back` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Overshoot on stat and medal pops |

The band stops at 200ms because these cover a state change rather than perform
one. Durations above it are deliberate moments — the boot curtain, the medal
entrance, the spinner and loader loops — and stay written out at their own site,
where the number is the point. `ease` and `ease-out` remain the plain keywords
for colour and opacity; the curve tokens are for things that move.

`styles-architecture.test.js` fails on any transition or animation duration at
or under 200ms that is not a token, so new timings cannot creep back in.
Animation *delays* are exempt. The 100ms race-start exit is deliberately named
for its single handoff rather than added to the general motion band.

## Change Rules

- Keep `styles.css` as the only game stylesheet linked from HTML.
- Do not size a full-screen child independently from `dvh`; route usable
  embedded-browser height through `--app-visible-height` and let descendants
  flex from their containing block.
- Reach for a motion token before typing a duration or curve. A new one belongs
  in `foundation.css` with the others, not inline.
- Add new styles to the partial that owns the product surface.
- Keep responsive rules beside their feature when they are new and
  self-contained. Do not move an existing override between files without
  checking its cascade dependencies.
- Do not introduce cascade layers as part of file maintenance; layers change
  precedence independently of selector specificity.
- Do not change the font URLs or remove the root-level production font assets
  without validating the actual Devvit-hosted path.
- When import order changes, update the architecture test and verify every
  affected modal and responsive layout.

## Validation

For structural or cross-file changes:

1. Run `npm test`.
2. Run `npm run build`.
3. Confirm generated `game.html` still references one `/game.css`.
4. Smoke-check loading, lobby, race HUD, pause, results, standings, tracks,
   garage, settings and sharing at desktop, narrow mobile and short landscape
   sizes.
5. For Daily/Campaign poster work, include 375 × 596, 390 × 844, 844 × 390,
   723 × 592, and 1463 × 725; verify no document scroll, no scoreline/CTA
   overlap, at least `5rem` of reported-viewport clearance below the complete
   action row on Reddit-sized mobile viewports, selected-card recentering after
   resize, and synchronized Start/Standings lock state.
