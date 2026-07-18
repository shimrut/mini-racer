# Bug investigation — 17 Jul 2026

Original read-only pass over Mini Racer (DailyGP) high-risk paths: daily posts, score submission locks, personal-best ghosts, post-bound challenges, and the local verification queue. Resolution notes below record the later implementation on `codex/parallelize-pb-ghost-submit`.

No code was changed in this investigation. Severity is about player/mod impact, not how often the bug fires.

---

## Summary

| Severity | Issue | Day-to-day likelihood |
| --- | --- | --- |
| Resolved | Switching tracks can clear / replace the wrong PB ghost | Guarded by keyed request generations and selection ownership |
| Resolved | Daily / podium post creation lock can expire and allow a duplicate Reddit post | 15m NX create-claim before Reddit; registry is first-writer-wins |
| Resolved | Improve after a new PB can still race the old ghost | Canonical submit response is used; unresolved starts ghostless |
| Medium | Submission lock can expire / release unsafely so two saves overlap | Low; mainly platform Redis slowdowns or two devices |
| Medium | Post-bound challenge write can overwrite the frozen daily challenge ledger | Low; needs mismatched post challenge data |
| Resolved | Malformed or expired local verification-queue entries can reschedule forever | Purged before retry scheduling |

Areas that looked solid in this pass: physics vs server replay validation, guest token recovery, and UTC day math (no clear logic bugs found).

---

## 1. Wrong PB ghost when switching tracks quickly

**Severity:** High

**What happens:** An older ghost request can finish after a newer track/challenge selection and clear or overwrite the newer ghost.

**Who notices:** Players who change daily tracks before the previous personal-best ghost request finishes.

**Where:**
- `game/daily-challenge/engine-methods.js` (`prepareTrackPersonalBestGhost`)
- `game/ghost/pb-ghost-service.js` (stale request returns `null`)
- `applyTrackPersonalBest(..., { prepareGhost: true })` clears the ghost when the record is `null`

**Fix direction:** After the await, only apply or clear ghost state if that challenge is still the active one.

**Resolution:** PB reads now have per-challenge generations, active selection has its own epoch, and submit-installed canonical records invalidate older GET generations. Late reads may update only their keyed cache; they cannot prepare, clear, or overwrite another selected track.

---

## 2. Duplicate daily or podium Reddit posts

**Severity:** High (impact if it happens); **low probability** for normal automatic posting alone

**What happens:** Post-creation locks lasted **30 seconds**. If creating the Reddit post + score-thread setup took longer than that, a second request could acquire the lock and submit another post for the same day/subreddit. Registry writes were plain overwrites, so Redis could keep only the second `postId`.

**Where:**
- `src/server/daily-gp-post-store.ts` / `src/server/daily-podium-post-store.ts`
- `src/server/daily-post-service.ts` / `src/server/daily-podium-service.ts`

**When it is unlikely:**
- Cron runs once per day (`00:05` UTC race posts, `00:01` UTC podium)
- One scheduler run processes each subreddit sequentially
- Existing post checks skip create when a record already exists
- A slow Reddit call alone does **not** duplicate; a **second concurrent creator** is required

**When it can happen:**
- Platform retries the scheduler while the first run is still posting
- A mod uses enable/create around the same time as cron
- Many subscribed subreddits + overlapping job runs under slow Reddit API

**Fix direction:** Ownership-safe lock with lease renewal, and/or persist an idempotency record before calling Reddit and reconcile afterward.

**Resolution:** Create-claims use NX with a **15-minute** TTL (crash recovery only; still released on success/failure). Post registry registration is first-writer-wins (`SET NX`); a later duplicate `postId` cannot overwrite the canonical record.

---

## 3. Old ghost after a new personal best (Improve)

**Severity:** Medium

**What happens:** After the server accepts a new PB, the client downloads the new ghost. If the player starts another run before that download is applied, the race can still use the previous ghost.

**What “right away” means:** Not milliseconds. Roughly **the ghost download time** (often ~0.2–2+ seconds on Reddit WebView). Improve is available immediately; there is also a **~1.1s** start-lights countdown, and the ghost is locked in at “GO.”

| Player behavior | Likely ghost |
| --- | --- |
| Mash Improve as soon as results appear | Often old ghost |
| Download finishes during start lights | New ghost |
| Wait until ranking shows accepted, then Improve | Usually new ghost (UI update waits on that download) |

**Where:**
- `game/scoreboard/engine-methods.js` (refresh after accepted PB)
- `game/daily-challenge/engine-methods.js` / `game/race/engine-methods.js` (`restartDailyChallenge` → `startSequence` → `beginRun`)
- `game/ghost/pb-ghost.js` (`beginRun` copies `preparedRecord`)

**Mitigations that do not make the player wait:**
1. **Preferred light fix:** Mark the old ghost stale when a new PB refresh starts; on Improve prefer the new ghost if ready by GO, else **no ghost** rather than the wrong one.
2. **Stronger later:** Build a temporary local ghost from the lap just driven, then replace with the server ghost when it arrives.

Do **not** block the Improve button on a spinner for this.

**Resolution:** Verification now starts from the finish event. The accepted response includes the canonical PB record and ghost generated by that same server replay validation, so the client installs it without a second GET. Improve and the 1.1-second countdown remain unchanged. If that record is not valid and ready by GO, the old ghost is never reused: gameplay starts ghostless and shows a two-second non-blocking `GHOST UNAVAILABLE` notice. A late response prepares only the next attempt.

## Resolved follow-up: valid daily lap coupled to PB storage

**Original failure:** A Redis or lock failure while saving the lifetime ghost could turn an otherwise valid daily result into an error.

**Resolution:** After one replay validation, the daily leaderboard write and lifetime PB write run concurrently. Daily persistence alone determines acceptance. PB-only failure returns `200 accepted: true` with `trackPbPersistenceStatus: "unavailable"`; a daily transaction interruption remains retryable `503`. The PB operation chooses among the existing lifetime record, the retained verified daily entry captured before persistence, and the current verified run under one PB lock.

---

## 4. Overlapping score submissions for the same player

**Severity:** Medium; **low day-to-day likelihood**

**What happens:** Per player/day submission locks last **5 seconds**. Unlock is non-atomic (get then delete), so a late unlock can delete a newer owner’s lock. Under slow Redis/server work, two saves can overlap on the leaderboard.

**What “heavy delay” means:** Saving that score takes **longer than 5 seconds** while holding the lock. Normal saves are usually well under a second.

**When it can happen:**
- Unusual Redis / Devvit platform slowdown
- Same Reddit account on two devices/tabs submitting at once while the first save is slow

**When it usually does not:**
- Normal single-device play
- The default client retry after failure (~30s)

**Where:**
- `src/server/daily-gp-store.ts` (`DAILY_GP_SUBMISSION_LOCK_TTL_MS = 5_000`, `acquireSubmissionLock` / `releaseSubmissionLock`)
- Same get-then-delete pattern in `src/server/pb-ghost-store.ts` and several other lock helpers

**Recommended mitigation (no player wait):**
1. Atomic compare-and-delete on unlock (only delete if still this request’s lock value)
2. Refresh / extend the lock while the save is still running (or use a longer TTL)
3. Harden leaderboard writes so concurrent saves cannot let a slower time overwrite a faster one (“best time wins”)
4. Optional: on “already in progress,” client retry after ~2–5s instead of ~1s

---

## 5. Post-bound challenge can overwrite the daily ledger

**Severity:** Medium

**What happens:** Normal daily challenge creation uses first-writer-wins (`hSetNX`). Post-bound resolution persists with `hSet`, so challenge data embedded in a Reddit post can overwrite the stored track/timing for that day.

**Who notices:** Anyone hitting a day where post data disagrees with the already-created ledger entry (stale, edited, or mismatched post payload).

**Where:**
- `src/server/daily-gp-store.ts` (`writeStoredDailyGpChallenge` / `persistServerDailyGpChallenge`)
- `src/server/post-bound-challenge.ts` (`getPostBoundDailyGpChallenge`)

**Fix direction:** Make post-bound persistence first-writer-wins; reject or ignore post data that does not exactly match an existing ledger entry.

---

## 6. Broken local verification-queue entries can loop

**Severity:** Low

**What happens:** A pending queue entry missing a challenge id or a finite best time is skipped during processing but never removed or marked failed. If it is still “due,” the timer can reschedule at zero delay and burn CPU.

**Who notices:** Rare users with corrupted or legacy `localStorage` verification-queue data.

**Where:**
- `game/scoreboard/engine-methods.js` (`processDailyChallengeVerificationEntry` early return)
- `game/scoreboard/verification-queue.js` (`getDueDailyChallengeVerifications`)

**Fix direction:** Mark invalid persisted entries as terminal errors or remove them before rescheduling.

**Resolution:** Queue entries now carry the challenge competition deadline. Reads purge expired entries and legacy entries whose challenge date cannot be derived, and processing rechecks expiry before retrying.

---

## Suggested fix order

1. Ghost stale-request guard (issue 1) and Improve stale-ghost handling (issue 3) — player-visible, no wait UX
2. Submission lock release + lease / best-time-wins (issue 4) — correctness under load
3. Post-bound ledger first-writer-wins (issue 5)
4. Post-creation lock / idempotency (issue 2) — rare but high blast radius
5. Verification-queue invalid entry cleanup (issue 6)

---

## Notes

- Investigation date: 2026-07-17
- Branch reviewed: `main` @ `84b90b0`
- Focused server tests related to store/validator paths were reported green during the pass; timing and lock edge cases are lightly covered.
- Related map of ownership and contracts: `docs/system-change-map.md`
