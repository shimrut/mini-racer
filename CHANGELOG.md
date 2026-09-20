# Changelog

- Fixed a Brag, Challenge Comment or Daily Share that posted a second comment.
  The app posted the comment, then checked what Reddit sent back. A comment with
  no link, or one Reddit put under the app's name, made the app report an error
  before it recorded the comment. Try Again found no record, looked in the
  thread, saw nothing there yet, and posted again. The same check failed again,
  so the error never changed. Now:
  - The app records the comment as soon as Reddit accepts it, before it checks
    anything else.
  - A recorded comment is never posted again. The app looks for its link, and
    tells the player the comment is up when it cannot find one.
  - The finish says the comment is up. It no longer offers Try Again for a
    comment Reddit has already taken.
  - A comment Reddit puts under the app's name is recorded, but never as the
    player's shared result.
  This corrects the entry below, which claimed this kind of double post was
  already fixed. It fixed the Brag that Reddit never answered. It did not fix
  the Brag that Reddit answered badly.

- Head to Head no longer shows UNVERIFIED for a dropped or server-failed
  confirmation. The finish stays on VERIFYING and retries. UNVERIFIED is only
  for a run the server actually rejected.

- Fixed Head to Head posts without the "Challenges" flair. Reddit dropped the
  flair from a post that the player makes. Now the app sets it after the post.
- A Campaign challenge now posts the run the player just finished, as a Daily
  challenge does. Before, it posted the player's saved best on that race.

- Fixed Brag, Challenge Comment and Daily Share posting twice, and saying "Could
  not post" when the comment was posted. On 19 Sep 2026 Reddit posted two Brags
  and then failed to send them back. Now:
  - Each result keeps a record. The app writes it before it posts the comment and
    adds the comment to it after. A later Share, Brag or Comment on the same
    result finds that record and shows the comment instead of posting again.
  - A record with no comment sends the next attempt to look in the thread. If the
    comment is there, the player is told it posted. If the thread shows nothing,
    the attempt posts. An older comment with the same words never counts as this
    one.
  - When Reddit's reply fails, the player is asked to share again to check.
  - A Brag and a Challenge Comment now wait for each other on the result, as a
    Daily Share already did, so two previews of one result post one comment.
  - A failed record no longer turns a posted comment into an error, and a failed
    lock cleanup does not either.
- A Garage reward whose write fails now waits on an owed list, and the next
  start-up grants it. Before, a player was told they won and the win never
  reached the Garage.
- Start-up repairs the first-race reward for a player who has only raced
  Campaign. Before, only a saved Daily run led to that repair.
- Choosing Guest in Keep Progress now drops a reward the account was still owed,
  with the rest of the Garage the player gave up.
- A late rank answer on a challenge finish no longer offers Comment again after
  the comment was posted.
- Fixed start-ups and saved runs failing when Reddit's database is slow. Reddit
  lets an installation hold only 20 to 30 Redis transactions at a time, and on
  16 Sep 2026 the game went past that for an hour and a half. A returning or new
  player's start-up now opens none:
  - The profile is written only when something in it changes. A new profile is
    created with `SET NX`. An unchanged guest profile still gets another year
    with one `EXPIRE`.
  - The start-up reward repair is skipped when the player already has the
    reward.
  - The profile no longer stores `lastSeenAt` or `updatedAt`. Nothing read them.
- Fixed Head to Head wins failing every day because two writes of the same reward
  fought over one lock. The win's rewards are now written after the Daily or
  Campaign save. A reward write also waits up to about 0.6 s for the lock, not
  20 ms.
- A Daily, Campaign or Head to Head finish no longer reports "submit failed"
  after the run is saved. A failed rank, Garage or brag step is left out of the
  answer. A Daily finish still asks the game to retry when both of its record
  writes fail, because the Keep Progress chooser needs one of them.
- The Keep Progress chooser now counts the account's Daily results, as it does
  for the guest. Before, an account whose only record was a Daily result looked
  empty, and a Guest choice could replace that result.
- A challenge post that fails to open now logs which check failed: the data field
  and its type, or whether the author's account was deleted.

- Fixed Head to Head refusing a challenge from the last two Campaign stages,
  Square Root and Half Life, with "No verified result is available for this
  challenge." The check allowed only the first 14 stages. It now reads the
  Campaign's own stage list, so a new stage can be challenged at once.

- Sharing a result and making a Head to Head post no longer try to delete the
  Reddit comment or post when the step fails. Reddit lets only the author delete,
  so the app could never remove a player's comment. On a test version, where
  Reddit posts from the app's account, that comment or post now stays up.

- Added `npm run typecheck`. Nothing checked the server's TypeScript before: the
  build strips the annotations without reading them.

- A guest transfer no longer skips a frozen Daily day whose rows disappear while
  earlier days are being copied. The day is judged under its own locks, so the
  transfer reports a changed source instead of a false success.

- A guest run moving to the account during a transfer no longer loses its slot to
  a slower run the account raced in the meantime. The faster time wins, and the
  other is dropped instead of being stranded where nothing could submit it.

- The Daily and Campaign lobbies now say when racing is paused for a progress
  transfer, instead of leaving Start and Retry doing nothing with no explanation.

- Guest transfer Garage steps now report ordinary lock contention as retryable
  rather than as an unknown server failure, so a busy moment no longer logs a
  stack trace.

- Removed the player's Reddit name from two guest transfer log lines, so ordinary
  application logs no longer say who ran a transfer.

- Fixed a Garage transfer baseline outliving the transfer that froze it and then
  being reused by that account's next transfer, which kept cars the player had
  chosen to replace. A baseline now records the transfer it belongs to, and the
  cleanup attempts both of its keys instead of stopping at the first failure.

- Fixed the Keep Progress chooser leaving start-up waiting forever when this device
  could not save the transfer receipt. The choice now reports the failure, so the
  player gets the retry dialog instead of a dialog with no way forward.

- Fixed Daily races selected from Campaign’s Tracks tab retaining Campaign finish
  routing and stopping without the correct result screen.

- Simplified shared challenge commenting and Tracks layout rules. Comment
  confirmation now checks the preview under its lock to reject stale retries.

- Moderator player trend charts now show the most recent 45 daily buckets so
  individual bars remain readable while the full retained history stays in the
  daily breakdown.

- Moderator analytics now include exact UTC-day D1/D7/D30 retention cohorts for
  signed-in racers. Cohort starts are scoped per subreddit, guests stay outside
  the denominator, and milestones that have not matured show as unavailable.

- Daily GP leaderboard, PB, ghost, challenge-history, post, podium, analytics,
  and share records now stay for one year after the race starts; the playable
  playlist remains seven days.
- Campaign guest progress, bests, and PB ghosts now stay for one year of
  inactivity. Signed-in Campaign records remain permanent.

- Challenge wins now offer **Brag** with three margin-specific messages for
  0.001–0.100s, 0.101–0.500s, and 0.501s+. Ties and losses offer **Comment**
  with one tie message plus three margin-specific messages over those same
  ranges as a text-only reply.
- Refined the Brag and Comment messages with the approved tier-specific copy,
  player time, track name, and reaction emoji.

- Reddit's review copy of the source no longer includes Cursor, VS Code, or
  agent folders. Local Cursor skill caches also stay out of git.

- Final podium View Replays and Play Now now sit farther from the bottom-right
  corner of the post.

- Added Chelsea Boots, Stone Gate, Crakow Boot, Slingshot Run, Broken Antler,
  and Mantis Bend to Daily rotation, after Split Jaw.

- Redis occupancy on moderator analytics now uses the current analytics Redis
  key names, so the production build can include that page.

- Moderator analytics now show how much Redis Mini Racer is using, broken down
  by the key families the game can name. Ghosts and leaderboards are sampled.
  Head to Head and other short-lived keys are called out as left out.

- Daily preview again puts the lap count on the right, just before Time to Beat.

- Moderator analytics now show Play Now taps and View Replays opens from final podium posts.

- Campaign moderator analytics now count a start on every attempt, including Retry, the same way Daily and Head to Head already did.

- Podium replay cars now use the same schematic marker sizing as before, drawn 25% smaller so three finishers read more clearly on the track.

- On desktop, final podium **View Replays** and **Play Now** sit bottom right again; phones still use full-width buttons.

- **View Replays** on the final podium post shows as soon as the post has saved recordings. Tapping it changes the button to **Loading** with a small bar underneath while the recordings unpack, then opens the replay.

- Podium replay play, #1 / #2 / #3, and Trail buttons now use a more opaque background so they stay readable over the track.

- Podium replay controls now return on mouse movement, and tapping the track plays or pauses instead of toggling the overlays.

- Podium replay controls return when the replay finishes, even if they had auto-hidden during playback.

- Podium replay now overlays the logo, track name, and controls on the track. They auto-hide after 2 seconds and return on mouse movement.

- Podium replay now keeps Trail on the play row with #1 / #2 / #3, and floats Back over the track above the progress bar so the track keeps more height.

- Podium replay toggles now read #1, #2, and #3 and sit on the same row as play/pause.

- The podium replay player now plays at normal speed only; the 0.5× and 2× speed buttons are gone.

- The podium replay clock now shows seconds and milliseconds only (for example `10.193`), without a minutes prefix.

- Final podium posts on phones now use a smaller header, tighter place rows, and full-width View Replays / Play Now buttons, so the layout fits Reddit’s short post card.

- Replay playback on the final podium now keeps only Mini Racer top left and the track name top right, so the track has more room.

- Final podium posts now freeze the top-three ghosts in the post body (same packed replay as Head to Head) and play them on the post: **View Replays** next to Play Now, all three cars on by default, Gold / Silver / Bronze to show or hide a car, **Trail** to show each car’s path, a pill progress bar with play/pause under it on the left, the clock on the right of that row, Gold / Silver / Bronze / Trail under the play controls, and **Back** under the clock in the same button shape (starts paused). Phone and desktop use that same chrome. Controls sit below the track, not over it.

- Home after a missed Head to Head returns to the challenge screen immediately. It no longer reloads the challenge from the server first.

- Head to Head finish now compares VS. YOUR PB and RANK against the same Daily or Campaign best those modes already use. A slower run no longer stays on "No lap times yet" or jumps the rank as if it were a first time.

- Head to Head finish now shows your Daily or Campaign place when the run is a new personal best, including a first time on that board.

- Winning a Head to Head no longer draws the browser's default outline around your finish time.

- Garage Car and Trail now use the same rounded pill switch as Settings on/off.

- Wall sparks now fade after you finish or pause, instead of freezing and keeping the game drawing in the background.

- The loading circle on Start Race now sits to the left of the text instead of underneath it.

- During a race the lap clock updates 30 times a second instead of every frame. There is one speedometer; phone and desktop only change where it sits. Finish times stay exact.

- Daily and Campaign Tracks tiles now show your rank as `#x` in the top-right of the drawing, when a rank is known.

- Daily and Campaign Tracks lists use two equal tiles per row: drawing on top, name on the left, laps on the right. Locked tracks are only dimmed. Empty medals and lock icons are gone. Hover is a CSS background only. Back sits in its own space at the bottom.

- Daily preview now puts the lap count as a small label above the track name, the same way Time to Beat sits above the time.

- New Daily races now use 1 or 2 laps only on tracks under 10 seconds (author time). Tracks of 10 seconds or more always run 1 lap. Days already published keep the lap count they had.

- Settings → **Hide HUD** (off by default) hides the lap counter, timer, best time, speedo, and lap flash. A pause icon stays in the spot you picked: timer (top-right), bottom-right, or centered speedo.

- Settings → **Pause** has three spots: **Timer** (default, tap the time), **Separate** (bottom-right button), and **Speedo** (tap the centered speedometer, no extra button).

- Race HUD no longer shows “2 laps” under the top-left lap counter. The 1 / 2 number stays.

- Pause on phones lives on the race timer by default (a pause icon next to the time). That keeps Pause away from steering thumbs. Settings → **Pause** can move it to a bottom-right button or onto the centered speedo.

- Mapmaker Line Build no longer rewrites a closed sketch. A square stays a square; the 7-car-wide road follows what you drew. Existing tracks stay as they are until you redraw them.

- Mapmaker Line Build now paints a lane exactly 7 cars wide (3.85u), instead of 4u (~7.3 cars). Existing tracks stay as they are until you redraw them.

- Daily and Campaign have a Tracks icon in the top-right again, between
  Standings and Garage, opening the same list as the expiry line and counter.

- The Tracks list now matches Garage: Daily Tracks or Campaign Tracks at the
  top, then a three-across grid of track tiles.

- Tapping the Campaign track counter opens the Tracks list with Campaign
  stages. Unlocked rows start that stage; locked rows jump the carousel to
  that poster.

- Tapping the Daily expiry line or track counter opens the Tracks list.

- Head to Head finish now shows Daily and Campaign as soon as the local clock
  is already faster than the target. Brag stays gray until the server confirms.
  Improve and Home come back if that confirm is a miss or fails.

- Head to Head finish words in the hero — VERIFYING, YOU WON, YOU LOST, YOU
  TIED, UNVERIFIED — now all use the same size.

- Head to Head finish now shows only VERIFYING while the result is checked, then
  slides YOU WON in so it pushes that word out.

- Head to Head finish rows and buttons no longer appear one by one. All three
  modes now use the same heading and time entrance.

- Daily and Campaign finish screens now put MEDALS first. Racing someone from
  standings also shows a VS opponent row, and VS PB stays underneath.

- Head to Head finish heading and time now wait the same 10ms after the modal
  fade as Daily and Campaign. The comparison-row stagger is unchanged.

- Daily and Campaign finish screens now open a small MEDALS sheet from that
  row, listing each medal on the left and its time on the right, the same way
  checkpoint splits open from the clock. The author medal is labeled author.
  Head to Head is unchanged.

- Daily and Campaign finish screens now put a status line above the time, in
  the same Mini / Racer entrance as Head to Head: the medal just unlocked,
  NEW BEST, or FINISHED. Head to Head still uses YOU WON / YOU LOST.

- Daily and Campaign finish screens now show medals on a compact MEDALS row
  beside RANK and VS PB, instead of as a large block under the time. Head to
  Head still uses YOU WON / YOU LOST in that top slot.

- Head to Head now waits for the server's judged beat / not-beat before showing
  YOU WON and the win buttons. Daily/Campaign personal-best save still runs on
  that same request, after the reply has already gone out.

- Added **Split Jaw** to the track list and Daily rotation.
- Opening standings no longer rewrites the player profile on every load, so
  parallel reads stop colliding. A lost Redis race on a real profile save is
  retried instead of treated as a hard failure.
- Redis storage use can be measured from the keys the game already writes.

- Daily times, ghost replays, and challenge records now stay for 45 days
  after the race started, matching posts and analytics. The playlist is still
  seven days; you cannot set a new time once a race has dropped off.
- Head to Head now paints the challenger's ghost with a random Garage skin
  that is not the acceptor's current car, so the two cars are easy to tell
  apart. The acceptor still races in the skin they have equipped.

- The finish-sheet RANK row no longer grows or recolors on hover. It still
  opens standings when that is available.

- Added **Square Root** (2 laps) and **Half Life** (1 lap) as Campaign stages
  14 and 15 after Golden Ratio. They stay out of Daily rotation. Square Root
  unlocks at 35 Campaign medals plus a medal on Golden Ratio; Half Life
  unlocks at 37 medals plus a medal on Square Root.

- Daily, Campaign, and Head to Head finishes now share one layout: the same
  320px column and padding as the buttons, and the same gap from the heading
  down to the comparison rows. Head to Head still swaps in YOU WON / YOU LOST
  and its entrance motion; Daily and Campaign still show time and medals.

- Nine new tracks join the Daily rotation: **Twisted Clover**, **Hook Loop**,
  **Crooked Arrow**, **Winding Road**, **Gun Slinger**, **Lightning Hook**,
  **Double Trouble**, **Broken Wing**, and **Twin Wings**. They are appended
  after Shark Fin, so already-published days keep their track.

- Daily and Campaign finish stats now use the same left-label / right-value
  rows as Head to Head: VS PB and RANK sit in the button column, with Next
  following that same row. Time and medals stay as they were.

- Daily and Campaign ranked submits now share one `submitCompetitionRun`
  path for replay checks, rate limits, the per-player submit lock, board
  write, and challenge PB. Daily still attaches rank / field size, car
  unlocks, and `hasAnyData` only after an accepted run; Campaign still
  updates stage progress afterward. Lock cleanup always finishes before a
  hard failure or retryable `503`, and wrappers never leak `releaseLock` on
  the HTTP reply.

- Daily submit now overlaps independent Redis work after a valid run (profile
  write, lock release, completed-race flag, garage snapshot) and returns the
  player's rank and field size on the same reply so the finish line can paint
  `#N of M` before the standings snapshot comes back. Challenge setup now
  creates and expires the standings-revision key with the rest of that day's
  board, and ranked writes no longer restamp those TTLs on every submit.
- Installed Reddit's experimental `devvit-docs` skill so coding agents can
  look up official Devvit documentation for this app's version.

- Upgraded the Devvit toolchain to 0.14.1. Reddit now runs apps on Node 24,
  which is why this is a 0.14 release; our game APIs stay the same. Wiki
  helpers were only deprecated, and this app does not use them. Hosted
  playtest validation remains required before publishing.

- Head to Head finish now left-aligns **YOU WON** / **YOU LOST** and
  right-aligns the time at **3.5rem**, tight together, with more space before
  the comparison rows. Those row labels and values share one size. Daily and
  Campaign finishes are unchanged.

- Eight new tracks join the Daily rotation: **Twisted Ladder**, **Hairpin
  Hook**, **Dragon Loop**, **Thor's Hammer**, **Question Mark**, **Nested
  Run**, **Mountain Peak**, and **Shark Fin**. Question Mark's third checkpoint
  has been widened to span the full corridor — it stopped 0.13 short of the
  inner wall.

- Runner Lab validation bots now actually drive the track. The guide they
  follow used to pair the two walls by sample index — the walls have different
  perimeters, so the pairing drifted out of phase and cut across the infield,
  and every bot on every map crashed within the first few seconds. It now
  traces the corridor instead, and reports width from both walls rather than
  doubling the nearer one, so narrow-section warnings match the real gap. The
  page also loads its tracks under `npm run mapmaker`, where the cache-busting
  import used to fail outright.

- The finish sheet's personal-best stat is now labelled **VS PB** instead of
  **BEST LAP** / **BEST RACE** — it has shown a signed gap to the PB, not a lap
  time, for a while now.

- The lobby mode menu now sits on the left, lined up under the **MINI RACER**
  wordmark. Keyboard navigation onto a track carousel also highlights its
  **x / y** counter, so the selected row is visible. The Daily subhead bills
  the selected track name instead of the day, matching Campaign, with the lap
  count under it. Daily also gets a line of its own above the track counter
  saying when the selected track drops off the playlist — a date, or a
  countdown on its last day.

- Rebuilt the moderator analytics dashboard around a player count that can be
  trusted. A player is now a signed-in Reddit account that **started a race**,
  counted once per UTC day — not an app open, which inflated the old number
  past Devvit's own `app_ready`. New versus returning comes from an analytics
  first-seen ledger rather than the player profile, so signing in no longer
  books a month-old player as brand new. Signed-out visitors are reported on
  their own line and never folded into the total: one person can be many
  browser ids. Every mode now reports the same two events, **starts** and
  **finishes**, so Daily, Campaign, and Challenge rows compare directly and
  carry a completion rate. Counts are scoped per subreddit instead of being
  shared across every install. Uniques are also deduped per calendar month and
  kept for 13 months. Unique reach and the per-track breakdown are gone — the
  first answered nothing, and the second could not tell 1 player driving 1000
  laps from 1000 players driving one. Mods still open it from **Open Mini
  Racer analytics**. The old analytics keys are not migrated — they measured
  something else and expire on their own — but new versus returning is not
  starting blind: the first time an account races, the ledger backfills itself
  from that account's own first-seen date, so established players are reported
  as returning rather than appearing new on the day this shipped.

- Finish-sheet ghost comparisons now show **VS #rank** and a signed gap
  (`+` slower, `-` faster) instead of the opponent name and WON/LOST BY.
  After beating that ghost, **Improve** starts a normal personal-best run
  instead of racing the same frozen rank again.

- Replaced the Head to Head poster helmets with italic uppercase **VS.**
  (white V, red S) between the two racers.

- Added **Queen of Hearts** and **Ace of Spades** to the Daily rotation after
  Double Crest. Existing published days are unchanged.

- The splash bar now crawls on its own so a server wait does not look frozen.
  The status line still names the real step. The splash still does not hide
  until that mode can be shown.

- Daily, Campaign, and Head to Head keep one splash until that mode’s lobby
  is ready. Daily and Head to Head start their server requests, and the
  account request, while that mode’s extra file is still downloading.
  Campaign starts the account request then, and asks for campaign progress
  only after identity has settled. Personal-best ghosts and the car image
  start after the track is named and do not keep the splash up.

- If identity cannot be confirmed at launch, the game now asks before
  continuing. **Retry Sync** tries again. **Continue Offline** uses the last
  saved account on this phone, then retries identity once in the background
  and once more when a Daily or Campaign personal best is queued.

- Fixed multi-lap retry comparisons treating lap 1 as a full race. After a
  finished 2- or 3-lap run, the next attempt's first-lap flash now compares
  against that same lap from the earlier race, not the previous total.

- Kept a Daily or Campaign finish that happened before the game knew who the
  player was. The time is stamped with who this phone already is — the last
  confirmed account, or a guest id if none — and is never thrown away on the
  next open. A later Reddit sign-in does not take it. A first-time guest run
  from this visit can still attach once identity answers.

- Rebuilt initial loading around one ordered plan per launch mode. Direct Daily
  prepares its active challenge track, Campaign resolves authoritative progress
  before one bootstrap and its selected stage, and Head to Head starts the duel
  request first without unrelated mode work. The global loading screen now hands
  off to the selected mode within 960ms including fade; PB ghosts and car images
  cannot hold it, promoted-guest choice happens after handoff, and superseded car
  loads always settle instead of forcing the former 20-second escape path. The
  deadline includes pre-coordinator startup time, a fast Head to Head response
  survives a slower identity sync, and Daily request failures now expose Retry
  without substituting the Home track.

- Fixed the game booting twice in the released build. The cache-busting `?v=`
  query was only added to the entry script, so the lazily loaded mode runtimes
  imported the entry back without it and the browser ran a second copy of the
  whole game: the carousel rendered twice, the music played twice staggered, two
  race loops shared one canvas, and the lobby could reappear over a race already
  in progress. Bundles are now cache-busted by file name instead, and deferred
  carousel work is discarded as soon as race start begins.

- Fixed Standings opened from a completed race closing to the bare race canvas.
  Closing that view now restores the finish sheet.

- Fixed first-time multi-lap Daily results showing the final lap as a red
  personal-best deficit. Multi-lap finishes now compare complete race totals
  only, label the comparison **Best Race**, and show the empty first-race state
  when there is no earlier race total.

- Replaced automatic guest sign-in merging with an explicit progress choice. Players can keep guest progress or use their saved account state/start fresh; the unselected state is discarded only after the chosen operation completes.

- Bound queued Daily and Campaign results to the account that raced them. A
  result waits for its own account instead of submitting under whoever signs in
  next, so it can no longer be credited to the wrong leaderboard or refused as a
  locked Campaign stage and lost, and two accounts can each hold a queued result
  for the same race on one device. A finish before identity answers is stamped
  with who this phone already is and kept. A later sign-in does not take it.

- Stopped a guest sign-in from leaving a working guest credential behind. Once a
  promotion has completed, the server refuses the old guest identity rather than
  relying on the browser to retire it, and hands that browser a fresh one.

- Kept a profile outage from resetting the selected car. When player bootstrap
  fails, the game shows the last confirmed cars and unlocks instead of treating
  everything as locked, and saves nothing until the real profile answers.

- Stopped an unreadable personal best from taking a fresh one with it. Cleanup
  now happens only where the record is locked for writing, so a replacement
  saved a moment earlier survives.

- Campaign now recovers a missing ghost instead of dropping it. When a result is
  saved but its ghost could not be, the replay is kept for three background
  retries while the medal, rank, unlock, and Next action stay available.

- Replaced ambiguous Garage Extra-car unlock text with one short requirement
  per skin: races, Gold Campaign medals, Author Campaign medals, posted Head to
  Head challenges, or beaten Head to Head challenges.

- Fixed track-load failures that could leave the loading screen or race-start
  transition stranded. The racer now constructs before the default track
  chunk resolves, track imports time out after 20 seconds, and Daily,
  Campaign, and Head to Head return to their lobby with a retry action when a
  selected track cannot be prepared.

- Hardened guest Campaign promotion for slow and concurrent sign-ins. All
  stage/progress locks renew for the full merge, ownership is checked before
  writes and cleanup, and car-unlock events that arrive during promotion are
  redirected to the Reddit account instead of being lost.

- Fixed the initial Home and Campaign lobby background so startup now builds
  and renders the default track before the loading gate clears, instead of
  showing a floating car over a blank canvas. Daily and Campaign starts also
  rebuild a missing canvas even when the requested track key is unchanged.

- Fixed Daily, Campaign, and Head to Head race starts after lazy mode loading.
  Start actions now retain the active racer context, so race preparation can
  render the background and begin the countdown instead of leaving players in
  the lobby.

- Prioritized first-load work by launch mode. Daily now gates on its active
  challenge, selected track, car, and PB ghost; Campaign gates on bootstrap,
  the selected stage, car, and available stage ghost; Head to Head gates on the
  authoritative challenge, target track, car, and frozen opponent ghost.
  Client track geometry and non-selected mode runtimes now load lazily after
  the selected lobby is ready. The entry module no longer blocks its own
  deferred mode chunk during evaluation, preventing a blank startup screen.
  Dynamically split mode source maps now use unique hashed filenames instead
  of overwriting each other during the production build.

- Approved the current Mistfall Circuit boundary in the track-registry
  fingerprint so integrity checks protect the geometry that actually ships.

- Restored the complete `numbered-v1` stage set to Campaign-only publication;
  Number Zero through Golden Ratio can no longer enter future Daily rotation.

- Limited Devvit release contents to the compiled game client, server, source
  maps, and required build inputs. Tests, docs, internal notes, generated review
  artwork, unrelated tooling, and macOS metadata are no longer sent in the
  publish source or WebView asset archives.

- Renamed the Campaign launcher's `Permanent Series` eyebrow to `The Numbers`.

- Reframed Head to Head post titles as a direct challenge —
  `Can you beat {time}s on {track name}?` — without repeating the
  author's Reddit username. Daily post previews now place the lap count before
  `TIME TO BEAT` instead of labeling the same target as `GOLD TARGET`.

- Rewrote the Reddit app README with a concise, player-first overview while
  retaining its version history and adding a comprehensive 2.0 entry.

- Upgraded the Devvit toolchain to 0.13.11 using the supported CLI dependency
  synchronizer. All direct Devvit packages and the lockfile now stay on
  0.13.11; hosted playtest validation remains required before publishing.

- Moved Daily and Campaign Previous/Next controls into a dedicated row below
  the track preview and added a centered `current / total` track counter.
- Bounded the global startup wait so a stalled profile, Daily, ghost, image, or
  track-worker dependency cannot leave Head to Head behind the loading screen.
- Direct Head to Head launches now start their challenge request immediately
  and gate only on challenge-critical assets, so unrelated Daily/profile work
  cannot add a second 20-second wait or replace the duel track and ghost.
- Guest-to-Reddit promotion now retains the verified guest credential until
  Campaign and car-unlock migration both succeed. Campaign promotion inventories
  every stage and repairs missing progress from verified leaderboard results
  before deleting guest records.
- Direct Campaign startup now treats unranked or promotion-pending responses as
  non-authoritative and retries once after player identity repair, preventing an
  empty first response from replacing real progress.
- Fixed Head to Head Brag comments to request Reddit user attribution.
- Removed the unused subreddit subscriber-count lookup and five-minute Redis
  cache from leaderboard snapshots. `totalCount` remains in the response for
  compatibility and now matches the accepted racer count.
- Fixed Head to Head post entry for guests and signed-in viewers. A ready
  challenge no longer gets a sign-in-only CTA, the post retries once with a
  fresh guest identity when a stored token is stale, and unavailable responses
  are no longer mislabeled as “Sign in to Race.” Challenge reads and submissions
  now also carry the current Reddit post ID, which the server needs to resolve
  the immutable challenge contract from the custom post. If a client cannot
  expose post context, the challenge ID now resolves to the stored Reddit post
  identity and the server still reads the replay from that post body. The
  frozen replay itself is not stored as a second server copy.
- Campaign challenge posts now keep their frozen target and ghost in the
  Reddit text fallback: human-readable copy comes first, followed by a
  versioned gzip/base64url replay envelope. The server validates its hash
  against post data and fails closed when the body is missing or changed;
  Redis retains only the post identity needed to locate that body when client
  context is unavailable.
- Campaign lap balancing now keeps the existing stage order while using the
  fixed `2,2,1,1,2,1,1,3,2,1,3,1,2,2` sequence for Number Zero through Golden
  Ratio.
- Campaign's right-side lobby header now shows the selected track name instead
  of the stage number; Daily keeps its selected date label.
- New Daily GP publication now limits races to one or two laps. The shared
  race contract still reads historical three-lap Daily records and supports
  Campaign's fixed one-, two-, and three-lap stages.
- Added Golden Ratio as Campaign stage 13: a three-lap finale unlocked at 32
  total Campaign medals plus a medal on Euler's Number. It remains out of Daily
  rotation.
- Added stable Current Daily, Campaign, and Lobby launcher posts. Current Daily
  follows the active UTC-day track without freezing, Campaign opens the shared
  game in Campaign mode, and Lobby opens the Home lobby. Each launcher is
  idempotently created from its subreddit menu action while dated Daily posts
  keep their existing frozen behavior.
- Fixed Daily and Campaign identity in the shared lobby header: Mini Racer,
  the mode label, divider, and billing row stay fixed while carousel movement
  updates only the right-side date/stage value. Removed the per-card identity
  and billing duplicates. Restored the compact carousel wordmark cap and mono
  billing scale so the mode screens do not inherit Home's large display type.
- Removed the oversized lap circle from the shared Daily/Campaign Start Race
  brief, leaving a compact dot separator before the `N Lap(s)` text.
- Added the singular/plural `Lap` label beside the filled lap-number circle in
  the shared Daily/Campaign Start Race brief.
- Restyled the shared Daily/Campaign race brief to use the header font, bold the
  selected track name, and show only the lap number inside a filled circular badge.
- Tightened the Daily/Campaign Mini Racer wordmark to the former track-name
  title position beside the top toolbar instead of leaving a full toolbar-height
  gap above it.
- Restored the fixed Mini Racer wordmark above the Daily/Campaign billing row,
  exactly in the poster's former track-name title slot, while keeping the
  selected track name and lap count on the Start Race action.
- Moved the selected track name into the Daily/Campaign Start Race action so
  its smaller second line reads `Track Name - N Laps`; the poster now keeps only
  the mode/date-stage billing above the schematic.
- Replaced the poster's left date/stage caption with the active mode label and
  moved the Daily date or Campaign stage to the right end of the billing line.
- Moved the selected track's lap count out of the Daily/Campaign poster header
  and onto the red Start Race action as a smaller line beneath the button label.
  The count follows the centred track in both modes.
- Campaign now runs to thirteen stages: Imaginary Number (10, 2 laps), Infinite
  Pie (11, 1 lap), and Euler's Number (12, 1 lap) continue the numbered ladder.
  Their gates follow the same curve as stages 03 onward — 25, 27, and 30
  medals, each still reachable without a single Author — and each stage keeps
  the medal-on-the-previous-stage condition that opens one stage at a time. The
  Campaign car unlocks stay at ten Gold and ten Author stages so nothing
  already earned is revoked.
- Replaced the leaderboard's text-only **Race** affordance with a ghost
  icon while preserving the full accessible opponent-race label. The shared
  action column now hugs the icon controls instead of reserving the old text
  label width.
- Standardized every player-visible race time to three decimal places across
  the HUD, result sheets, split and delta displays, medal targets, selectors,
  Reddit result comments, post copy, and final podiums.
- Daily and Campaign now ease their full-screen selector away over 100ms when
  Start Race is pressed, then begin the countdown once track preparation is
  ready.
- Daily and Campaign track schematics now place the player's selected Garage
  car at the start line instead of showing a generic red direction triangle.
  Changing car skins refreshes both selector surfaces immediately, and the
  preview derives its size from the same car and track scale used during a
  race, then applies a consistent `2x` lobby multiplier.
- Reworked the Daily and Campaign selector as one full-screen race surface.
  Track cards and inner preview panels no longer sit above the background; the
  selected schematic becomes the dominant artwork, neighboring tracks crop in
  at the screen edges, and the existing toolbar and Start Race action remain
  anchored above it.
- Replaced the Campaign locked-card MEDALS label, fraction, and bar with one
  medal-shaped counter. The earned/required count sits inside the medal while
  a perimeter stroke shows unlock progress. Incomplete counts and progress are
  muted so they do not read as earned; reached requirements turn white. Locked
  card artwork now carries a large, centered version of the same white lock
  badge used in the Garage, on a red backing. The shared lock viewBox includes
  the full shackle so its top does not clip at larger sizes.
- Added permanent achievement unlocks for the new Extra cars. Crimson unlocks
  after any verified race; Campaign medals unlock Gold, Blaze, Surge, and
  Arctic; unique Head-to-Head posts unlock Fuchsia and Plasma; verified duel
  wins unlock Lime and Onyx. Locked cars show a white lock on a subtle backing;
  a white progress arc appears only after progress begins. Selecting one opens
  a compact requirement panel.
  Both client and server still reject selecting them early.
- Fixed Crimson remaining locked for existing racers when their race predated
  the unlock event store. Retained Daily race history and any saved Campaign
  result now backfill the permanent completed-race unlock.
- Fixed the Mini Racer wordmark briefly disappearing when returning to Home
  because its first-launch entrance animation replayed from zero opacity.
- Daily and Campaign now use a compact top toolbar with Back, Standings,
  Garage, and Settings. Standings follows the currently centred track, and
  Start Race is again the sole full-width bottom action.
- Guest Campaign progress is no longer lost at sign-in. Guest finishes keep their
  replay, and signing in replays them through the normal validated submission so
  the server re-derives every time and medal. Stages claim bottom-up, a stage the
  server refuses stops the claim, and a verified result is never traded down for
  a guest one. Claimed stages also gain PB ghosts.
- Campaign finishes are gated and queued like Daily: finishes that fail win
  validation are rejected outright, runs with severe frame stalls are not ranked,
  an overflowed replay reports **Run too long to rank**, and a confirmed run
  survives a dropped connection through the durable verification queue.
- A Campaign run the server refuses no longer keeps showing an earned medal,
  since Campaign medals are the stage-unlock gate.
- Campaign progress is stored per player instead of as a field in one
  campaign-wide record.
- Challenge finish shows Submitting/Verifying in the medal area, then the
  challenge medal (win), outcome label (loss/tie), or an error — without
  remounting the sheet. Brag unlocks only after a verified win.
- Challenge finishes always show **Improve**, **Brag**, and **Home**. Brag is
  enabled only when the challenge is beaten. A win shows a display-only challenge
  medal and **Challenge beaten** (not Campaign medal tiers).
- Challenge lobby matches Daily/Campaign: Back as a mode action, “Challenge”
  under the title with “u/… challenges you” on the next line, compact details
  panel, and a bottom **Accept** button.
- You can’t accept a player challenge you created: Accept shows a short message
  and opens Campaign instead. The server also rejects self get/submit.
- Mapmaker start-pos tool uses a location-pin icon with a small "start pos" label.
- Mapmaker checkpoints tool uses a stopwatch icon with a small "checkpoints" label.
- Mapmaker finish-line tool uses a flag icon with a small "finish line" label.
- Mapmaker edit-layer tools sit in the canvas header next to the track name (replacing the Outer/Inner/Lines legend).
- Removed the Mapmaker canvas car/brush scale box.
- Mapmaker Line Build tool button shows a bottle icon with a small "line build" label under it.
- Mapmaker Line Build widens bends that are tighter than half the lane before building walls, so the inside corner cannot loop through itself.
- Mapmaker Line Build keeps lane width through corners by filleting the centerline then offsetting walls (no miter flare).
- Mapmaker now shows the same race-style track preview as the game (rounded walls, asphalt, curbs, checkered start/finish), with faint sharp construction lines still visible for editing.
- Mapmaker start car now sits a short fixed distance behind the start/finish line instead of keeping a far drag offset.
- Fixed Mapmaker start-car facing so the nose points toward the start/finish line instead of sitting rear-first against it.
- Mapmaker start car angle is derived from the start/finish line: the car always faces perpendicular and snaps onto the line center when moved. The manual Start Angle field is removed.
- Mapmaker keeps visible start-line/checkpoint end dots for length, but dragging the line or either end moves the whole gate.
- Mapmaker start lines and checkpoints now stick out past both walls so wall-hugging cars still trigger them.
- Fixed Mapmaker start-line/checkpoint snapping so dragging through a corner no longer jumps the gate to another part of the track.
- Mapmaker start line and checkpoint edits snap wall-to-wall and stay perpendicular to the track walls.
- Mapmaker Wall Corners uses plain labels (Sharp, A bit rounded, Rounded, Soft) instead of a raw curve-radius number.
- Mapmaker Line Build brush is fixed at 4u; other brush sizes and presets are removed.
- Mapmaker Save & Integrate now lets authors choose **Daily Challenge** or
  **Campaign only**. Campaign-only tracks stay in the catalog/registry but
  off the Daily schedule; the writer also accepts catalogs where the schedule
  is already a subset of the catalog.
- Restored the pre-Campaign compact lobby footprint across Home, Daily, and
  Campaign. Daily and Campaign Standings/Tracks actions are right-aligned again
  and use the original Font Awesome standings and track icons.
- Campaign now matches Daily's compact lobby layout: Standings opens the shared
  standings modal with independent per-stage leaderboards, while Tracks opens
  the shared Tracks modal with permanent Campaign progress and stage selection.
- Restored the existing Font Awesome Garage and Settings icons on the new Home
  screen instead of substituting platform-dependent text glyphs.
- Added a permanent ten-stage Campaign using Number Zero through Number
  Nine with fixed `1,1,1,2,2,2,3,3,3,3` lap counts, linearly scaled medal
  targets, Gold-gated progression, permanent per-stage standings, and
  Campaign-scoped PB ghosts.
- Added a standalone Home screen with Daily and Campaign choices, corner
  Garage/Settings actions, direct Daily/Campaign/challenge startup, and Back
  navigation from each mode lobby.
- Added signed-in player challenge custom posts backed only by verified
  Campaign or duel results. Challenges freeze the opponent ghost, allow an
  isolated locked-stage duel without Campaign writes, support win/tie/loss
  result chaining, reuse identical posts, and cap new posts at three per
  player, subreddit, and UTC day. Guests cannot create or accept challenges.
- Removed Number Zero through Number Nine from future Daily rotation while
  retaining them in the full playable registry for Campaign.
- Daily GP challenges now freeze a deterministic 1/2/3-lap race format at publication: tracks with author times over 10.95 seconds use 1–2 laps, faster tracks use 1–3, medal targets scale linearly, intermediate finishes flash the cumulative qualifying medal, and only the complete race updates the permanent track medal.
- Multi-lap ranking now shares a versioned client/server race and replay contract. New replays allow 2,500 frames per required lap, legacy published one-lap challenges retain the 3,000-frame limit, checkpoint splits remain cumulative, and PB ghosts are bound to lap count and rules revision.
- Daily cards, playlist, finish UI, Reddit fallback/share copy, score threads, and final podium data now describe the complete race and its lap count.
- Mapmaker freezes the camera while dragging a track point so extreme points no longer pan/rescale the view mid-drag.
- Mapmaker shows a race-scale ghost car at the start and under the Line Build cursor, plus brush sizes in car widths, so lane scale is visible while authoring.
- Home Start resumes the last track raced this session (matching the background map); today's featured daily remains the fallback when nothing has been raced yet or the last map expired.
- Upgraded the Devvit toolchain to 0.13.9 (faster CLI uploads / playtest).
- Set mapmaker Line Build brush default to 4u (was 5u), including the module serializer fallback.
- Mapmaker Curve Radius input now shows the same default (3) Line Build uses when a track has no stored radius.
- Mapmaker trackpad two-finger scroll pans again; pinch (ctrl+wheel) and mouse-wheel line/page steps still zoom.
- Removed Number Eight from the Daily GP schedule (catalog, registry, definition, and share image).
- Added Golden Marsh, Jumping Jack, and Furious Fast to the Daily GP schedule with share images and medal targets; refined Needle Chicane and Turbo Shell geometry.
- Fixed procedural music failing to start when the Web Audio context was still suspended at race start (notably on iOS Reddit).
- Fix standings date rail getting squeezed by long leaderboards (`flex-shrink: 0`).
- Fix daily standings always anchoring the date rail to today; an older loaded track only changes the selected day.
- Campaign lobby paints immediately on open and loads progress in the background; Start/Continue shows a small spinner if bootstrap is still pending.
- Campaign and challenge finishes open the result modal immediately (like Daily) and confirm the run in the background instead of showing a separate saving sheet.
- Campaign finish shows RANK immediately (submitting) then fills in place from the stage leaderboard after confirmation, matching Daily.
- Tightened Devvit Journey attempt boundaries so each explicit player intent (`initial_start`, `track_switch`, `restart`, `retry`, `improve`) maps to one start/end pair, including mid-run track switches that now replace the active Journey before the next attempt begins.
- Mid-lap PB ghost samples now blend position and angle to each 50ms grid mark between 60Hz poses, so playback no longer sits up to one physics frame ahead when the clocks drift. Finish-sample residual lead is unchanged.
- Checkpoint/lap ±0.01 deltas use normal green/red flash colors again; amber `is-warning` is reserved for notices like GHOST UNAVAILABLE.
- Finish and checkpoint times now interpolate within the 1/60s physics step at the line crossing, so leaderboard milliseconds are no longer stuck ending only in 0, 3, or 7.
- Fixed verified personal-best ghosts sometimes saving as missing: ghost recording now stamps samples on the compact 50ms grid and reconciles sample count at finish so Rank can keep the time and the ghost together.
- Fix standings opening before the daily playlist finishes loading by always rendering the full seven-day date rail immediately, refreshing day chips when the playlist resolves, and clearing stuck loading states after snapshot fetch failures.
- Fix standings date rail rendering below the leaderboard list when the day strip is rebuilt during an in-place update.
- Fix uneven standings row heights by giving empty community slots the same `leaderboard-row` class as player rows.
- Match player row height to the share column by sizing the existing `leaderboard-row__action` slot to the share button.
- Fix standings date rail disappearing after modal refresh by rebuilding the strip when the container is cleared while the rail cache still matches.
- Fix standings date-rail hover flicker by keeping the day strip mounted during snapshot refresh and aligning mouse/keyboard chip highlights.
- Standings date strip keeps Today as a single label and shows other days as a small month over a larger day number, using the same accent pill and focus ring treatment as garage tabs.
- Hardened leaderboard-identity and daily-gp-model mutation tests with full name-catalog snapshots, exact constructed-name fixtures, and pinned TTL/window constant values after `ignoreStatic` exposed hybrid static survivors.
- Added Number Zero through Number Six tracks (definitions, catalog/registry wiring, share images) and updated track runtime integrity expectations plus the full registry fingerprint.
- Exported simulation scrape/collision helpers and enabled Stryker `ignoreStatic` so static mutants no longer dominate runtime.
- Added wave-7 mutation-kill tests for exported `daily-gp-store.ts` parse/normalize helpers, `daily-gp-share.ts` share normalize helpers, and `daily-challenge/service.js` coercion/formatting helpers with direct field-type assertions (empty string fallbacks, non-string coercion, and boundary labels); exported share parse/context helpers and store pagination/preference normalizers for direct assertions.
- Added wave-6 mutation-kill tests for `daily-challenge/service.js`, `daily-gp-store.ts`, and `daily-gp-share.ts` covering mock URL params, playlist sort/expiry boundaries, active-cache guards, stored-result validation, community-floor snapshots, podium time formatting, share auth/rate-limit/confirm guards, already-shared recovery, and exact medal/comment copy.
- Added wave-5 mutation-kill tests for `simulation.js`, `daily-challenge/service.js`, `daily-gp-store.ts`, and `daily-gp-share.ts` covering contact-epsilon tie breaks, swept nose contacts, hash dedupe, route-trace sampling, frameSkip spark counts, post-bound skin/objective normalization, playlist merge/expiry fallbacks, active-cache fallback, strict-replay entry metadata, podium minute formatting, share rate limits, score-thread anchor reuse, historical post recovery, and user-attributed share rejection.
- Expanded `daily-podium-service.ts` mutation tests with month-by-month date anchors, publication-window re-checks after lock/avatar resolution, exact redd.it/redditmedia.com/redditstatic.com avatar hosts, registry race winner/loser paths, recovery listing filters, subscription updater preservation, and exact markdown fallback structure.
- Added wave-4 mutation-kill tests for `daily-challenge/service.js`, `daily-gp-store.ts`, `daily-gp-share.ts`, and `simulation.js` covering preview-page detection, playlist expiry >1s filtering, stored-result mismatch guards, community-total caps, submission rate-limit retry windows, nearby-row pagination boundaries, share confirm casing/idempotency paths, contact-epsilon ties, slip-gate activation, max-speed thrust cutoff, and checkpoint/finish gating.
- Expanded autopost-store and leaderboard-identity mutation tests with non-empty string field guards, enabled defaults, FNV hash fixture assertions, and u/ prefix sanitization edges.
- Added mutation-kill tests for `daily-podium-service.ts`, `daily-post-service.ts`, `daily-gp-post-store.ts`, and `daily-podium-post-store.ts` covering typeof/string field guards, regex date anchors, publication-window boundaries, Reddit avatar hostname checks, `t3_` post-id prefixes, `createdAt`/`updatedAt` epoch fallbacks, pending-snapshot expiration comparisons, autopost updater fallbacks, and recovery preferred-url selection.
- Added wave-4 simulation mutation tests for contact-normal flips, scrape severity/suppression, collision-hash cell queries, reverse braking, and skid/history gates.
- Added mutation-kill tests for Redis lock/compression, daily and podium post stores/services, autopost stores, history backfill, and leaderboard-identity helpers covering NX acquisition, ownership unlock/renewal, gzip threshold/fallback, corrupt JSON and null post ids, publication-window boundaries, stale-record recovery, lock-race reuse, and malformed subscription parsing.
- Tightened rate-limit identity tests with exact utf-8 SHA-256 digests and empty-string challengeId/post-data guards for post-bound challenge resolution; ignored `.venv` in Stryker sandbox copies.
- Added mutation-kill tests for `pb-ghost-trace.ts`, `pb-ghost-store.ts`, `game/storage.js`, `game/daily-challenge/storage.js`, and `player-token.ts` covering utf-8 token signatures, bootstrap GET/error boundaries, storage prune and rollback guards, PB ghost trace finish/overflow edges, and Redis PB schema rejection paths.
- Added `tests/result-flow-verification-mutation-kills.test.js` with boundary assertions for combined-rank formatting, verification rank labels, modal payload guards, daily-gp expiry regex anchors, and verification-queue expiry/stage normalization.
- Added `tests/store-share-mutation-kills.test.js` and expanded `tests/server-daily-gp-share-wave2.test.js` with boundary assertions for Daily GP store parsers, snapshot pagination, submission improvement guards, share-preview key prefixes, subreddit mismatch confirm guards, historical post recovery filters, and rate-limit expiry fallbacks.
- Added wave-3 mutation tests for `simulation.js` (exported contact helpers, thrust/downforce/slip/scrape gates, event reset) and `daily-challenge/service.js` (mock URL params, cache trim, snapshot inflight cleanup, prefetch dedupe).
- Expanded the Stryker mutate set with Redis lock/compression, daily and podium post stores/services, autopost stores, history backfill, and leaderboard-identity helpers.
- Added mutation-boundary tests for Daily GP store parsers, share rate-limit/error copy, post-bound challenge id anchors, and daily-challenge cache/snapshot/playlist expiry edges; exported store parse helpers and playlist expiry resolution for direct assertions.
- Added `tests/simulation-boundary-kills.test.js` with thrust-gate, steer/downforce Infinity, slip-gate init, and swept half-length fixtures, plus exported `selectWallContact` / `selectDeepestOverlap` helpers so CONTACT_EPSILON contact tie-breaks can be asserted directly.
- Added 24 wave-2 mutation tests with comparison-boundary assertions and isolated hydration modules (`daily-challenge-snapshot-expiry-hydrate.test.js`, `daily-challenge-snapshot-expiry-runtime.test.js`, `daily-challenge-start-override-boundaries.test.js`) for `daily-challenge/service.js` snapshot/start-override expiry, `daily-gp-store.ts` ledger cutoff and community totals, `daily-gp-share.ts` replay/rate-limit/confirm guards, and `simulation.js` braking, skid, and downforce gates.
- Added wave-2 mutation tests across `daily-challenge/service.js`, `daily-gp-store.ts`, `daily-gp-share.ts`, `simulation.js`, `result-flow.js`, `verification-queue.js`, `snapshot.js`, and `pb-ghost-trace.ts` covering mockTrack routing, post-bound expiry overrides, in-flight playlist/snapshot dedupe, observable multi-tick simulation state, hosted snapshot failure guards, ledger rotation/maintenance, share auth/token validation, pagination snapshot fields, and verification expiry purge paths.
- Expanded mutation tests for `game/daily-challenge/service.js`, `daily-gp-store.ts`, `daily-gp-share.ts`, `simulation.js`, `result-flow.js`, `verification-queue.js`, and `pb-ghost-trace.ts` with active-cache endsAt boundaries, playlist/snapshot expiresAt >1s filtering, formula-based simulation assertions, hasSeenGame=false bootstrap reads, rate-limit TTL-once behavior, combined-rank formatting, and share post recovery guards.
- Expanded `game/daily-challenge/service.js` mutation tests with 39 focused cases for mock URL params, cache trim/clear paths, playlist expiry boundaries, hydrate-once guards, snapshot expiry persistence, best-result tie handling, fetch route/method assertions, and submit/share payload edges.
- Expanded mutation tests for `daily-gp-store.ts`, `daily-gp-share.ts`, and `daily-challenge/service.js` with guest-token mismatch guards, podium minute formatting, preview/shared-record field validation, post-recovery fallbacks, local-vs-snapshot best-time merge, and daily submit/time-label boundaries.
- Added 18 precision mutation tests in `tests/simulation-branches.test.js` targeting `game/race/simulation.js` survivors on acceleration drag (L574, L578, L582-L583), reverse braking (L586-L587), steer grip and slip-gate hysteresis (L603, L614, L619, L621, L630), skid thresholds (L735, L737), run-history rounding (L761), wall-radius overlap (L229), swept half-length (L255), scrape velocity (L435, L438-L440, L443), repeat-suppression (L704, L706), downforce (L596), steer trim (L538), contact tie-break (L302, L304, L305), and event-singleton reset (L8-L19).
- Expanded server mutation tests for Daily GP store/share flows, PB ghost retention, and post-bound challenge resolution, covering ledger maintenance, track-rotation fallbacks, corrupt Redis records, share/score-thread lock-loss paths, and additional parsing edge cases.
- Expanded mutation tests for daily-challenge service mock/cache fallbacks, simulation contact-normal branches, Daily GP store submission guards, share confirm idempotency, verification snapshot stages, and result-flow empty-run stats.
- Expanded mutation tests for verification-queue expiry normalization, result-flow rank/delta branches, PB ghost trace pose validation, daily-challenge storage rollback guards, player-bootstrap payload fallbacks, PB ghost-store schema rejection, Daily GP model boundaries, and scoreboard-service inflight recovery.
- Expanded `tests/simulation-branches.test.js` with 21 additional branch tests for event-snapshot reset, physics-config fallbacks, slip-gate hysteresis, checkpoint array repair, negative collision-hash buckets, swept nose contacts, overlap resolution, scrape-config defaults, and route-trace/run-history precision.
- Raised `game/race/simulation.js` mutation coverage with 37 branch-focused unit tests for checkpoint splits, collision broadphase fallbacks, driving-physics gates (downforce, slip clamp, steer trim), swept/degenerate wall contacts, and scrape-severity weighting.
- Expanded `game/daily-challenge/service.js` mutation tests for active-cache hydration/clearing, playlist prune/hydrate/dedupe/cap paths, snapshot sync and corrupted-cache reads, in-flight snapshot cleanup, card-status timing boundaries, and submit/fetch guard rails.
- Raised mutation coverage on weak modules with targeted unit tests: guest player tokens, car handling, moderator access, checkpoint-time normalization, PB ghost traces, result-flow rank/stats helpers, and verification-queue legacy expiry.
- Expanded `daily-gp-store.ts` mutation tests for snapshot player-rank windowing, empty leaderboard states, stored-challenge type coercion, profile timestamp fallbacks, challenge-history maintenance edges, and submission identity rejection paths.
- Raised `daily-gp-share.ts` mutation coverage from ~56% to ~72% and `daily-challenge/service.js` from ~57% to ~68% by covering historical Reddit-post recovery, post-registration race conditions, score-thread anchor reuse/rebuild/lock-loss paths, corrupted share/preview records, localStorage cache read/write/hydration failures, in-flight playlist and snapshot request dedupe, and remaining formatting/boundary mutants.
- Expanded daily-challenge service tests for card-status boundaries, best-result merge, snapshot prefetch, mock playlist fallback, expired post handling, and local share/submit guards.
- Expanded mutation soft-spot tests for player bootstrap storage, daily-challenge mock/cache normalization, and Daily GP share validation, rate limits, and comment formatting.
- Tightened replay-validator tests against remaining mutation survivors: crash signal variants, non-finite failure details, missing winData, fixedDt fallback, and initial simulation state.
- Expanded server replay-validator tests for payload schema, frame-cap boundaries, failure details, ghost output, checkpoint splits, and hard-to-reach rejection branches.
- Added unit tests for client scoreboard replay recording so input compression, frame caps, overflow discard, and payload copying are covered.
- Made submission, PB, score-thread, sharing, and post-creation Redis locks ownership-safe. Submission and PB leases now last 30 seconds, long Reddit operations renew their lease, and stale requests cannot delete a successor's lock or commit protected writes.
- Restored the instant lobby reveal after loading by preparing its title and controls behind the loading-screen fade while keeping Start input and Devvit `App.Ready` gated until dismissal completes.
- Leaderboard rows and the pinned player time now show the full stored millisecond precision by default.
- Added official Devvit Journeys for the expanded race flow: interactive readiness, explicit attempt starts, monotonic checkpoint progress, pause/resume interactions, and complete or incomplete attempt endings. Journey failures never block gameplay, and no player, track, replay, or custom Redis data is attached.

- Replaced lifetime PB and ghost storage with challenge-scoped records that expire six hours after the track leaves its seven-day availability window. Daily leaderboard keys and response formats are unchanged, but now share that fixed deadline.
- Reduced inactive player-profile and preference retention to 7 days for guests and 30 days for signed-in players without changing the stored profile format.
- Bounded published challenge history to 30 days and added resumable maintenance that corrects known live leaderboard deadlines while preserving active entries.
- Changed final podium automation to retry hourly during the six-hour post-expiry window. The first attempt freezes the public top-three payload so retries remain consistent and idempotent.
- Removed custom gameplay and moderator analytics collection, APIs, Redis cleanup code, menu action, dashboard assets, and dependencies. Historical counters expire naturally.
- Reduced verified PB ghost traces by replacing timestamped millimetre JSON tuples with a fixed-20-Hz schema-v2 origin/delta representation using centimetre positions and shortest-angle deltas. A representative 12-second trace is 56.8% smaller raw and 64.3% smaller after gzip without changing playback interpolation or finish timing.
- Started verified score submission at the finish event and returned the canonical challenge-PB ghost in the accepted response, allowing immediate Improve attempts to use the correct verified ghost by GO without a second download.
- Prevented stale ghost responses and rapid track switching from clearing or preparing the wrong track. When an expected verified ghost is not ready at GO, racing starts on time without a ghost and shows a two-second `GHOST UNAVAILABLE` HUD notice after GO disappears.
- Restyled lap-flash warning notices (including `GHOST UNAVAILABLE`) with a dark amber background so white text stays readable.
- Isolated daily result acceptance from challenge-PB Redis failures by persisting both concurrently after one replay validation. PB-only failures now keep the valid daily result accepted, while daily transaction interruptions remain retryable.
- Made the gold podium row larger and added matching silver/bronze side gradients.
- Split final podium places into separate rounded rows with spacing and no borders.
- Restyled final podium posts to match the rounded results panel reference while keeping Mini Racer type, color, and accent rules; removed the red trail divider in favor of the faint track watermark.
- Tightened final podium spacing and lowered the track watermark so results read clearer against the backdrop.
- Removed the dashed empty-time box and gold-place star accents from final podium posts for a quieter layout.
- Added a **Play Now** control on final podium posts that opens today's featured Mini Racer track.
- Fixed the final podium custom post so the red finish-line trail meets the car (dash mask no longer blanks the right side) and the daily track schematic shows as a faint background immediately on load instead of after avatar or car-asset waits.
- Replaced the podium's hand-drawn fallback with Reddit's official hosted default Snoo. Reddit accounts whose standard profile icon is not exposed by Devvit now use that official fallback, and the legacy avatar cache is versioned so existing podiums adopt it immediately.
- Fixed podium public racers incorrectly showing the generic Snoo on posts created before avatar payloads existed. Legacy posts now resolve and cache only their already-public Reddit identities, new posts retain the Reddit-hosted avatar URL directly, and podium names no longer include `u/`.
- Added identity-aware podium avatars: finalists displaying a Reddit username show their publication-time Snoovatar, while private identities and unavailable avatars use a bundled generic Snoo without exposing additional profile data.
- Added independently enabled final podium posts at 00:01 UTC. Each post freezes the global top three verified results for the track leaving the seven-day window, respects each finalist's username/private-name setting at publication time, and safely fills empty places when fewer than three racers finished.
- Pressing plain `R` now restarts the race while playing, paused, or on the finish screen. Modifier combinations such as Ctrl/Cmd/Alt/Shift+R keep their normal browser behavior and do not restart.
- Fixed PB ghost motion using the raw 60 Hz simulation clock instead of the live car's interpolated render timeline, which made the ghost visibly step when first-run frame pacing was uneven.

How the game works: [README.md](README.md#how-the-game-works).

## 0.7

- Added persistent personal-best ghosts per player and track. Verified lifetime
  track PBs now survive daily challenge dates, return when a track is featured
  again, and can be followed as a highly transparent, collisionless copy of the
  player's selected car; the default-on ghost can be disabled in Settings.
  Custom-post startup now prepares the resolved track's ghost before the lobby
  appears, including historical posts and today's fallback for expired posts,
  and the first race reuses that prepared asset instead of rebuilding it.
- Selecting a race from Tracks now transitions directly into track preparation
  and the countdown instead of briefly restoring the home screen; PB ghost
  retrieval runs concurrently and no longer delays race startup.
- Added Number One and Number Two to the Daily GP schedule with dedicated
  geometry modules and medal targets, while preserving the existing 45-track
  registry unchanged.
- Split the large track registry into lightweight catalog metadata, explicit Daily GP schedule order, and one geometry module per track. Metadata-only consumers no longer load full geometry, while rendering, collision, previews, and server replay validation retain the same assembled `TRACKS` contract.
- Mapmaker can now save and integrate a track directly through the local development server. New tracks append to the Daily GP schedule, existing tracks update in place, and confirmed renames replace the old source and registry entries.
- Split the Devvit server into a boot-only entrypoint, an import-safe composition root, capability-specific route registrars, and focused Reddit/Redis workflow modules without changing endpoints, response shapes, Redis records, or moderator behavior.
- Guest submission throttling now uses a hashed server-provided Reddit request identity, so generating a new signed guest profile no longer resets the rate-limit window.
- Fixed Android Reddit app sessions that could show only the car over a white background. Android now uses the reliable main-thread track renderer, while iOS and web clients retain the worker-rendered track path.
- Every wall collision now costs momentum but lets the lap continue, including severe head-on impacts; the collision body follows the car's visible orientation so nose, side, and rear contact resolve consistently.
- Removed the terminal crash screen. The former crash auto-restart setting is now optional `Collision Auto-Restart`, defaults off, and restarts the attempt after a scrape only when the player enables it.
- Players can now preview and confirm a Reddit-attributed result comment from the finish screen, or share a verified best from the selected day in Standings. The server validates the result, derives the medal and copy, and prevents duplicate shares of the same time.
- Daily post creation now reuses one canonical post per subreddit and challenge day and does not report success until its Mini Racer score thread is pinned. Older posts are repaired lazily so result sharing also works for available historical days.
- Result sharing fails closed if Reddit cannot attribute the comment to the acting player; the app removes the fallback comment instead of silently posting it from the app account.
- Guest profiles are now claimed atomically on first bootstrap and require their signed token for later profile reads, preference or identity changes, personalized standings, and submissions. Browsers that lose the credential rotate to a new guest identity once without clearing local settings or run data.
- Player profiles now use individually expiring Redis records, so one active player no longer refreshes the retention window for every historical profile. Retired shared-hash records are ignored and expire naturally rather than being migrated over current preferences.
- Standings now read Reddit's public subscriber count through one supported community-info request and cache it for five minutes, replacing repeated moderator/approved-user listings and redundant fallback calls on every leaderboard page.
- Player car, trail, audio, music, and collision-restart preferences now persist in the existing Reddit Redis profile and are restored during startup, rather than relying only on browser storage that can reset after an app update.
- The complete Vitest suite is now tracked in Git instead of being excluded by `.gitignore`.
- Opening standings or Tracks from an older Reddit post now shows that challenge's original UTC date instead of incorrectly calling the post-bound track `Today`.
- Standings now load every scored racer in 50-row pages as the list is scrolled, while the current player's rank and best time remain visible in the header regardless of which ranks have loaded; the initial rank-loading state is compact and aligned with that header.
- Mobile standings can now switch between available days by swiping left or right, while the existing horizontally scrollable date strip remains visible and tappable and vertical standings scrolling continues to work.
- Upgraded the Devvit toolchain to 0.13.7 with Vite 7.3.6, aligned server imports with declared Devvit packages, and removed the deprecated no-op inline entrypoint flag.
- Standings now show cached results immediately and then force-refresh the selected day from the server each time standings are reopened, keeping web and mobile entry counts aligned without replacing usable cached results when a refresh fails.
- Returning to a retained mobile WebView now refreshes visible standings, or marks the current challenge stale so its next standings open cannot reuse an outdated racer count.
- Daily Reddit posts now use the concise `Mini Racer, {D MMM}: {track name}` title format, while the text fallback supplies indexable product, control, medal, leaderboard, and availability information without requiring track-specific descriptions.
- Reduced the production game bundle by canonicalizing module imports, removing unused helpers, and deleting legacy proxy configuration scaffolding.
- Removed disabled analytics pageview, player-type, map-selection, menu, and mode-selection plumbing while preserving the active game lifecycle and race event set.
- Removed the retired intermediate standings track-picker and its rank-card styling, plus an unused modal icon/keyboard-hint renderer; current Tracks, Standings, swipe navigation, and combined action buttons are unchanged.
- Consolidated client leaderboard snapshot normalization and moderator menu-action error handling without changing public routes or response shapes.
- Removed unused JS helper exports and an unused player-status store left behind after earlier flow changes.
- Removed an orphaned leaderboard next-target helper that was never wired into the tracked app UI.
- Removed stale HTML IDs and modifier classes that no longer drive gameplay, modal, garage, analytics, or tool behavior.
- Removed stale result-modal, playlist, preview, and moderator-tool CSS selectors that no longer match the shipped UI.
- Start overlay spacing is tighter on the common Reddit desktop and mobile window sizes, so the title, utility actions, and primary CTA stay visible without feeling oversized.
- Restored lobby menu width, utility icon/label sizing, and the three-column Garage car grid after a UI rollback.
- Garage car names now omit Mini, Cyber, and Steam family prefixes.
- Flatter car visuals and expanded garage assets
- Sharper track rendering and canvas layout across screens
- Daily challenge ranking, caching, and restart fixes
- Daily challenge submission stages now surface live player status: submitting, verifying, pending, retrying, and terminal errors
- Daily GP track rotation now walks `game/track/tracks.js` in key order, one track per day, with a server-side ledger freezing each published day so adding or reordering tracks never reshuffles days already published
- Daily GP playlist rows now come from server-side published history instead of recalculating past days from the current track file
- Added server/shared backfill for the June 2-11, 2026 published Daily GP history
- Local Daily GP runs now use the server/post-bound featured challenge path unless an explicit mock or standalone preview mode is requested
- Wall collision and post-run flow fixes
n explicit mock or standalone preview mode is requested
- Wall collision and post-run flow fixes
