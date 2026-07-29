# Game CSS Architecture

## Purpose

`styles.css` remains the single stylesheet entrypoint loaded by `game.html`. It is
an ordered manifest whose imports are bundled into the production `game.css`.

Standalone post surfaces (`preview.css`, `podium.css`, `campaign-challenge.css`)
import `fonts.css` and reuse the same Outfit / JetBrains Mono + red accent
(`#ef4444`) tokens as the game.

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

## Motion Tokens

`foundation.css` owns the timing vocabulary, and every partial transitions
against it rather than against a hand-typed number.

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120ms | Immediate feedback: hover and press colour, opacity |
| `--dur-base` | 160ms | The default — enters, exits, content swaps |
| `--dur-slow` | 200ms | The ceiling for anything the player waits through |
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
or under 200ms that is not a token, so a fourth timing cannot creep back in.
Animation *delays* are exempt.

## Change Rules

- Keep `styles.css` as the only game stylesheet linked from HTML.
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
