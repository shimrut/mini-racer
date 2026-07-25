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
| 5 | `styles/race-controls-and-feedback.css` | Touch controls, countdown and lap feedback |
| 6 | `styles/modal-and-result-shell.css` | Modal foundation, pause and initial result rules |
| 7 | `styles/settings-and-track-shells.css` | Settings and track-list modal foundations |
| 8 | `styles/modal-components-and-standings.css` | Reusable sheets, modal components and standings foundation |
| 9 | `styles/responsive-layout.css` | Existing cross-product responsive overrides |
| 10 | `styles/results.css` | Main finish-result presentation |
| 11 | `styles/loading.css` | Startup loading screen |
| 12 | `styles/result-details.css` | Result details overlay and compact result layout |
| 13 | `styles/tracks-and-small-screens.css` | Track cards and later small-screen sheet overrides |
| 14 | `styles/standings-and-sharing.css` | Standings header, shareable rows and share panel |

Some files intentionally span more than one product surface. Those boundaries
reflect contiguous sections of the original stylesheet and avoid changing which
equally specific rule wins.

## Change Rules

- Keep `styles.css` as the only game stylesheet linked from HTML.
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
