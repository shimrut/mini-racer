# Game CSS Architecture

## Purpose

`styles.css` remains the single stylesheet entrypoint loaded by `game.html`. It is
an ordered manifest whose imports are bundled into the production `game.css`.

Standalone post surfaces (`preview.css`, `campaign.css`, `podium.css`,
`head-to-head.css`, `mod-analytics.css`)
import `fonts.css` and reuse the same Outfit / JetBrains Mono + red accent
(`#ef4444`) tokens as the game. The podium row keeps place, identity, and
time in one grid, with identity tight to the rank. On phones the title shrinks,
the “Final podium” line hides, date and lap sit on one line, rows get shorter,
and **View Replays** / **Play Now** share the footer width. **View Replays** sits next
to Play Now. Replay mode hides the list and the podium subtitle/date/lap lines, keeps Mini
Racer top left and the track name top right, gives the track its own band above
the chrome, and puts a thin pill progress bar with a thicker grab knob above
play/pause with #1 / #2 / #3 and Trail on the left and the clock on the right,
with Back floating over the track above the progress bar.
Back uses the same button shape as the place toggles. That chrome is the same
on every viewport. The moderator analytics page is one
sticky-header table: a row per UTC day, with the day's players split into new
and returning and each mode's starts and finishes beside them. The newest row
carries the red accent. The Head to Head surface uses a responsive
race-poster composition: the duel/target brief owns the left reading path, the
verified track trace remains an open hero on the right, and the CTA anchors below
that trace. Its brand uses the shared stacked Mini/Racer lockup, the duel row
marks the matchup with italic uppercase VS. (white V, red S), and its
format line carries the lap count without adding ghost-status copy. Keep the existing
`challenge-*` IDs stable because
`head-to-head.js` hydrates them from immutable Reddit post data and
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
| 4 | `styles/lobby-and-garage.css` | Game canvas, start menu and garage rules. Garage Car/Trail uses the same sliding pill as Settings on/off: slate track (`#1e293b` so it reads on the garage sheet), red thumb, `--radius-full`, `2.5rem` tall. |
| 5 | `styles/lobby-modes.css` | Home, Daily, Campaign and Challenge lobby composition |
| 6 | `styles/track-carousel.css` | Shared Daily/Campaign selector rail, cards and medal ladder |
| 7 | `styles/race-controls-and-feedback.css` | Touch controls, countdown and lap feedback |
| 8 | `styles/modal-and-result-shell.css` | Modal foundation, pause and initial result rules |
| 9 | `styles/settings-and-track-shells.css` | Settings and track-list modal foundations. Settings on/off rows use the same Off/On pill as the Daily/Campaign lobby switch: a slightly lighter slate track so it reads on the settings card, sliding red thumb, Outfit labels. Pause keeps that row: label left, three-way pill (Separate / Timer / Speedo) right, sized to the labels with Off/On-like padding. Keyboard selection still uses the row's `is-menu-selected` ring. |
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

## Finish Sheet Contract

Daily, Campaign, and Head to Head share one finish column in
`styles/result-details.css` under `#modal-combined-view`: the hero, comparison
rows, and buttons use the same 320px width and 0.35rem padding, and the rows
sit 2.75rem below the hero. Mode only changes the content in those slots.

Head to Head fills the hero with italic Outfit `YOU WON` / `YOU LOST` /
`YOU TIED` on the left above a right-aligned race time of the same
size, scoped under `#modal-combined-view.is-challenge-finish`. Green is a win,
red is a loss, and a tie stays neutral. Pending verification shows only
`VERIFYING`; a judged result pushes that word out as `YOU WON` / `YOU LOST` /
`YOU TIED` slides in. Failed verification uses `UNVERIFIED` and keeps its
status detail. Every hero word in that slot — VERIFYING, YOU WON, YOU LOST,
YOU TIED, UNVERIFIED — uses the same 3.5rem size as the race time.

Below that stack, the existing result slots flow as three left-label/right-value
upright rows: opponent delta, prior-PB delta, and originating rank. The PB slot keeps its
honest empty state. The rank row stays visible: it shows the rank already held on
that board, updates the number only when this run is a personal best, and reads
`TRACK LOCKED` for a Campaign stage the player has not unlocked. Tapping that
locked row opens the existing split-times mini overlay with a short explanation.
The rank row stays clickable for standings or that locked note, with no hover
scale or recolor. The layout
uses flex flow, inherited modal width and safe-area behavior, plus a
`max-height: 640px` compaction; it must not introduce absolute result positioning.
The Head to Head hero contains no avatar, medal, opponent name, or duplicate margin.
Those elements remain valid on the separate Challenge lobby/won portrait.
The verdict lockup and Daily/Campaign status heading enter with the same
`slideInLeft` 0.5s glide as Mini, and the time with the same `slideInRight`
0.6s / 0.1s delay as Racer, both delayed by `--dur-finish-headline` (10ms)
after the finish modal fade starts. Comparison rows and buttons do not
stagger. A local Head to Head beat can swap Improve/Home for Daily/Campaign
while VERIFYING is still showing; Brag stays disabled until the judged win.
Reduced motion turns the sequence off. Daily and Campaign put a
status heading above the time in that same column — medal name, NEW BEST, or
FINISHED. MEDALS, VS PB, and RANK stay the comparison rows. Racing a standings
ghost also shows VS #rank (or VS) above VS PB. Tapping MEDALS opens
the same mini overlay as checkpoint splits, with each medal, its name, and its
target time in one row.

## Daily And Campaign Poster Contract

Daily and Campaign share one responsive poster composition rather than
maintaining mode-specific card layouts:

- `lobby-modes.css` owns the shared Daily/Campaign header in flow, the top-right
  toolbar, mode pane, bottom primary row, and the two-line Daily/Campaign Start
  Race action layout. A pending Start spinner sits to the left of that stack so
  the button does not grow a third row.
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
- A frame is the one place where that measurement fails. The reddit.com page
  keeps the game in a frame, and a frame reports its own box as
  `visualViewport.height` and reports a zero safe-area inset. The app therefore
  cannot see Reddit's bar or the mobile browser's toolbar over the bottom strip,
  which cut the speedometer and the pause button. `markFramedDocument()` puts
  `is-framed` on the root, and the phone rule in `responsive-layout.css` holds
  `.mobile-hud-bar` 4rem above the frame's bottom edge. The Reddit apps load the
  game as the top document, so they stay on the measured clearance. Desktop
  keeps the base rule. This 4rem is the only guessed clearance in the
  stylesheets. Do not extend it to the lobby, which measures correctly.
- Each Daily/Campaign pane is a two-row grid: the carousel gets
  `minmax(0, 1fr)` and Start Race gets its own intrinsic row. Neither is
  positioned, sticky, or layered. The pane, carousel, and mode-specific shell
  clip their own paint so transient WebKit resize states cannot draw poster
  content beneath the action. Inside each poster, the status footer owns a
  fixed `4rem` status band and the artwork is clipped to the card itself. The
  personal-best icon, standings value, and medal ladder remain present for open cards,
  while locked cards replace that context with a two-item prerequisite checklist.
  Tapping the medal ladder opens the same MEDALS mini overlay used on the finish
  screen, mounted on `#start-overlay` so it covers the lobby.
- The Daily/Campaign carousel stacks the schematic, the `current / total`
  counter, then the track's own footer (time, rank, medals) — everything below
  the artwork describes the track above it. Daily's expiry line and counter
  open the Tracks list; Campaign's counter opens the same list with Campaign
  stages. That list uses a header title (`Daily Tracks` / `Campaign Tracks`) and
  `#daily-playlist-list` as equal `repeat(2, minmax(0, 1fr))` tiles (preview
  with medal top-left and rank `#x` top-right when known, name on the left,
  laps on the right), scoped under
  `#daily-playlist-modal` so lobby posters stay wide hero cards. Previous and Next leave that stack:
  they are circular icon buttons grid-placed into row 1 with `align-self:
  center` and `justify-self: start`/`end`, so they flank the schematic and stay
  centred on artwork whose height is only resolved at layout time. Absolute
  offsets from the carousel's own edges could not track that `1fr` row. They
  are direct children of `.track-carousel` rather than of
  `.track-carousel__navigation`, which now carries only the counter;
  `syncNavButtons()` still hides that wrapper when the rail is empty and the
  buttons themselves below two cards. Their 2.5rem circles overlay the outer
  edge of the scroll viewport, so a swipe has to start inboard of them. The
  challenge poster keeps its original two-row layout.
- The Daily/Campaign header remains in normal flow above the rail. The actual
  `.lobby-title` is the fixed Mini Racer wordmark, and `.lobby-subhead` owns the
  mode label, divider, and right-side Daily date or Campaign track selection.
- The wordmark is the route back to the mode menu. `.lobby-title` stays the `h1`
  and keeps `pointer-events: none`; the `.lobby-title__home` button inside it
  takes them back, so the hit area is the letters rather than the full header
  width. The button inherits `font`, `color`, `letter-spacing`, `line-height`,
  `text-align`, `text-transform` and `text-shadow` — a bare `button` would
  otherwise pick all of those up from the UA sheet. It is `disabled` on Home,
  which keeps it out of the tab order there, and its `:disabled` rule restores
  `color` and `opacity` so the UA's grey does not reach "MINI".
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
- Daily and Campaign put Back, Standings, Tracks, Garage, and Settings in one compact
  right-aligned icon-only rail. Tracks sits between Standings and Garage, matching
  the old main-menu order. The buttons retain their accessible `aria-label`
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
mode change that routes through Home or Challenge it adds
`is-lobby-transitioning` to `#start-overlay`, swaps the pane and body mode
synchronously under the veil, then removes the class after two animation frames.
The overlay's opaque `::after` layer fades away with `--dur-base`, so the live
race canvas, old pane and independently changing header cannot bleed through the
swap. Those handoffs also run inside a `startViewTransition()` scoped to
`.lobby-panes`.

Switching directly between Daily and Campaign takes neither path. The two modes
share a header, a background track and a pane layout, so `showPane()` treats
them as a toggle: the `.lobby-mode-switch` thumb slides on its own transition
and `lobbyPaneIn` runs on the arriving pane's `.track-carousel` instead of the
pane itself, leaving the Start Race button planted. Veiling or cross-fading the
whole lobby there reads as a full-screen flicker over content that barely
changed, and the veil's reason to exist — hiding a background track reload —
does not apply, because neither mode reloads it.

`showPane()` records which kind of swap it ran in `body[data-lobby-pane-swap]`,
and that value stays until the next swap replaces it. Clearing it once the
entrance settles would re-apply `animation` to `.lobby-pane` and replay the
entrance a second time.

The panes remain in one grid cell for stable measurement, but hidden panes leave
the layout immediately. Only the arriving pane runs `lobbyPaneIn`; the lobby no
longer relies on a delayed `display` transition or `allow-discrete` support in
an embedded WebView. Keyboard navigation and pointer input are blocked while
the veil is active, so the Daily/Campaign toggle stays interactive throughout.

The race HUD keeps a stable `12px` top position during the race-start handoff.
During a run the lap clock is written at 30 Hz and the speed readout at 15 Hz
to one `#speedometer` in `.mobile-hud-bar`. Phone and desktop only change that
bar's layout.
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
| `--dur-finish-headline` | 10ms | Finish heading delay after the modal fade |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Neutral in-and-out |
| `--ease-settle` | `cubic-bezier(0.22, 1, 0.36, 1)` | Panels and cards arriving |
| `--ease-glide` | `cubic-bezier(0.16, 1, 0.3, 1)` | Long decelerating entrances |
| `--ease-back` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Overshoot on stat and medal pops |

The band stops at 200ms because these cover a state change rather than perform
one. Durations above it are deliberate moments — the boot curtain, the medal
entrance, the spinner and loader loops — and stay written out at their own site,
where the number is the point. The splash bar crawl (1.8s to 88%, then 12s to
96%) lives in `styles/loading.css` so it can keep moving while startup waits. `ease` and `ease-out` remain the plain keywords
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
3. Confirm generated `game.html` references exactly one content-hashed game CSS file.
4. Smoke-check loading, lobby, race HUD, pause, results, standings, tracks,
   garage, settings and sharing at desktop, narrow mobile and short landscape
   sizes.
5. For Daily/Campaign poster work, include 375 × 596, 390 × 844, 844 × 390,
   723 × 592, and 1463 × 725; verify no document scroll, no scoreline/CTA
   overlap, at least `5rem` of reported-viewport clearance below the complete
   action row on Reddit-sized mobile viewports, selected-card recentering after
   resize, and synchronized Start/Standings lock state.
