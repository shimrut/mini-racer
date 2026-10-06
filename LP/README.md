# Mini Racer promo page

Standalone single-page promo site with the same lobby look as the game (Outfit type, racing red title, Daily / Campaign / The Club). The hero carries the searchable detail. Open `index.html` in a browser, or host the whole `LP` folder anywhere.

Canonical host: **https://miniracer.club/**. That origin is hard-coded in the canonical tags, Open Graph URLs, JSON-LD, `sitemap.xml`, `robots.txt` and `llms.txt` — change it in those files if the domain ever moves.

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

## Numbers on the page

The player and race counts (`.proof` in `index.html`) are typed in by hand; update them from Mod Analytics. The medal times (`.medals`) are Half Life's, from `game/medals/medal-times.json` (key `halfLife`).

## Generated assets

`track.png` (hero background) is generated with the same custom-post preview track renderer as the Reddit post preview. `favicon.png` and `apple-touch-icon.png` are kept as committed files.

From the repo root:

```sh
npm run generate:lp-assets
```

```sh
npm run generate:lp-assets -- --track=titanTown
```
