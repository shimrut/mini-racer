# Race start leaves the previous track visible

Investigated October 1, 2026, on `challenge-share-buttons`, HEAD `87eab8bc`.
Scope: code and live Devvit logs; no runtime changes. The existing dirty
`game/track/grounds.js` was preserved.

## Findings

There is a concrete Daily cache path that leaves authoritative track loading
until Start. The previous track remains on screen because the lobby begins
fading before that awaited work finishes. The code establishes this path;
existing hosted logs do not identify which request caused the reported pause
or measure its duration.

1. **Saved Daily cards are treated as a complete playlist without restoring
   their tracks.** `game/daily-challenge/service.js:400-422` persists and
   restores challenge metadata. Stored geometry and `confirmedKeys` are
   separate, memory-only state (`game/track/stored-tracks.js:12`,
   `game/track/stored-track-service.js:16-18`).
   `getDailyChallengePlaylist()` returns seven usable cached challenges
   without fetching (`service.js:810-816`). The carousel and Tracks sheet
   also skip fetching when they already have seven cards
   (`game/daily-challenge/engine-methods.js:818,883`). Consequently a reload
   can show selectable cards whose authoritative layouts were never loaded
   in this session. The opening Daily can already be confirmed while the
   other cached cards are not.

2. **Prewarming does not close that confirmation gap.**
   `game/daily-challenge/engine-methods.js:427-438` loads a definition and
   prepares its canvas. For a built-in key, `loadClientTrack()` reads the
   local definition without confirming a stored override
   (`game/track/client-registry.js:84-105`). A cosmetic request for a custom
   track also does not establish `confirmedKeys` unless a confirmation caller
   joins it (`game/track/stored-track-service.js:100,139-141`). A completed
   cosmetic prewarm is therefore insufficient to make every ranked start
   ready.

3. **The start transition exposes the old canvas during the wait.**
   Daily starts the exit transition at
   `game/daily-challenge/engine-methods.js:725`, then awaits authoritative
   confirmation at `:743`, then loads the new track at `:748`. Campaign uses
   the same order (`game/campaign/engine-methods.js:781,800,809`). The
   transition is 100 ms (`game/race/ui-start-overlay.js:7,77-102`), and CSS
   sets the lobby opacity to zero
   (`styles/race-controls-and-feedback.css:151-154`). The current track is
   replaced only after its definition resolves
   (`game/track/engine-methods.js:131-136`). There is no loading presentation
   protecting the old canvas during this interval. Countdown starts after
   preparation completes.

4. **An unconfirmed start now has a blocking Redis request.**
   `ensureRankedTrackDefinition()` calls
   `ensureStoredTracks(..., { requireConfirmation: true })`, built-in keys
   included (`game/track/engine-methods.js:23-26`). Until confirmed, this
   fetches `/api/tracks/stored?keys=...`, with an 8-second client timeout
   (`game/track/stored-track-service.js:13,73-105,114-143`). This requirement
   was introduced by `1cf4ee62` on September 30. Before that change,
   built-in keys were skipped by default. Confirmation is needed to avoid
   racing the wrong override; it is scheduled too late on the cached path.

5. **The server makes that request wait for the whole stored catalog first.**
   Middleware awaits `ensureStoredCatalogLoaded()` before entering the route
   (`src/server/server-app.ts:344-357`). A warm catalog still needs a Redis
   `mGet` for both revisions. A cold or changed catalog reads the track
   snapshot, then the series snapshot, then checks both revisions again
   (`src/server/tracks/stored-catalog.ts:42-74`). Track records load in
   sequential batches of 25 (`track-store.ts:184-196`), and series index and
   records load separately (`src/server/campaign/series-store.ts:160-192`).
   `/api/tracks/stored` then reads its requested track records directly again
   (`src/server/routes/track-routes.ts:248-251`,
   `src/server/tracks/track-store.ts:280-286`). The warm request therefore
   has two serial Redis reads; a cold request has the catalog load too.
   The paired consistency gate came from `cb7b2129` on October 1.

## Limits and other modes

Fresh Daily active/playlist and Campaign bootstrap responses already carry
`storedTracks`, including an empty array when only app definitions apply.
The client confirms those keys before returning the response
(`game/daily-challenge/service.js:750-752,788-792`,
`game/campaign/service.js:139-144`). Once confirmed, starting those tracks
does not fetch their geometry again in that session. Campaign's start-stamp
and PB ghost requests run in the background, so their Redis work alone does
not explain a blocked countdown
(`game/campaign/engine-methods.js:784-795,821-825`).

The cached Daily gap is established. A fresh, fully bootstrapped Campaign
switch needs separate hosted request evidence before attributing its pause
to Redis. No local rendering timing is being used as hosted evidence.

## Live logs

Read with the existing CLI, separately for both installations:

```sh
node_modules/.bin/devvit logs mini_racer_dev mini-racer --since 6h --json --log-runtime --show-timestamps
node_modules/.bin/devvit logs MiniRacerGame mini-racer --since 6h --json --log-runtime --show-timestamps
```

- Dev: five copy-check messages between 13:09:35 and 13:10:31 Bucharest time.
  The latest reports 157 exact track copies, 83 locked, and no copy problems.
  Those 157 records alone require seven record batches in a cold loader.
- Production: 43 console records in the retrieved window, ending at
  19:05:12 Bucharest time. They include Head to Head and reward errors,
  without stored-track/catalog load errors.
- Neither log set contains successful track-request durations or Redis-read
  timings. Absence of errors does not establish fast loading or rule out
  the reported wait. These logs do not establish that production has the
  dev installation's 157 copied tracks.
- Captures: `/private/tmp/dailygp-race-start-dev-live.log` and
  `/private/tmp/dailygp-race-start-prod-live.log`.

## Targeted correction direction

Confirm and hydrate the visible Daily choices during lobby preparation,
including when their cards come from browser storage. Prepare assets against
that confirmed definition. Begin the lobby exit only after the chosen track
is ready; keep a visible preparing/retry state if preparation is outstanding.
Avoid re-reading requested placed geometry after a consistent server snapshot
has already supplied it, provided the same placement and freshness guarantees
are retained. No fixes were implemented in this investigation.
