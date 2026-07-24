# Mini Racer promo page

Standalone page with the same lobby look as the game (Outfit type, racing red title, Daily / Campaign / Join Community). Open `index.html` in a browser, or host the whole `LP` folder anywhere.

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

## Track background

`track.jpg` is generated with the same custom-post preview track renderer as the Reddit post preview.

From the repo root:

```sh
npm run generate:lp-assets
# optional: npm run generate:lp-assets -- --track=titanTown
```
