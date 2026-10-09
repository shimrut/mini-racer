# Mini Racer landing page improvement proposal

Date: 2026-10-06. Status: implemented as a separate local preview in `LP/v2.html`; no deployment or replacement of `LP/index.html`.

## Goal

Help a new visitor understand the racing, see reasons to return, and open a race. Keep the recognizable Mini Racer identity while showing more of the actual game.

## Current findings

- The live homepage at <https://miniracer.club/> matches the single-hero structure in `LP/index.html`: navigation, a static track image, stacked title, two paragraphs and one play button. There is no gameplay footage or further feature content.
- The narrow browser view shows a heavily enlarged track behind the title and paragraph panel. The car sits at the starting line; visitors cannot see steering, a ghost, a finish, medals or customization in action. Desktop composition is inferred from `LP/styles.css`, not visually verified in this review.
- The live **Race now** link points to the subreddit. `LP/config.js` leaves Daily and Campaign empty and supplies Community; the `defaultPlay` expression in `LP/index.html` selects Community and overwrites the Daily fallback. A race CTA should open the intended race launcher. The config comment also incorrectly says empty values disable buttons; markup fallbacks remain active.
- Existing marketing counts need review before reuse. `LP/llms.txt` says 23 cars while the README's 2.0 changelog says 22. Campaign definitions can grow and published stored series can supplement the app definitions; the Numbers completion endpoint is explicit. Avoid treating an old count as the whole current product.
- `tools/build-site.js` publishes the homepage and `/mapmaker` together. A later release must preserve that combined build and its protected routes.

## Recommended direction

The signature element is a short, real gameplay loop: steering through a corner, chasing a ghost and crossing the line. Use the game's rendering and actual interface, with a still poster if footage is unavailable. Keep motion contained to that demonstration.

Use the actual game UI sources: midnight navy `#020617`, accent red `#ef4444`, text `#f8fafc`, dim text `#94a3b8` and muted text `#64748b` from `styles/foundation.css`. Use the game's Outfit type, stacked lobby title, bold italic uppercase headings, red pill actions, metallic hexagonal medals and Garage paint controls. JetBrains Mono belongs to timing and the existing brand tagline.

The revised direction follows the user's review: a game promotion page with large game artwork and literal feature copy. Remove eyebrow labels, invented slogans and equal feature-card grids. Keep the original “Small tracks. Big competition.” brand tagline. The user rejected the alternating-row layout and selected an arcade game poster: bold, dense and playful, with racing filling the screen. Page flow is now a full-bleed Shark Bite poster with oversized title and foreground Street car; a compact selectable mode showcase with a track strip; a large Garage showroom against a red diagonal backdrop; a short controls/play footer.

## Content and behavior

1. **Hero:** retain “Small tracks. Big competition.” Suggested support: “Race the daily track, chase ghosts, and earn Campaign medals.” Make gameplay visible immediately. Put the primary action and “Plays on Reddit” near the headline.
2. **Three modes:** explain a distinct reason to play each. Daily: a shared daily course and standings. Campaign: earn Bronze, Silver, Gold and Author medals to progress. Head to Head: challenge another player's saved ghost. Pair each explanation with genuine game imagery. Only offer a direct Head to Head action if there is a maintained, valid destination.
3. **Track gallery:** show four to six visually different circuits with their real names. Reuse the existing track preview renderer. Choose examples available to players; developer-only or unpublished grounds and series do not establish playable content.
4. **Garage:** show a small selection of actual cars, paint and trail choices. Explain that customization changes appearance. Prefer a static composition initially; a full interactive Garage adds work without being necessary to explain the feature.
5. **Controls and expectations:** explain automatic acceleration, keyboard steering and touch controls briefly. Say the game opens on Reddit. Use clear buttons such as “Play Daily on Reddit” and “Play Campaign.”
6. **Closing action:** repeat the race action after the showcase, alongside community and useful help links. Use real evidence if adding community quotes or player numbers; otherwise omit them.

On mobile, stack headline, race action and demonstration before the longer feature sections. Give the gameplay its own area rather than placing paragraphs over it. Use a lightweight muted inline video, a useful poster, reduced-motion behavior, and an explicit way to pause repeated motion. Load lower-page imagery as needed. Preserve keyboard focus and comfortable touch targets.

## Sensible implementation stages

- First pass: correct race destinations and config documentation; rebuild the hero; add the three-mode section, a track strip and closing CTA using existing assets.
- Second pass: capture and optimize real gameplay footage; add the Garage showcase; create a dedicated social sharing image showing the car, track and brand. Keep title, description, structured data, `llms.txt` and sitemap consistent with the resulting page.
- Consider an interactive steering demo only after the static showcase is complete. Reuse the game's simulation if it is later approved; introducing a separately behaving mini-game is unnecessary for this first redesign.

## Validation

This review inspected the live homepage and narrow-layout screenshot, the local landing page/config/styles, build ownership, and relevant game documentation. It did not verify the Reddit launchers themselves or measure conversion.

For implementation, verify all CTA destinations, desktop and phone layouts, keyboard focus, reduced motion and media fallbacks. Run the existing landing-asset and site checks plus `npm run build:site`; add focused link-resolution coverage for the observed Community override. Confirm the combined output still includes Mapmaker and its existing route protections before any deployment. Measure race-launch clicks separately from community visits if analytics are later requested.

## Version two implementation

- `LP/v2.html`, `v2.css` and `v2.js` implement the arcade-poster preview as a separate page. The original homepage remains available for comparison. The preview is excluded from indexing and the canonical sitemap.
- The hero crops genuine Shark Bite race artwork around the original stacked title, a large foreground white Street car and a translucent blue car. This is promotional artwork; the complete recorded car/ghost lap appears in the Daily mode showcase below. No eyebrows, invented slogans, feature-card grids or repeated full-width separators are used.
- Daily, Campaign and Head to Head share one selectable showcase, followed by four named track previews. The selector uses semantic tabs with one active panel, roving focus, Left/Right wrapping, Home/End and pointer selection. Campaign displays the actual four medal icons; Head to Head shows car and ghost artwork. These controls only change promotional content.
- Garage shows a large current Street car against a red diagonal backdrop with seven real body-paint choices. Paint controls update only the pictured car. Copy names cars, paint, decals and trails without making numerical catalog claims or claiming all ground types have identical physics.
- `tools/generate-lp-showcase.js` now also reuses `buildTrackCanvas` and race presentation for curbs, asphalt, finish and tire barriers. Transparent off-track areas allow the poster composition. The geometry fit is exactly the existing replay transform, so the new race artwork and recorded overlay stay aligned. Node document/canvas shims restore their previous globals in `finally`.
- Two demonstration laps use shared physics and the test autopilot, finishing in approximately 6.056s and 6.468s with all three checkpoints. They are not hosted/player standings. Replay has pause/play, reduced-motion stills with explicit opt-in, offscreen/document-hidden suspension, and a track-only failure fallback. Selecting a different mode suspends the hidden Daily replay through its existing visibility observer.
- Game UI comes from copied authoritative styles, refreshed by `build:site`. `createMedalIconSvg`, `DrawnCar` and the Garage crop helper provide actual medals and cars. The landing CSS owns poster composition, scrolling layout and artwork sizing; the game retains font, palette and component styling ownership.
- Validation is local: 56 focused tests passed across preview links/interpolation, recorded laps/rendering, authoritative UI copies, Street paint renders, actual race/replay alignment, medal generation, existing landing assets and Mapmaker site protections. Typecheck and combined site build passed. Browser checks cover 320px/390px phones, a 768px tablet and a 1440px desktop, with no horizontal document overflow. A Campaign panel sizing issue at tablet width was fixed with bounded grid columns and rechecked. Mode selection, keyboard End/wrapping, replay controls, paint selection and correct links were verified; console warnings/errors were absent. Reduced-motion and failed-fetch branches are source-reviewed rather than browser-emulated; hosted launchers and physical devices remain unverified. Screenshots are under the ignored `output/landing-v2/` folder.
- The combined build keeps the original homepage, version-two preview, Mapmaker and the existing protected route manifest. No game runtime, ranking, persistence, Mapmaker behavior or deployment changed.

Review locally at <http://127.0.0.1:4178/v2.html> after following `LP/README.md`. This is a design preview; making it the main homepage or publishing it is a later step.
