# Redis improvements — 2026-09-21

Read-only review of the working tree at `0861c03` (branch `h2h-card-early-tap`). No code was changed.
Each item below was traced in the code. The review did not run the game, the test suite, or a hosted
load test, so it gives command counts from the code, not measured timings.

The groups combine two axes: how much work the change is, and how much a live player feels it.

## The scarce resource

Reddit gives one installation 40,000 Redis commands a second, and 20 to 30 concurrent transaction
blocks. Command volume is not the constraint today. Transaction blocks are: on 2026-09-16 the profile
write filled the transaction limit, and start-ups and saved runs failed for about 90 minutes. The
comment at `src/server/competition-identity.ts:493-496` records this. That write now skips its
transaction when nothing changed.

A fenced lock release (`releaseRedisLock`, `src/server/redis-lock.ts:190-237`) costs five sequential
calls — `WATCH`, `GET`, `MULTI`, `DEL`, `EXEC` — and holds one transaction block for all five. One
finished Daily race performs three of these releases (submission lock, personal-best lock, Garage
promotion lock), plus one transaction for the personal-best write. Counting transaction blocks is
therefore the right way to rank the items below, not counting commands.

One finished Daily race costs about 55 to 60 Redis commands in total. About 25 of them repeat work
that is already stored.

---

## Group A — Small change, players feel it

### A1. The guest token secret is read from Redis on every call that verifies a token

`getGuestPlayerTokenSecret` (`src/server/player-token.ts:13-22`) performs a `GET` every time
`verifyGuestPlayerToken` or `mintGuestPlayerToken` runs. The secret is written once with `SET NX` and
never changes.

Cost: one extra `GET`, before any other work, on every request that carries a guest token. Player
start-up pays it twice, because `getServerPlayerBootstrap` verifies the same token again at
`src/server/daily-gp-store.ts:3326` after `resolveAuthorizedPlayerIdentity` already verified it at
`:3227`. Campaign bootstrap pays it twice for the same reason (`src/server/campaign-store.ts:567`).

Change: hold the secret in a module-level variable after the first read. Drop the second verify call
in both bootstraps and reuse the identity that was already resolved.

Risk: low. The value is immutable for the life of the installation. If the secret is ever rotated, the
memo needs a short TTL.

### A2. Daily personal-best summaries are read one challenge at a time

`getServerPlayerTrackPbSummaries` (`src/server/daily-gp-store.ts:3120-3139`) loops over up to seven
challenge IDs and awaits each one. Each pass calls `readOrSeedTrackPersonalBest` (`:3037`), which reads
the record and can also read a leaderboard entry and take a lock to seed.

Cost: up to 14 sequential round trips on the Daily list screen, where the player waits for the times to
appear.

Change: run the seven reads together. Keep the seed path separate from the read path, so a backfill
lock never sits in the middle of a read.

Risk: low. The reads are independent keys. Keep the seed writes bounded so seven locks are not taken at
once.

### A3. A Campaign-origin Head to Head repairs all sixteen stages

`readHeadToHeadViewerBest` (`src/server/head-to-head-runtime.ts:311-318`) calls
`repairCampaignStandingsFromEntries`, which walks every stage. The request concerns one stage.

Cost: 32 probe reads in 16 serial round trips, instead of 2 reads, on every Head to Head challenge
opened by a player who has an identity.

Change: scope the repair to the origin stage of that challenge.

Risk: low. The other fifteen stages are still repaired by Campaign bootstrap.

### A4. Identity resolution runs its reads one after another, and later paths repeat them

`resolveGuestIdentityStatus` (`src/server/guest-retirement.ts:60-83`) reads the selection-pending key,
then the promotion key, then sometimes the Campaign progress key, in sequence. Every authorized request
runs this for a guest.

`resolveChallengeViewer` (`src/server/head-to-head-service.ts:203-222`) then calls
`isProgressTransferPending`, which reads the same selection-pending key a second time.

Cost: two or three serial round trips at the start of every request, and one duplicate read per Head to
Head request from a guest.

Change: read the first two keys in one round trip. Return the pending flag from the identity result and
let the callers use it.

Risk: low. The two keys are independent. The order between them carries no rule.

---

## Group B — Small change, players do not feel it

These reduce cost and protect headroom. They do not change what a player waits for.

### B1. Analytics refreshes eight expiry times on every recorded event

`applyRetention` (`src/server/analytics-store.ts:346-357`) sends eight `EXPIRE` calls for each start,
finish, challenge creation, and podium action. The day keys keep 365 days. The month and ledger keys
keep 400 days.

Cost: one recorded event costs about 16 commands, and half of them are these refreshes. At 100,000
starts a day that is 800,000 expiry calls, before finishes are counted.

Change: stamp each bucket once, not once per event. A per-process record of the buckets already stamped
is enough, because a restart restamps and the margin is a year.

Risk: low, if the rolling ledgers (`first-seen`, `cohort-starts`) keep a refresh path. Do not move them
to create-time-only stamping.

### B2. Campaign standings repair walks sixteen stages in sequence

`repairCampaignStandingsFromEntries` (`src/server/campaign-store.ts:510-548`) awaits each stage in a
`for` loop. `readCampaignStandingsByRaceId` (`:458-467`) then reads `zCard` and `zRank` for all sixteen
stages, and `repairCampaignProgressFromLeaderboard` (`:470-507`) reads the entry of every stage with no
result. A stage with no result is read three times.

Cost: Campaign bootstrap uses about 70 commands, and 16 of its round trips are serial.

Change: run the read-only probes together and reuse the entries that progress recovery already read.
Take a lock only for a stage that the probe proves is wrong.

Risk: medium-low. Keep the repair writes serial, or the stage locks compete with a live submit.

### B3. Head to Head history maintenance and expiry stamping run inside write paths

`maintainChallengeHistory` (`src/server/daily-gp-store.ts:768-800`) scans a page of the challenge
history and restamps four keys for each entry it reads. It runs when a challenge is written or
backfilled, which is rare, so this is recorded for completeness and not for action now.

---

## Group C — Medium change, players feel it

### C1. Every race finish takes the Garage promotion lock for a field that is already stored

`recordCompletedRace` (`src/server/car-unlock-store.ts:451-456`) always enters `writeCarUnlockEvent`,
which takes the promotion lock, resolves the owner, writes the field with `HSETNX`, reads the transfer
baseline, and releases the lock. That is about nine commands and one transaction block, on every Daily,
Campaign, and Head to Head finish, for a field that a returning player already has.

Start-up already skips it. `getServerPlayerBootstrap` (`src/server/daily-gp-store.ts:3404-3409`) checks
`hasRecordedCompletedRace` first. The comment at `src/server/car-unlock-store.ts:436-442` states why a
finish may not use the same skip: a reward accepted while a transfer is open must be journaled even when
the field already exists.

Change: skip the locked write on a finish only when the owner holds the field **and** no transfer
baseline exists for that owner. The check must run outside the lock, or it saves nothing.

Risk: medium. `docs/player-experience-redis-review-validation-2026-09-18.md:60-73` sets out the race:
`captureGuestTransferGarageBaseline` takes the lock, reads the Garage, and only then writes the
baseline. A skip that reads the baseline inside that gap does not wait, where the locked write would
wait and journal. Ship this only with a test that overlaps the skip with a capture, not only with a
transfer that starts after both reads.

Saving: about seven commands and one transaction block per finish.

### C2. One finish performs three fenced lock releases

The submission lock (`src/server/competition-submit.ts:341`), the personal-best lock
(`src/server/pb-ghost-store.ts:455`), and the promotion lock (`src/server/car-unlock-store.ts:220`) each
release through the five-call fenced path. `releaseRedisLockGroup` (`src/server/redis-lock.ts:262-302`)
already exists and drops a whole group in one transaction.

Change: let the personal-best write hand its lock back to the submit path instead of releasing it in its
own `finally`, and release both in one group. C1 removes the third release.

Risk: medium. The personal-best write currently owns its lock for its whole life. Moving the release
changes who holds it when a write fails. Keep the compare-and-delete: a past incident required it.

Saving: two transaction blocks per finish, down from four to two.

### C3. Player start-up is a chain of serial round trips inside an eight-second deadline

`getServerPlayerBootstrap` (`src/server/daily-gp-store.ts:3214-3445`) awaits, in order: identity, the
stored profile, the account transfer state, a second token verify, the promotion target, the profile
upsert, the Garage snapshot (which also reads Campaign progress), the completed-race check, and the owed
reward settle. The client aborts at 8,000 ms (`game/storage.js:44`) and then shows the synchronization
prompt.

Change: resolve the reads that do not depend on each other together. A1 removes one of them. The Garage
read and the Campaign progress read can start as soon as the identity is known.

Risk: medium. The transfer gates must stay ahead of every write, exactly as they are now. Only move
reads.

---

## Group D — Larger change, mostly future risk

### D1. Campaign data never expires

`toCampaignCompetition` (`src/server/competition.ts:103`) sets `ttlSeconds: null`. Campaign
leaderboards, entry hashes, personal-best hashes, and progress keys therefore hold every player who has
ever raced a stage, including every guest browser. Guest progress carries an expiry, but the ledger
score is at least "newest saved time plus 365 days", and Campaign shipped on 2026-07-23. No guest can be
due before about July 2027.

Change: decide the retention rule for Campaign now, while the data is small. The app cannot measure the
hosted instance — Devvit has no `INFO`, no `DBSIZE`, and no key scan — so `src/server/storage-usage.ts`
walks the keys the app can name. Use that page to watch the trend.

Risk: this is a product decision, not only a code change. A Campaign board that drops players changes
what the stage screens show.

### D2. Expired-guest cleanup runs inside player-facing requests

`cleanupExpiredCampaignGuestsBestEffort` (`src/server/campaign-store.ts:346-399`) is awaited by six
player-facing endpoints. A global throttle limits the heavy part to once in 60 seconds and ten guests,
so today each call costs one `zRange`. When the ledger starts to produce due guests, each run queues up
to 16 x 4 stage commands plus deletions inside one transaction, in front of a waiting player.

Change: move the work to a scheduled job before the first guests fall due. Keep the refreshed-expiry
recheck and the ownership protections.

Risk: medium. The work must stay durable. Do not replace it with unawaited request work.

### D3. The server records no Redis figures

Only the guest transfer logs timings (`src/server/daily-gp-store.ts:2417`). Nothing records Redis calls
per request, transaction duration, conflict counts, or endpoint percentiles.

Change: record calls and duration per endpoint, and count transaction conflicts. Without this, every
item above is ranked from the code, and no change can be proved to have helped.

---

## Already optimized — do not redo

- Leaderboard pages share one cached answer for ten seconds, keyed on a standings revision
  (`src/server/competition-leaderboard.ts:371-390`).
- The profile write skips its transaction when nothing changed, and creates a new profile with `SET NX`
  (`src/server/competition-identity.ts:497-521`).
- The account transfer state reads both of its keys in one `mGet`
  (`src/server/daily-gp-store.ts:1987-1990`).
- Leaderboard entries and profiles are read in parallel
  (`src/server/competition-leaderboard.ts:181-226`).
- Personal-best records use batched `hMGet` (`src/server/pb-ghost-store.ts:300-337`).
- Head to Head challenge storage sets the value and its expiry in one call
  (`src/server/head-to-head-store.ts:76-80`).
- The Daily snapshot no longer stamps the profile key (`src/server/daily-gp-store.ts:3566-3572`).
- Head to Head feed cards no longer call the server (`3484f29`).
- Head to Head challenge records live in the post, not in Redis.

## Suggested order

1. A1, A3 — smallest change, immediate effect on start-up and on every Head to Head.
2. A2, A4 — same size, one screen and every request.
3. B1, B2 — cost and headroom.
4. C1, C2 — the two transaction blocks per finish. C1 needs the race test named above.
5. C3 — after A1, because A1 removes one of its steps.
6. D3 — then D1 and D2, on measured figures.
