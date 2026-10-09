# Mini Racer promo page

Standalone single-page promo site with the same lobby look as the game (Outfit type, racing red title, Daily / Campaign / The Club). The hero carries the searchable detail. Open `index.html` in a browser, or host the whole `LP` folder anywhere.

Canonical host: **https://miniracer.club/**. That origin is hard-coded in the canonical tags, Open Graph URLs, JSON-LD, `sitemap.xml`, `robots.txt` and `llms.txt` — change it in those files if the domain ever moves.

The [2026-10-06 landing page proposal](../docs/landing-page-improvement-proposal-2026-10-06.md) records the redesign direction and validation. A second version is available in `v2.html` for local review; `index.html` remains the current homepage.

## Version two preview

The preview uses the user's selected arcade-poster direction: a cropped Shark Bite race scene with oversized game branding and a close-up Street car, a compact Daily / Campaign / Head to Head selector, a named track strip and a red Garage showroom. Copy describes the game directly, with no eyebrow labels or invented slogans. The original “Small tracks. Big competition.” tagline remains. It has `noindex` metadata and is not listed in the sitemap.

The mode selector changes only the promotional content. It supports pointer selection, Left/Right, Home/End and normal Tab navigation. The actual Play links launch the corresponding Reddit posts.

Build and serve the combined site locally:

```sh
npm run build:site
python3 -m http.server 4178 --bind 127.0.0.1 --directory site/dist
```

Open <http://127.0.0.1:4178/v2.html>. The existing page is at `/`. No deployment is needed to compare them.

Regenerate preview artwork and recorded laps with:

```sh
node tools/generate-lp-showcase.js
```

The generator reuses `buildTrackCanvas` for the full race artwork, the schematic renderer for small track previews, and shared physics and test autopilot for the replay. The actual road, curbs, finish line and tire barriers keep the game's presentation; transparent off-track areas allow poster composition. Two complete Classic Circuit laps are sampled at 20 Hz, including the exact finish-line crossing. They are demonstration recordings, not live standings or player results. `v2.js` only plays those samples; it does not run a separate driving simulation. The animation pauses offscreen, while the document is hidden, or with its pause button. Reduced motion shows a still unless the visitor explicitly plays the replay. A failed replay request retains the track preview.

`showcase/` contains generated tracks, replay JSON and seven body-color renders of the current Street car. Car images use the actual `DrawnCar` model, paint palette and Garage crop helper; medals use the game’s `createMedalIconSvg`. `showcase/ui/` copies the authoritative game styles in their documented cascade order; only font asset paths change. `build:site` refreshes these game components in the output, while `v2.css` owns document layout and artwork sizing. The color controls only change the showcase picture. Every `data-destination` link uses its own `config.js` override or HTML fallback; Community configuration cannot replace a Daily race link. This behavior is scoped to version two; the original page retains its existing link resolution.

## Publish

miniracer.club is the Cloudflare Pages project `miniracer`. Every upload replaces the whole site, so this page and the online Mapmaker (`/mapmaker`) are published together from the repo root:

```sh
npm run deploy:site
```

`npm run build:site` builds the site into `site/dist` without publishing it. See `docs/track-authoring.md`, **Online Mapmaker**.

Short links live in `_redirects`. Change those URLs when the Reddit launcher posts change, and keep them in line with the links in `index.html` and `config.js`.

| Path | Goes to |
| --- | --- |
| `/today`, `/daily`, `/play` | Today's Daily post |
| `/campaign`, `/career` | The Campaign post |
| `/club`, `/community`, `/join` | The subreddit |

`today.html` is the same Daily jump, for browsers that do not follow the shortcut file.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Hero page with the about copy. Metadata, Open Graph/Twitter tags, `WebSite` + `VideoGame` JSON-LD. |
| `styles.css` | Shared hero styles. |
| `v2.html`, `v2.css`, `v2.js` | Separate redesign preview, styles, recorded-lap playback and car-color controls. |
| `showcase/` | Generated tracks, recorded laps, current Street car artwork and original game UI components for version two. |
| `_redirects` | The short links above. |
| `today.html` | Backup jump to today's Daily. |
| `robots.txt` | Allow-all, with the AI answer-engine crawlers spelled out, and the sitemap pointer. |
| `sitemap.xml` | One page. Bump `lastmod` when the copy changes. |
| `llms.txt` | Plain-text summary of the game for answer engines. Keep it in sync with `index.html`. |
| `track.png`, `favicon.png`, `apple-touch-icon.png` | Generated — see below. |

## Set the links

Edit `config.js` and paste the URLs. An empty value leaves the link written in `index.html` as it is.

```js
window.LP_LINKS = {
    daily: 'https://…',
    campaign: 'https://…',
    community: 'https://www.reddit.com/r/MiniRacerGame/',
};
```

## Generated assets

`track.png` (hero background) is generated with the same custom-post preview track renderer as the Reddit post preview. `favicon.png` and `apple-touch-icon.png` are kept as committed files.

From the repo root:

```sh
npm run generate:lp-assets
```

```sh
npm run generate:lp-assets -- --track=titanTown
```
