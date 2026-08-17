# Mini Racer promo page

Standalone page with the same lobby look as the game (Outfit type, racing red title, Daily / Campaign / Join Community), plus an About page carrying the searchable/citable detail. Open `index.html` in a browser, or host the whole `LP` folder anywhere.

Canonical host: **https://miniracer.club/**. That origin is hard-coded in the canonical tags, Open Graph URLs, JSON-LD, `sitemap.xml`, `robots.txt` and `llms.txt` — change it in those files if the domain ever moves.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Hero page. Metadata, Open Graph/Twitter tags, `WebSite` + `VideoGame` JSON-LD. |
| `about.html` | About screen: the modes, driving, verified times. `AboutPage` + `BreadcrumbList` JSON-LD. |
| `styles.css` | Shared — hero styles plus the `body.page-about` styles used by About. |
| `robots.txt` | Allow-all, with the AI answer-engine crawlers spelled out, and the sitemap pointer. |
| `sitemap.xml` | Both pages. Bump `lastmod` when the copy changes. |
| `llms.txt` | Plain-text summary of the game for answer engines. Keep it in sync with `about.html`. |
| `track.png`, `og.png`, `favicon.png`, `apple-touch-icon.png` | Generated — see below. |

About is its own page in the game's materials — night navy, Outfit italic names, mono clocks, the schematic track as an object. First screen is a poster. Then Daily / Campaign / Head to Head as a starting grid, the track again as a plate, how it plays, and Race in the same red as Racer. Not a lobby, not a modal, not type on a blur. Copy stays short. No spec tables, no FAQ.

## Set the links

Edit `config.js` and paste the URLs:

```js
window.LP_LINKS = {
    daily: 'https://…',
    campaign: 'https://…',
    community: 'https://www.reddit.com/r/MiniRacerGame/',
};
```

Empty values leave that button disabled.

## Generated assets

`track.png` (hero background) is generated with the same custom-post preview track renderer as the Reddit post preview. The same command also writes `og.png` (1200×630 social card, Outfit lockup over the track) and the two icons, resized from `assets/icon.png`.

From the repo root:

```sh
npm run generate:lp-assets
```

```sh
npm run generate:lp-assets -- --track=titanTown
```
