# What the Redis and Devvit API offers that we do not use — 2026-09-21

Read-only review. No code was changed.

Companion to `docs/redis-improvements-2026-09-21.md`. That review counts the calls the app makes.
This one starts from the other side: the commands and the platform features that the shipped Devvit
packages give us, and the places where the app pays for work that a supplied feature removes.

## Sources

The hosted documentation site is not reachable from this machine, so this review reads the shipped
type definitions of `@devvit/redis` 0.14.1 and `@devvit/web/server` 0.14.1 in `node_modules`. The
platform limits below are the figures quoted from the documentation site on 2026-09-18 and recorded
in `docs/player-experience-redis-review-2026-09-18.md`.

## What the platform gives us

- **One round trip for each call.** Pipelining is not supported. Only these commands batch work:
  `mGet`, `mSet`, `hMGet`, `hSet` with many fields, `zAdd` with many members, `del` with many keys,
  and `exists` with many keys. Everything else overlaps only through `Promise.all`.
- **`set` carries `expiration` and `nx`.** A hash and a sorted set have no expiry option, so
  `expire` stays necessary for them. There is no `hExpire`.
- **`redisCompressed` is a drop-in client.** It compresses on write and decompresses on read.
- **`cache()` from `@devvit/web/server`** gives a local cache, a Redis cache, and protection against
  a stampede, in one call.
- **The scheduler takes cron tasks.** The app already runs two.
- **Limits:** 40,000 commands each second for one installation, 20 to 30 concurrent transaction
  blocks, and a five-second transaction timeout.
- **Absent:** `hExists`, `INFO`, `DBSIZE`, `KEYS`, and a global `SCAN`.
- **A deviation:** `zRange` with `reverse` keeps `start` as the low bound. Do not "correct" a call
  that already respects this.

---

## 1. The leaderboard reads full ghost traces to set one boolean

This is the largest payload waste found, and the change is small.

`readRowsForRankedMembers` (`src/server/competition-leaderboard.ts:181-226`) reads the personal-best
record of every opponent on the page. It uses the whole record for one thing:
`isCompleteOpponentRecord` (`:117-131`), which answers a boolean, `opponentRaceAvailable`. Every
ghost trace that the read moved is then discarded.

A trace holds three numbers for each 50 ms sample, up to 4,000 samples, and up to 128 KB encoded
(`src/server/pb-ghost-trace.ts:8-9`). A 40-second race gives about 12 KB.

The page holds ten rows by default. The nearby window holds five
(`DAILY_GP_NEARBY_RADIUS`, `src/server/daily-gp-model.ts:24`). The page answer is cached for ten
seconds, but the nearby window is not cached (`src/server/competition-leaderboard.ts:451-459`), and
it runs for every player whose rank sits outside the page — that is most players. Each of those
requests moves, decompresses, and parses about five ghost traces to set five booleans.

Change: write a small readiness marker when the personal best is written, and read the marker with
the entries that the page already reads. The page then needs no personal-best read at all.

Risk: low. A marker can go stale. The opponent-race endpoint re-reads the real record and already
answers `409 ghost_unavailable` when the record is incomplete
(`src/server/competition-opponent-race.ts:169-172`), so a stale marker costs one refused start, not
a wrong race.

## 2. The nearby window has no cache

Same path as item 1. The page uses `cacheSharedJson` with a key built from the standings revision
(`src/server/competition-leaderboard.ts:371-390`). The nearby window builds no key and reads Redis
every time.

Change: give the window the same revision-keyed cache, with the rank band in the key, not the
player id. Five ranks share one band, so the cache serves many players from one read.

Risk: low. The revision already changes when the board changes, so a stale window cannot outlive a
new time by more than the chosen TTL.

## 3. Eight expiry refreshes for each recorded event

`applyRetention` (`src/server/analytics-store.ts:346-357`) sends eight `EXPIRE` calls for every
start, finish, challenge creation, and podium action. This is item B1 of the companion review. The
API adds one fact to it: no command writes a hash field and its expiry together, so the only saving
is to stamp each bucket once instead of once for each event.

## 4. Two commands where one command does the work

- `writeDailyGpPostRecord` (`src/server/daily-gp-post-store.ts:74-80`) calls `set` and then
  `expire`. Its own sibling, `writeDailyGpPostRecordIfAbsent` (`:82-89`), already passes
  `expiration` to `set`. One command is enough for a string key.
- `clearGuestTransferGarageEvidence` (`src/server/car-unlock-store.ts:352-366`) deletes two keys
  with two calls. `del` takes both keys. Combining them changes which key a failure names, so keep
  the log message honest if you combine.

Both are write paths that run rarely. They are free to fix and safe.

## 5. `hGetAll` where a count or a field list is enough

`readGuestTransferGarageJournalFields` (`src/server/car-unlock-store.ts:385-390`) and the two
progress checks (`:647`, `:682`) call `hGetAll` and then use only `Object.keys(...)` or the length.
`hKeys` returns the names alone, and `hLen` returns the count and moves no payload.

These run on the guest transfer paths, not on every request, so the saving is small. The rule behind
it is the one that makes item 1 large: there is no `hExists`, so any probe of a hash field pulls the
whole value.

## 6. The moderator summary pulls one field for each player, for each day

`loadAnalyticsDay` (`src/server/analytics-store.ts:496-506`) reads three whole hashes for each day
in the window, and the cohort table needs the player map, so `hGetAll` is correct here. The cost
grows with the player count: one field for each player for each day, over 30 days, in one request.
Record this as a watch item. It is a moderator page, and no change is due now.

---

## Verified as already correct — do not redo

- Leaderboard entries, profiles, and personal bests use `hMGet` and `mGet` batches.
- The profile map uses one `mGet` (`src/server/competition-identity.ts:585-602`).
- Every large value that Redis holds is a personal-best record, and those hashes use the
  `redisCompressed` client. Podium snapshots, share previews, and post records hold names, times, and
  ids only, so compression would add nothing.
- Head to Head challenge data rides in the post, which the server reads from the request context
  instead of Redis (`src/server/post-bound-challenge.ts:57-68`).
- Snoovatar lookups already go through the platform cache
  (`src/server/daily-podium-service.ts:157-161`).
- The one uncached Reddit post lookup sits behind the challenge-creation lock
  (`src/server/head-to-head-service.ts:551-566`), so it runs once for each created challenge.
- The client runs no polling loop against the server, so the realtime feature saves nothing today.

## Order

1. Item 1, then item 2. Same path, same test, largest effect.
2. Item 3, from the companion review.
3. Items 4 and 5 when the files are open for another reason.
