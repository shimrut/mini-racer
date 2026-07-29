# Mini Racer

Mini Racer is a quick Daily and Campaign racing game for Reddit.

Outside Reddit, a standalone promo page lives in [`LP/`](LP/) — open `LP/index.html` and set the Daily / Campaign links in `LP/config.js`.

Open a Mini Racer post, tap **Race Now**, learn the track, and try again until your lap is cleaner and faster. Runs are short on purpose — restart fast, improve often.

## How the game works

Every Daily GP attempt is **1, 2, or 3 laps**, frozen when that day's challenge is published. Cross the finish line after the required laps to complete it.
Press **R** to restart while racing, paused, or on the finish screen.
Steer, finish the complete race as fast as you can, then try again.

## What players can do

- Race **today's featured track** and chase your personal best
- Earn **medals** by beating the target times on each track
- Climb that day's **leaderboard** in Standings
- Missed a day? You can replay the last **7 days** of tracks
- Play the permanent ten-stage **Campaign**, earning Gold to unlock the next
  fixed 1-, 2-, or 3-lap race
- Change how your car looks in the **Garage** (available and achievement-unlocked
  skins plus trails — handling stays the same)
- **Share** a finished race or a verified daily best as a Reddit comment (you preview the text first)
- When signed in, turn a verified Campaign or player-challenge result into a
  custom challenge post with your frozen ghost

Your selected car look and settings are saved to your player profile. Car
unlocks are permanent. Other guest profile data expires after 7 inactive days;
signed-in profile data expires after 30 inactive days.

## Daily tracks

- A **new track** becomes the featured race each day (day changes at midnight UTC)
- Once a day's track is posted, it **stays that track** — it does not get swapped later
- Longer tracks randomly use 1 or 2 laps; shorter tracks randomly use 1, 2, or 3 laps
- Medal targets scale from the one-lap targets, and intermediate finishes show the medal earned on cumulative race time
- Tracks stay playable for **7 days**, then drop out of the list
- Communities can auto-publish that track's final global podium when the window closes
- Each track card shows a preview, your best time, medals, and how long that track is still available
- Your personal best and ghost remain available until 6 hours after that daily track leaves the seven-day list

## Standings and sharing

- Standings show the full daily ranking as you scroll; **your rank stays visible** even if you are far down the list
- On the finish screen: **Improve**, **Share Time**, and **Home**
- In Standings: **Share Best** appears when you have a verified time for the day you are viewing
- Shared results go to the post's pinned **score thread**, as a comment from your Reddit account after you confirm
- Sharing the same result again reuses the existing comment instead of posting a duplicate

Campaign has a separate permanent leaderboard for each stage. Guests can
practice Campaign locally, but Reddit sign-in is required for permanent
Campaign competition and all player challenges. Challenge duels are isolated:
they do not unlock Campaign stages or change Campaign standings.

## First look on Reddit

The post preview shows today's track, lap count, scaled gold-medal target, a car on the start line, and a **Race Now** button.

Older posts keep their original track while it is still available. If that day's track has expired, opening the post takes you to **today's** featured track instead.

Daily posts use a short title like `Mini Racer, 12 Jul: Neon Apex`, with a plain-text description underneath for search and clients that cannot show the interactive game.

Final podium posts (separate moderator opt-in) show the top three verified times for the track that just expired, with each finalist's Reddit name or private racer name, their avatar when available, and a **Play Now** button for today's featured track.

## Garage

- **22 car skins** across Extra, Mini, Cyberpunk, and Steampunk sets
- Extra unlocks: Crimson after one verified race; Gold and Blaze after Gold or
  Author on 5/all 10 Campaign stages; Surge and Arctic after Author on 5/all
  10 Campaign stages; Fuchsia and Plasma after posting Head-to-Heads on 1/5
  distinct tracks; Lime and Onyx after 1/10 Head-to-Head wins
- Cobalt and every non-achievement car are available immediately
- Locked cars show a white lock; its white progress arc appears only after
  progress begins. Select one to open its unlock requirement and exact progress
- **8 trails**, including no trail
- Looks only — the car drives the same either way

## For moderators

Install Mini Racer in your subreddit, then use the subreddit menu:

| Menu item | What it does |
| --- | --- |
| **Create Mini Racer post** | Creates a playable race post for today |
| **Enable daily Mini Racer posts** | Auto-posts a new race each day (UTC) |
| **Disable daily Mini Racer posts** | Stops the daily auto-posts |
| **Enable daily Mini Racer podium posts** | Auto-posts the final podium after a track expires, with hourly retries during the six-hour publication window |
| **Disable daily Mini Racer podium posts** | Stops final podium auto-posts without affecting race posts |

Tips:

- Only **one** race post is used per community per day — creating again reuses that post instead of flooding the feed
- Every race post gets a pinned **Mini Racer score thread** for player result comments
- Podium posts are informational, use an independent opt-in, and never create a score thread
- Players share scores as replies in that thread, from their own accounts

## What's new

### 1.4.1

- Ghosts are more reliable — the **ghost unavailable** message should appear a lot less
- Ghosts no longer jump a bit ahead right after the race starts
- Improved leaderboard timing — times are accurate to the millisecond (no longer stuck ending in only 0, 3, or 7)
- Fixed game music not working in the iOS Reddit app
- Small "Standings" screen tweaks so it's easier to read
- Once in game "Start race" starts the last played track
- Code maintenance

### 1.3

- Race **ghost** of your PB (on by default; turn it off in Settings)
- Press **R** to restart while racing, paused, or on the finish screen
- Keyboard navigation through menus now available
- Leaderboard times show full **milliseconds** for more accurate ranking
- Custom **podium** post after a track is out of rotation

### 1.2

- Hitting a wall no longer ends the lap — you scrape, lose speed, and keep going
- **Collision Auto-Restart** is optional and off by default (turn it on in Settings if you want a bump to restart the attempt)
- Tracks list shows when a track is about to expire
- Standings header shows the track name and time; mobile day switching is simpler
- Daily posts can show a track preview image when shared as a link
- New tracks added to the rotation (**Number One**, **Number Two**)
- Android fix: the track no longer appears as a blank white background

### 1.1

- **Share Time** after a finish, and **Share Best** from Standings — preview the comment, then post it from your Reddit account
- Every race post gets a pinned **score thread** for those shared results
- Clearer daily post titles and better plain-text description under the post
- Car look and settings save to your Reddit profile (less likely to reset after an update)
- Standings load more racers as you scroll, while your own rank stays visible
- Nicer post preview (today’s track, gold-medal target, car on the start line)
- Mini Racer app icon for the Reddit apps listing
