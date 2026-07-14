# Mini Racer

Mini Racer is a fast, one-lap arcade racing game built for Reddit.

Open a Mini Racer post, tap `Race Now`, learn the track quickly, and try to put down a cleaner lap than everyone else. The game is built around short sessions, quick restarts, and visible improvement from run to run.

## What players can do

- Race a featured track and chase the fastest lap.
- Improve a personal best and climb the leaderboard.
- Share a finished lap or a verified daily best as a Reddit comment after confirming the exact copy and posting account.
- Replay recent tracks from the in-game `Tracks` screen.
- Unlock medals on each track by beating target times.
- Customize the car look in the Garage.

## Track release cadence

- Mini Racer features a new track every day.
- The featured slot updates on the UTC day reset.
- Once a day is published, that track is locked in and does not change.
- The `Tracks` screen keeps the last 7 days available to play.
- Each track card shows the track preview, your best time, earned medals, and how long that track is still available.

## Public Reddit posts and discoverability

- Daily Reddit post titles use `Mini Racer, {D MMM}: {track name}`, for example `Mini Racer, 12 Jul: Neon Apex`.
- The post text fallback provides a readable explanation of Mini Racer, its controls, leaderboard, medal targets, and seven-day track availability for Google, Reddit search, Reddit Answers, and clients that cannot render the interactive post.
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
- Selections and gameplay preferences are saved to the player's Reddit profile, so app updates do not reset them.

## How a run works

- Every attempt is a single lap.
- Crossing the finish line completes the run.
- Crashing ends the attempt.
- If a completed lap is better than your previous best on that track, it becomes your new best time.

## Progress and competition

- Your best time is shown for each available track.
- Standings load the complete ranked field as you scroll and keep your own rank visible even when it is outside the currently loaded rows.
- Medals are earned by beating fixed target times on each track.
- The finish screen offers `Improve`, `Share Time`, and `Home`. Standings offer `Share Best` when the player has a verified time for the selected day.
- Every custom race post creates and pins its Mini Racer score thread as part of the same post action. Shared results are replies to that thread and are posted from the player's Reddit account only after confirmation. Repeating the same share reuses the existing comment instead of posting a duplicate.
- The game is designed for fast retries, so improvement comes from learning braking points, corner shape, and clean exits.

## First-time experience

- The post preview marks the current track as `Today`, shows its gold-medal target time and medal, places the stock in-game car just past the starting line with a short trail behind it, and includes a `Race Now` button.
- The full game opens with the featured track ready to play.
- The controls and goal are immediate: finish one clean lap as fast as possible.

## For moderators

Mini Racer is meant to be installed in a subreddit and used to create playable posts for that community. Once installed, moderators can create a Mini Racer post from the subreddit menu. Moderator and scheduled creation both reuse one canonical post per community and UTC race day; every canonical post has one pinned Mini Racer score-thread comment for player result replies.
