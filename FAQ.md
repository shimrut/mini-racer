# Mini Racer — troubleshooting FAQ

Stuff that makes players say “what just happened?” — not the basics you can learn by opening the game.

---

## Rank / Standings

### I finished a good lap but Rank didn’t update

Only a **new personal best for that day’s track** is sent for ranking. A matching or slower lap still counts as practice — Standings stay as they were.

### Rank says “Verifying…”, “Retrying…”, or sits there forever

After a new best, the game sends your lap to the server to re-check it. Status you’ll see:

- **Submitting… / Submitting rank** — sending the run
- **Verifying… / Verifying rank** — server is replaying the lap
- **Retrying… / Retrying rank** — temporary failure; it will try again (often after a short wait)
- **Rank rejected / Rank error** — that attempt didn’t stick

Leave the finish screen open for a bit, or come back shortly. Retries usually finish on their own unless the day has expired (see below).

### It says my run was too long to rank

Very long laps can’t be checked. Aim for a cleaner finish under about **50 seconds**, then try again.

### It says leaderboard rank was disabled because of frame stalls

The game hitch badly mid-run (lag, switching apps, locking the phone, low power). That lap is **not** sent for ranking. Keep the race open and the screen awake, then race again.

### I got **RUN REJECTED** after crossing the line

The finish didn’t pass the game’s own checks before submit. Common reasons:

- Lap finished before every checkpoint was confirmed
- Lap time was unrealistically short (under ~2 seconds)
- Track / challenge context changed mid-attempt (e.g. day switched while you were still racing)

Hit retry and complete a full clean lap on the track that’s currently loaded.

### My time showed, then Rank failed / was rejected

The server re-drives your steering to confirm the lap. If that check fails, the time is **not** kept on Standings. Race again for a clean finish.

Other server messages you may see:

- **Too many submission attempts. Try again soon.** — slow down; you’re submitting too fast
- **Submission already in progress.** — wait a moment and try again
- **Daily challenge is no longer playable.** — that day’s track left the playable window
- **Leaderboard submission expired.** — a pending check sat too long after the day closed

### I had a time pending, then it expired

Ranking only works while that day’s track is still in the **7-day Tracks** list. After it drops off, pending checks stop (there’s a short grace window, then they’re gone). Verified results already on Standings can linger a bit longer than the Tracks list.

### My Standings time vanished / I’m a “new” racer

If you play as a **guest**, ranking is tied to a hidden session. Clear site data, a new device, or a long gap can rotate that session — you look like a new player even if the Garage still looks familiar.

**Sign in to Reddit** to keep one identity longer (guest profiles expire after ~7 idle days; signed-in after ~30).

### I turned Username off — did I lose my times?

No. Standings just shows a generated racer name instead of your Reddit name. Times stay on the same account/session.

---

## Pause / HUD

### I keep hitting Pause by accident on my phone

Pause is on the **timer** at the top by default, not next to steering. Settings → **Pause** can put it on the timer, a bottom-right button (**Separate**), or the centered speedometer (**Speedo**).

### How do I hide the race numbers?

Settings → **Hide HUD**. Pause stays as an icon in the spot you picked: timer (top-right), bottom-right, or centered speedo. Turn Hide HUD off to bring the timer, laps, and speedo back.

---

## Ghost

### What does **GHOST UNAVAILABLE** mean?

You have (or should have) a personal-best ghost, Settings → **Personal Best Ghost** is On, but the ghost wasn’t ready when the race started (still downloading, failed to load, or not saved yet). You race alone; the notice shows for a couple of seconds after **GO**.

Improve again after Rank finishes verifying — the ghost usually shows up on a later attempt.

### My time ranked but there’s still no ghost

Standings save and ghost save can succeed separately. Your time can stick even when the ghost copy didn’t. Try another Improve after verification completes, and confirm Personal Best Ghost is On.

If the time was verified before a ghost-recording fix shipped, that day’s stored copy may still have no ghost — set a new better verified time to store one.

### There’s no ghost and no notice

Either you don’t have a verified best on that track yet, or Personal Best Ghost is Off in Settings. That’s normal — no warning is shown.

### Ghost vanished after I switched days / tapped Improve quickly

Ghosts are per day/track. If a download isn’t ready in time, the game starts without a ghost rather than showing the wrong one. Race again once Rank/verification has settled.

---

## Sharing

### Why is an Extra car locked in the Garage?

Locked Extra cars show a white lock in the Garage. A white progress arc appears
around it after progress begins. Select the locked car to open its requirement
and exact progress. Complete one
verified Daily, Campaign, or Head-to-Head race for Crimson. Campaign Gold and
Blaze count stages with either Gold or Author; Surge and Arctic specifically
require Author. Posting the same Head-to-Head track repeatedly counts once
toward Plasma, and replaying the same challenge cannot add extra wins toward
Onyx.

Existing accepted Daily history and saved Campaign results also count for
Crimson, including races completed before achievement tracking was added.
Unlocks stay unlocked. Guest race completion is carried into the Reddit account
when that guest signs in. Creating a Head-to-Head post or posting a Brag comment
requires Reddit sign-in; guests can still race and beat another player's
challenge.

### Why does Campaign say Start on one device and Continue on another?

Signed-in Campaign progress is permanent for that Reddit account. Guest
Campaign progress is stored only in the current browser, so another device or
cleared site data starts locally from the beginning.

### Why is the next Campaign track locked?

Bank the medal total shown on the locked card and earn at least one medal on
the stage immediately before it. Better medals add more to the total.
The locked track card shows the current/required medal count inside a medal;
the white stroke filling its perimeter shows how close the total is.

### Can a challenge unlock a Campaign track?

No. A player challenge is an isolated duel against a frozen verified ghost.
Its verified win can be shared as a Brag comment by a signed-in winner, but it
never changes Campaign progress, PBs, medals, or leaderboards. Challenge
finishes also do not award Campaign medals or ranks, and they never appear on
Campaign or Daily standings.
A win shows a display-only challenge medal and **Challenge beaten** after the
result is verified (you’ll see Submitting/Verifying in that medal spot first).
Finish buttons are always **Improve**, **Brag**, and **Home**; **Brag** unlocks
only after a verified beat. A loss or tie uses the same buttons, but **Brag**
stays disabled.

### Can I accept or create a player challenge?

Reddit sign-in is required to create a challenge post or submit a Brag comment.
Guests can open, race, and submit against another player’s challenge, but their
Head to Head result is temporary and does not merge if they later sign in.

You can’t accept a challenge you created yourself. Opening your own
post shows a short message and opens your Campaign instead.

### Share says the preview expired

You waited too long on the confirm step (~**10 minutes**). Start **Share** again and post sooner.

### “Sign in to Reddit to share your time.”

Sharing posts a comment as **you**. Guests can’t share — sign in and try again.

### “Reddit user-attributed sharing is not available for this app version.”

Reddit wouldn’t post the comment as your account, so Mini Racer cancelled instead of posting as the app. Update Reddit / reopen the post while signed in, then share again.

### “No verified result is available to share.”

**Share Best** needs a **verified** time for that day (Rank finished successfully), while the day is still playable, and a Mini Racer race post for that community/day.

### I shared twice and didn’t get a second comment

Same verified result **reuses** your existing score-thread comment on purpose. Delete that comment on Reddit if you want a fresh one.

### “This share preview belongs to another Reddit account.”

You started the share on one Reddit account and tried to confirm on another. Stay on the same signed-in account.

### “The post for this race day is unavailable.”

There’s no race post for that day in this community (or it can’t be found). Mods need a Mini Racer race post for that day before shares can land in a score thread.

---

## Tracks, days, and old posts

### Why isn’t “today” matching my clock?

Days flip at **midnight UTC**, which can be afternoon or evening where you live. The featured track changes then — not at your local midnight.

### An old Mini Racer post opened today’s track

That post’s day left the **7-day** play list. Expired posts send you to **today’s** featured race instead. While a day is still in Tracks, older posts keep that day’s track (and show the original date, not “Today”).

### Podium post → Play Now opened a different track

Podium posts are for a day that just left rotation. **Play Now** always opens **today’s** featured race, not the podium day’s track.

### How do I watch a podium replay?

Tap **View Replays** next to **Play Now** on the final podium post. All three recordings are ready (gold / arctic / blaze cars) and wait until you tap play. Drag the progress bar, tap play/pause, use #1 / #2 / #3 to show or hide a car, tap **Trail** to show each car’s path, then **Back** to return to the list. Time sits on the right of the play row; **Trail** sits under play and **Back** sits under the time. **Play Now** still opens today’s race. If View Replays is missing, none of the top three had a saved recording.

### I still have a medal icon but my PB / ghost is gone

Medal marks on your device can stick after the server’s best/ghost for that day expires (shortly after the track leaves Tracks). The icon doesn’t mean the ghost is still loadable.

### Lobby says Challenge unavailable / No tracks available

The day’s challenge couldn’t load (network, or nothing playable right now). Close and reopen the post, or try again shortly.

---

## Driving feel that feels “broken”

### I bumped a wall and suddenly restarted

**Collision Auto-Restart** is On in Settings. Turn it Off if you want bumps to only slow you down (default).

### After a bump / restart / unpause my car won’t accelerate for a moment

There’s a short launch lock so you don’t rocket off immediately after an auto-restart or resume. Wait a beat, then throttle.

---

## Quick glossary (messages you’ll see)

| You see | Meaning |
| --- | --- |
| **GHOST UNAVAILABLE** | Expected PB ghost wasn’t ready at GO |
| **RUN REJECTED** | Finish failed local checks; not submitted |
| **Run too long to rank.** | Lap too long for server check (~50s+) |
| **…severe frame stalls.** | Lag mid-run; ranking disabled for that lap |
| **Submitting… / Verifying… / Retrying…** | Rank pipeline in progress |
| **Rank rejected / Rank error** | That submit didn’t stick |
| **Leaderboard submission expired.** | Pending check past the day’s deadline |
| **Couldn't rank this run. Try again.** | Generic submit failure — race again |
| **Submission replay is missing…** | Finish again so a new replay can be sent |
| **This share preview expired.** | Confirm share within ~10 minutes |
| **Sign in to Reddit to share…** | Sharing requires a signed-in Reddit account |
