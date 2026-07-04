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

- Mini Racer rotates in a new featured track every day.
- The featured slot updates on the UTC day reset.
- Every track in `game/track/tracks.js` is automatically eligible for future Daily GP generation.
- The `Tracks` screen is driven by server-side published history, so adding new tracks does not reshuffle days that were already published.
- The server includes a one-time June 2-11, 2026 published-history backfill for the launch window.
- Local game runs use the Daily GP API/post-bound challenge path; only explicit mock modes and standalone preview pages manufacture local mock challenges.
- The local active-challenge cache is only a fallback when the API cannot be reached, not the source of truth for today's featured track.
- The `Tracks` screen keeps the last 7 days available to play.
- Each track card shows the track preview, your best time, earned medals, and how long that track is still available.

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
- Leaderboards show where your lap stands against other players.
- Medals are earned by beating fixed target times on each track.
- The game is designed for fast retries, so improvement comes from learning braking points, corner shape, and clean exits.

## First-time experience

- The post preview shows the current track and a `Race Now` button.
- The full game opens with the featured track ready to play.
- The controls and goal are immediate: finish one clean lap as fast as possible.

## For moderators

Mini Racer is meant to be installed in a subreddit and used to create playable posts for that community. Once installed, moderators can create a Mini Racer post from the subreddit menu.
