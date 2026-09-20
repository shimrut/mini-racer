# Fix the duplicate brag

## The fault

The app posts the comment. Reddit accepts it. The app then checks the comment
it got back. Two checks can fail:

- The author name does not match the player
  ([head-to-head-share.ts:279](../src/server/head-to-head-share.ts),
  [daily-gp-share.ts:630](../src/server/daily-gp-share.ts)).
- The comment has no `t1_` ID
  ([head-to-head-share.ts:291](../src/server/head-to-head-share.ts),
  [daily-gp-share.ts:639](../src/server/daily-gp-share.ts)).

Both checks run before the app saves the record. So a failed check leaves a
live comment with no receipt.

The player sees an error and a Try Again button. Try Again reads the record,
finds no comment ID, and searches the thread. Reddit's listing is not current
yet, so the search finds nothing. The app posts the comment again. The same
check fails again. The player sees the same error.

This is the reported fault: a duplicate brag, and an error that does not change.

## 1. Save the receipt first

In `head-to-head-share.ts` and `daily-gp-share.ts`, move the record write ahead
of both checks. When `submitUserComment` returns `posted`, write the record
immediately with what Reddit gave:

- `commentId` and `commentUrl` when the ID is valid.
- `authorName`, as Reddit reported it.
- `postedAt`, the time of the successful submit.

Then run the two checks, and keep their current outcomes.

Add `postedAt` and `authorName` to `UserCommentRecord` in
`user-comment-submit.ts`. Both are optional. Keep `username` as the player,
because `findPostedComment` searches on it.

This step alone stops the duplicate. Every later attempt finds a receipt.

## 2. Never post again after a known publication

In `submitUserComment`, a stored record with `postedAt` means the app knows the
comment is live. That record must never reach the submit path.

- Record has `commentId`: return it, as it does today.
- Record has `postedAt` and no `commentId`: try to resolve the link from the
  thread. Return the comment when the search finds it. Otherwise return a new
  outcome, `posted_no_link`. Do not submit.
- Record has neither: unchanged. This is the uncertain attempt, and it is out of
  scope here.

## 3. Report a publication as a publication

Both services return one shared shape for a comment the app knows is live:

| Case | Response |
|---|---|
| ID and author correct | Unchanged success |
| Author is not the player | `user_action_unavailable`, unchanged, plus the receipt |
| No ID | `posted_without_link`, in place of the current throw |

Move the attribution check onto the record's `authorName`, so a retry gives the
same answer as the first attempt. Without this, a retry reads the saved ID and
reports success for a comment that is not the player's.

The no-ID case stops throwing. A throw becomes a route-level 500, which tells
the panel nothing, and the comment is live.

## 4. Show the player what happened

In `ui-modal-shell.js`, the confirm panel offers Try Again for every failure.
Give the three cases their own answers:

- The app knows the comment is live: show the posted panel. No Try Again. For
  `posted_without_link`, say the comment went up without a link. For
  `user_action_unavailable`, say the comment went up under the app's name.
- The app knows nothing was posted: Try Again, as today.
- The app cannot tell: unchanged for now. See Out of scope.

## 5. Tests

Change:

- `server-daily-gp-share.test.js:1000`, "fails closed when Reddit returns a user
  comment without a t1_ id". It asserts a throw. The new answer is
  `posted_without_link`.

Extend:

- `server-head-to-head-share.test.js:253`, "rejects an incorrectly attributed
  comment without deleting it". Keep the status. Add: the record holds the
  comment, and a second confirm posts nothing and repeats the same status.

Add, for Daily and for both Head to Head actions:

- Reddit returns a comment with no ID. The record records the publication. A
  second confirm posts nothing.
- Reddit returns a comment from another author. The record records the
  publication. A second confirm posts nothing and repeats the status.
- A stale thread listing after either failure never causes a second submit.
- The panel shows the posted state, with no Try Again, for both cases.

## Out of scope

The uncertain path, where `submitComment` throws and the app cannot tell whether
the comment exists, is a separate fault. It answers `comment_unconfirmed`, shows
Close, and blocks the brag for that finish. It is not the reported fault and it
is not changed here.

The Garage settlement order is a separate fault and is not changed here.
