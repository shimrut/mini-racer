# "Submit failed" fix plan — 2026-09-19

Branch `remove-unneeded-deletes`, based on `62322ed`. Nothing is committed or deployed. The live
install (r/MiniRacerGame) runs v2.2.0.

**Status, end of 2026-09-19:** Parts A and B are built, including B5 and B6. Three more changes are
also built:
- A Head to Head win answers "won" after the save when the brag record, a reward or the Garage read
  fails (`submit` in `src/server/head-to-head-service.ts`).
- The Keep Progress chooser counts the account's Daily rows (`getGuestProgressSelection`).
- A challenge post that fails to open logs which check failed (`postDataProblem` in
  `src/server/head-to-head-post.ts`).

The posts that fail to open are listed in `docs/unopenable-challenge-posts-2026-09-19.md`.
2,898 tests pass. `npm run typecheck` shows the same 23 errors as `62322ed`. `npm run build` is
clean.

Part A lists the changes that are already in the working tree. Part B lists the changes that are
proposed and required: deleting the two profile times, renewing guest expiry, skipping the
start-up reward repair, and creating a missing profile without a transaction. **Do not ship Part A without Part B.** Part C lists what this plan does
not change, and why. Part D records the first review round.

The branch also holds two unrelated changes: the removal of seven Reddit delete calls, and the
Head to Head fix for Campaign stages 14 and 15. They are outside this review.

---

## Evidence

Source: `npx devvit logs MiniRacerGame mini-racer --since 7d --json`. The command returns only the
newest ~5,000 rows. These rows cover 2026-09-16 12:58 UTC to 2026-09-19 13:28 UTC.

- **Daily submit** ("Failed to submit Reddit Mini Racer run"): 177 failures. All 177 are on
  2026-09-16 between 12:58 and 14:27 UTC. There are none after that.
  - 148 are `2 UNKNOWN: ... exceeded max concurrency limit on redis transactions`.
  - 29 are `Car unlock progress update is already in progress.`
- **Start-up** ("Failed to load Reddit Mini Racer player bootstrap"): 1,296 failures in the same
  window, all from the transaction limit.
- **Head to Head, every day:** "Head to Head result could not be ranked in its own mode: Car unlock
  progress update is already in progress" occurs 62, 57, 203 and 81 times on 16–19 Sep. "Failed to
  submit Mini Racer head-to-head: ... already in progress" occurs 55, 4, 6 and 2 times.
- **The limit:** The Reddit docs give two figures in `docs/capabilities/server/redis.mdx`. The
  prose says 30 concurrent transaction blocks per installation. The limits table and the `multi`
  row say "20 (default)". Plan for 20. Each block has a 5-second timeout.
- **Which call hit the limit:** The live bundle is minified, so this is by elimination. Every
  limit error fails at `watch`. In the current source, only `upsertPlayerProfile`
  (`src/server/competition-identity.ts`) calls `redis.watch` directly *and* is called, without a
  catch, by both start-up and Daily submit. The logged stack for all 1,296 start-up failures and for
  101 of the 148 Daily failures is `watch ← Mf`, where `Mf` is called from both the start-up
  handler and the Daily submit handler. The other 47 Daily failures pass through the lock
  transaction helper (`beginOwnedRedisLockTransaction`).
  - The logs show two different minified callers of `watch`. The first is `Yn`, the lock helper.
    Every "... lock cleanup failed" row passes through `Yn ← kU`, and those rows come only from
    `releaseRedisLock`. The second is `Mf`, which calls `watch` directly.
  - The start-up reward repair (`recordCompletedRace` in `getServerPlayerBootstrap`) takes the lock
    path, but it is inside a `try/catch` that logs "Completed-race unlock backfill failed". Its
    275 limit rows show `Yn ← kU`. So it cannot be one of the 1,296 "Failed to load" rows.
  - Limit: the live build is v2.2.0, and this source is newer. The mapping holds only where the
    two builds agree.
- **Busy errors in the burst:** A lock release is itself a transaction. When a release failed at
  the limit, the lock stayed held until its 30-second TTL, and other reward writes for that player
  failed as busy.
- **Head to Head, daily cause:** On a win, `submit` in `src/server/head-to-head-service.ts` ran
  `recordCompletedRace` + `recordHeadToHeadWin` at the same time as the origin save. The origin
  save calls `submitServerDailyGpRun` or `submitServerCampaignRun`, and both of those call
  `recordCompletedRace` for the same player. Two writers took one promotion lock, and the lock
  waited only 4 × 5 ms.

---

## Part A — changes already in the working tree

### A1. Skip the profile transaction when only the timestamps would change

`src/server/competition-identity.ts`
- New: `PLAYER_PROFILE_TIMESTAMP_REFRESH_MS` (24 h), `withoutTimestamps`, `writeWouldOnlyRestamp`.
- `upsertPlayerProfile`: a plain `GET` before the `WATCH` loop. If the stored profile was written
  less than 24 h ago, and the new profile equals it in every field except `lastSeenAt` and
  `updatedAt`, the function returns the stored profile. It opens no transaction.
- Why it is safe: a skip writes nothing, so a writer that races the `GET` loses nothing. Any
  real change (name, identity, preferences, `hasAnyData`, `hasSeenGame`, `firstSeenAt`) still
  goes through the `WATCH` loop as before.
- **Part B replaces the 24-hour rule. Do not ship A1 without Part B.** A1 skips only a profile
  written in the last 24 hours. A returning player's first start-up of the day finds a profile
  from yesterday, so it still opens a `WATCH`. A start-up that fails writes nothing, so every retry
  opens a `WATCH` again. That is the 16 Sep pattern. The Part B rule skips any unchanged profile,
  whatever its age, and that is what removes the start-up write.

Tests: `tests/server-daily-gp-store.test.js`, three new cases after "surfaces a profile write
failure that is not a lost race":
- A recent profile with no change opens no transaction.
- A day-old profile is still written.
- A recent profile whose `hasAnyData` changes is still written.

### A2. A reward write waits longer for the lock

`src/server/car-unlock-store.ts`
- `acquirePromotionLock` takes a list of retry pauses.
- `TRANSFER_LOCK_RETRY_DELAYS_MS = [5, 5, 5, 5]` keeps the old behaviour for every transfer path
  (`acquireTransferPromotionLock`).
- `REWARD_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320]` (~0.63 s in total) applies only to
  `writeCarUnlockEvent`. That function serves `recordCompletedRace`, `recordHeadToHeadPost` and
  `recordHeadToHeadWin`.

Tests: `tests/server-car-unlock-store.test.js`
- "waits for another reward write on the same player instead of failing at once" frees the lock
  after 100 ms. It fails with the old 4 × 5 ms (checked).
- "still reports busy when the lock stays held past the whole wait".

### A3. Head to Head: write the win's rewards after the origin save

`src/server/head-to-head-service.ts`, `submit`, win branch:
`unlockWrites = originSave.then(async () => { recordCompletedRace; recordHeadToHeadWin })`.
`originSave` is `recordVerifiedBest`, which catches every error, so `.then` always runs.
A win still writes `recordCompletedRace` twice: once in the origin save, and once here. Keep the
second write. After A4, the origin save can answer 200 with a failed reward write, and the second
write repairs it.

Test: `tests/server-head-to-head.test.js`, "records the win rewards only after the origin save,
which writes the same reward". It fails without the change (checked).

### A4. After the save, answer "saved"

`src/server/daily-gp-store.ts`, `submitServerDailyGpRun`, after `submitCompetitionRun` accepts:
- `Promise.allSettled` over the rank read, the Garage read, `recordCompletedRace` and
  `upsertPlayerProfile`. Then `await outcome.releaseLock`.
- If **both** `recordCompletedRace` and `upsertPlayerProfile` rejected, the function throws as
  today, so the route answers 500 and the game retries in 30 s. The reason: the Keep Progress
  chooser decides "the account has progress" from Campaign data, the reward record or
  `profile.hasAnyData`. It does not count the account's Daily rows. With neither record, a
  Guest choice could replace this run.
- Otherwise the function answers 200, and it logs each failed job.
  - A failed rank read gives `playerRank`, `playerRankLabel` and `leaderboardEntryCount` = `null`.
  - The answer has `carUnlocks` only if the Garage read **and** the reward write succeeded. The
    Garage read passes `completedRaceEvidence = true`. If it showed a reward that did not store,
    the next start-up could lock the car again.

`src/server/campaign-store.ts`, `submitServerCampaignRun`:
- `Promise.allSettled` over `getCarUnlockSnapshot` and `recordCompletedRace`. The answer is
  always 200 after the progress save. `carUnlocks` follows the same rule as Daily. The existing
  `finally { await outcome.releaseLock }` still waits for the lock.

Game side, checked and not changed: `scoreboardSnapshotFromSubmitRank` accepts a missing rank, and
`applyCarUnlockSnapshot` ignores a missing snapshot. Campaign uses
`response.body.carUnlocks ?? <previous>`.

Tests:
- `tests/daily-gp-store.test.js`, "Daily finish after the run is saved": each of the four jobs
  fails alone → 200, and the time is on the board. Both writes fail → the error is thrown, and
  the time is on the board.
- `tests/server-campaign-store.test.js`: the Garage read fails, or the reward write fails → 200,
  the progress is stored, there is no `carUnlocks`, and the lock is released. The old test "awaits
  releaseLock when post-accept unlock work rejects" expected a throw, and this replaces it.

State after Part A: 2,884 tests pass. `npm run typecheck` shows the same 23 errors that exist on
`62322ed`. `npm run build` is clean.

---

## Part B — proposed, and required: delete `lastSeenAt` and `updatedAt`, renew guest expiry, skip the start-up reward repair, and create missing profiles with `SET NX`

Part B is not clean-up. Without it, a returning player's first start-up of each day still opens
a profile `WATCH`, and it opens a lock-release `WATCH` for the reward repair. A start-up storm
still fills the limit.

### What reads them today

- `lastSeenAt`: the start-up payload sends it to the game (`src/server/daily-gp-store.ts`, type at
  `:159`, values at `:3270`, `:3302`, `:3351`, `:3418`). No game file reads it, and no game file
  has ever read it (`git log -S lastSeenAt -- game` is empty).
- `updatedAt`: after Part A, only the 24-hour rule in A1 reads it.
- Moderator analytics (`src/server/analytics-store.ts`) reads the profile's `firstSeenAt` only,
  in `claimFirstSeen`, for the new/returning label. D1/D2/D3/D7/D14/D30 use the analytics ledger:
  `cohort-starts` and the per-day player hashes, written by `recordAnalyticsRace`.
  `src/server/storage-usage.ts` measures the size of the profile key only.
- `game/player/profile-cache.js` has its own `updatedAt`, which the browser sets. It is not the
  profile's field and this plan does not touch it.
- The fields came from the first commit (`45e79bb`, 2026-05-23), which used Supabase
  (`IGNORE SUPABASE/`). That version did not read them either.

### Changes

1. `src/server/daily-gp-model.ts:135–136`: remove `lastSeenAt` and `updatedAt` from
   `DailyGpPlayerProfile`.
2. `src/server/competition-identity.ts`
   - `parseStoredPlayerProfile`: stop reading the two fields. Stored profiles keep them in their
     JSON until their next real change, and the parser ignores them.
   - `buildPlayerProfile`: stop writing them.
   - Replace `PLAYER_PROFILE_TIMESTAMP_REFRESH_MS`, `withoutTimestamps` and `writeWouldOnlyRestamp`
     with one test: the new profile equals the stored profile (`JSON.stringify` of both). Skip
     whenever they are equal. There is no longer a 24-hour rule.
   - **Guest expiry renewal:** every time `upsertPlayerProfile` skips for a guest id
     (`createPlayerProfileExpiration(playerId)` is defined), call
     `redis.expire(profileKey, DAILY_GP_GUEST_PROFILE_TTL_SECONDS)`. This keeps today's promise:
     any visit resets the year. It is one command and not a transaction, and it reads no TTL, so
     there are no `expireTime` sentinels to handle. `EXPIRE` on a key with no TTL attaches the year.
     On a key that vanished after the `GET`, it does nothing and returns 0. Both cases still occur;
     the code just does not branch on them. Signed-in profiles have no TTL
     (`DAILY_GP_SIGNED_IN_PROFILE_TTL_SECONDS = null`), so they need nothing.
   - **If `EXPIRE` throws, still return the stored profile.** The skip already decided that there
     is nothing to save, and the renewal is extra. A throw would fail the start-up with a 500 again,
     and that failure is what this change removes. Catch the error, log it, and return the stored
     profile.
   - Do not renew only when little time remains. Suppose the rule were "fewer than 30 days left":
     a guest who plays in January and July would get no renewal in July, and would lose the
     profile the next January. Today, that guest is kept.
   - An `EXPIRE` aborts any `WATCH` on the same key, as `redis-lock.ts` notes. The only clash is
     with the same player's own real profile write in flight: the first `hasAnyData`, a preference
     save, an identity change, or the start-up skin clamp. After B, a normal Daily finish skips and
     does not `WATCH`. The write's three retries cover the clash, and a test proves it (B4).
   - The comment on `ensurePlayerProfileExists` mentions the two fields. Change it.
3. `src/server/daily-gp-store.ts`: remove `lastSeenAt` from the start-up payload type (`:159`) and
   from the four return objects (`:3270`, `:3302`, `:3351`, `:3418`).
4. Tests that mention `lastSeenAt` (42 lines): `tests/daily-gp-store.test.js`,
   `tests/mutation-soft-spots-wave7.test.js`, `tests/server-campaign-store.test.js`,
   `tests/server-daily-gp-store-parse-boundaries.test.js`, `tests/server-daily-gp-store.test.js`,
   `tests/store-share-mutation-kills.test.js`. Rewrite the three A1 tests:
   - An unchanged profile opens no transaction, whatever the age of the stored profile.
   - An unchanged guest profile gets `expire(key, 365 days)` on every skip, even when most of the
     year remains.
   - An unchanged signed-in profile gets no `expire`.
   - An `expire` that throws is logged, and the stored profile is still returned.
   - A changed profile is written.
   - A missing profile is created with `SET NX` and opens no transaction (B6). If `SET NX` loses
     to another request, the `WATCH` loop merges onto the winner.
   - An `EXPIRE` that lands between another request's `WATCH` and `EXEC` on the same profile makes
     that write retry, and the retry stores the change.
5. **Skip the start-up reward repair when the field already exists.**
   - Where: `getServerPlayerBootstrap` in `src/server/daily-gp-store.ts`, the
     `recordCompletedRace` call under `profile.hasAnyData && !backfillBlockedByTransfer`.
   - Add an export to `src/server/car-unlock-store.ts` that resolves the promoted owner the same way
     `writeCarUnlockEvent` does, without the lock. It reads `race:completed` on the owner's hash.
     When the field is `'1'`, start-up does not call `recordCompletedRace`.
   - This removes the last transaction from a returning player's start-up: the lock release.
     Part C lists the real writes that remain.
   - Round 2 agreed that the present, absent and promoted-guest tests are enough. A transfer that
     is waiting for a choice already blocks the repair.
   - Why it is safe here and not for every reward write: the journal protects a reward *earned*
     while a transfer is open. The start-up repair earns nothing, because it only restates a field
     the owner already holds. Suppose a Guest choice then replaces the account's Garage. The field
     goes, and the guest's own `race:completed` comes in. The empty-guest fix refuses a guest with
     nothing to carry, and a guest with accepted runs normally holds its own field. If the guest's
     field is missing, the account's field is also missing afterwards, so the next start-up does
     not skip. The locked repair then writes it under the same condition as today: the profile's
     `hasAnyData` is on. A transfer never writes the profile.
   - The global skip stays out (Part C). A Daily, Campaign or Head to Head finish still takes the
     locked write.
   - Tests: the field is present → no lock and no transaction. The field is absent → the locked
     write runs, as today. A promoted guest resolves to its account's field.
6. **Create a missing profile without a transaction.**
   - Where: `upsertPlayerProfile` in `src/server/competition-identity.ts`, when the plain `GET`
     finds no stored profile.
   - Build the profile from no previous profile. Write it with
     `SET key value NX` and the usual expiration, as `claimNewGuestPlayerProfile` and
     `ensurePlayerProfileExists` already do. If `SET NX` succeeds, return the new profile. If it
     fails, another request created the profile first, so go on to the `WATCH` loop. The loop reads
     the winner and merges this request's fields onto it.
   - Why: a brand-new signed-in player's first start-up runs `upsertPlayerProfile` with no stored
     profile. Today that is a `WATCH` transaction. A traffic spike is mostly new players, so without
     B6 each of them still takes a slot at start-up. `NX` never overwrites, so it cannot lose a
     concurrent write.

### When the guest renewal runs

`upsertPlayerProfile` runs on every start-up, through `getServerPlayerBootstrap`, except the first
visit of a new guest, which `claimNewGuestPlayerProfile` writes with a TTL. It also runs on every
Daily finish, every preference save and every identity change. On each of these calls, a guest's
year restarts in one of two ways: the full rewrite when something changed, or the `EXPIRE` when
nothing did. Today, only the full rewrite does it, on the same calls. So the rule stays the same:
any visit within a year keeps a guest profile for another year.

### Effect on existing players

- Stored profiles keep everything else, including `firstSeenAt`, which drives the returning-player
  start screen and the moderator new/returning label.
- A guest who stopped playing expires on the same date as today, because their last write set
  that date.
- Older game builds still open in a browser do not read the fields.

---

## Part C — not changed on purpose

- **Skip `recordCompletedRace` on every finish when the field already exists.** A reward accepted
  during a guest transfer must be journaled even when the field exists. See
  `docs/player-experience-redis-review-validation-2026-09-18.md`, "Completed-race reward". Only
  the start-up repair skips (B5).
- **Lock release without a transaction.** The compare-and-delete in `src/server/redis-lock.ts` is
  kept, because a past incident required it.
- **The lock wait on transfer paths.** It stays at 4 × 5 ms. Busy is already a retryable 503
  there.
- **The Keep Progress chooser ignores the account's Daily rows** (`accountHasProgress` in
  `getGuestProgressSelection`). This is a live bug today. It needs its own fix in the transfer
  code.
- **Head to Head can still answer 500 after a save** if `writeHeadToHeadAccept`,
  `recordHeadToHeadWin` or `readChallengeCarUnlocks` fails. This is the same kind of fault that A4
  fixes for Daily and Campaign. A3 removes only the self-clash.
- **A large enough traffic spike can still reach the limit** (20 or 30). After Part B, a
  returning player's start-up opens no transaction, and after B6 neither does a new player's. The
  remaining start-up transactions are all real writes, and they stay:
  - The skin clamp: when the Garage no longer allows the stored car, start-up writes the
    preference with a `WATCH`.
  - The start-up reward repair when `race:completed` is missing (the absent path in B5). It takes
    the lock and a lock-release transaction.
  - A guest sign-in that opens, resumes or retires a transfer.
  - Opening Campaign runs a standings repair only for a stage whose entry and score disagree. It
    runs the guest clean-up only when expired guests exist and the throttle allows it. A Daily finish still opens about five: the
  board write, the PB write, the PB lock release, the submission lock release and the reward lock
  release.

---

## Part D — review round 1: answers, and what is still open

Answered:
1. **Elimination.** It is sound for the current source. The start-up reward repair logs under its
   own message through `Yn ← kU`, and the lock helper `Yn` is not `Mf`. `cleanupExpiredCampaignGuests`
   also calls `watch`, but start-up does not reach it. The residual doubt is the difference between
   the v2.2.0 build and this source.
2. **Lock timing in A4.** It does not change. `submitCompetitionRun` starts `releaseLock` in its
   `finally`. The new code changes only when the caller waits for it.
3. **The 0.63 s wait.** It is acceptable. Start-up gives up at 8 s (`PLAYER_BOOTSTRAP_TIMEOUT_MS`).
   An uncontended lock does not wait. A lock stuck until its 30 s TTL still fails, 0.6 s later.
4. **Other readers.** Nothing outside `src/` and `game/` reads the two fields. The moderator
   post's `updatedAt` belongs to a different object.
5. **Equality.** `parseStoredPlayerProfile` and `buildPlayerProfile` build their objects in the same
   key order, and `parse` drops extra stored fields. So the check cannot miss a change. The only
   error is an extra write when preference keys come in a different order.
6. **`EXPIRE` against `WATCH`.** An `EXPIRE` aborts a `WATCH` on the same key. The conflict is per
   key, so only the same player's own requests can collide. After Part B, a real profile
   write is rare, so the clash is rare. The write's three retries cover it, and a test proves it
   (B4). Review round 2 rejected an earlier "renew only when fewer than 30 days remain" rule,
   because it drops guests who play twice a year.

Still open:
- The Head to Head 500-after-save (Part C) is the same kind of fault as A4. It is outside this
  change.
- Whether the live limit is 20 or 30. Neither figure changes the plan.

Review round 3:
- Added: a throw from the renewal `EXPIRE` is caught and logged, and it does not fail start-up (B2,
  B4).
- Corrected: Part C listed one start-up exception, but there are more. It now lists every
  remaining start-up transaction.
- Added by the author: B6. A brand-new player's first start-up no longer takes a transaction.
