# Reddit Launch Checklist

This checklist maps Mini Racer to Reddit’s current Devvit launch guidance:
[Launch your app](https://developers.reddit.com/docs/guides/launch/launch-guide)

## Purpose

Use this as the final go/no-go list before running `devvit publish`.

Mini Racer is a **game**, so the most important launch requirements are:

- Stable on both **mobile and web**
- Tested with **developer, moderator, and regular user** accounts
- Uses a **custom first screen**
- Avoids **inline scrolling** inside the in-feed launch experience
- Has a **dedicated non-test subreddit** for the live launch

## Launch checklist

### Product and UX

- [ ] The in-feed launch card is clear at first glance and explains the action: race today’s challenge.
- [ ] The stable Current Daily launcher always displays the active UTC-day track and opens the expanded game in Daily mode; it never reuses a dated post payload.
- [ ] The Campaign launcher opens the expanded game in Campaign mode.
- [ ] The Campaign launcher keeps the expanded game's loading screen visible until Campaign progress, stages, and unlocks resolve; the first Campaign lobby paint shows the actual player state without a pending Start Race spinner.
- [ ] Open Campaign directly with a stale/missing guest token and during a
  forced guest-promotion failure; an unranked or promotion-pending first response
  never replaces progress, the repaired credential retries once, and the guest
  credential remains available for a later retry if migration still fails.
- [ ] The Lobby launcher opens the expanded game in the Home lobby, even after a previous Daily or Campaign launch on the same device.
- [ ] The full game is understandable for a first-time player without extra instructions.
- [ ] The launch card works without inline scroll traps.
- [ ] The expanded game works across phone and desktop layouts.
- [ ] The retry flow is fast and predictable after a finish or an enabled collision auto-restart.
- [ ] A verified PB ghost appears on the next attempt for that daily challenge and remains until 365 days after the race started, even after the challenge leaves the seven-day playlist.
- [ ] The PB ghost uses the player's currently selected car and is visibly more transparent than the live player car.
- [ ] `Race Now` keeps the custom-post loading screen visible until the resolved track ghost is prepared: valid historical posts load their own ghost, while expired posts load today's featured-track ghost.
- [ ] `Personal Best Ghost` defaults on, disables immediately in Settings, and stays disabled after reopening the app.
- [ ] The finish screen shows `Improve`, `Share`, and `Home`; `Share` offers `Comment Time` or `Issue Challenge`, and each signed-in action displays its exact copy plus Reddit username before posting.
- [ ] `Share Best` appears only for a verified time in the selected standings day and keeps the selected day and scroll position after canceling.
- [ ] Standalone game launch opens Home with Daily, Campaign, Garage, and
  Settings as matching mode-action rows, and no Home Start button.
- [ ] Daily and Campaign direct launches show Back, Standings, Tracks, Garage, and
  Settings as compact icon-only actions in the top-right rail. Tracks sits
  between Standings and Garage. The Mini Racer
  title is part of that fixed header, and the mode label, divider, and right-side
  slot stay fixed while the carousel moves; Daily updates its date and Campaign
  updates its selected track name. The selected track is
  a borderless bounded schematic hero, neighboring tracks peek at both screen
  edges, and a tiny version of the currently selected Garage car replaces the
  generic direction triangle at the start line. Its size relative to the track
  remains a consistent `2x` version of the in-race car-to-track proportion on
  both compact and tall tracks; changing the Garage skin repaints this marker
  in both modes. A centered Start Race pill is the only bottom action. Back
  returns to Home, and Standings opens on the track currently centred in the
  carousel. Tapping the top-right Tracks icon, Daily expiry line, or track
  counter opens the Tracks list for the Daily playlist. Tapping that same icon
  or the Campaign track counter opens the same list for Campaign stages.
- [ ] At the first and last Daily/Campaign entries, the selected track still
  centers in the Reddit WebView. Swiping or tapping an edge track updates only
  the right-side Daily date or Campaign track name plus the selected Standings
  and Start Race targets; the fixed title, mode label, and divider do not move.
- [ ] Campaign matches the Daily lobby layout: no stage rows appear directly;
  Standings opens the shared modal for the current stage, and Tracks opens the
  shared modal with Campaign progress and selectable unlocked stages.
- [ ] Campaign stages use the fixed `2,2,1,1,2,1,1,3,2,1,3,1,2,2,2,1` lap
  sequence, closing on Half Life as a one-lap stage — Imaginary Number is the
  last three-lap one — and require
  the configured medal total plus any medal on the immediately previous stage,
  and keep independent permanent standings and PB ghosts.
- [ ] A locked Campaign card shows both unlock gates with medal placeholders:
  pending gates are blue-gray, satisfied gates are white with a dark-blue
  checkmark, and the total gate shows the remaining medal count inside its
  placeholder. The lock itself uses an opaque blue-gray medal-shaped plate;
  it does not show the old MEDALS label or horizontal bar.
- [ ] Daily standings expose exactly seven navigation pages. Campaign standings
  expose every stage in a horizontally scrollable rail with seven page slots
  visible at a time, including pages where the player has no rank. Each selected
  page keeps its own leaderboard rows and paging. Race start remains unlock-gated.
- [ ] A newly completed verified Daily, Campaign, or Head-to-Head race unlocks
  Crimson; an accepted Head-to-Head loss or tie still counts as completion.
  Retained accepted Daily history and any saved Campaign result from before
  achievement tracking also backfill Crimson.
- [ ] The 5/10 Gold Campaign medal requirements unlock Gold/Blaze, while the
  5/10 Author Campaign medal requirements unlock Surge/Arctic.
- [ ] While signed in, the first successful user-authored Head-to-Head challenge
  post unlocks Fuchsia, five different posted track keys unlock Plasma, the
  first verified duel win unlocks Lime, and ten different won challenge IDs
  unlock Onyx. Comments and Brag replies do not count as posts; reposting one
  track, tying or losing, or replaying one challenge cannot inflate progress.
- [ ] Locked Garage cars show a white lock on a barely visible backing. The
  white circular progress arc is absent at zero and appears after progress
  begins. Pointer or keyboard activation opens the compact requirement/progress
  panel with one short requirement, but cannot select the car; Close and Escape
  dismiss only that panel and restore focus to its car. The preferences API
  still rejects locked choices. Unlocks remain after post deletion, slower
  retries, and profile expiry; an authorized guest Crimson unlock merges at
  Reddit sign-in.
- [ ] In Daily standings, select an available historical day and a non-self
  racer, confirm Race Opponent, and verify the correct day/track starts with
  that opponent's ghost, target time, and checkpoint deltas while a faster
  verified finish updates the normal Daily rank.
- [ ] In Campaign standings, select an unlocked stage and opponent, verify the
  normal Campaign submission/progression path remains active, and confirm a
  guest result is ranked server-side, retained for 365 days of inactivity, and
  merged into the Reddit account on sign-in with the faster result preserved.
- [ ] Opponent loss/tie retries the same frozen ghost; a win offers the nearest
  raceable racer above the refreshed position, skipping unavailable ghosts,
  while first place falls back to normal Beat Your PB behavior.
- [ ] Disabling PB Ghost hides only the player's normal PB ghost. A deliberately
  selected opponent still renders with one random shipped skin that remains
  stable across retries and changes when a different opponent is selected.
- [ ] Crossing the final Campaign finish line opens a saving sheet immediately;
  accepted, rejected, timed-out, and interrupted-response paths all end on an
  actionable result sheet, including when PB ghost or lobby refresh fails.
- [ ] A signed-in Campaign or Daily result creates a reusable custom challenge
  post authored by that signed-in Reddit user; guests can open, race, and
  submit Head to Head challenges but cannot create posts. Confirm the app has
  `SUBMIT_POST`, the request runs as `USER` with user-generated content, and an
  app-authored fallback is deleted and reported as unavailable without awarding
  the post unlock.
- [ ] Accept a Head to Head: the live car stays on the equipped Garage skin
  and the challenger ghost uses a different random Garage skin. Retry keeps
  that pairing; Race again from the lobby may pick a new challenger skin.
- [ ] The Head to Head post makes the challenger, viewer, track name, target
  time, lap count, and Race Head to Head action legible without
  inline scrolling on desktop or compact Reddit WebView widths.
- [ ] A challenge post opens the correct frozen opponent ghost, permits its
  locked Campaign track or expired Daily track only for that duel, reports
  win/tie/loss correctly, and writes no Daily/Campaign progress, PB, or
  leaderboard data.
- [ ] Run **Collect Mini Racer challenges** on the live community until it says
  the last month is covered. One click does not read every challenge. Click
  again while it says to keep going. Change Track then has those posts to open.
- [ ] After three finished losses, Concede posts the comment, then the finish
  row becomes Improve / Change Track / Home. Change Track opens a different
  challenge in the same medal band, not this one and not the player's own. A tie, a win, a skipped
  Concede, and a guest never see that button.
- [ ] A guest can race a Head to Head from the in-feed post; a verified win
  remains visible for five minutes, creates no durable Head to Head history,
  cannot be used to Brag while signed out, and does not merge at sign-in.
- [ ] Open a Head to Head with no Reddit session and with a stale stored guest
  token; verify the post refreshes the guest identity once, enables Race Head to
  Head, and never shows a sign-in requirement for a ready challenge.
- [ ] Interrupt or time out a Head to Head load and verify the global loader
  dismisses, the challenge pane offers Retry, and a successful retry enables
  Race Head to Head without a sign-in prompt.
- [ ] Hold profile and Daily startup requests open while a Head to Head response
  succeeds; the challenge opens from its single request without waiting for the
  unrelated requests, its track/frozen ghost remain selected, and Start stays
  disabled only until the challenge viewer identity is resolved.
- [ ] Open Daily, Campaign, and Head to Head custom launches and confirm the
  global loader hands off within one second. Confirm Start remains disabled in
  the selected mode's Preparing state until its authoritative contract,
  track/runtime canvas, and required frozen opponent ghost are ready; car,
  personal-best ghost, playlist, and other-mode warming may continue afterward.
- [ ] Exercise more than twelve Head to Head submission attempts in one minute
  for one identity and verify the 429 response is actionable, expensive post
  resolution is skipped for throttled attempts, and normal submission resumes
  after the window expires.
- [ ] Challenge-post reuse accepts only posts authored by the challenger;
  app-authored pre-launch posts are unavailable and are neither reused nor
  recovered. Confirm the three-new-posts per track/player/subreddit/UTC-day
  limit with real Reddit context, including that a fourth overall post on
  another track is allowed.

### Reddit-specific setup

- [ ] A dedicated production subreddit exists for Mini Racer: `MiniRacerGame`. Do not launch from `mini_racer_dev`.
- [ ] The moderator install flow is confirmed in the target subreddit.
- [ ] The **Create Mini Racer post** menu item successfully creates a playable post.
- [ ] The **Create current Daily launcher**, **Create Campaign launcher**, and **Create Lobby launcher** menu items each create the correct canonical post and navigate to it.
- [ ] Repeating any launcher creation action reuses the existing subreddit launcher post instead of creating a duplicate.
- [ ] The subreddit has the three Mini Racer post flair templates: `Daily`, `Challenge`, and `Podiums`. All three can stay moderator-only: the app sets the flair after each post exists, including a Head to Head post that the player makes. Launcher posts do not use a flair.
- [ ] Reddit's post-flair navigation is enabled, and newly created dated Daily, Head to Head, and podium posts appear under `Daily`, `Challenge`, and `Podiums` respectively.
- [ ] At least one example post has been created and reviewed end to end.
- [ ] Moderator, scheduler, and repeated create actions reuse the same canonical post for the subreddit and UTC day.
- [ ] The pinned `🏁 Mini Racer score thread` comment exists before a newly triggered post action reports success, and an older recoverable post is repaired before sharing.
- [ ] Podium automation can be enabled and disabled independently from race posts, retries hourly during the six-hour post-expiry window, freezes the first top-three snapshot, and reuses one canonical podium post.
- [ ] Podium posts show exactly three positions, preserve publication-time username/private-name choices, expose no player IDs, and use explicit placeholders when fewer than three verified racers finished.
- [ ] Podium **View Replays** is visible immediately when the post has packed recordings. Tapping it shows **Loading** with a small bar under the button, unpacks the frozen top-three ghosts, then plays them on the post (not in the game), starts paused with all cars visible, overlays the logo, track name, Back, progress bar, play/pause, #1 / #2 / #3, Trail, and clock on the track, auto-hides those overlays after 2 seconds, shows them again on mouse movement, and plays or pauses when the track is tapped. Back returns to the list. The button is omitted when no top-three ghost was saved.
- [ ] Podium Reddit identities show the correct Snoovatar when Devvit exposes one and omit the `u/` prefix; standard-profile-icon accounts, private identities, unavailable avatars, and empty places show Reddit's official hosted default Snoo on desktop and mobile.
- [ ] A podium created before avatar payloads were introduced backfills its public Reddit avatars through `/api/podium/avatars` without resolving or exposing private identities.

### Quality and trust

- [ ] Daily challenge loading works for a signed-in Reddit user.
- [ ] Leaderboard reads and submissions work for real users in Reddit context.
- [ ] Reddit username display behaves correctly when identity is enabled.
- [ ] Guest fallback identity behaves correctly when Reddit username display is unavailable or off.
- [ ] Invalid or suspicious replay submissions are rejected cleanly.
- [ ] Published one- and two-lap Daily challenges, historical three-lap Daily
  records, and Campaign three-lap stages keep the same lap count across reloads,
  retries, and stored history.
- [ ] Intermediate finish lines flash the medal for cumulative elapsed time at that completed-lap scale, without permanently awarding it before the final finish.
- [ ] Multi-lap submissions rank only after all required laps, preserve cumulative checkpoint splits, and reject mismatched replay rules or target lap counts.
- [ ] Share previews, score-thread comments, text fallback, and final podium posts show the complete race time and correct lap count.
- [ ] A daily leaderboard improvement and its challenge PB/ghost improvement are displayed and stored independently while sharing the same fixed expiry deadline.
- [ ] An existing verified challenge result can seed a time-only PB without showing a fabricated ghost.
- [ ] A geometry or simulation revision rejects an incompatible stored ghost instead of rendering it on the changed track.
- [ ] Error states are understandable and do not leave the player stuck.
- [ ] `SUBMIT_COMMENT` user-action permission is present in `devvit.json`, and the reviewed app version is approved for regular-user attribution.
- [ ] A regular user can preview, confirm, and view a score-thread reply authored by that same account.
- [ ] Playtest/app-account fallback attribution is rejected and cleaned up instead of appearing as a successful player share.
- [ ] Re-sharing the same result returns the existing comment; deleting it allows a new share.

### Devvit Journeys playtest

- [ ] `journeys` permission and the official `/api/telemetry` route are present. Custom moderator summary uses `/api/analytics/summary` and the restored `dailygp:analytics:*` Redis keys only, never Journey payloads.
- [ ] Moderator analytics shows signed-in race cohorts with exact UTC-day D1/D2/D3/D7/D14/D30 return rates, keeps immature milestones blank, and excludes guest browser IDs from the denominator.
- [ ] `App.Ready` fires once after the expanded lobby becomes interactive; preview, Daily launcher, Campaign launcher, and podium entrypoints do not fire it.
- [ ] Explicit Start/Retry/Improve/Restart begins an attempt with the matching Journey start reason, checkpoint progress never moves backward, pause/resume use fixed actions, and valid/incomplete endings match the race lifecycle.
- [ ] Journey payloads contain no player identity, guest token, challenge or track identifier, replay data, device details, or lap score.
- [ ] `npx devvit playtest` on `mini_racer_dev` returns a Journey receipt without affecting race behavior. `JOURNEY_RECEIPT_DENIED_NOT_ALLOWLISTED` proves routing only; `JOURNEY_RECEIPT_VALID` is required to claim ingestion.

### Cross-account testing

- [ ] Developer account tested
- [ ] Moderator account tested
- [ ] Regular user account tested

### Release operations

- [x] `README.md` still matches the shipped product and moderator flow.
- [x] `CHANGELOG.md` reflects the main launchable changes.
- [x] `npm test` passes on the version being published.
- [x] The WebView upload contains only compiled game assets (including source maps), with no macOS metadata.
- [x] The publish source archive excludes tests, docs, internal notes, generated review artwork, and non-build tooling; only the three scripts required by `npm run build` remain.
- [x] The `1.0.0` upload and remote build succeeded.
- [x] `devvit publish --version 1.0.0` submitted the intended unlisted release.

## Publish notes

- Default launch command in this repo: `npm run launch`
- Equivalent direct command: `npx devvit publish`
- Recommended mode for this game: **unlisted publish**
- Use `--public` only if the product direction changes and Mini Racer becomes a general-purpose app for any community
- Version `1.0.0` was uploaded on July 10, 2026 and is pending Reddit review because the app creates custom posts.

## Reviewer summary

Mini Racer is a subreddit-specific racing game with:

- A custom inline launch screen
- A full expanded gameplay view
- Server-side replay validation
- Redis-backed daily leaderboards
- Moderator-controlled post creation

## Open decision before launch

- [x] Confirm the production subreddit name: `MiniRacerGame`
- [ ] Confirm who owns launch-day moderation and player support
- [x] Confirm the first publish version number and release date: `1.0.0`, submitted July 10, 2026
