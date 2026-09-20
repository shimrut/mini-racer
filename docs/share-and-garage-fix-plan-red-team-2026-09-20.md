# Red team: the five-item plan — 2026-09-20

Branch `remove-unneeded-deletes`. The plan proposes five changes: the Daily share receipt, the
settle for Campaign-only players, the owed list in a transfer, the late rank repaint, and the
preview claim. Nothing here changes code. Every claim below names the file and the line it comes
from.

Verdict: items 2, 3 and 4 fix real faults. Item 1 fixes a real fault and adds a state that nothing
can resolve. Item 5 is mostly covered by item 1, and one half of it cannot be built as written.
Two of the five sit next to a sibling path that has the same fault and gets no fix.

---

## Cross-cutting

### C1. Items 1 and 5 guard the same event twice

Item 1 writes the result's record before the post. Item 5 writes a spent marker for the preview
before the post. Both answer "has this comment already gone up?".

They cannot disagree. `createSharedResultKey` (`src/server/daily-gp-share.ts:87`) is built from the
subreddit, the challenge, the username and the time. Two previews of the same result therefore
share one record key. The record already stops the second post, whichever preview asks for it.

Drop the marker. Keep item 5's post-lock preview read, which is a different point (C5 below).

### C2. The receipt is Daily-only, and the comment helper is not

`submitUserComment` (`src/server/user-comment-submit.ts:67`) serves three callers: the Daily share
(`src/server/daily-gp-share.ts:595`), the challenge comment and the challenge brag (both through
`submitHeadToHeadShareComment`, `src/server/head-to-head-share.ts:138`).

Only the Daily caller keeps a record of what it posted. The challenge comment keeps none: its
preview key is a fresh `randomUUID` (`src/server/head-to-head-comment.ts:94`), and nothing reads
back what was posted. So N previews post N comments today, and item 1 does not change that.

Item 4 makes this concrete rather than theoretical. See F4.2.

Put the receipt in the shared helper, keyed by the caller's own result key. One receipt, three
flows, one test set.

### C3. The plan adds a third idiom for "did this already happen"

The repo holds two already:

- Search Reddit. `recoverPost` finds a challenge post Reddit made when the record write failed
  (`src/server/head-to-head-service.ts:763`). `submitUserComment` scans the thread for the comment
  it could not confirm (`src/server/user-comment-submit.ts:91`).
- Store a record. `SharedResultRecord` (`src/server/daily-gp-share.ts:55`).

Item 1 adds a third: a half-written record. Its pending state has no resolver, because
`readActiveSharedResult` proves a record with `reddit.getCommentById` and there is no comment id to
give it (`src/server/daily-gp-share.ts:435`).

Use the scan that already exists to resolve it. The pending record then says "look again", and the
existing code says what it finds.

### C4. A fourth inline `SET NX`

`acquireRedisLock` (`src/server/redis-lock.ts:102`) and `writeDailyGpPostRecordIfAbsent`
(`src/server/daily-gp-post-store.ts:82`) each write their own `set(..., { nx: true })` and read the
answer with `Boolean(result)`. Items 1 and 5 add two more. Add one `setIfAbsent` helper next to
`acquireRedisLock` and use it in all four places.

### C5. The stated costs are wrong in three places

- "One extra Redis command per post" holds only when item 5's marker goes. With item 5 as written
  the confirm adds two writes, one read and two rollback paths.
- "One extra read per start-up" is right, but the plan's sibling change (B6 in
  `docs/submit-failure-fix-plan-2026-09-19.md`) exists to take a new player's start-up down to no
  transaction at all. Item 2 as written puts a read back on that same player. See F2.3.
- "Two extra writes during a transfer's preparation" is two extra *reads* in the ordinary case,
  because both owed lists are almost always empty. When a list is not empty, each grant takes a
  promotion lock and a lock-release transaction — the exact command class the whole effort is
  shedding.

---

## Item 1 — the Daily receipt

The fault is real. `recordSharedResult` runs after the post and swallows its own failure
(`src/server/daily-gp-share.ts:638`), so a lost record lets a later Share post a second comment.

### F1.1 A pending receipt has no way back (high)

`recordSharedResult` writes with `DAILY_GP_REDIS_TTL_SECONDS`, which is 365 days
(`src/server/daily-gp-model.ts:26`). A receipt created before the post and never completed
therefore answers "already shared" for a year, and it names the post rather than a comment. If
Reddit never made that comment, the player cannot share that time again for a year, and the panel
tells them it is already in the score thread.

Fix inside the plan's own shape: create the receipt with a short expiration, about the preview's
ten minutes. Extend it to the full term only when the outcome says the comment may be live, which
is the `null` answer from `submitUserComment`. Complete it with the full term when the comment is
confirmed. The normal path costs nothing more, and every failure path cleans itself.

### F1.2 A refusal now needs a compensating delete under load (high)

The plan removes the record on a conclusive refusal. A refusal reaches
`confirmDailyGpShare` as a throw (`src/server/user-comment-submit.ts:87`), and the route turns a
throw into 500 `share_failed` (`src/server/routes/share-routes.ts:50`). So the delete has to run in
a catch, and it is best effort like every other cleanup here.

Both live refusals are real: "this user account is not valid" and "failed to mint auth token"
(`src/server/user-comment-submit.ts:26`). A refusal is not rare, and the delete runs against the
same Redis that this whole plan exists because it failed. The short expiration in F1.1 makes the
delete an optimisation instead of a correctness step.

Also note what "conclusive refusal" covers. `submitUserComment` deletes the preview key before it
posts (`src/server/user-comment-submit.ts:81`). A throw from that delete is not a refusal and is
not caught, yet nothing was posted. Classify the throw, do not assume it.

### F1.3 The parse and the liveness check both change (medium)

`parseShareSharedResult` rejects any record without a `t1_` id
(`src/server/daily-gp-share.ts:160`). `readActiveSharedResult` deletes a record whose comment
Reddit reports as removed (`src/server/daily-gp-share.ts:440`). A pending record fails the first
and cannot be judged by the second.

That second point is a behaviour loss worth naming: today a player who deletes their comment may
share again. Under a stuck pending record they cannot.

### F1.4 The panel copy may become false (low)

`_showShareOutcome` prints "Your result is already in the score thread."
(`game/race/ui-modal-shell.js:816`). For a pending receipt that sentence may be wrong. Give the
pending case its own short line.

### F1.5 A preview may answer from a confirm that is still running (low)

`previewDailyGpShare` calls `readActiveSharedResult` (`src/server/daily-gp-share.ts:525`) with no
lock. It can read a receipt whose confirm is still in flight and later refused. The window is short
and the preview is restored, but the player can see two different answers a second apart.

---

## Item 2 — Campaign-only players

### F2.1 The fault is real (confirmed)

`hasAnyData: true` is written in exactly one place, the Daily submit
(`src/server/daily-gp-store.ts:3712`). The settle sits behind that flag
(`src/server/daily-gp-store.ts:3389`). A player who only races Campaign or Head to Head never
settles an owed win, so a failed reward write is never repaired.

### F2.2 The same gate hides the completed-race repair (medium)

`profile.hasAnyData` also gates `hasRecordedCompletedRace` and `recordCompletedRace`
(`src/server/daily-gp-store.ts:3389`), and it is passed as the snapshot's evidence flag
(`src/server/daily-gp-store.ts:3403`). A Campaign-only player whose `race:completed` write failed
gets no repair either, and their snapshot has no evidence to stand in for it.

Item 2 fixes one half of the blind spot. Either fix both, or say in the plan why the repair stays
behind the flag.

### F2.3 The gate the plan describes is not the gate it states (medium)

The plan says the settle "runs for every returning player", but the rule it gives is "loses the
has-data condition". Those differ: with no gate the read also runs for every first-time player,
and B6 in the other plan exists to make that player's start-up cheap.

There is no free gate. `hasSeenGame` is true for everyone (`src/server/competition-identity.ts:392`).
`isReturningPlayer` needs the profile to be a day old (`src/server/daily-gp-store.ts:627`), which
would delay the repair by up to a day. So either accept one `hGetAll` on every start-up and say so,
or hold the owed fields in the Garage hash that start-up already reads. The second option removes
this read and most of item 3, but it makes `unlocksChanged` treat an owed field as tampering
(`src/server/daily-gp-store.ts:444`), so it is a larger change than it looks. Accepting the read is
the reasonable call; state it as a read for every player, not for returning players.

### F2.4 "No lock and no transaction" is conditional (medium)

True when the owed list is empty. When it is not, `settleOwedHeadToHeadWins` calls
`recordHeadToHeadWin` per field (`src/server/car-unlock-store.ts:455`), each of which takes the
promotion lock and releases it with a WATCH transaction
(`src/server/car-unlock-store.ts:181`, `src/server/redis-lock.ts:232`). Rare, but the claim as
written is unconditional.

---

## Item 3 — the owed list and the transfer

The fault is real. `mergeGuestCarUnlockProgress` copies and replaces the Garage hash only
(`src/server/car-unlock-store.ts:569`). The account's owed list survives a Guest choice, and the
next start-up grants that credit into the Garage the player asked to replace.

### F3.1 The grant must come before the source inventory, not before the baseline (medium)

The plan orders the grant "before the account's Garage is frozen". The Garage freeze is
`captureGuestTransferGarageBaseline` (`src/server/daily-gp-store.ts:2697`). The guest's Garage is
fingerprinted earlier, at `captureGuestTransferSourceInventory`
(`src/server/daily-gp-store.ts:2643`), and the copy verifies itself against that fingerprint
(`verifySourceDomain('unlocks')`, `src/server/daily-gp-store.ts:2728`).

A grant placed between the two changes the guest hash after the fingerprint. It survives today only
because `unlocksChanged` tolerates an *added* valid Garage field
(`src/server/daily-gp-store.ts:442`). It does not survive the other arm of that check: an inventory
that carries only the aggregate hash compares exactly and stops the transfer with
`recovery_required`, which needs a person.

So the ordering constraint is tighter than the plan states. Grant before the inventory capture, so
the inventory and the copy describe the same Garage.

### F3.2 Grant only while the phase is `preparing` (medium)

A resumed transfer re-enters this function in `copying` or `cleaning`
(`src/server/daily-gp-store.ts:2626`). Its recorded inventory is then the only evidence used, and
the guest hash must not move. Put the grant inside the same `preparing` condition that guards the
baseline, and before the inventory capture.

### F3.3 "After that the transfer sees only the Garage it already knows" is not true (medium)

`rememberOwedHeadToHeadWin` writes the owed list without the promotion lock, on purpose
(`src/server/car-unlock-store.ts:424`). A reward write that fails after preparation therefore puts
a field back on the list while the transfer is open.

The outcome is benign: a reward earned while a transfer is open is meant to survive, which is what
the journal does for the Garage. But the plan should not rest on a claim of completeness it does
not have.

### F3.4 A grant on a retry is journaled, and then preserved (low)

`writeCarUnlockEvent` journals every accepted event against an open baseline
(`src/server/car-unlock-store.ts:192`). A retry that re-enters preparation grants an owed win after
this transfer's baseline exists, so the journal preserves it through a Guest choice. The player
keeps one credit they asked to give up. Harmless, and worth one comment in the code.

### F3.5 Preparation needs a failure signal, so change the return (low)

`settleOwedHeadToHeadWins` never throws, by design, and start-up depends on that
(`src/server/car-unlock-store.ts:446`). Return a boolean and let start-up ignore it. Do not fork the
function into a throwing twin.

### F3.6 Delete field by field, not the key (low)

`settleOwedHeadToHeadWins` already deletes each field after its grant
(`src/server/car-unlock-store.ts:456`). Keep that. A `del` of the whole key can drop a field an
unlocked writer added between the read and the delete.

### F3.7 The empty-guest check does not read the owed list (low)

`guestHoldsTransferableProgress` looks at campaign progress, the Garage hash, the profile flag and
the competition rows (`src/server/daily-gp-store.ts:1811`). A guest whose only asset is an owed win
is refused as "nothing to carry", and preparation never runs. Narrow, because a challenge win
implies a finished race, which normally leaves `race:completed` behind.

---

## Item 4 — the late rank repaint

### F4.1 The fault is real (confirmed)

`updateChallengeFinishHero` recomputes the button from the phase and the share request on every
call, and rebinds the click (`game/race/ui-modal-shell.js:1443`). A late `bestUpdate` from
`claimSettledBest` reaches it through `paintBestUpdate`
(`game/head-to-head/engine-methods.js:471`). That submit runs in parallel with the finish, so under
the load this plan is about, it lands after the player has used the share panel.

### F4.2 The record must cover the posted comment, not only the unconfirmed one (high)

A successful comment disables the button imperatively and relabels it "Commented"
(`game/race/ui-modal-shell.js:826`). The repaint in F4.1 sets `disabled = !shareEnabled` and the
label back to "Comment" (`game/race/ui-modal-shell.js:1451`). So the button comes back after a
comment that really posted, not only after an unconfirmed one.

The challenge comment has no server-side receipt (C2), so this is a real second comment, not a
cosmetic slip. Record "this finish has spent its comment", with the reason beside it, and compute
the button from that. One record, three reasons: posted, already posted, unconfirmed.

### F4.3 The Daily half rests on a wrong premise (medium)

The plan says the Daily Share button "is repainted the same way". It is not.
`updateModalScoreboardSnapshot` repaints the rank value and the leaderboard list and never touches
`combinedPlaylistBtn` (`game/race/ui-modal-shell.js:2046`). A late Daily rank answer reaches only
that function (`game/scoreboard/engine-methods.js:391`). The Daily button is also left available on
purpose after a share (`keepShareAvailable`, `game/race/ui-modal-shell.js:971`), because the server
answers `already_shared`.

Drop the Daily half, or give it a reason that holds.

---

## Item 5 — the real claim

### F5.1 The preview cannot be read after the lock as described (blocking as written)

The Daily lock key is derived from the preview's own contents:
`createShareLockKey(preview)` builds on `createSharedResultKey(preview)`
(`src/server/daily-gp-share.ts:101`). The confirm must read the preview to know which lock to take
(`src/server/daily-gp-share.ts:554`).

The Head to Head path can read after the lock because it locks on the token key instead:
`` `${tokenKey}:lock` `` (`src/server/head-to-head-share.ts:160`), with the comment this plan is
echoing.

So choose one, and say which:

- Keep the result lock, read the preview again inside it, and re-check ownership on the second
  copy. One extra `GET` per confirm. The lock still serializes two previews of one result.
- Move to a token lock, matching Head to Head, and let the receipt from item 1 cover two previews of
  one result.

The first is the smaller change and keeps the stronger lock.

### F5.2 The marker is redundant (high)

See C1. Once the receipt is written before the post, the marker cannot refuse a post that the
receipt would allow.

### F5.3 The `del` claim is right, the conclusion does not follow (medium)

`del(...keys): Promise<void>` in `@devvit/redis` — the client returns no count
(`node_modules/@devvit/redis/RedisClient.d.ts:68`), and `set` with `nx` returns a value that the
repo already reads as a boolean (`src/server/redis-lock.ts:102`). So the premise holds. But the
risk a returned count would remove is the second post, and the receipt removes it already.

### F5.4 Say where the spend changes (medium)

`submitUserComment` spends the preview for all three callers
(`src/server/user-comment-submit.ts:81`). Changing the spend inside it changes the brag and the
challenge comment too. Changing it only for Daily forks a shared helper into two spend modes. The
plan does not say which, and this is the one place in it where DRY is at stake.

### F5.5 Every refusal rolls back two records (low)

The preview restore (`src/server/user-comment-submit.ts:45`) and the new record delete are both best
effort. Two rollbacks, two ways to leave the player stuck. F1.1 removes the second one's teeth.

---

## The shape this suggests

1. One receipt, in `submitUserComment`, for the Daily share, the challenge comment and the brag.
   The caller passes its own result key and its own interim link.
2. The receipt starts short-lived. An unknown outcome extends it. A confirmed comment completes it
   with the full term. A refusal deletes it, and the short term is the safety net.
3. A pending receipt is resolved with the thread scan the helper already has, not with a new rule.
4. Item 5 reduces to one line: read the preview again inside the lock, and re-check ownership.
5. Item 2 states one extra read for every player, and says what happens to the completed-race
   repair.
6. Item 3 grants before the source inventory is captured, only while the phase is `preparing`, and
   reports failure through a return value.
7. Item 4 records "this finish has spent its comment" with the reason, and changes nothing on the
   Daily finish.

## Tests the plan does not name

- A receipt that never completes stops blocking the share, and the player can share again.
- A refusal whose receipt delete fails still lets the player share again.
- A challenge comment posts once when a late rank answer repaints the hero after a successful post.
- Preparation grants an owed credit before the source inventory is captured, and the copy still
  verifies.
- A transfer resumed in `copying` grants nothing.
- Start-up settles an owed win for a player who has never raced Daily.

---

# Round 2: the implementation plan

The plan answers every finding above. Two things it adds are new, and one of them can post a second
comment. The rest are gaps to close before the code is written, not changes of direction.

## What I checked and found clean

- **No deadlock in preparation.** The transfer holds the two selection locks only
  (`src/server/daily-gp-store.ts:2378`). The promotion lock is taken later, inside
  `captureGuestTransferGarageBaseline` and `mergeGuestCarUnlockProgress`. So the settle may take and
  release that lock during preparation.
- **A failed settle is retryable.** A `GuestProgressSelectionRetryableError` thrown before the first
  `saveRecord` is classified `retryable`, writes nothing durable, and the browser retries
  (`src/server/daily-gp-store.ts:2911`).
- **The source inventory is recaptured on every entry into preparing**
  (`src/server/daily-gp-store.ts:2640`), so a grant before the capture stays consistent across
  retries.
- **A `race:completed` entry on the owed list is real evidence.** It is written only after an
  accepted run failed its reward write, so the settle may grant it without the has-data flag.

## R1. The one-minute rule can post a second comment (high)

This is the one place where the design produces a duplicate instead of refusing one.

A pending receipt older than a minute is scanned for, not found, dropped, re-claimed and posted.
"Not found" has two causes: the first request never posted, or the first request has not posted
yet. The plan treats both as the first.

A post is not bounded by a minute. The share lock is 30 s with a 10 s renewal
(`src/server/daily-gp-share.ts:37`), and the lease renews without limit, so the existing code
already assumes a confirm can run past 30 s. Under the load this whole effort is about, a minute is
inside the range, not outside it.

For Daily the result lock hides the problem: a second request takes the same lock and answers
`share_in_progress` (`src/server/daily-gp-share.ts:564`). The brag and the challenge comment lock on
the *token* instead (`src/server/head-to-head-share.ts:160`), so two previews take two different
locks and nothing serializes them. The one-minute rule is the only guard exactly where it is
weakest.

**Fix, and it removes the rule:** lock on the result key in all three flows, the way Daily already
does. Then a pending receipt seen inside the lock can only be a dead one, and the scan resolves it
with no takeover and no timer. Delete "claimed less than a minute ago" from the design. One lock
rule, one receipt rule, one key.

If you keep the timer instead, make the takeover a compare-and-set on the pending value, so two
requests cannot both decide to re-claim, and size the window to the longest post you will tolerate,
not to a minute.

## R2. The game refuses the new status on two of the three flows (high)

The confirm accepts `['commented']` and nothing else for a challenge comment, and
`['shared', 'already_shared']` for a brag (`game/race/ui-modal-shell.js:1030`). An `already_posted`
answer therefore throws, and the player is told "Could not share this result." over a comment that
is live.

The preview branch has the same list in another shape: it handles only `already_shared` and
`already_created`, and anything else falls through to the error throw
(`game/race/ui-modal-shell.js:967`).

Both lists must learn the new status. Better: use one status name for all three flows and one list
in the client, since the whole point of this change is one receipt.

## R3. A preview written before the deploy has no result key (high)

The brag and comment preview is parsed on four fields and passes anything else through
(`src/server/head-to-head-share.ts:65`). A preview written by the old build returns `undefined` for
the new result key. An undefined key is one shared key across every player.

Previews live ten minutes, so the window is real on every deploy. Either derive the key in the
confirm from fields the preview already has, or refuse a preview that carries no key and let the
player take a new one. Do not let the claim run with a missing key.

## R4. The pending receipt must carry the post and the parent (medium)

The plan says pending holds the text, the player and the claim time. The scan also needs where to
look. A Daily share is a reply under the score-thread comment
(`src/server/daily-gp-share.ts:595`), and `getComments` without that parent reads the post's
top-level comments instead (`src/server/user-comment-submit.ts:91`). The scan would then never find
the comment, report "not found", and post a second one.

Store the post id and the parent id on the receipt. The confirm that claims it has both.

## R5. Twenty-five comments is enough seconds later, not minutes later (medium)

The existing scan reads the 25 newest and filters by creation time
(`src/server/user-comment-submit.ts:91`). Today it runs seconds after the failed submit, so 25 is
generous. The new scan runs when the next preview meets an older receipt, which may be minutes or a
day later. On a busy score thread the player's reply can sit past the 25th newest, and "not found"
again means a second comment.

Page until the comments are older than the claim time, or raise the limit for this use. Say which.

## R6. "Extend on unknown" must mean one specific answer (medium)

`submitUserComment` returns `null` only after `submitComment` threw and the thread was scanned
(`src/server/user-comment-submit.ts:107`). Every other throw leaves the function as an exception,
including a throw from the preview spend, which runs before the post
(`src/server/user-comment-submit.ts:81`), and a refusal that the two known messages do not match
(`src/server/user-comment-submit.ts:26`).

Extend the receipt on the `null` answer alone. On any other throw, leave the ten minutes to clear
it. If "unknown" is read as "anything that was not a known refusal", a failure that posted nothing
locks that result out for the full term.

## R7. Say what happens to the liveness check (medium)

Daily proves a complete record today by fetching the comment, and deletes the record when Reddit
reports it removed (`src/server/daily-gp-share.ts:435`). That is what lets a player who deletes
their comment share again. The plan does not say whether the shared receipt keeps it.

Two decisions, both needed:

- Keep the check for a complete receipt, or drop it. Keeping it costs one Reddit read per preview
  and keeps today's behaviour. Dropping it holds the result for the full term.
- Skip a removed comment in the scan. Otherwise a removed comment completes a receipt and the
  player can never post again.

## R8. "A resumed transfer grants nothing" contradicts the plan's own note (medium)

A retry that re-enters preparation carries phase `preparing`
(`src/server/daily-gp-store.ts:2626`), so a grant gated on `preparing` does run on that retry. The
plan's own comment says so: "a grant during a retry is journaled and survives a Guest choice by one
credit".

Write the rule as it is: a transfer resumed **past** preparing grants nothing.

## R9. The first-race evidence is already in hand (medium)

The plan keeps the has-data flag on the first-race backfill, because without evidence of a finished
race it would hand out the first-race car. The reasoning is right, and the evidence exists a few
lines below: `readPlayerCarUnlocks` reads the player's campaign results on every start-up
(`src/server/daily-gp-store.ts:3403`, `src/server/campaign-store.ts:409`). A non-empty results map
is a finished race.

Read the unlocks first and decide the backfill from them, and the Campaign-only blind spot closes
for no extra read. If you would rather not move it, say plainly that a Campaign-only player whose
field is missing waits for their next race, and that the owed list covers the common cause.

## R10. Put the remember in one place, and the caps in one table (low)

Today only the won challenge remembers, and it does it in the caller
(`src/server/car-unlock-store.ts:415`). Every reward write already passes through
`writeCarUnlockEvent` (`src/server/car-unlock-store.ts:181`). Put the remember there, and the three
recorders need no change at all.

"Grants each entry by its own rule" then needs a table from prefix to limit and writer, used by the
Garage write and the settle. `recordUniqueFieldUntil` already takes the prefix and the limit
(`src/server/car-unlock-store.ts:325`), so the table is the only new thing. Two copies of "posted
track up to five, won challenge up to ten" is the duplication this plan exists to avoid.

## R11. There are ten hand-rolled `SET NX` calls, not three (low)

`src/server/redis-lock.ts:103`, `src/server/daily-gp-post-store.ts:85`,
`src/server/competition-identity.ts:430`, `:518`, `:581`, `src/server/campaign-store.ts:353`,
`src/server/daily-gp-store.ts:2269`, `src/server/daily-podium-post-store.ts:84`, `:140`,
`src/server/player-token.ts:20`.

They read the answer four different ways, and one passes a spread expiration that can be empty
(`createPlayerProfileExpiration`). The helper should accept "no expiration" and return a boolean.
Converting all ten is a wider change than the plan implies; converting the ones that read a boolean
is the right scope. Say which you mean.

## R12. Reset the spent record where the finish's other state resets (low)

`_challengeFinishShareRequest` and `_challengeFinishPhase` are set per finish
(`game/race/ui-modal-shell.js:1193`). The spent record belongs beside them, or the next finish
inherits a spent comment.

The cancel path also sets the button directly (`game/race/ui-modal-shell.js:1000`), as does the
outcome panel (`game/race/ui-modal-shell.js:826`). If the record is the source of truth, every one
of those has to go through it, or the repaint and the panel will disagree again.

## R13. Delete the confirm's own receipt read (low)

Once the helper owns the receipt, the confirm's `readActiveSharedResult` call inside the lock
(`src/server/daily-gp-share.ts:575`) is a third read of the same thing. Remove it, keep the preview
one.

## Tests to add to your list

- Two requests, the second arriving while the first is still posting: one comment. This is R1, and
  it is the only new failure the design can produce.
- A preview written before the deploy: the confirm refuses it or derives its key, and never claims
  an undefined one.
- A Daily receipt's scan looks under the score-thread comment, not at the post's top level.
- A removed comment does not complete a receipt.
- A throw before the post leaves a ten-minute receipt, not a full-term one.
- The challenge comment's "already posted" answer reaches the outcome panel instead of the error
  path.
- A new finish clears the previous finish's spent record.

## Costs, corrected

- The brag and the challenge comment gain a receipt read at preview time. They have none today.
- If the liveness check stays, add one Reddit read per preview for a complete receipt.
- The scan is one Reddit read, and it may need more than one page (R5).
- Everything else in the plan's cost list matches what I read.

---

# Round 3: the status answer and the two narrowed rules

The two narrowed rules are right. The status answer needs one more split, because the game reads two
different lists.

## S1. The preview branch and the confirm branch accept different names (high)

The plan gives one rule: a repeat keeps the status each flow already ships. That works on the
confirm and breaks on the preview.

The confirm accepts `['commented']` for a challenge comment and `['shared', 'already_shared']` for a
brag (`game/race/ui-modal-shell.js:1030`). The preview accepts `already_shared` and
`already_created`, and throws on everything else that is not `ready`
(`game/race/ui-modal-shell.js:967`).

So a challenge comment that answers `commented` from the **preview** throws on a build already open
in a browser, and the player is told "Could not share this result." over a live comment. That is the
fault this rule exists to prevent, one step earlier.

Two ways out:

- The preview answers a repeat as `already_shared` for all three flows, and the confirm keeps each
  flow's shipped success status. The old preview branch accepts it and shows the outcome panel with
  the live comment.
- Simpler, and it needs no new rule: the preview answers a repeat only where it already does today,
  which is Daily and the challenge post. The challenge comment reports `ready` and lets the confirm
  settle it under the lock, exactly as it already does for a pending receipt. It costs one round
  trip in a case that needs the player to race to the same millisecond twice.

The second one removes the split instead of describing it.

## S2. Fold the repeat marker into the one that exists (medium)

`_showShareOutcome` already reads a repeat one way: `result?.status === 'already_created'`
(`game/race/ui-modal-shell.js:802`). A second field for the same idea leaves two mechanisms in one
function. Use the new field for the challenge post too, and delete that line.

Note also that Daily's panel changes wording. Today a repeat says "Shared" and "Your result is
already in the score thread." (`game/race/ui-modal-shell.js:816`). With the marker it says
"Already posted". That is more truthful, and it is a change that was not called out.

## S3. The paged scan must stop with the same slack the match uses (medium)

The match already allows a second, because Reddit reports whole seconds
(`src/server/user-comment-submit.ts:20`). The walk's stop condition needs the same allowance. A walk
that stops exactly at the claim time can pass the comment by one second, report absent, and post a
second one.

## S4. A lost lock must not roll back the claim (medium)

The ownership check now runs after the claim. When it fails, the request answers "in progress" and
must leave the receipt where it is: another request may hold the lock and be posting. The instinct
is to clean up what you claimed, and here that instinct posts a second comment.

## S5. The pending record's post URL may have no reader left (low)

With the preview no longer answering from a pending receipt, and the confirm always resolving one
under the lock, every answer that carries a link carries a comment link. The post URL was for the
interim answer that no longer exists.

It has one good use left: the unconfirmed answer tells the player to check the thread and gives them
nothing to open (`src/server/head-to-head-share.ts:212`). Put the link there, or drop the field.

---

# Round 4: dropping the thread from the receipt

Dropping the post URL, the post id and the parent id is sound. A confirm always has a preview, and
every thread is derivable from it: Daily resolves the day's post and its score-thread comment
(`src/server/daily-gp-share.ts:579`, `:590`), and both challenge flows carry the post id on the
preview (`src/server/head-to-head-share.ts:187`). Nothing else ever scans.

Three things follow from it, and one of them is not cleanup.

## T1. "The panel shows it" is new client work, not a copy change (high)

The game has never opened a Reddit link. The share panel builds a title, a quote and a button, and
renders no anchor (`game/race/ui-modal-shell.js:800`). `postUrl` reaches the client only as a flag
that tells a challenge-create outcome from a comment one, and `commentUrl` has no reader at all.
The one `navigateTo` in the repo belongs to moderator menu actions
(`src/server/routes/internal-routes.ts:114`), which is a different contract and not available to
the webview.

So making "check the post" openable means adding navigation to the webview and proving it in the
frame, on the website and in the app. That is its own piece of work with its own failure modes, not
a line of copy.

There is a better answer, and this plan already built it. After the receipt, the dead end is gone:
the player presses Share again, the confirm scans, finds the comment and answers "already posted"
with its link. The message does not need to send them anywhere. Say to try again, in the words the
finish screen already uses, and drop the link.

## T2. Resolve the thread lazily, or every repeat pays for it (medium)

The confirm reads the receipt before it resolves anything
(`src/server/daily-gp-share.ts:575`), and only then resolves the post
(`src/server/daily-gp-share.ts:579`) and the score thread
(`src/server/daily-gp-share.ts:590`). Keep that order. `ensureDailyGpScoreThread` takes a second
lock and can post an anchor comment as the app, and `resolveDailyGpPostRecord` can fall back to a
100-post listing.

Resolve the thread only when the receipt is pending and a scan is needed. A complete receipt should
still answer from Redis alone.

## T3. "Absent" now has three meanings (medium)

The scan looks in today's thread, not the one the claim used. Both can move: a deleted day post is
replaced through `recoverDailyGpPost` (`src/server/daily-gp-share.ts:263`), and a removed score
thread anchor is replaced by `ensureDailyGpScoreThread` (`src/server/daily-gp-share.ts:365`).

In both cases the earlier comment is unreachable and posting again is the right outcome. It is
still the one place where the design knowingly allows a second live comment, so write it in the
code where the scan decides, not only here.

## T4. Keep the claimed text, and match on it (medium)

The ids are derivable. The text is not. `formatDailyGpShareComment`
(`src/server/daily-gp-share.ts:112`) and `formatChallengeComment`
(`src/server/head-to-head-comment.ts:31`) decide what is in the thread, and a build that changes
either one makes a receipt claimed by the previous build unmatchable. The scan would report absent
and post a duplicate of a comment that is already live.

The scan must match the text the receipt recorded, never the text the current preview built.

---

# Round 5: double check of the settled design

I walked the whole path once more, failure by failure. Three things.

## U1. A live comment can end up guarded by a ten-minute receipt (high)

The terms are: a claim lasts ten minutes, an unknown outcome extends it to the full term, and a
confirmed comment completes it with the full term.

Take the case the design names as safe: the comment posts, and the completing write fails. The plan
says the pending receipt still blocks a second post and the next scan completes it. It blocks for
ten minutes. After that the receipt is gone, and the next Share finds nothing, claims, and posts a
second comment.

The trigger is a failed Redis write under load, which is the fault this whole effort exists for, and
the player only has to come back later than ten minutes.

The request knows which case it is in, because it is holding the comment. On a confirmed comment,
if the completing write fails, extend the receipt to the full term. One `EXPIRE`, and the guard
outlives the failure. Treat a failed completion the way an unknown outcome is treated, because for
the guard they are the same thing: a live comment with no link on the record.

## U2. "Press Share again" is two steps, and the second one asks for the post (medium)

A pending receipt makes the preview report `ready`
(`game/race/ui-modal-shell.js:1006` builds the confirm panel from it). So the player who is told to
press Share again gets "Post this comment as u/x?" with a Post button, and only after pressing it
are they told the comment is already up.

It works, and it cannot double post. Two things follow:

- A player who cancels at that panel, because it looks like it is asking them to post twice, is
  never told the comment is live. Their next attempt asks the same question again.
- The unconfirmed copy has to survive that middle step. "Press Share again" is true; the panel then
  says something that reads like the opposite.

If that matters, the preview may **read** a pending receipt older than the in-flight window and scan
without completing it, which breaks no rule here: the rule is that the preview may not *change* a
pending receipt. It costs one thread read on a rare path. Otherwise, accept the extra click and
write the copy so the middle step does not read as a contradiction.

## U3. "From Redis alone" needs the liveness check to move, not to be copied (low)

`readActiveSharedResult` fetches the comment from Reddit, and today both the preview and the confirm
call it (`src/server/daily-gp-share.ts:525`, `:575`). A complete receipt answered "from Redis alone"
means the confirm no longer makes that call, and the preview owns retirement on its own. That is the
intent, and a careful refactor keeps it in both places by accident.

The consequence is small and self-correcting: a comment removed between the preview and the confirm
gets an "already posted" answer with a dead link, and the next preview retires the receipt.

## Checked and sound

- **The brag's key is constructible at preview time.** `previewHeadToHeadBrag` holds
  `acceptRecord.challengeId` and `acceptRecord.bestTimeMs` before it writes the preview
  (`src/server/head-to-head-brag.ts:73`, `:104`), so the challenge, the player and the time are all
  in hand.
- **Every other failure path lands correctly**: a known refusal deletes and restores, an unknown
  outcome extends, a second request serializes on the result lock and reads a complete receipt, and
  a process that dies between the claim and the post leaves a receipt the ten minutes clear.

---

# Settled

Every finding above is answered. The agreed shape:

**The receipt.** One receipt, in the shared submit path, for the Daily share, the challenge comment
and the brag. The caller hands it the result key: Daily derives it from fields its preview already
holds, and the two challenge flows carry it on the preview and refuse a preview without one. A
receipt is pending or complete. Pending holds the text, the player and the claim time. Complete adds
the comment link. It carries no post id, parent id or post URL, because only a confirm scans and a
confirm always resolves its own thread.

**The order inside a post.** Claim with a conditional write, ten minutes. Spend the preview. Check
lock ownership. Post.

**Terms.** A confirmed comment completes the receipt with the full term. A confirmed comment whose
completion fails extends it to the full term, because the guard cannot tell that from an unknown
outcome. An unknown outcome extends it. A known refusal deletes it and restores the preview. Every
other throw leaves the ten minutes, which is the floor.

**One lock rule.** All three flows lock on the result key. The confirm reads its preview, takes the
lock, re-reads the preview inside it, and re-checks the owner. A pending receipt found inside that
lock is dead: scan, complete it if the comment is there, otherwise replace it and post. A lost lock
touches nothing.

**The scan.** Only a confirm scans. It walks the newest comments until it passes the claim time,
with the same second of slack the match uses, and with a cap. The cap means unknown, so the receipt
stays and the answer is unconfirmed. It matches the text the receipt recorded, never the text the
current preview built. Absent can also mean the thread the claim used is gone, and posting again is
right there.

**The preview.** It reports a repeat only where it already does, which is Daily and the challenge
post, and it reports ready for a pending receipt so the confirm settles it under the lock. It may
not change a pending receipt. It keeps the check that asks Reddit whether a complete receipt's
comment is still there, and retires it when the comment is gone.

**Statuses.** No new status names. A repeat keeps the status each flow already ships and carries a
field that marks it as a repeat. That field replaces the `already_created` check the panel uses
today, so there is one way to say it. A build already open in a browser ignores the field and shows
the live comment with its normal line.

**Owed rewards.** Every failed reward write records its own entry, without a lock, in one place. The
settle grants each entry by one table of prefix, limit and writer, deletes each entry after its
grant, never throws, and reports whether it emptied the list. Start-up runs it whenever no transfer
is open, for every player, at one plain read.

**The first-race repair.** The Garage read moves above it, and the repair runs when the snapshot
shows a finished race and the stored field is missing. A campaign result counts as a finished race
(`game/car/car-unlock-policy.js:115`), so the Campaign-only blind spot closes without another read.

**The transfer.** While the phase is preparing, and before the source inventory is captured, both
sides' lists are settled and emptied. A transfer resumed past preparing grants nothing. A failed
settle makes preparation retryable. Two comments go in the code: a grant during a retry is journaled
and survives a Guest choice by one credit, and a reward that fails later can add an entry while the
transfer is open, which is meant to survive.

**The finish screen.** Each finish records that its comment is spent, with the reason. The hero
repaint computes the button from that record, and it resets where the finish's other state resets.
Every other place that enables or disables that button goes through the same record. The Daily
finish is untouched.

**One helper.** A shared set-if-absent call, accepting no expiration and returning a boolean,
replaces the hand-rolled calls that read their answer as one.

---

# Round 6: the implementation plan

Against `docs/share-and-garage-implementation-plan-2026-09-20.md`. The order is right and Step B's
reason is stated correctly. Six gaps, two of which leave a live comment unguarded.

## V1. Two outcomes are missing from the settle, and both leave a live comment (high)

A2 step 6 lists three outcomes: confirmed, known refusal, unknown. The code has two more, and both
happen **after** Reddit accepted the comment:

- The comment comes back with an author that is not the player. Both callers answer 409
  `user_action_unavailable` today (`src/server/daily-gp-share.ts:618`,
  `src/server/head-to-head-share.ts:216`).
- The comment comes back without a usable `t1_` id. Both callers throw
  (`src/server/head-to-head-share.ts:229`).

Neither is a refusal and neither is unknown, so under "every other throw leaves the ten minutes"
both leave a live comment guarded for ten minutes. After that the next attempt posts a second one.
This is the hole from U1, in the branches U1 did not cover.

The guard's question is "does a comment exist?", not "is it usable?". Any outcome where Reddit
returned a comment must give the receipt the full term, whatever the answer to the player is.

## V2. Step A never says how the other two flows opt out (high)

Step A puts the receipt in the path all three flows share and turns it on for Daily alone. The
document does not say what makes the other two skip it. The obvious rule — no result key, no
receipt — is the same condition Step B gives the opposite meaning: "a preview without one is
refused as expired".

Name the opt-out so it cannot be confused: in Step A the two challenge callers pass no receipt at
all, and Step B replaces that by passing one and refusing a preview that has none. If both readings
survive into one build, a challenge preview from before a deploy is either silently unguarded or
wrongly expired, depending on which line the implementer read.

## V3. The preview's rule for a pending receipt is not in the plan (medium)

A3 says the liveness check stays in the preview. It never says what the preview does when it finds a
**pending** receipt, and that is a load-bearing decision: it reports the share as ready and lets the
confirm settle it under the lock, because a post may still be in flight. An implementer reading only
this plan will make the preview answer "already posted", which is the case that was ruled out.

Also missing from A4: Daily's repeat panel now reads "Already posted" where it read "Shared".

## V4. "Pending" means two different things three lines apart (medium)

A2 step 1 reads a pending receipt as "the request that claimed it is gone, because this request
holds the lock". A2 step 2 reads one as "already being posted". Both are right — the difference is
whether it was there before this request looked or appeared after — and nothing in the document says
so. The next person to read it will make them agree and break one.

## V5. "No new database transactions anywhere" is not true of Step C (medium)

The settle grants through the ordinary reward write, which takes the promotion lock and releases it
with a transaction (`src/server/car-unlock-store.ts:181`, `src/server/redis-lock.ts:232`). Step C
runs it at start-up for every player instead of only for a player with Daily data, so a player with
a non-empty list now takes a lock and a release transaction at start-up where they took none.

It is rare and it is the existing path, which is the point worth making. The flat claim is what
needs fixing, not the design.

## V6. Step D drops the reset (medium)

A record that says "this finish spent its comment" has to clear when a new finish opens, beside
`_challengeFinishShareRequest` and `_challengeFinishPhase`
(`game/race/ui-modal-shell.js:1193`), or the next finish inherits it. And the cancel path still
enables that button directly (`game/race/ui-modal-shell.js:1000`), as does the outcome panel
(`game/race/ui-modal-shell.js:826`). If the record is the source of truth, those have to read it
too, or the repaint and the panel disagree again — which is the fault Step D exists to fix.

## V7. Smaller

- **The brag and the comment can share a receipt key.** Challenge, player and time are the same
  fields for both. The times cannot collide today, because a win is faster than the target and a
  loss is not, but that is a lot of weight on an implicit argument. The existing preview keys
  already carry the action (`miniracer:head-to-head:brag`, `...:comment`); carry it into the receipt
  key and the lock, or the two flows also queue on each other.
- **Step C does not say where the remember lives.** Every reward write already passes through
  `writeCarUnlockEvent` (`src/server/car-unlock-store.ts:181`). Put it there and the three recorders
  need no change. And the caps — five and ten — belong in one table read by both the Garage write
  and the settle, not in prose in two places.
- **The helper names three users.** Six sites read an `nx` answer as a boolean today, including the
  profile claim (`src/server/competition-identity.ts:430`), the campaign guest throttle
  (`src/server/campaign-store.ts:353`) and the podium snapshot
  (`src/server/daily-podium-post-store.ts:84`). Convert them or say why not.

## Tests the plan does not name

- The lost-claim branch answers "already being posted" and posts nothing.
- A comment returned with the wrong author, or without a usable id, still guards the result past ten
  minutes.
- The preview reports ready for a pending receipt and does not answer "already posted".
- A new finish clears the previous finish's spent record.

---

# Round 7: the updated implementation plan

Every Round 6 finding is folded in, and the two meanings of an unfinished receipt are now named in
the document rather than left for a reader to reconcile. Four things.

## W1. Daily's receipt key must not gain the action (high)

A1 says the key is "the caller's result key, and the caller's action", and that a complete record
holds what today's record holds "so records written before this work still parse". Parsing is not
the problem. The **key** is.

Today's key is `dailygp:shared-result:<subreddit>:<day>:<player>:<time>`
(`src/server/daily-gp-share.ts:87`), with no action in it, and a complete record lives a year
(`src/server/daily-gp-model.ts:26`). Adding an action segment to Daily's key orphans every record the
live build has written. Each of those results becomes unguarded, and the first player to share one
again posts a second comment. It is not limited to the current day either, because a standings share
can name an earlier day in the playlist.

The action is only needed where two flows would otherwise collide, and those two have no records to
preserve. Leave Daily's key byte-identical and put the action in the challenge keys alone.

## W2. The wrong-author branch does not hold, and it is terminal (high)

Step 6's new branch extends the receipt to the full term when Reddit returns a comment under the
wrong name. That buys nothing as the rest of the path is written.

The receipt stays *pending*, because there is no usable link to complete it with. A later attempt
therefore scans, and the scan matches on the player's own name
(`src/server/user-comment-submit.ts:101`). An app-authored comment does not match, so the walk passes
the claim time, calls it absent, drops the receipt and posts again.

The missing-id branch heals correctly, because that comment **is** the player's and a later scan
finds it. Only the wrong-author branch fails.

Worth saying plainly: `user_action_unavailable` means this app version cannot post as the player at
all, so every attempt adds another app-authored comment with the player's words. Today that is
already true and nothing stops it. If the receipt is to stop it, that outcome has to be recorded on
the record — either as complete, so nothing scans, or with the author the scan should look for.

## W3. After Step B, deleting your comment no longer lets you post again on the two challenge flows (medium)

A4 puts the liveness check in the Daily preview and nowhere else. Step B gives the challenge flows a
receipt but no preview-side read, and their confirm answers a complete receipt from Redis alone. So
a player who deletes their brag or their challenge comment can never post that result again, for the
full term. Today they can, because those flows keep no record at all.

It is a small case, and it is a behaviour change that the plan does not name. If you want it kept,
the challenge preview can read a **complete** receipt, ask Reddit whether the comment is still there,
and retire it if it is gone, while still reporting ready — it never answers a repeat, so it never
meets an old build's status list. One Reddit read on a rare path.

## W4. Two smaller ones

- **"They behave exactly as they do today" is not exact.** Step A moves the callers' ownership check
  inside the shared path, and the challenge callers run it before the call today
  (`src/server/head-to-head-share.ts:195`). After Step A it runs after the preview spend, immediately
  before the post. That is better, and it is a change — say so, because the claim is what justifies
  shipping Step A alone.
- **The helper count.** Ten places hand-roll the call, not nine:
  `src/server/redis-lock.ts:103`, `src/server/daily-gp-post-store.ts:85`,
  `src/server/daily-podium-post-store.ts:84`, `:140`, `src/server/competition-identity.ts:430`,
  `:518`, `:581`, `src/server/campaign-store.ts:353`, `src/server/daily-gp-store.ts:2269`,
  `src/server/player-token.ts:20`. Seven of them read the answer; three ignore it. The rule in the
  plan is right and the count is not.

## Tests to add

- Daily's receipt key is the key the live build writes, so a record written before the deploy still
  guards its result.
- A comment returned under the wrong name is not posted a second time by the next attempt.

---

# Round 8: subtract

Rounds 5 to 7 reviewed branches instead of the shape. This round asks what the plan can delete.

## X1. The two terms and the settle outcomes protect nothing (high)

The plan's own rule for an unfinished receipt is: scan, and **if the comment is not there, post
anyway** (A2 step 1, "walked past the claim time with no match — drop the receipt and carry on to
the claim").

So an unfinished receipt never blocks a player. It costs a thread read and then behaves exactly as
if it were not there.

Every term rule in the plan exists to bound a lockout that this rule already makes impossible:

- the ten-minute claim, and the whole idea of two terms;
- "an unknown outcome extends the receipt to the full term";
- "a confirmed comment whose completion fails extends it" (U1);
- "Reddit returned a comment we cannot use, extend it" (V1, W2);
- "a known refusal deletes the receipt", which becomes an optimisation that saves a later scan, not
  a correctness step — so "if that delete fails" stops mattering;
- the claim-lost branch's second answer, which can re-read and scan like any other path.

What remains is one record with one term and one transition:

> **The receipt.** Written before the post, holding the comment text, the player and the claim time.
> Given the comment's link once a link is known. A request that finds one with a link answers
> "already posted". A request that finds one without a link scans the thread: found, it stores the
> link and answers "already posted"; absent, it posts; the walk's cap means unknown, so it leaves
> the record and answers unconfirmed.

That is the whole guard. It gives every guarantee the current plan gives, in one state.

It also dissolves W1: with no state field and no action in Daily's key, the record Daily writes
today **is** the record, and nothing written before the deploy is orphaned.

The one thing the ten minutes did buy is storage: a refused share leaves a record where today it
leaves none. The refusal delete keeps that in check, and it is now allowed to fail.

## X2. Step D is no longer a correctness fix (medium)

Once the challenge comment has a receipt, the re-enabled button cannot post twice: the second
attempt reads the receipt and answers "already posted". So Step D stops being about duplicate
comments and becomes about a button that lies.

The minimum is what the working tree already does — do not bring the button back — plus computing
it from the finish's own record. The "one painter" refactor, routing the cancel path and the outcome
panel through that record, is polish. Ship it if it is cheap, drop it if Step C is more valuable,
but do not carry it as though a duplicate comment depends on it.

## X3. The transfer half of Step C can be one delete (high)

Step C4 is the riskiest change in the plan: it adds a grant inside guest transfer preparation, with
an ordering constraint against the source inventory, a new retryable failure, a return value, a
journal interaction and two code comments. The function it touches fails into `recovery_required`,
which needs a person.

What it buys: after a Guest choice, the account's owed list no longer grants credit the player gave
up, and the guest's owed credit carries across.

The first half is the actual bug. The second half is not reachable today anyway: after promotion,
start-up settles under the account id (`src/server/daily-gp-store.ts:3401`), so a guest's owed list
is already orphaned and its credit already lost.

So the bug is fixed by deleting the account's owed list where the Guest choice already freezes the
Garage (`src/server/daily-gp-store.ts:2696`) — one `del` in the branch that already exists for
exactly this choice.

- It needs no lock and no transaction.
- It cannot fail into `recovery_required`; a failed delete leaves today's behaviour.
- It has no ordering relationship with the source inventory, because it does not touch the Garage
  hash.
- It deletes "a transfer resumed past preparing grants nothing", the retry/journal comment, the
  retryable-failure path and two of the plan's tests.

The cost: a player loses an owed credit that had not been granted yet, in the window before their
one transfer. That is smaller than the risk of writing to the Garage during preparation.

## X4. What has to stay

- The receipt, in the shared submit path, claimed before the post.
- The result lock for Brag and Challenge Comment. Without it two previews run side by side and the
  receipt's "this one is dead" reading is false. The alternative is a timer, which is worse.
- The scan's rules: the text the record holds, one second of slack, the cap meaning unknown, and
  the author it matches on (W2 is a question about that match, not a branch).
- The owed list for every reward kind, and the start-up settle for every player.
- The first-race repair read from the snapshot.

## X5. The one dead end in both shapes

A record with no link whose thread has grown past the walk's cap can never be resolved: every
attempt hits the cap and answers unconfirmed. It needs an unknown outcome and a busy thread
together. Size the cap so it only trips in extreme cases, and accept it rather than engineering
around it — "give up and post" is the duplicate this whole design exists to stop.

---

# Round 9: the cut-down plan

The plan is now four pieces and no new idioms, and the three subtractions it claims are each
correct: the conditional claim really does protect nothing the result lock does not; a linkless
record really is invisible to the preview's existing parser
(`src/server/daily-gp-share.ts:160`), so the preview needs no change; and the record really does
replace the preview spend as the guard — for a caller that has a record.

That last qualifier is where it breaks.

## Y1. Piece 1 regresses the two challenge flows until piece 2 lands (high)

Today `submitUserComment` spends the preview before it posts
(`src/server/user-comment-submit.ts:81`). For Brag and Challenge Comment that spend is half the
guard: the token lock serialises two confirms (`src/server/head-to-head-share.ts:159`), and the
spend stops a resent token from posting a second comment
(`src/server/head-to-head-share.ts:173` reads the preview inside the lock and answers expired when
it is gone).

Piece 1 removes the spend from the shared path and gives only Daily a record. So for one commit the
two challenge flows have neither. The case it opens is the exact case this work exists for: the post
throws unknown, nothing deletes the preview, the player retries, and a second comment goes up. Today
that retry is refused as expired.

"Before this step these flows pass no record at all and behave exactly as they do today" is
therefore not true.

Surgical fix: the shared path spends the preview before posting **when the caller passes no record**.
One condition. The two challenge flows keep today's behaviour exactly until piece 2 gives them a
record, and Daily gets the new behaviour immediately.

## Y2. The plan is silent on the scan that already exists (high)

"Every other failure answers unconfirmed" reads as though the immediate scan goes.

That scan is the fix for a live incident: on 2026-09-19 Reddit posted two Brags and threw, and both
players were told the Brag failed. `submitUserComment` now catches that, scans the thread and
reports the comment it finds (`src/server/user-comment-submit.ts:89`).

With the record, dropping it is not a correctness loss — the next attempt's scan resolves it — but it
turns a case that is answered correctly today into "Reddit did not confirm this", plus a round trip.
That is a regression of a fix written for a real incident.

Keep it, and say so: the throw path scans once before answering unconfirmed, and the deferred scan
is the same function with the record's time instead of this attempt's.

## Y3. A recognised refusal should still delete the record (medium)

The plan keeps the refusal list only to choose the answer. Nothing deletes the record, and the term
is now always long.

So every refused share leaves a year-long linkless record, and every later attempt on that result
pays a thread walk before it posts. Refusals are not rare — both messages come from the live logs
(`src/server/user-comment-submit.ts:26`).

One line, in the branch that already exists, and it is allowed to fail: a failed delete leaves a
record that the next attempt resolves by scanning. This is the one deletion Round 8 said becomes an
optimisation — it is still worth doing.

## Y4. Two ordering details piece 1 leaves out (medium)

- The ownership check appears only in the "no record" branch. The linkless-absent branch posts too.
  The check belongs immediately before the post on both paths.
- The linkless-absent branch should refresh the record's time before it posts. If it does not, a
  second unknown outcome leaves the record still carrying the first attempt's time, so every later
  walk reaches further back and meets the cap sooner — and the cap is the one dead end the plan
  accepts.

## Y5. Piece 4 is inert unless the share panel writes the record (low)

"Nothing else changes" cannot include the panel. Something has to mark the comment spent, and the
only thing that knows is the share flow — the outcome panel and the unconfirmed branch. Leave the
direct button set where it is if painting in one place is out of scope, but the panel must write the
record, or the repaint has nothing to read.

## Y6. Smaller

- The guest's own owed list is orphaned forever after a promotion, because start-up settles under
  the account id (`src/server/daily-gp-store.ts:3401`). The plan's own delete is in the right place
  to take both lists, at no extra risk.
- One test is missing for the subtraction that piece 1 makes: the **same** preview resent twice posts
  one comment. Test 1 covers two different previews.
