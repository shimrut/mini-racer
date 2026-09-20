# Fix the duplicate brag

Revised after rounds 1 and 2 of
`docs/brag-duplicate-fix-plan-red-team-2026-09-20.md`.

## The fault

The app writes a receipt before it posts
([user-comment-submit.ts:169](../src/server/user-comment-submit.ts)). That receipt
holds the text, the player, and the claim time. It holds no comment ID, because
the comment does not exist yet.

The app then posts. Reddit accepts the comment. The app then checks what it got
back. Two checks can fail:

- The author is not the player
  ([head-to-head-share.ts:279](../src/server/head-to-head-share.ts),
  [daily-gp-share.ts:630](../src/server/daily-gp-share.ts)).
- The comment has no `t1_` ID
  ([head-to-head-share.ts:291](../src/server/head-to-head-share.ts),
  [daily-gp-share.ts:639](../src/server/daily-gp-share.ts)).

Both checks run before the caller writes the comment into the receipt. So a
failed check leaves the claim receipt, and nothing records that Reddit accepted
the comment.

The duplicate comes from this rule
([user-comment-submit.ts:144](../src/server/user-comment-submit.ts)): a receipt
with no comment ID walks the thread, an empty listing means absent, and absent
means post. Reddit's listing lags, so Try Again posts a second comment. The same
check fails. The player sees the same error.

`createdAt` cannot carry the missing fact. The app writes it before it posts, so
it says "we tried", not "Reddit accepted". That is what `postedAt` is for.

## 1. Record the publication in the helper

Put the write in `submitUserComment`, where Reddit answers. Both callers write
too late today, and repeating the early write in both of them keeps `posted`
meaning "the caller must remember to record this".

The helper has everything it needs at two points: when `submitComment` returns a
comment ([user-comment-submit.ts:175](../src/server/user-comment-submit.ts)),
and when the throw path finds one in the thread
([:194](../src/server/user-comment-submit.ts)). At both, update the claim with:

- `postedAt`, the time Reddit answered.
- `authorName`, as Reddit reported it.
- `commentId` and `commentUrl`, only when the ID is a `t1_` ID **and** the author
  is the player.

Compare the author with `trim()` and `toLowerCase()`, the same compare the
callers use ([head-to-head-share.ts:74](../src/server/head-to-head-share.ts)) and
the walk already uses. A difference of case alone must not skip the ID.

The write is an **update of the claim**. Keep `commentText`, `username`, and
`createdAt`. `parseUserCommentRecord` returns null without the first two
([user-comment-submit.ts:51](../src/server/user-comment-submit.ts)), and a
receipt that does not parse looks like no receipt, so the next attempt posts
again. That is worse than a failed write, which at least leaves the claim.

Keep `createdAt` as the claim time for a second reason. Today's completion write
resets it to the time after the post
([daily-gp-share.ts:647](../src/server/daily-gp-share.ts),
[head-to-head-share.ts:302](../src/server/head-to-head-share.ts)). Copy that into
a no-ID receipt and the resolve walk searches from a time later than the comment,
so it never finds it.

Return the receipt with the outcome. Callers judge the receipt from here on, so
`posted` and `posted_without_link` both carry it — the in-memory copy, even when
the Redis write failed. A caller still reading `outcome.comment` sees no comment
on `posted_without_link`, reads an empty author, and reports
`user_action_unavailable` for the player's own comment.

Add `postedAt` and `authorName` to `UserCommentRecord`. Both are optional. Keep
`username` as the player, because the walk searches on it.

Both callers stop writing receipts.

A failed write still leaves only the claim, and that attempt can still duplicate.
That is the same hole the completion write has today. State it. Do not claim the
duplicate is impossible.

## 2. A receipt with `postedAt` never posts

In `submitUserComment`, check in this order:

1. `commentId`: return `already`, as today.
2. `postedAt` and no `commentId`: walk the thread for the link. **Do not submit.**
   - The walk finds it: complete the receipt and return `already`. Returning the
     comment while the receipt has no ID makes every later attempt answer
     `posted_without_link`. Store the ID only when it is a `t1_` ID, the same rule
     as step 1. Anything else is a publication with no usable link, so the receipt
     keeps `postedAt` with no ID and the answer is `posted_without_link`.
   - The walk misses or cannot finish: return `posted_without_link`, not
     `unconfirmed`. Unconfirmed is for a claim that may never have posted.
3. Neither: the existing linkless walk, unchanged. That is the uncertain attempt.
   See Out of scope.

The `postedAt` check must come **before** the existing `if (stored)` block
([user-comment-submit.ts:144](../src/server/user-comment-submit.ts)). That block
treats an empty listing as absent and posts. Handle `postedAt` inside it or after
it and step 2 never runs on the path that duplicates.

Steps 1 and 2 ship together. Step 1 alone does not stop the no-ID duplicate,
because nothing reads `postedAt` until step 2.

## 3. Judge the publication from the receipt

Both callers keep the two checks, and read them off the receipt, on `posted` and
`posted_without_link` — the two outcomes this work writes `authorName` on:

| Receipt | Answer |
|---|---|
| ID, author is the player | Unchanged success |
| Author is not the player | `user_action_unavailable`, unchanged |
| No ID, author is the player | `posted_without_link`, in place of the current throw |

The author check comes first, including on `posted_without_link`. The walk
matches the player ([user-comment-submit.ts:115](../src/server/user-comment-submit.ts)),
so an app-authored comment is never found and would otherwise be reported as the
player's comment posted without a link.

**Do not run the author check on `already`.** Leave that success path as it is.
Receipts already in the wild carry no `authorName`, and a missing name would read
as "not the player". `already` is also how a leftover claim becomes a real
receipt: the thread walk finds the comment and returns it, which is the "share
again to check" recovery. Break that and the recovery tells the player their
comment went up under the app's name, and the result stays stuck.

An ID on a receipt already means the comment is the player's. The walk matches
only the player, and step 1 writes an ID only when the author is the player. The
check would be redundant as well as harmful.

Step 1 stores no `commentId` for an app-authored comment, so the three places
that read a stored ID as success stay correct and stay unchanged:
[daily-gp-share.ts:586](../src/server/daily-gp-share.ts),
[head-to-head-share.ts:241](../src/server/head-to-head-share.ts), and the Daily
preview's parser at [daily-gp-share.ts:165](../src/server/daily-gp-share.ts).
Every receipt written by the current code has a matching author, so no stored
receipt is affected.

The no-ID case stops throwing. A throw becomes a route-level 500, which tells the
panel nothing, and the comment is live.

Use one name on the wire: `posted_without_link`.

Leave the `user_action_unavailable` error string as it is. A test asserts the
whole 409 body with `toEqual`. Add no field to that body.

## 4. Stop offering Try Again for a comment that is up

The confirm button throws on any answer that is not `ok` and in a short success
list ([ui-modal-shell.js:1036](../game/race/ui-modal-shell.js)), and `ok` follows
the HTTP code. `user_action_unavailable` is a 409 today, so it already shows Try
Again, and a 409 `posted_without_link` would too.

Intercept both above that throw, where `comment_unconfirmed` is already
intercepted ([ui-modal-shell.js:1019](../game/race/ui-modal-shell.js)).

Scope the two interceptions differently:

- `posted_without_link`: every confirm.
- `user_action_unavailable`: Daily Share, Brag, and Challenge Comment only.
  Create Challenge shares this confirm handler
  ([ui-modal-shell.js:1012](../game/race/ui-modal-shell.js)) and returns the same
  409 when Reddit attributes the **post** to the app
  ([head-to-head-service.ts:815](../src/server/head-to-head-service.ts)). No
  comment exists, the post slot is released, and "the comment went up" is false.
  That flow keeps its failure.

The panel supplies both sentences, keyed off the status, because the server
strings are frozen:

- `posted_without_link`: the comment went up, without a link to it.
- `user_action_unavailable`: the comment went up under the app's name, not the
  player's.

This is not a wording change to `_showShareOutcome`. That function titles the
panel "Shared" and quotes the comment text
([ui-modal-shell.js:806](../game/race/ui-modal-shell.js)). Both new states
replace that quote.

Mark the finish spent the way the success path does
([ui-modal-shell.js:1042](../game/race/ui-modal-shell.js)). Copying the
`comment_unconfirmed` branch instead leaves error styling and a Close button on a
comment that is up.

## 5. Tests

Change:

- [server-daily-gp-share.test.js:1000](../tests/server-daily-gp-share.test.js),
  "fails closed when Reddit returns a user comment without a t1_ id". It asserts
  a throw. The answer becomes `posted_without_link`.

Watch:

- [server-daily-gp-share-wave5.test.js:265](../tests/server-daily-gp-share-wave5.test.js)
  asserts the 409 body with `toEqual`. Any added field fails it.

Extend:

- [server-head-to-head-share.test.js:253](../tests/server-head-to-head-share.test.js),
  "rejects an incorrectly attributed comment without deleting it". Keep the
  status. Add: a second confirm posts nothing and repeats the status.

Add, for Daily Share, Brag, and Challenge Comment:

- Reddit returns a comment with no ID. The receipt records the publication. A
  second confirm posts nothing and answers `posted_without_link`.
- Reddit returns a comment from another author. The receipt stores no ID. A
  second confirm posts nothing and repeats `user_action_unavailable`.
- A `postedAt` receipt whose walk cannot finish answers `posted_without_link` and
  posts nothing.
- A `postedAt` receipt whose walk finds the comment answers with the ID, not
  `posted_without_link`.
- A claim receipt with no `authorName`, whose walk finds the comment, answers
  success. It must not answer `user_action_unavailable`.
- A walk that finds a comment without a `t1_` ID answers `posted_without_link`
  and stores no ID.
- A wrong-author comment with a valid ID never makes the Daily preview answer
  `already_shared`.
- A wrong-author comment with no ID answers `user_action_unavailable`, not
  `posted_without_link`.
- The completed receipt still parses: text, player, and the original `createdAt`
  survive the update.
- The resolve walk finds a no-ID comment whose claim time is the original
  `createdAt`.
- A stale thread listing after either failure causes no second submit.
- The panel shows the posted state, with no Try Again, for both statuses.

And:

- Create Challenge still reports `user_action_unavailable` as a failure, not as a
  comment that went up.

Head to Head has no existing no-ID throw test. Only Daily does.

Amend `CHANGELOG.md:12`. It already claims this class of fault is fixed.

## Out of scope

The uncertain attempt, where `submitComment` throws and the walk finds nothing,
is a separate fault. It answers `comment_unconfirmed`, shows Close, and blocks
the brag for that finish. It is not the reported fault.

The Garage settlement order is a separate fault.
