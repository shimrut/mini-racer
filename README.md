# Mini Racer

Mini Racer is a fast, one-lap arcade racing game built for Reddit.

Open a Mini Racer post, tap `Race Now`, learn the track quickly, and try to put down a cleaner lap than everyone else. The game is built around short sessions, quick restarts, and visible improvement from run to run.

## What players can do

- Race a featured track and chase the fastest lap.
- Improve a personal best and climb the leaderboard.
- Replay recent tracks from the in-game `Tracks` screen.
- Unlock medals on each track by beating target times.
- Customize the car look in the Garage.

## Track release cadence

- Mini Racer features a new track every day.
- The featured slot updates on the UTC day reset.
- The schedule walks `game/track/tracks.js` in key order, one track per day, wrapping at the end of the list. A server-side ledger records each day's track, so days that were already published never change.
- Add a new track anywhere in `tracks.js` and it takes that slot in the rotation; days already published are not reshuffled. Past days are frozen in the ledger; only days not yet written reflect the current file order.
- The server includes a one-time June 2-11, 2026 published-history backfill for the launch window.
- Local game runs use the Daily GP API/post-bound challenge path; only explicit mock modes and standalone preview pages use a local mock challenge (the first track in `tracks.js`, or a specific track forced via `?mockDaily=<trackKey>`).
- The local active-challenge cache is only a fallback when the API cannot be reached, not the source of truth for today's featured track.
- The `Tracks` screen keeps the last 7 days available to play.
- Each track card shows the track preview, your best time, earned medals, and how long that track is still available.

## Public Reddit posts and discoverability

- Daily Reddit post titles use `Mini Racer, {D MMM}: {track name}`, for example `Mini Racer, 12 Jul: Neon Apex`.
- The post text fallback provides a readable explanation of Mini Racer, its controls, leaderboard, medal targets, and seven-day track availability for Google, Reddit search, Reddit Answers, and clients that cannot render the interactive post.
- The fallback is generated from existing challenge and medal data. Tracks do not require individually maintained marketing descriptions.
- The richer discovery copy belongs to the text fallback; the visible Reddit title stays short and consistent.

## Track availability

- A new track becomes the featured race each day.
- Older tracks do not disappear immediately.
- Tracks remain playable for 7 days, then expire and drop out of the list.
- If a track is close to expiring, the game shows the remaining time directly on the track card.

## Garage options

The Garage lets players change how their car looks without changing handling.

- `Car skins`: 12 selectable skins grouped into Mini, Cyberpunk, and Steampunk sets.
- `Trails`: 8 route-trail options, including `No Trail`.
- Selections are saved, so the car keeps its look between sessions on the same device.

## How a run works

- Every attempt is a single lap.
- Crossing the finish line completes the run.
- Crashing ends the attempt.
- If a completed lap is better than your previous best on that track, it becomes your new best time.

## Progress and competition

- Your best time is shown for each available track.
- Standings load the complete ranked field as you scroll and keep your own rank visible even when it is outside the currently loaded rows.
- Medals are earned by beating fixed target times on each track.
- The game is designed for fast retries, so improvement comes from learning braking points, corner shape, and clean exits.

## First-time experience

- The post preview shows the current track and a `Race Now` button.
- The full game opens with the featured track ready to play.
- The controls and goal are immediate: finish one clean lap as fast as possible.

## For moderators

Mini Racer is meant to be installed in a subreddit and used to create playable posts for that community. Once installed, moderators can create a Mini Racer post from the subreddit menu.
