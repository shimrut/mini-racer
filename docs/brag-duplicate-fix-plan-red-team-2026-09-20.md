# Red team: duplicate brag plan — 2026-09-20

Against `docs/brag-duplicate-fix-plan-2026-09-20.md`. Nothing here changes code.

Verdict: the fault is real, the four-way split is the right one, and the two things left out
should stay out. The diagnosis is wrong in a way that makes “step 1 alone stops the duplicate”
false for the path that throws. Write the publication in the shared helper, not in the two
callers that already write too late. Check the stored author before anything treats a saved id
as success, including two early returns and Daily’s preview.

---

## The diagnosis

There is already a receipt. `submitUserComment` writes it before it posts
(`src/server/user-comment-submit.ts:169`): text, player, time, no comment id. A failed check
does not “leave a live comment with no receipt”. It leaves that claim receipt in place, and
the next attempt is allowed to spend it.

The duplicate is this rule (`src/server/user-comment-submit.ts:144`): a stored record with no
comment id walks the thread; an empty listing means absent; absent means post. Reddit’s listing
lags, so Try Again posts again. Same check fails. Same error.

`postedAt` is the missing bit: a marker that means “Reddit accepted this”, which `createdAt`
does not, because `createdAt` is written before the post.

---

## F1. Step 1 alone does not stop the no-ID duplicate (high)

The no-ID path is the throw, the route-level 500, and the Try Again loop
(`src/server/daily-gp-share.ts:639`, `src/server/head-to-head-share.ts:292`,
`src/server/routes/share-routes.ts:47`, `src/server/routes/head-to-head-routes.ts:161`).
Step 1 writes `postedAt` and no `commentId`. Without step 2, the helper still sees a record
with no id and posts again.

Step 1 alone does stop the other check: a valid `t1_` id, saved before the author 409, makes
the next attempt return `already`. That attempt then reports success for a comment that is not
the player’s, which is why step 3 exists.

Ship 1 and 2 together, or put `postedAt` in the helper and have it refuse to post. Do not
claim step 1 is enough.

---

## F2. Write the publication in the helper, not in both callers (high)

The late write is in `confirmDailyGpShare` and `submitHeadToHeadShareComment`, after the two
checks (`src/server/daily-gp-share.ts:642`, `src/server/head-to-head-share.ts:297`). Putting
the early write in those same two places duplicates it and leaves `posted` still meaning
“the caller must remember to record this”.

When `submitComment` returns a comment, or the throw path finds one in the thread
(`src/server/user-comment-submit.ts:175` and `:194`), the helper already has everything step 1
lists. Write `postedAt`, `authorName`, and a valid id there, then return `posted`. The callers
keep the two checks and stop writing records.

A failed write still leaves only the claim. That is today’s completion-write hole, and it is
the same class as the throw path this plan leaves out. Say so. Do not claim the duplicate
cannot happen.

---

## F3. Two early returns, and Daily’s preview, treat any saved id as success (high)

Step 3 names the retry that reads a saved id. It does not name the three places that already
do that without looking at the author:

- Daily confirm, before the helper: `stored?.commentId` → `already_shared`
  (`src/server/daily-gp-share.ts:586`).
- Head to Head confirm, before the helper: the same, then `postedBody`
  (`src/server/head-to-head-share.ts:241`).
- Daily preview: `parseShareSharedResult` requires a `t1_` id and then asks Reddit whether
  that comment is still there (`src/server/daily-gp-share.ts:165`, `:422`). No author check.

Save a valid id for an app-authored comment, and the next Daily Share is told the result is
already in the score thread.

Smaller fix: do not store `commentId` when the author is not the player. Store `postedAt` and
`authorName` only. The preview parser still ignores that record, the helper’s `postedAt`
branch does not post, and the author check returns `user_action_unavailable`. The player
should not get a success link to an app comment.

If the id is stored anyway, the author check has to run in all three places above, not only
after a `posted` outcome.

---

## F4. A wrong-author comment with no id must not become “posted without a link” (medium)

The resolve walk matches the player (`src/server/user-comment-submit.ts:115`). An app-authored
comment is not found, so step 2 returns `posted_no_link`. Mapping that 1:1 onto
`posted_without_link` tells the player the comment went up without a link, under their name.

Run the author check on the record first, including this outcome. No id and a foreign
`authorName` is still `user_action_unavailable`.

---

## F5. The panel still offers Try Again unless both statuses are intercepted (high for step 4)

The confirm button throws on anything that is not ok and in a short success list
(`game/race/ui-modal-shell.js:1036`). `ok` follows the HTTP code (`game/engine.js:21` via the
service helpers). `user_action_unavailable` is 409 today, so it is already Try Again. A new
`posted_without_link` on 409 is too.

`comment_unconfirmed` is handled above that throw (`game/race/ui-modal-shell.js:1019`). Put
both publication outcomes there, or on 200 with their own copy, and say which. Step 4 is not
a copy tweak of `_showShareOutcome`: that function quotes the comment text and titles the
panel “Shared”. The two new lines have to replace that quote.

Pick one client-facing name. The plan uses `posted_no_link` in the helper and
`posted_without_link` in the panel.

---

## F6. Keep the claim’s `createdAt` (medium)

Today’s completion write sets `createdAt` to now, after the post
(`src/server/daily-gp-share.ts:647`, `src/server/head-to-head-share.ts:302`). Copy that into
the no-id write and the resolve walk’s `sinceMs` is later than the comment, so the link is
never found. `postedAt` is the new field. Leave `createdAt` alone.

---

## F7. Smaller

- Daily preview stays blind to a `postedAt`-only record, because the parser still wants a
  `t1_` id. The player is asked “Post this comment as u/x?” and only then told it is up.
  Head to Head already does that. Accept it. Step 2 is what stops the second post.
- `tests/server-daily-gp-share-wave5.test.js:265` uses `toEqual` on the 409 body. Extra
  receipt fields fail it. The plan lists the H2H test and the Daily throw test, not this one.
- The changelog already says this class of bug is fixed (`CHANGELOG.md:12`). This work amends
  that claim. Head to Head has no existing no-id throw test; only Daily does
  (`tests/server-daily-gp-share.test.js:1000`).

---

## Tests the plan does not name

- A wrong-author comment with a valid id does not make Daily preview answer `already_shared`.
- A wrong-author comment with no id retries as `user_action_unavailable`, not
  `posted_without_link`, and posts nothing.
- The panel shows the posted state, with no Try Again, for `user_action_unavailable` and for
  `posted_without_link`, on Brag, Challenge Comment, and Daily Share.
- The resolve walk still finds a no-id comment whose claim time is the original `createdAt`.

---

## The shape this suggests

1. In `submitUserComment`, when Reddit has returned a comment, write `postedAt` and
   `authorName`, and a `commentId` only when it is a `t1_` id **and** the author is the
   player. Then return `posted`. Callers stop writing records.
2. A record with `postedAt` never posts. Resolve the link if the walk can. Otherwise return
   `posted_no_link`.
3. Callers read `authorName` off the record, on `posted`, `already`, and `posted_no_link`.
   Foreign author: `user_action_unavailable`. No id: `posted_without_link`. Otherwise the
   success they already ship.
4. The panel intercepts those two statuses the way it already intercepts
   `comment_unconfirmed`, shows the posted state, and offers no Try Again.

Out of scope stays out of scope: a throw whose walk finds nothing, and the Garage reward.

---

# Round 2: the rewritten plan

Round 1 is folded in. The diagnosis now matches the code, steps 1 and 2 ship together, the
publication write is in the helper, an app-authored comment stores no id, and the failed-write
hole is named. Four things left, two of which can still duplicate or lie to the player.

## What I checked and found clean

- Old receipts are safe. A complete receipt is only written after the author check
  (`src/server/daily-gp-share.ts:630` then `:642`). A claim receipt has no `authorName` and no
  `postedAt`, so it stays on the unchanged uncertain path.
- Keeping `createdAt`, one wire name, the `toEqual` body, and the changelog amendment are all
  in the document now.
- Out of scope is still the right cut.

## R1. `postedAt` has to be checked before the walk that posts (high)

A publication receipt with no id is still a stored receipt. Today's `if (stored)` block
(`src/server/user-comment-submit.ts:144`) walks, treats an empty listing as absent, and posts.
If `postedAt` is handled inside or after that block, step 2 never runs on the path that
duplicates.

Check `commentId`, then `postedAt`, then the existing linkless walk. A `postedAt` receipt whose
walk is unknown is `posted_without_link`, not `unconfirmed`. Unconfirmed is for a claim that
may not have posted.

## R2. Callers judge the receipt, so the helper has to return it (high)

`posted` today carries only the Reddit comment (`src/server/user-comment-submit.ts:175`). Step 3
reads `authorName` and the id off the receipt, and callers stop writing. Two consequences:

- `posted` and `posted_without_link` must carry the receipt the helper just wrote (the
  in-memory copy, even if Redis failed). If callers keep reading `outcome.comment`, a
  `posted_without_link` retry has no comment and an empty author, so the author check reports
  `user_action_unavailable` for a player comment that has no id.
- "Return the comment when the walk finds it" is not enough. If the receipt still has no id,
  callers still answer `posted_without_link`. When the walk finds it, complete the receipt with
  the id — the author matched, so the id rule allows it — and return `already`.

The publication write is an update of the claim. It must keep `commentText`, `username`, and
`createdAt`. `parseUserCommentRecord` returns null without the first two
(`src/server/user-comment-submit.ts:51`). A successful write of a record that does not parse
looks like no receipt, and the next attempt posts again. That is worse than the failed-write
hole, which at least leaves the claim.

## R3. Do not intercept `user_action_unavailable` on challenge create (high)

The confirm handler serves the challenge post as well as the three comment flows
(`game/race/ui-modal-shell.js:1012`). Challenge create already returns 409
`user_action_unavailable` when Reddit attributes the **post** to the app
(`src/server/head-to-head-service.ts:815`). That is not a live comment, the quota slot is
released, and the copy "the comment went up under the app's name" is false.

Intercept `posted_without_link` for every confirm. Intercept `user_action_unavailable` only
when the request is Daily Share, Brag, or Challenge Comment.

## R4. The two new sentences live in the client (medium)

The wave5 `toEqual` freezes the 409 error at "Reddit user-attributed sharing is not available
for this app version." Showing `body.error` keeps that line. Changing it fails the test. The
intercept keys off the status and supplies both quotes itself. Do not add `commentText` to
that body.

Same compare the callers already use (`trim` + lower) decides whether the helper stores an id.
A case-only mismatch would otherwise skip the id and report `posted_without_link` for a
comment that is the player's.

The posted-state intercept marks the finish spent the way the success path does
(`game/race/ui-modal-shell.js:1042`). Copying the unconfirmed branch instead leaves error
styling and a Close button on a comment that is up.

## Tests to add to the list

- A `postedAt` receipt whose walk is unknown answers `posted_without_link` and does not post.
- A `postedAt` receipt whose walk finds the comment answers with the id, not
  `posted_without_link`.
- Challenge create still surfaces `user_action_unavailable` as a failure, not as "the comment
  went up under the app's name".

---

# Round 3: all four folded in

R1–R4 are in the document as described, including the author compare and the four tests.
One remaining hole ships as a regression of the 19 September recovery.

## What I checked and found clean

- `postedAt` is ordered above the linkless walk, and an unfinished walk on that receipt is
  `posted_without_link`.
- The helper returns the receipt, completes on a find, and updates the claim in place.
- The two intercepts are scoped so Create Challenge keeps its 409.
- The new copy is client-side; the 409 body stays frozen.

## S1. Do not run the author check on `already` (high)

Live receipts have no `authorName`. A complete receipt is written only after the author
passed, and the field does not exist yet (`src/server/daily-gp-share.ts:642`,
`src/server/head-to-head-share.ts:297`).

The two early returns that see a stored id never reach the new checks, and the plan leaves
them alone. Helper `already` does reach them. That outcome is how a claim receipt is
completed: the linkless walk finds the comment and returns `{ ...stored, commentId }`
(`src/server/user-comment-submit.ts:153`), still with no `authorName`.

That is the recovery for an unconfirmed share
(`tests/server-daily-gp-share.test.js:1116`, `tests/server-head-to-head-share.test.js:160`).
Move today's check — `normalize(authorName || '') !== player` — onto that receipt and an
empty author is "not the player". The player who was told to share again to check is then
told the comment went up under the app's name, and the result is stuck.

The id rule already means `already` is the player's comment. Legacy ids are too. Run the
author check on `posted` and `posted_without_link` only, where step 1 has written
`authorName`. Leave the `already` success return as it is.

## S2. Completing a find still needs the `t1_` rule (low)

Step 2 stores the found id because the author matched. Store it only when it is a `t1_` id,
the same rule as step 1. A non-`t1_` value makes `stored?.commentId` true
(`src/server/user-comment-submit.ts:143`), so later attempts never walk and never recover a
real link.

## Settled except S1

The rest of the shape can be built. S1 is the one change of rule, not of wording.
