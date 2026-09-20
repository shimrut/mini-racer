# Implementation plan: one record per result, owed rewards, a spent comment — 2026-09-20

The shape settled in `docs/share-and-garage-fix-plan-red-team-2026-09-20.md`, cut to what it needs
after Round 8. Four pieces, no new idioms, no new lifetimes.

## The record

One record per result, in the shape the Daily share already stores: the comment text, the player,
the time it was written, and — once a comment exists — its id and link. It is written immediately
before the comment is posted and given the link after. Its term is the one the share record has
today. There is no second state and no second lifetime.

- **Key**: the caller's result key and action. Daily uses the key it has today — subreddit, day,
  player, time. The two challenge flows use challenge, player, time, and brag or comment, so they
  cannot meet on one key. The result lock uses the same key.
- **A record with a link** means the comment is up. The attempt answers "already posted" from Redis
  alone, and resolves no thread.
- **A record with no link** means an attempt got that far and did not finish. The attempt walks the
  thread's newest comments back to the record's own time, with one second of slack, matching the
  text the record holds and the player it names.
  - Found: store the link and answer "already posted".
  - Walked past that time with no match: post.
  - Reached the walk's cap: leave the record and answer unconfirmed. The cap is not "absent".
- **No record**: write one, then post.

Both branches that post — no record, and a linkless record the walk called absent — check the lock's
ownership immediately before posting. The absent branch also refreshes the record's time first, or a
second unknown outcome leaves the old time in place, every later walk reaches further back, and the
walk meets its cap sooner.

When a post throws, the thread is scanned once before the attempt answers, as the code does today.
That is the fix written for the 19 September incident, where Reddit posted two Brags and threw, and
both players were told it failed. It is the same walk as the deferred one, with the record's time.

Why the term must stay long: a record with no link never blocks a player, but it is the only thing
that makes the next attempt look in the thread instead of posting blind. Give it a short life and
the guard is gone.

## What this deletes from the code as it stands

- The preview is no longer spent before the post, and no longer restored after a refusal, **for a
  caller that passes a record**. The record guards the result, so a resent preview reaches it and is
  told the comment is up. A caller that passes no record keeps the spend, because its preview is
  then its only guard; that is the two challenge flows, and only until their piece lands.
- No conditional claim and no helper for one. The result lock serialises two attempts; a conditional
  write never protected anything the lock does not.
- No pending state on the record, and no parser change. A record without a comment id already fails
  the parser the preview uses, so the preview needs no change at all. Only the confirm reads the
  record as it is.
- The refusal list stays, but only to decide the answer: a recognised refusal posted nothing, so it
  throws and the player may try again, and it deletes the record it just wrote. That delete may
  fail; it saves the next attempt one thread walk and keeps no stray records. Every other failure
  answers unconfirmed, after the one scan above.

## The four pieces

### 1. The record, for the Daily share

Order inside the confirm, under the result lock it already takes: read the preview, take the lock,
read the preview again inside it, check it still belongs to this player, read the record. A linked
record answers at once. A linkless record resolves the day's post and score thread and scans. With
no record, resolve, check lock ownership, write the record, post, then store the link. A failed
store is logged: the record stays linkless and the next attempt resolves it.

The game gets one string: the unconfirmed line asks the player to share again to check, instead of
sending them to the post. The game has never opened a Reddit link and this work does not add one.

### 2. The result lock and the record for Brag and Challenge Comment

These ship together. The record's rule for a linkless record is only true when one attempt at a
result waits for the other, and these two flows queue on the preview today.

- The preview carries the result key. From this step on, a preview without one is expired; previews
  live ten minutes, so a deploy costs one retry. Before this step these flows pass no record, keep
  the preview spend, and are no weaker than the tree they land on.
- The confirm locks on the result key instead of the preview token, and reads the preview again
  inside the lock.
- A repeat answers with the status each flow already ships.
- The interim rule goes: with all three callers passing a record, the shared path no longer spends a
  preview before posting, and the condition that kept it is removed rather than left unreachable.

### 3. Owed rewards

- The remember lives in the one write every reward already passes through, so the three recorders do
  not change. A failed reward write records its own field on the player's owed list, without the
  lock it just lost.
- Settling grants each entry by its rule, deletes each entry after its grant, never throws. The caps
  — five posted tracks, ten wins — move into one table the Garage write and the settle both read.
- Start-up reads the Garage first, then repairs the first-race field when the snapshot shows a
  finished race and the stored field is missing. A campaign result already counts as a finished race
  there, so the Campaign-only blind spot closes with no extra read. The settle then runs whenever no
  transfer is open, for every player.
- The transfer gets one delete, not a grant: a Guest choice clears the account's owed list, and the
  retired guest's with it, in the branch that already freezes the account's Garage for that choice.
  No lock, no transaction, no ordering against the source inventory, and a failed delete leaves
  today's behaviour. A guest's own list is settled at that guest's next start-up, so the only credit
  lost is one earned and failed in the same session as the choice. An Account choice leaves the
  guest's list unread, as it is today.

### 4. The finish screen

The share panel writes the record when a comment is posted, already posted or unconfirmed, because
only it knows. The repaint reads that record instead of recomputing the button from the phase alone,
and the record clears when a new finish opens. The panel may keep setting the button directly as it
does now. Nothing else changes: with the record in place a re-enabled button cannot post twice, so this is a button
that tells the truth, not a duplicate comment. Painting the button in one place is polish and is not
part of this work.

## Tests

1. Two previews of one result post one comment. One test for the Daily share, the brag and the
   challenge comment.
2. A comment that posts but whose link cannot be stored is found by the next attempt, which answers
   "already posted".
3. A recognised refusal posts nothing, keeps the preview, and a retry posts exactly one comment.
4. The scan matches the text the record holds, not the text the current preview built.
5. The walk's cap answers unconfirmed and leaves the record.
6. A linked record answers without resolving the score thread.
7. A challenge preview without a result key is expired.
8. One preview sent twice posts one comment, in both challenge flows, before their record lands.
9. A late rank answer leaves a spent Comment button spent.
10. A new finish clears the previous finish's spent record.
11. Start-up repairs the first-race field for a player whose only record is a Campaign result.
12. Start-up settles an owed win for a player who has never raced Daily.
13. A failed first-race reward is granted at the next start-up.
14. A Guest choice clears the account's owed list.

Tests written for the preview spend in the current working tree go with it.

## Verification

The full suite, `npm run typecheck` — the same 23 errors HEAD reports, no more — and `npm run build`.
Hosted Reddit behaviour stays unverified until the deploy.

## Accepted, not fixed

- A linkless record whose thread has grown past the walk's cap can never resolve: every attempt
  answers unconfirmed. It needs an unknown outcome and a busy thread together. Posting anyway would
  be the duplicate this design exists to stop.
- A comment Reddit posts under the app's name cannot be matched by a scan that looks for the player,
  so a test version can still end with two. Approved versions post as the player.
- A replaced day post or score thread is the one case where two comments can be live, and it is
  deliberate: the earlier one is unreachable.
- After an unconfirmed comment the player needs one more screen to learn the outcome, and a player
  who cancels there is not told.
