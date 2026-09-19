# Validation of the player experience and Redis review — 2026-09-18

This file checks each claim in "Player experience and Redis review — 2026-09-18" against the code at `77640b0`. Line numbers refer to `77640b0`. The working tree has uncommitted guest-transfer changes in `src/server/daily-gp-store.ts` and `game/storage.js`. Those changes do not touch the paths below, but they move some line numbers.

Verdicts: **Confirmed**, **Confirmed with a correction**, **Partly wrong**, **Overstated**, or **Not checked**.

## Findings tied to player symptoms

### 1. Last two Campaign tracks cannot create challenges — Confirmed

- `src/server/head-to-head-model.ts:61–63` accepts only `numbered-v1-00` to `numbered-v1-13`.
- `game/campaign/manifest.js:12–29` defines 16 stages. Stage 14 is `squareRoot` and stage 15 is `halfLife`. Commit `09e4a64` (2026-08-24) added them. The rule was not changed.
- `src/server/campaign-store.ts:916–928` builds the Campaign source with `campaignId` and `raceId` and no `origin`. `getHeadToHeadOrigin` then returns null for stages 14 and 15.
- `src/server/head-to-head-service.ts:339–361` (`isValidSource`) requires an origin, so `preview` returns 404 "No verified result is available for this challenge." at 637–640.
- Reproduced: the predicate and the origin resolver, run on all 16 manifest stages, pass 00–13 and fail 14 and 15.

### 2. Brag can succeed and still report failure — Confirmed, and wider than stated

- `src/server/head-to-head-share.ts:204` posts the comment. `:234` deletes the token. `:247–248` stops the lease and releases the lock.
- `releaseRedisLock` (`src/server/redis-lock.ts:190–237`) retries a lost race, but it throws any other Redis error. `redis.del` also throws on a Redis error.
- The route (`src/server/routes/head-to-head-routes.ts:154–165`) turns the throw into 500 "Could not post this brag."
- The share sheet (`game/race/ui-modal-shell.js:1017–1021`) then shows "Try Again" with the same token.
  - If the token delete failed, the token survives. "Try Again" posts a second comment.
  - If only the lock release failed, the token is gone. "Try Again" answers "This brag preview expired."
- Not in the review: the challenge comment uses the same function (`src/server/head-to-head-comment.ts:131`), so it has the same fault.
- The Daily "share your time" comment (`src/server/daily-gp-share.ts:588–633`) is safer, but it is not safe. It deletes the comment when the lock is lost, when the transaction cannot start, or when `exec` returns empty. It does not delete the comment when the save throws. The code's own notes say that Reddit throws on a lost race instead of returning an empty `exec` (`src/server/redis-lock.ts:304–320`). After a throw the token survives, and "Try Again" can post a second comment. A missing comment ID at `:611` also throws without a delete.

### 3. Daily can save a result and still return "submit failed" — Confirmed with a correction

- `src/server/daily-gp-store.ts:3607–3618` awaits five items in one `Promise.all` after the save.
- Correction: the lock release cannot reject. `src/server/competition-submit.ts:341–344` attaches a `.catch` to it. The other four items can reject:
  - `recordCompletedRace` throws `CarUnlockProgressBusyError` after five lock attempts 5 ms apart (`src/server/car-unlock-store.ts:46–59`). Another reward write for the same player (a parallel submit or a Head to Head win, for example) is enough.
  - `upsertPlayerProfile` throws after three lost races (`src/server/competition-identity.ts:245`, `:475–507`).
  - The standings read and the Garage read throw on any Redis error.
- The route answers 500 "Daily challenge submit failed" (`src/server/routes/competition-routes.ts:119–122`).
- The client treats 500 as retryable (`game/scoreboard/verification-queue.js:272–276`). It shows a retrying state with the error text (`game/scoreboard/engine-methods.js:435–460`). The retry is accepted with `improved: false`, because the first attempt already stored the time (`src/server/competition-submit.ts:303–305`).
- Not in the review: Campaign submit has the same pattern. `src/server/campaign-store.ts:836–845` awaits the Garage snapshot and `recordCompletedRace` after the progress save.

### 4. Head to Head conflates a temporary failure with an unverified result — Confirmed

- `game/head-to-head/engine-methods.js:507–565` sends one request and never retries.
- `game/head-to-head/service.js:9–25` returns `{ ok: false }` on a 5xx. It does not throw. So a server fault is not marked as `confirmationFailed`. The player sees the route's text, "Could not verify this challenge run." (`src/server/routes/head-to-head-routes.ts:132–135`).
- A rejected replay shows "This challenge run could not be verified." (`src/server/head-to-head-service.ts:1080`). The two texts say the same thing to a player.
- A dropped connection gets a different text ("could not be confirmed"), but it ends on the same error screen.
- Server side: `recordVerifiedBest` catches its own errors (`:975–997`). But `writeHeadToHeadAccept`, `recordCompletedRace` and `recordHeadToHeadWin` can reject (`:1100–1123`), and `readChallengeCarUnlocks` runs after them (`:1135`). A rejection there gives 500 after the origin best was saved.
- Daily and Campaign have the verification queue. Head to Head does not.

### 5. Startup has an eight-second timeout and avoidable work — Confirmed with a correction

- `game/storage.js:44` sets 8,000 ms. `game/engine.js:828` starts with `promptOnSyncFailure: true`. `game/storage.js:397–419` shows the sync prompt on any failure.
- `src/server/daily-gp-store.ts:3205` reads the profile. `:3278–3285` writes it in a WATCH transaction, which reads it again. `:3301–3307` runs the completed-race write for every returning player with data. `:3308` reads the Garage.
- Correction: the completed-race write at startup is inside `try/catch`. It adds time but cannot fail startup. The profile write can fail startup after three lost races.

## Optimization order

### First: make success acknowledgements reliable — Agreed

Items 1–4 are faults that players see today. Item 1 does not involve Redis.

### Completed-race reward — Partly wrong

- Correct: `recordCompletedRace` (`src/server/car-unlock-store.ts:333–343`) always takes the promotion lock. An uncontended call costs about eight Redis calls: `SET NX`, `GET` promotion, `HSETNX`, `GET` baseline for an account, and a five-call fenced release. It does this even when the field exists.
- Wrong: the review calls the field "permanent". A transfer with the Guest choice deletes the account Garage and keeps only fields that are absent from the baseline or present in the journal (`:451–487`).
- The journal must record the event even when the field already exists. The code says so at `:107–110` and `:472–477`. A skip that only checks "field present" also skips the journal, and a transfer can then delete the reward.
- Safe version: skip only when the owner's field is present and no transfer baseline exists for that owner. Resolve the promoted owner first.
- Do not do this check under the promotion lock. The lock is most of the cost: `SET NX` and a five-call release. A check under the lock costs the same nine calls as the write it replaces. The check must run without the lock to save anything.
- A check without the lock is not equivalent to the locked write, whatever the read order:
  - A transfer that starts after both reads is not a new loss. A locked write that has already finished gives the reward up in the same way.
  - Field first, then baseline, can lose a reward. A whole transfer can capture, delete the field, and clear the baseline between the two reads.
  - Baseline first, then field, has one worse gap. `captureGuestTransferGarageBaseline` (`src/server/car-unlock-store.ts:197–228`) takes the promotion lock, reads the Garage, and only then writes the baseline. A skip that reads the baseline in that gap sees none and does not wait. A locked write that starts at the same moment waits, sees the baseline, and journals.
  - This is the same kind of loss the locked write already allows, but it is not the same exposure. Preparation (`src/server/daily-gp-store.ts:2632–2689`) runs several reads after the choice and before the capture takes the lock. The account marker that blocks new submits is first set after the capture (`:2692`, through `saveRecord` at `:2509–2512`). The chooser sets only the guest marker (`:2319–2324`). A locked reward write in that window finds no baseline and does not journal. The skip adds a short interval inside the capture where only the skip can lose. A locked write in that interval waits and journals.
- Saving: an account write costs nine commands. For an account, the owner read is not needed, because only guest ids get a promotion key (`src/server/car-unlock-store.ts:491, :588, :620`). So a skip reads two keys and saves about seven commands. A guest write costs eight, and a guest skip saves about six.
- A race test is required before any skip ships. It must include a capture that overlaps the baseline read, not only a transfer that starts after both reads.

### Campaign bootstrap — Confirmed with a correction

- `repairCampaignStandingsFromEntries` (`src/server/campaign-store.ts:510–549`) checks all 16 stages in a sequential `for` loop. That is 32 reads in 16 serial round trips.
- `readCampaignStandingsByRaceId` (`:458–468`) then reads `zCard` and `zRank` for all 16 stages. So every stage is read at least twice.
- `repairCampaignProgressFromLeaderboard` (`:470–508`) first reads the entry of each stage with no result. A stage with no result is read three times, and its entry is read twice.
- Correction: each stage has its own keys, so few reads can be batched. The gains are reuse of the entries and parallel read-only probes.

### Campaign-origin Head to Head — Confirmed

- `src/server/head-to-head-runtime.ts:311–318` runs the full 16-stage repair.
- This runs on every challenge `GET` by a player with an identity (`src/server/head-to-head-service.ts:945`).
- One stage costs 2 probe reads instead of 32.

### Expired-guest cleanup — Overstated for now

- The description of the transaction is correct (`src/server/campaign-store.ts:346–399`). Six player-facing endpoints await it (`:564, :627, :679, :705, :873, :906`).
- Omitted: a global throttle lets the heavy part run at most once in 60 seconds, for at most 10 guests (`:104–105`, `:352–356`).
- Omitted: every ledger score is at least "newest saved timestamp + 365 days" (`:123–125`, `:263–266`, `:338–342`; `src/server/competition.ts:88`).
- Campaign first appears in commit `649ef01` (2026-07-23, "feat: add permanent campaign mode"). No Campaign guest data can be older. So no guest can be due before about 23 July 2027, unless a stored timestamp is wrong. (An earlier version of this file used the first commit, 2026-05-23. That commit imports 45,514 lines of an existing game, so it does not show when the game started.)
- Current cost: one `zRange` for each call. The ledger is not empty; it holds every guest with Campaign progress, but none of them is due. The design risk is real, but it cannot cause today's failures.

### Analytics — Confirmed

- `applyRetention` (`src/server/analytics-store.ts:343–355`) sends eight `EXPIRE` calls for each recorded start or finish.
- One event costs about 14–16 calls in total.
- 100,000 starts give 800,000 `EXPIRE` calls. That is about 9 a second on average, against a documented 40,000 a second. This is waste, not a capacity risk.

### Daily PB summaries — Confirmed

- `getServerPlayerTrackPbSummaries` (`src/server/daily-gp-store.ts:3034–3053`) handles up to 7 challenges one after another.
- `readOrSeedTrackPersonalBest` (`:2951`) can take a lock and write a seed inside this read path.

### Existing optimizations — Confirmed

- `readRowsForRankedMembers` (`src/server/competition-leaderboard.ts:181–226`) reads entries and profiles in parallel.
- `getPlayerTrackPbRecords` (`src/server/pb-ghost-store.ts:300–337`) uses `hMGet` batches.
- `setWithTtl` (`src/server/head-to-head-store.ts:76–80`) sets the value and the expiry in one call.

## Capacity and validation — Confirmed

- 100,000 ÷ 86,400 = 1.16 starts a second.
- The Devvit docs (`reddit/devvit-docs` at `5f8e98b`, `versioned_docs/version-0.14/capabilities/server/redis.mdx`) say:
  - "30 concurrent transaction blocks per installation" in the transactions text (line 115).
  - "20 concurrent transaction blocks; 5-second execution timeout" in the platform table (line 183).
  - "Max concurrent transactions per installation: 20 (default)" in the command reference (line 636).
  - "40,000 commands per second per installation" (line 179). Pipelining: "Not supported" (line 180).
- The conflict between 30 and 20 is real.
- `docs/redis-integrity-validation-2026-08-12.md:20` records the hosted error "exceeded max concurrency limit on redis transactions".
