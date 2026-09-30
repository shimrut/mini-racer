# Community map creator: options and recommendation

Date: 2026-09-30. Status: moderator-first implementation on `ingame-mapmaker`;
hosted Reddit verification remains before release.

## Implemented first slice

- The **Open Mini Racer Creator** moderator menu action opens a dedicated
  `map-creator` post and desktop editor. Creator API routes check moderator
  membership; touch devices show a desktop-only message. The existing local
  and online developer Mapmaker remain separate.
- `GET`/`PUT /api/creator/draft` save one active Redis draft per moderator.
  The editor uses explicit Save, acknowledges the server result, keeps failed
  saves visibly unsaved, and recovers a saved draft after reopening. It uses
  the shared Mapmaker geometry and checks. Test Drive stores a completed lap
  signature for the exact saved layout; an edit invalidates it.
- `POST /api/creator/publish` rechecks bounded geometry and that completed
  lap signature, then records an immutable map ID and snapshot. Creator map
  listing and status routes allow moderators to unpublish and restore maps.
  The public `GET /api/community/maps` list and `/api/community/maps/:id`
  detail expose published snapshots only. Redis keys and pagination are
  implemented in `src/server/community/community-map-store.ts`.
- The game's **Community** entry browses published maps with author credit and
  starts a one-lap unranked race from the immutable snapshot. The finish shows
  elapsed time and Retry/Community actions, without persistent PBs, medals, or
  leaderboards. There is no editor entry in the game.

Local verification: focused Creator, server, and Community tests pass;
TypeScript check and Devvit build pass. The built desktop Creator and mobile
desktop-only notice were inspected in a browser. Mocked API browser checks
covered failed Save, retry, reopening a draft, Test Drive navigation, and
loading a published Community map into a race on desktop and mobile. Hosted
Reddit checks remain necessary for custom-post navigation, moderator identity,
Redis persistence across sessions, and publish/unpublish against a real
installation. The full local suite currently has three unrelated failures:
existing catalog medal thresholds, catalog integrity expectation, and the
already edited dirt/snow ground-speed ordering.

## Intended product boundary

- Put **Create maps** in its own Reddit/Devvit tool, opened from a separate
  subreddit moderator menu action. It is a desktop authoring surface, with no
  editor link or editor controls in the game. A phone opening the tool gets a
  clear desktop-only message. Community play should work on mobile.
- Put published maps in a **Community** area of the game for browsing and
  racing. Keep draft, review, and authoring controls out of that area.
- Treat promotion into Daily or Campaign as a separate curator action, not as
  a consequence of publishing to Community.

This updates the [2026-09-23 investigation](./community-mapmaker-investigation-2026-09-23.md).
Its proposed in-game editor and mobile authoring flow no longer fit the request.
Its description of weak gate/road checks is also stale: the current Mapmaker
places gates against the finished walls and performs structural checks
(`tools/mapmaker/auto-gates.js`, `tools/mapmaker/track-quality.js`, and
[Track Authoring](./track-authoring.md)).

## First usable release for moderators

The first complete slice should let a moderator create a map, recover the
draft after leaving, finish a Test Drive lap, publish an immutable map, and
find and race it in Community. It should not stop at an editor that can save
drafts but has nowhere to play the result.

1. Add **Open Mini Racer Creator** to the subreddit moderator menu. It opens
   a dedicated desktop-only Devvit custom-post page in the existing app. The
   server checks moderator membership on the menu action and every creator
   API request. There is no editor link in the game.
2. Reuse the Mapmaker's new-track drawing, editing, checks, undo, and Test
   Drive. Keep built-in track integration, Campaign Planner, shared cloud maps,
   passcode controls, and editing a published map out of this surface.
3. Store one active draft per moderator in Devvit Redis. **New Track** must
   ask before replacing an unfinished draft. Show **Saving**, **Saved**,
   or a persistent save error based on server acknowledgement. A failed save
   must leave the draft editable and visibly unsaved. Reopening the tool loads
   the last saved draft. The client must never claim a save succeeded because
   it merely wrote browser storage.
4. Require structural checks and one completed local Test Drive lap before
   **Publish** becomes available. The server reruns the shared geometry checks
   with strict size and coordinate bounds before storing the map. Do not trust
   the editor's green check alone. Any layout or rules edit invalidates that
   completed lap. Publish creates an immutable ID and snapshot; later changes
   start a new draft. Moderators can unpublish and restore a map without
   destroying its record.
5. Add a paginated **Community** browser in the game and load the stored
   snapshot by immutable ID. Everyone can race it on desktop or mobile. For
   this first release, the race shows a finish time but is explicitly
   **unranked**: no leaderboard, medals, persistent PB, or Author time. That
   avoids implying server-verified results before the dynamic replay path is
   ready. Start with one-lap maps; add other lap counts with ranked play.

There is no contributor grant, approval queue, user-facing creator menu, or
Daily/Campaign promotion button in this release. Moderators are the only
authors and can publish directly. The server still needs authorization,
bounded payloads, and validation because a moderator's browser can send bad
data accidentally. Before calling this usable, verify draft recovery and
publish/unpublish in a hosted Reddit desktop post, then race the same map on
desktop and mobile and confirm a rejected geometry cannot reach Community.

## What can be reused

The repository already has a separate Mapmaker and Test Drive at
`miniracer.club/mapmaker`. `tools/build-site.js` bundles the editor from
`tools/mapmaker.html`; `site/functions/_middleware.js` guards it with one
passcode, and `site/functions/api/maps/*` stores drafts in Cloudflare KV.
That gives us the canvas, geometry editing, checks, and driving preview.
The current online save accepts unfinished maps; everyone with the passcode
shares the same cloud list. It has no Reddit author ownership or publication
workflow. Test Drive keeps lap times, not replay inputs. Those pieces need new
adapters and server validation before community publication. Do not expose
the passcode or the shared KV list to community authors.

The Devvit build currently excludes `tools/*` (`devvit.json`). Editor code
needed by Devvit and track validation needed by the server should move into
shared modules, with the local and online developer Mapmaker using them too.
The current source loop is not retained as a canonical saved input after
building a road. We must choose either a versioned, deterministic source
format that the server can rebuild, or a bounded full-geometry format that the
server validates independently. The earlier investigation's proposed
centerline-only publish payload cannot be assumed to work with today's editor.

## Reddit entry and author access

Use **another entry point in the existing Mini Racer Devvit app**, rather than
a second installed app. App Redis data is scoped to an installation, so a
second app would need a separate cross-app service to share community maps
with the game. A subreddit menu action can return `navigateTo` for a dedicated
custom post, as the current Analytics tool does (`devvit.json`,
`src/server/routes/internal-routes.ts`, and
`src/server/moderator/moderator-analytics-post.ts`). The editor should have its
own page, post type, and API routes. Keep one persistent editor host post per
subreddit so creators do not have to publish Reddit posts merely to use the
tool. A separate moderation/review panel can be added later; it is not the
editor. Current Devvit documentation describes menu navigation to a custom
post, but does not establish a direct menu-to-postless webview route.

Devvit's menu configuration offers `forUserType: moderator` or `user`. The
`user` choice is visible to all users; there is no approved-user or flair
visibility mode. Every editor route, including opening drafts, saving,
submitting, and moderation actions, must check the acting Reddit account and
subreddit on the server; logged-out callers cannot save maps. Fail closed if
the identity or Reddit membership lookup fails. Menu visibility is only a
presentation control. The existing Analytics menu route is a pattern for
navigation, but its data-route moderator checks are the security pattern to
follow.

| Access route | How it is granted in Reddit | Tradeoff |
| --- | --- | --- |
| Moderators only | Existing subreddit moderator membership and a moderator menu item | Smallest first release; no nonmoderator creators. |
| Reddit approved users | Mods & Members → Approved users; check `getApprovedUsers({ subredditName, username })` on each request | Native Reddit management, but approval also affects subreddit posting privileges and the author menu still appears to everyone. |
| Moderator-assigned user flair | Moderators grant a non-user-editable creator flair; read the author's subreddit flair | Familiar visible badge, but current Devvit exposes flair text/CSS class rather than a stable template ID; renames and flair settings make it a brittle authorization source. |
| App creator list | Moderators grant/revoke access from a dedicated Reddit-hosted moderator panel backed by Redis | Precisely scoped to map creation, but requires a small access-management UI instead of Reddit's native Approved users list. |

**Recommendation:** start with moderators only. If other creators are needed,
use Reddit Approved users when its broader posting privilege is acceptable;
otherwise add an app creator list managed from the moderator panel. Use flair
as a badge, not as the sole permission check. A later `forUserType: user` menu
entry can take all users to the creator post and show a clear access message to
non-creators, while the server enforces the actual permission. The existing
Analytics host post is removed after creation; do not assume a removed post
will open for nonmoderators. Test contributor access on Reddit and use a
visible workshop post if necessary.

Official sources: [Devvit menu actions](https://developers.reddit.com/docs/capabilities/client/menu-actions),
[Devvit Web configuration](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration),
[custom posts](https://developers.reddit.com/docs/capabilities/creating_custom_post),
[logged-out identity](https://developers.reddit.com/docs/guides/logged-out-users#detect-user-state),
[Reddit user actions](https://developers.reddit.com/docs/capabilities/server/userActions),
[Reddit approved users](https://support.reddithelp.com/hc/en-us/articles/15484466715284-User-Management-approved-users),
[Reddit user flair](https://support.reddithelp.com/hc/en-us/articles/15484503095060-User-Flair),
and [Devvit Reddit API](https://developers.reddit.com/docs/api/redditapi/RedditClient/classes/RedditClient).

## Storage and publication options

**Recommended storage: Devvit Redis for per-author drafts and immutable
published map records.** It keeps identity, community gameplay, and review
state in the same app installation. Store bounded source/geometry, metadata,
author Reddit ID, schema/rules version, status, and creation time. Use opaque
map IDs; keep the display name separate so a name change or collision cannot
replace another author's map. Index drafts by author and published maps by
community/status. Cap draft count, payload size, point count, and publication
rate; measure actual Redis usage before opening authoring widely. The current
[Redis documentation](https://developers.reddit.com/docs/capabilities/server/redis)
states a 5 GB per-install limit and a 5 MB request limit. The game's Redis
usage will also include race results and ghosts, so map count alone is not a
capacity estimate.

Cloudflare KV remains suitable for the existing passcode-protected developer
workflow. Using it for Reddit creator drafts would require separate Reddit
identity and authorization across services and would not by itself make maps
available to the game's Devvit server.

For a creator release, save drafts across sessions in Redis, show a Test Drive,
and submit an immutable snapshot. On submission the server must validate the
bounded geometry, start/checkpoint order, road clearance, lap feasibility, and
version against shared code. If an Author time or medal thresholds will be
shown, add replay input recording to Test Drive and verify that run on the
server; today's Test Drive lap time is not proof. A moderator approval step is
the safer default when nonmoderators can submit. Keep rejected drafts editable
and let authors see the reason. Published maps can be unlisted or restored by
moderators without losing the author or race records.

Community racing is a second integration step. The current game client rejects
keys outside its built-in catalog (`game/track/client-registry.js`), Daily
parsing also expects catalog tracks (`src/server/daily/daily-gp-store.ts`),
and the shared competition model currently has Daily and Campaign modes.
The Community loader and replay validator must both use the same immutable
stored track version. Reuse the competition/leaderboard machinery only after
that track resolution is explicit; do not inject community IDs into the static
catalog. Start the Community browser with paginated approved maps and author
attribution, then add per-map standings once server-verified racing is wired.

## Daily and Campaign promotion

| Option | Mechanism | Assessment |
| --- | --- | --- |
| Curated import and release | Export the approved immutable map into the local Mapmaker, run checks/Test Drive, save it into the built-in catalog, assign Daily or append a Campaign stage with Campaign Planner, then release the app | Recommended first path. Existing schedule, stage, and replay contracts stay intact. Preserve creator credit and a link to the source community map; keep Community results separate from Daily/Campaign results. |
| Direct Redis promotion | Daily/Campaign load a frozen published map version and its race rules from Redis | Faster curation after it exists, but requires dynamic client/server track resolution, versioned challenge snapshots, and Campaign progression/storage changes. This is a later project. |

Today `TRACK_SCHEDULE_KEYS` drives Daily publication and
`game/campaign/series.json` defines Campaign stages. Once a Campaign series is
live, existing stages and their lap/medal contract cannot change
([Track Authoring](./track-authoring.md)); a promoted map would be appended as
a new stage, not substituted into an existing one. Daily and Campaign
leaderboards must keep their own race identity even if the geometry originated
in Community.

## Suggested sequence

1. Extract shared editor/track validation modules and add the desktop-only
   creator entry point, moderator menu item, authenticated draft APIs, and
   Redis persistence. Keep the existing developer Mapmaker working.
2. Add server-validated moderator publishing, unpublish/restore, immutable
   records, and creator attribution. Verify the custom-post desktop experience
   in hosted Reddit.
3. Build Community browsing and unranked racing against published snapshots.
   Add server-verified standings in a later release.
4. Import selected maps into the built-in catalog for Daily/Campaign promotion.
   Expand creator access using the chosen Reddit interface after the first
   moderator workflow is proven.

Later product choices: whether nonmoderator authors use Reddit Approved users
or an app creator list, whether their submissions require review, when to add
verified leaderboards and medals, and whether Daily/Campaign promotion should
ever happen directly from Redis.
