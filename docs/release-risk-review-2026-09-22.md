# Release risk review — 2026-09-22

Scope: the unreleased batch on `analytics-fewer-redis-reads` (b383d3f back to about
2026-09-18), read against 30K MAU, 10K DAU, and about 70K player rows in Redis.

Method: static read of the code, plus `npm run typecheck` and `npm test`. Both pass
(236 test files, 3034 tests). No code was changed.

Live logs refused to start, because something already holds port 5678. The live post
flair templates were supplied: `Daily`, `Launcher`, `Challenge`, `Podium`.

---

## 1. WITHDRAWN — frame stalls do not shorten a lap

An earlier draft of this review claimed that a phone hitch removes time from the
recorded lap. **That was wrong.** The claim assumed a lap ends after a fixed amount of
real time. It does not. A lap ends when the car crosses the line, which takes a fixed
number of physics steps.

`state.currentTime += dt` sits in the same block that integrates velocity and position
(`game/race/simulation.js:580`), and `update()` is only ever called with `FIXED_DT`.
The clock and the car therefore advance together, step for step, and cannot separate.
Nothing in the lap timing reads the wall clock.

Measured, for a lap that is 7.00 s of driving:

| frame | recorded | wall clock | input samples | rank |
|---|---|---|---|---|
| 16.7 ms (60 fps) | 7.00 s | 7.0 s | 420 | ranks |
| 50 ms (20 fps) | 7.00 s | 7.0 s | 140 | ranks |
| 100 ms (10 fps) | 7.00 s | 7.0 s | 70 | ranks |
| 150 ms | 7.00 s | 10.5 s | 70 | ranks |
| 250 ms | 7.00 s | 17.5 s | 70 | ranks |
| 400 ms | 7.00 s | 28.0 s | 70 | blocked |

What frame drops actually do:

- **Under 100 ms frames:** nothing changes. The player sees a stutter.
- **100 ms to 250 ms frames:** the game enters slow motion, because it advances at most
  100 ms of simulation per frame. The recorded time stays honest. The player loses
  control fidelity — input is sampled once per frame and held across every catch-up
  step, so a lap gets 70 steering samples instead of 420. Slow devices are penalised,
  not rewarded.
- **Over 250 ms:** the car and the clock both stop, so the time stays honest, but the
  rank is refused. The flag is sticky for the whole run, so one bad frame kills the lap.

**The batch's change here is an improvement.** Production also blocks whenever the
accumulator overflows its 3-step limit, which trips from about 67 ms frames upward, so
production refuses honest laps from mid-range phones. Removing that gate is correct.

No change is needed in the race loop.

---

## 2. The podium post asks for a flair template that does not exist

**Confirmed against the live flair list:** `Daily`, `Launcher`, `Challenge`, `Podium`.

**Where:** `src/server/post-flair-service.ts:11`, `src/server/daily-podium-service.ts:516`

The app asks for these names (`POST_FLAIR_TEXT_BY_TYPE`):

| post type | app asks for | live template | result |
|---|---|---|---|
| `daily-race` | `Daily` | `Daily` | matches |
| `head-to-head` | `Challenge` | `Challenge` | matches after this batch |
| `daily-podium` | `Podiums` | `Podium` | **no match** |

`normalizeFlairText` only trims and lowercases. It does not fold the plural, so
`podiums` never equals `podium`. `resolveMiniRacerPostFlairId` then throws
(`post-flair-service.ts:28`), and it throws **before** `submitCustomPost`
(`daily-podium-service.ts:516`). No podium post is created.

**It fails silently.** The daily scheduler catches the error per subreddit, logs it, and
still answers `ok: true` with `createdCount: 0`
(`src/server/routes/internal-routes.ts:381`). Nothing raises an alarm. The moderator
menu action at `:250` is the only path that would show the error as a toast.

**This is not new.** `Podiums` has been in the map since 42bc88c, dated 2026-09-08, so
podium posts have been failing since then. This batch does not fix it. Since you are
promoting anyway, this is a one-word change worth taking with it.

**The Head to Head rename is correct, and it matters.** Production looks for
`Challenges`, which is not in your list. So challenge creation returns a 500 to every
player right now, and 0bcb80f fixes that. It is the strongest reason to promote.

`Launcher` exists on the community but this batch stopped putting a flair on launcher
posts, so that template is simply unused now. Nothing breaks.

**The shape is still worth changing.** The flair is cosmetic. Commit 233663a already
moved the flair write to after the post exists and wrapped it in `try/catch`
(`daily-post-service.ts:77`, `daily-podium-service.ts:556`). Only the lookup that feeds
it still aborts the job. The same pattern sits in front of the Daily post
(`daily-post-service.ts:51`) and in front of player-created challenges
(`head-to-head-service.ts:835`). Any future rename of `Daily` or `Challenge` takes down
the Daily post or challenge creation for everyone.

---

## 3. The new nearby-standings cache almost never hits, and costs more than it saves

**Who it hits:** every player outside the top ten. On a 10K-row daily board that is
almost everyone.

**Where:** `src/server/competition-leaderboard.ts:499`, `:418`;
`src/server/competition.ts:34`

Commit 99bc2c5 put the five-name strip behind the shared cache. The cache key holds
both of these:

- `offset`, which is `playerRank - 3`. It is unique to the player's rank.
- `revision`, which increments on **every** leaderboard write
  (`competition-leaderboard.ts:288`), and a second time when the submit path marks the
  opponent-race flag (`:266`).

Two players share a key only when they sit in the same five-rank window **and** nobody
submits a time in between. On a board with 10K players and constant submissions, that
combination is rare. The strip therefore misses almost every time.

Each miss now costs more than the old direct read did:

- one extra `GET` on the revision key,
- one extra `GET` on the cache value,
- one `SET` for the cache lock,
- one `SET` for the cache value,
- the same source work as before.

It also creates two short-lived Redis keys per open, and it reads the revision key
twice per snapshot, once for the top page and once for the strip.

There is one more effect. Devvit's cache keeps every key it has seen in a module-level
object that nothing sweeps (`node_modules/@devvit/cache/cache.js:11`, and
`#updateCache` in `PromiseCache.js`). A key that never repeats stays in memory for the
life of the process. Because these keys never repeat, the process accumulates dead
standings pages.

The top-ten page has had this key shape since 2026-08-08, so that part is already live.
The strip is new, and the strip is the path nearly all players take.

---

## 4. The Head to Head feed card lost its server fallback

**Who it hits:** everyone scrolling the community.

**Where:** `game/head-to-head/poster-access.js:23`, `head-to-head.js`,
`head-to-head-accept.js`

Commit 3484f29 removed every server call from the card. There is no `fetch` left in
`head-to-head.js` or `preview.js`. The card now paints from `devvit.context.postData`
alone.

`playable` is simply `Boolean(postData.challengeId)`. When `postData` does not arrive,
the button reads **Challenge Unavailable**, stays disabled, and has no way to recover.
Before this batch the card asked the server, which could resolve the challenge from
Redis by post ID.

Author recognition has a smaller gap. The card prefers `challengerUserId`, which only
posts created by this new version carry. Older posts fall back to
`devvit.context.postAuthorId`. That field is filled on the signed-context path but is
`undefined` on the fallback path (`node_modules/@devvit/web-view-scripts/devvit-global.js`,
line 77 against line 97). On that path the author of an older post sees **Accept
Challenge** on their own post.

---

## 5. The moderator analytics page still reads every player of every retained day

**Who it hits:** moderators directly. It can also starve the request workers that
players share.

**Where:** `src/server/analytics-store.ts:855`, `:758`

Commit 1950348 removed the per-day counter reads. It did not remove these:

- `buildSummaryFromHash` runs `hGetAll` on every retained day's player hash. Each hash
  holds one field per player per day. At 10K DAU across about 30 days that is roughly
  300K fields in one request.
- It also reads `cohortStarts`, which holds one field per player ever seen.
- `migrateSummary` does all of that plus the month hashes, once, under a three-minute
  lock, the first time a moderator opens the page after the update.

---

## 6. The Head to Head catalog grows without a limit

**Where:** `src/server/head-to-head-catalog.ts`

This subsystem is new in this batch. The first commit is b07e0b5, dated 2026-09-21.

Nothing sets an expiry and nothing prunes. Every challenge post adds one field to the
cards hash, one member to the `all` sorted set, and one member to a band sorted set.
Only the by-track index gets a `zRem` (`:281`). The sweep gathers a month of posts, but
no path removes anything older than a month.

The read path is bounded at 1000 cards per band, and "Change Track" may check the
neighbouring bands, so one tap can pull up to 3000 card bodies.

The write path is wrapped in `try/catch`
(`upsertHeadToHeadCatalogCardBestEffort`), so it cannot break challenge creation.

---

## Checked, and fine

These were the obvious suspects. They hold up, so they should not need another look.

- **The three new tracks do not shift the schedule.** They append to
  `TRACK_SCHEDULE_KEYS`, and the daily pick walks forward from the track stored for
  yesterday (`src/server/daily-gp-store.ts:843`). Existing days keep their track.
- **Every `zRange` by score now sends the low bound first.** b383d3f fixed the
  inverted one in `competition-opponent-race.ts`. No other site has the old order.
- **PB ghost compression survives the 0.14.5 upgrade.** `pb-ghost-store.ts` reads
  through `redisCompressed`, and the 0.14.5 proxy still decodes `hMGet` with the same
  `__gz:b64__:` envelope.
- **The new per-request caches do not leak between players.** The challenge, profile,
  and guest flag all pass through function parameters. Nothing sits at module level.
- **`opponentRaceReady` heals on its own.** The submit path writes the mark
  (`competition-submit.ts:389`), and rows without it fall back to a ghost read. The
  daily board resets each day, so the fallback lasts at most one day.
- **The wrong-author comment removal is narrow.** It only removes the comment the app
  has just created, and only when Reddit names a different author
  (`user-comment-submit.ts`).

---

## Verdict

**Promote it.** Nothing in the batch breaks the game for a large share of players, and
it repairs something that is broken in production right now: the Head to Head flair
lookup asks for `Challenges`, which is not a template on the community, so challenge
creation returns a 500 to every player who tries. Commit 0bcb80f fixes that.

Take one thing with it, or straight after:

1. Rename the community's `Podium` flair to `Podiums`, or change the constant in
   `post-flair-service.ts:11`. Either closes finding 2. Until then podium posts keep
   failing silently, as they have since 2026-09-08.

Then watch, after promoting:

2. Head to Head cards in the feed. If existing posts start reading **Challenge
   Unavailable**, that is finding 4 — the card no longer has a server fallback when
   post data does not arrive.

Findings 3, 5, and 6 are follow-up work. They cost Redis calls, moderator page time,
and slow row growth. None of them stops the game.
