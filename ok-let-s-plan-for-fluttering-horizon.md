# Head to Head: post-only storage + rename off `head-to-head`

## Context

Head to Head is one of four separate features with deliberately different retention:

| feature | retention | owns storage? |
|---|---|---|
| Daily | time-limited (`DAILY_GP_CHALLENGE_HISTORY_TTL_SECONDS`) | yes |
| Campaign | permanent | yes |
| Duel (race a standings ghost) | inherits whichever leaderboard it reads | no — read-only |
| **Head to Head** | **must live entirely in the post it was created from** | **must own nothing** |

Two things are wrong today.

**1. Head to Head persists state it shouldn't.** The contract is already post-only (`writeHeadToHead` has zero callers; `frozenGhost` is documented "never persisted in Redis"), but four keys survive the post with no TTL — the worst being a per-viewer results hash carrying a **full ghost replay**, written on every accepted run and never expired. This surfaced when the lobby poster rendered a "Your best" time from a challenge accepted in an earlier session.

**2. The code is named after Campaign, which it has nothing to do with.** Every file, type and route says `head-to-head`, while all user-facing copy already says "Head to Head". Worse, `HeadToHeadSourceKind` has a `'duel'` member that is **not** the duel feature — it is an unreachable "issue a Head to Head from a Head to Head" path. The name collision actively misleads.

Outcome: Head to Head owns no data that outlives the accept window; its code is named `head-to-head` throughout; Daily, Campaign and Duel storage are untouched.

Neither Campaign nor Head to Head is live, so wire values (`postType`, devvit post-type key, route paths, redis prefix, replay format marker) can change freely with no compatibility branch.

---

## Part 1 — Remove permanent storage

### Delete outright

Dead code, verified by reference count:

- `writeHeadToHead` / `readHeadToHead` and the `…:<challengeId>` record key. Zero live writers; the read at `head-to-head-post.ts:282` sits behind `replayDataHash !== undefined`, which no current post satisfies.
- The `'duel'` source branch in `resolveHeadToHeadSource` (`head-to-head-runtime.ts:62-83`) and the `'duel'` member of `HeadToHeadSourceKind`. Nothing constructs it — the client only sends `source: 'campaign'` (`game/campaign/engine-methods.js:922`, `:980`) and `source: 'daily'` (`game/race/ui-modal-shell.js:679`). This is the only reason the stored result carries a `ghost`.
- `improved` and `bestResult` from the submit response. Never read; the client's only `body.improved` is `game/scoreboard/engine-methods.js:330`, the Daily endpoint.
- The whole result store: `…:results:<sha(playerId)>`, `resultCollectionKey`, `writeHeadToHeadResult`, `readHeadToHeadResult`, the legacy `resultKey` fallback, and `HeadToHeadResult.ghost`.
- `mergeGuestHeadToHeadResults` **and its call site** at `src/server/daily-gp-store.ts:854`. Leave the sibling `mergeGuestCampaignProgress` / `mergeGuestCarUnlockProgress` calls alone — those are Campaign and progression.
- The 45-day `…:brag:shared:<id>:<user>` record and `parseShared` / `alreadySharedBody`. **Decision: duplicate brags are accepted.** Past the accept window a player can post a second brag comment; that is the agreed trade for owning no data.

### Replace with a 5-minute accept token

`submit()` already validates the replay against the post and holds every value it needs — it just persists instead of returning.

- On a verified submit, write `…:accept:<token>` = `{ challengeId, postId, playerId, bestTimeMs, medal, commentText }` with a **300 s TTL**, and return `acceptToken` in the response body. No ghost.
- Build `commentText` at submit time via the existing `formatChallengeBragComment` (`head-to-head-brag.ts:68`), so the comment quotes **the run just finished** rather than a re-derived stored best.
- Brag preview takes `{ acceptToken }` instead of `{ challengeId }`, reads that key, and drops both the result lookup and the `bestTimeMs >= targetTimeMs` gate (the token only exists for a verified run; keep the win check against the token's `bestTimeMs`).
- Brag confirm is unchanged apart from deleting the shared-record write.

### Put the creation keys on the preview TTL

`…:post-identity:<challengeId>` and `…:post:<sub>:<user>:<raceId>:<ms>` only matter inside the creation window. Give both the existing `PREVIEW_TTL_SECONDS` (10 min) rather than deleting them:

- The identity index is the third fallback for `postId`, which `resolveHeadToHeadRecordResult` hard-requires (`head-to-head-post.ts:233`). The client sends it (`game/campaign/service.js:153`) and the server reads its own (`server-app.ts:113`); the index only covers WebView requests where both are missing.
- The dedup key is a fast path in front of `recoverPost()`, which dedups only by
  scanning the challenger's recent posts. Both stored-identity reuse and
  recovery require the Reddit post author to match that challenger; old
  app-authored posts are not live candidates.

### Keep unchanged

- `…:preview:<token>` and `…:brag:preview:<token>` — already 10 min.
- `…:create-count:<subreddit>:<user>:<track>:<UTC-day>` — three-new-posts-per-track
  rate limit, not challenge data, expires at UTC midnight.
- Creation and result locks.
- **Car unlocks** (`recordHeadToHeadPost` / `recordHeadToHeadWin`, `car-unlock-store.ts:60`, `:76`) — decision: keep as-is. Progression, same bucket as Campaign; the challengeId is a dedup key so one win can't count twice.

---

## Part 2 — Rename to `head-to-head`

Mechanical, but touches ~35 files. Do it as a **separate commit** from Part 1 so the storage change stays reviewable.

### Server file renames

`src/server/head-to-head-{model,store,service,post,replay,runtime,brag}.ts` → `head-to-head-*.ts`, and `src/server/routes/head-to-head-routes.ts` → `head-to-head-routes.ts`.

### Client file renames

- `head-to-head.{html,js,css}` → `head-to-head.{html,js,css}` (update the `<link>` and `<script>` tags inside the HTML).
- Extract Head to Head out of the Campaign modules — this is the point of the rename:
  - `game/campaign/service.js:266-314` (the six `*HeadToHead*` functions plus the `readChallengePostId` / `challengePostIdentityBody` helpers) → new `game/head-to-head/service.js`.
  - The seven methods in `game/campaign/engine-methods.js` (`loadChallengeLobby`, `startHeadToHead`, `handleHeadToHeadWin`, `previewHeadToHead`, `confirmHeadToHead`, `previewHeadToHeadBrag`, `confirmHeadToHeadBrag`) → new `game/head-to-head/engine-methods.js`, registered in the `Object.assign` at `game/engine.js:823` next to `campaignEngineMethods`.

### Identifier and wire-value map

| from | to |
|---|---|
| `HeadToHead*` types/functions | `HeadToHead*` |
| `headToHead*` locals/params | `headToHead*` |
| `HEAD_TO_HEAD_POST_TYPE = 'head-to-head'` | `HEAD_TO_HEAD_POST_TYPE = 'head-to-head'` |
| `CAMPAIGN_ID = 'numbered-v1'` | **delete** — duplicate of `CAMPAIGN_ID` in `game/campaign/manifest.js`; import that instead (`head-to-head-runtime.ts` already does) |
| `HEAD_TO_HEAD_REPLAY_FORMAT = 'MINIRACER-CHALLENGE-REPLAY-V1'` | `HEAD_TO_HEAD_REPLAY_FORMAT = 'MINIRACER-HEAD-TO-HEAD-REPLAY-V1'` |
| redis `PREFIX = 'miniracer:head-to-head'` | `'miniracer:head-to-head'` |
| routes `/api/head-to-head{,/preview,/create,/submit,/brag/*}` | `/api/head-to-head{,/preview,/create,/submit,/brag/*}` |
| client `kind: 'head-to-head'` | `kind: 'head-to-head'` |
| `devvit.json` post type key + entry | `"head-to-head": { "height": "tall", "entry": "head-to-head.html" }` |

`sourceKind` keeps `'campaign' | 'daily'` — those correctly name which feature the run *originated* in.

### Not renamed

CSS class names inside `head-to-head.css` and the lobby styles are already `challenge-*` / `challenge-racer__*`, which reads fine. Leave them; renaming them would churn `styles/` and the CSS architecture tests for no gain.

---

## Part 3 — Client: drop the stale "Your best" seat

The current branch's uncommitted poster work added a viewer seat fed by the deleted store. Remove **only** the time, keep the avatar seat and the track preview:

- `game.html` — delete the `challenge-racer__figures` block containing `challenge-viewer-time` from the `challenge-racer--viewer` div; keep `challenge-viewer-avatar`.
- `game/lobby/service.js` — drop `viewerBestTimeMs` / `viewerBestLabel` from `normalizeChallengeLobbyState`.
- `game/lobby/ui.js:560` — drop the `challenge-viewer-time` `setText`.
- `game/head-to-head/engine-methods.js` — drop `viewerBestTimeMs: response.body?.bestResult?.bestTimeMs` from the `showChallenge` call.
- Thread the new `acceptToken` from the submit response into the finish modal's `shareRequest` (`game/campaign/engine-methods.js:1200`, `shareRequest: { kind: 'challenge-brag', challengeId }` → carries the token instead).

---

## Branching

Branch from the current `feature/challenge-accept-poster` (not `main`) with `git switch -c`, so the uncommitted poster work carries over. Commit in three steps: poster cleanup → storage removal → rename.

## Files

Primary: `src/server/head-to-head-{service,store,brag,post,runtime,model,replay}.ts`, `src/server/routes/head-to-head-routes.ts`, `src/server/server-app.ts`, `src/server/daily-gp-store.ts` (one merge call removed), `devvit.json`, `head-to-head.{html,js,css}`, `game/head-to-head/{service,engine-methods}.js`, `game/engine.js`, `game/lobby/{service,ui}.js`, `game.html`.

Docs to update: `docs/system-change-map.md` (lines 247, 283, 294, 399, 474), `docs/css-architecture.md` (lines 9, 17).

## Verification

1. `npm run test` — full suite. Expect pre-existing unrelated failures only (`darkMatter` medal thresholds, track-registry expectation).
2. Rename the five `tests/*head-to-head*.test.js` files to `*head-to-head*` and update their imports; rewrite the assertions in `server-head-to-head.test.js` that expect `bestResult` (`:581`, `:625`, `:683`) to assert the accept token instead. `tests/server-campaign-store.test.js` loses its result-merge cases.
3. Grep gates — both must return zero hits outside `CHANGELOG.md`:
   - `grep -ri "campaign.challenge\|headToHead" --exclude-dir=node_modules --exclude-dir=dist .`
   - `grep -rn "readHeadToHeadResult\|writeHeadToHeadResult\|resultCollectionKey" src/`
4. Assert no un-TTL'd writes remain: every `redis.set`/`hSet` in `src/server/head-to-head-*.ts` must be followed by an `expire`, except the rate-limit counter.
5. `npm run build` and `git diff --check`.
6. Hosted Reddit/WebView check is the real gate, as it has been for every previous Head to Head change — the local static host can't reproduce Reddit's custom-post body transport. Publish a fresh Head to Head post on the dev sub, accept it from a second account, confirm: the lobby shows no "Your best", the brag comment quotes the run just finished, and after ~6 minutes the brag button no longer works while the post itself still loads and races correctly.
