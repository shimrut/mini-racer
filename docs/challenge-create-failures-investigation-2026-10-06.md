# Challenge create failures — investigation, 2026-10-06

Players see **Could not create this challenge.** after tapping **Create Challenge**. Reported from a new account.

## What the player sees

The message is the catch-all for any unexpected error in `/api/head-to-head/create` (`src/server/routes/head-to-head-routes.ts:117`). The preview step before it works, so the failure is inside `create` (`src/server/head-to-head/head-to-head-service.ts:643`).

## Reddit logs, 29 Sep 06:20 UTC – 6 Oct 06:26 UTC

Older logs (22–28 Sep) are gone. 179 failures in the window.

| UTC day | Failures |
| --- | --- |
| 29 Sep (from 06:20) | 41 |
| 30 Sep | 41 |
| 1 Oct | 16 |
| 2 Oct | 12 |
| 3 Oct | 9 |
| 4 Oct | 43 |
| 5 Oct | 13 |
| 6 Oct (to 06:26) | 4 |

| Cause | Count | Pattern |
| --- | --- | --- |
| Reddit could not look up the player (114 not found, 9 forbidden) | 123 | Steady. Still happening. |
| Reddit could not use the player's login to post | 46 | Two bursts: 13 on 30 Sep, 26 on 4 Oct. None since. |
| Reddit said the account is not allowed to post | 10 | Through 4 Oct. None since. |

## Causes in the code

### 1. Duplicate check reads the player's post history and fails the whole post (123, our bug)

Before every new challenge post, `recoverPost` reads the player's recent Reddit posts to find a challenge an earlier attempt may have already posted (`head-to-head-service.ts:521`, called at `:741`). It has no error handling. When Reddit hides that history (new or filtered accounts answer not found; hidden profiles answer forbidden), the error ends the request with the catch-all message. That player can never create a challenge.

Campaign sharing already treats the same read as best effort and logs instead of failing (`src/server/campaign/campaign-share.ts:165`). The avatar lookup is also best effort (`src/server/player/reddit-avatar.ts:13`), so it is not the cause.

### 2. Reddit could not use the player's login (46, Reddit side)

`reddit.submitCustomPost` with `runAs: 'USER'` throws "failed to mint" when Reddit cannot act for the player (`head-to-head-service.ts:785`). The two bursts match Reddit outages. The code cannot prevent these. The post slot is already released on error (`:855`).

### 3. Reddit refused the account (10, Reddit side)

Same call, refused for that account (for example "this user account is not valid"). Reddit's or the community's rule; the code cannot prevent these.

Both Reddit refusals are already recognised by `isUserActionRefusedBeforePosting` (`src/server/posts/user-comment-submit.ts:39`). Campaign sharing and challenge comments use it to show a clear message. Challenge create does not, so players get the catch-all.

## Fix plan

1. Make the duplicate check best effort: if the post history cannot be read, log it and post as normal. Fixes cause 1 (69% of failures). Duplicate risk stays capped by the existing creation lock and three-posts-per-track daily limit.
2. Catch Reddit's refusal around the post call, release the slot, and answer `user_action_unavailable` with a clear message. Causes 2 and 3 still fail, but players know it is Reddit and can try later.
3. Add tests for both paths in `tests/server-head-to-head.test.js`.
