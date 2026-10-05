# Challenge views by track — 2026-10-05

Implemented on `codex/challenge-view-analytics`, branched from
`codex/campaign-finished-screen` with existing unrelated changes preserved.

Mini Racer moderator analytics now shows one row per tracked **track**, with
**Today** and **Lifetime** periods. This replaces the earlier individual-post
listing at the user's request. Repeat views and clicks count in full; only
unique viewers are deduplicated.

## Built-in options

- Reddit's native Post Insights reports views for individual posts. Authors
  can open **See More Insights** beneath their posts, and community moderators
  can see insights for all posts in their community. This does not satisfy the
  requested in-app moderator analytics scope.
- No supported way to read those counts into the app was found in the current
  Devvit Post API documentation or the installed `@devvit/reddit` Post types
  used by `@devvit/web` 0.14.5. They expose score and comment count, but no post
  view count or Post Insights method. This is a documented API limitation;
  native insights on a particular live challenge were not inspected.
- Devvit Journeys provides app engagement analytics. Its documented dashboard
  aggregates data per app per UTC day, rather than per challenge post. Its
  guidelines explicitly forbid recording page/app views as Journey starts.
  `App.Ready` is an app readiness event, not a per-post views API.

Sources checked on 2026-10-04:

- [Reddit Post & Comment Insights](https://support.reddithelp.com/hc/en-us/articles/35363096996500-Post-Comment-Insights)
- [Devvit Post API](https://developers.reddit.com/docs/api/redditapi/models/classes/Post)
- [Devvit Journeys](https://developers.reddit.com/docs/capabilities/analytics/devvit-journeys)
- [Journeys Dashboard](https://developers.reddit.com/docs/capabilities/analytics/journeys-dashboard)
- [Devvit context and experimental logged-out ID](https://developers.reddit.com/docs/api/public-api/type-aliases/BaseContext)

## Current app paths

- Issuing a challenge uses `src/server/head-to-head/head-to-head-service.ts`
  to publish a user-authored custom post with `entry: 'head-to-head'` and
  challenge/track data embedded in trusted `postData`.
- The early poster entry in `game/head-to-head/poster-access.js` starts
  `poster-analytics.js`. Passive poster display does not need a race API read;
  counting the expanded game's `/api/head-to-head` would miss these views.
- `src/server/moderator/challenge-analytics-store.ts` owns event writes and
  track totals. `challenge-analytics-migration.ts` preserves previous per-post
  totals. Existing race/create analytics and Journeys keep their own paths.
- `pages/mod-analytics.{html,js,css}` renders the track table independently of
  the summary chart's date range. Storage estimates include current and
  retained daily buckets, lifetime families and preserved legacy data.

## Implemented behavior

| Metric | Today | Lifetime |
| --- | --- | --- |
| Views | Every qualifying poster view on this UTC day, across all posts for the track. | Every recorded view for the track, including Today and imported earlier totals. |
| Unique viewers | Distinct observed identities for this track and UTC day, across all its posts. | Distinct observed identities for this track across all posts and days. |
| Clicks | Accept Challenge and author Open Mini Racer taps today, including repeats. | Both actions since tracking began, including Today. |

Today's activity includes visits to older challenge posts. Lifetime includes
Today immediately: each event updates both buckets, and midnight UTC selects
a fresh daily key. No scheduled merge or sum of daily uniques is needed.
A returning viewer can appear in several daily counts but only once in the
track's lifetime unique count.

1. The poster reports a view for each visible episode, including repeat visits,
   background returns, restored pages and reloads. Resizes and repeat observer
   notifications within one episode do not manufacture views. A small positive
   intersection threshold (0.001) handles edge entry, and all queued entries
   are processed. Older WebViews fall back to visible-document loads.
2. `POST /api/analytics/challenge` accepts `view`, `click` and `own_open`. The
   server derives the subreddit, track, challenge type and viewer identity
   from Devvit context, ignoring client-supplied target/account data. Ownership
   uses the trusted challenger account, with post-author fallback. Author
   `click` events are also classified as own opens; another viewer's forged
   `own_open` is ignored. Event writes load neither the catalog nor migration.
3. Raw `hIncrBy` totals count repeats. `hSetNX` records hashed viewer identities
   per track/day and per track/lifetime; `hLen` supplies uniques. Signed-in
   identity uses `userId`, otherwise the experimental `loid` when present.
   Unidentified views affect totals only. Sign-in changes and anonymous IDs
   mean uniques measure observed identities, rather than guaranteed people.
   Totals precede membership writes, and reads fetch membership before totals
   and Today before Lifetime, preserving count ordering under concurrent views.
4. Both enabled poster actions report without awaiting analytics. Disabled
   buttons report nothing. Accept taps and author opens are stored separately;
   the table shows their sum, with the split in the Clicks cell's tooltip.
   Race-start events are not reused.
5. Moderator-only `GET /api/analytics/challenges?offset=0` pages an alphabetical
   track index, 25 at a time, and returns one UTC date plus Today/Lifetime
   metrics. It loads only the page's named stored definitions before names,
   preserving the cold-cache fix described below. It lists tracks with recorded
   activity; newly installed communities have an empty table until an event.
6. The UI defaults to Today and offers Lifetime, Refresh, Load more and Retry.
   Narrow screens scroll inside the table. Pagination errors preserve rows
   and the existing summary. Refresh reloads page zero. When pagination crosses
   a UTC date, the controller fetches page zero instead of mixing daily data;
   if that fails, the previous rows retain their explicit previous date.

## Storage and previous counts

New data uses `miniracer:challenge-analytics:v2:{subreddit}` with `:tracks`,
`:lifetime:counts`, `:lifetime:{track}:viewers`, `:d:{YYYY-MM-DD}:counts` and
`:d:{YYYY-MM-DD}:{track}:viewers`. Track counter fields separately store views,
Accept clicks, own opens and first tracking time. Daily counts/membership
expire at day start plus two days, a fixed deadline unaffected by repeat
visits. Lifetime counts, membership and the track index remain permanent.

Before the first moderator read, previous v1 catalogued post totals seed
Lifetime only. Their hashed viewer fields are unioned across posts to preserve
track-level uniques. Earlier clicks were Accept taps; author opens were not
tracked by v1. No day is invented for totals that carried no daily history.

The import freezes the catalogued post-to-track mapping in receipt snapshots,
including zero-count posts, with bounded catalog/receipt reads. Each post's
positive counter deltas and viewer union commit atomically with its imported
snapshot under WATCH and a bounded retry. Interrupted or concurrent imports
resume without repeating increments. Later moderator reads check only this
fixed legacy population: an old-version request finishing after the upgrade
can add its late counters/membership to Lifetime. Unchanged snapshots require
no viewer scan; changed viewer hashes are scanned in batches of 100. Completion
stops further catalog traversal, rather than assuming old requests have drained.

The v1 source keys remain intact; receipts/completion and both data versions
are included in storage accounting. Existing uncatalogued legacy posts cannot
be mapped by this import. New v2 event writes need no catalog membership.

Views should be at least identified uniques for the same track and period.
Raw clicks can exceed unique viewers when someone taps repeatedly; a strict
views >= uniques >= clicks funnel would require unique clickers instead.
App-observed events cannot recover historical Reddit views or feed exposure
where the WebView never runs. Delivery/storage failures can miss events and
never block expansion. Failed metric reads appear as errors, not false zeros.
Lifetime membership grows with identified viewers.

## Hosted failure and fix — 2026-10-05

The issued-challenges table displayed **Could not load challenge counts** on
the development installation. Hosted `mini_racer_dev` logs from
2026-10-04 20:56–20:57 UTC repeatedly show `StoredTrackNotLoadedError` in
`getChallengeAnalyticsPage`, naming `safariCircuit` and `countryRoad`.
The index was loaded, but `getTrackName()` needs a stored track's record;
the new endpoint had omitted that load. A warm cache or built-in-only local
fixture concealed the missing load. The failure happens while constructing
the response rows, after metric reads.

Added `loadStoredTracks()` for this page's track keys before name lookup.
The existing loader deduplicates keys, loads at most the page's 25 tracks,
and preserves pinned-catalog consistency and retry behavior. It does not
change event writes, stored geometry, or medal data.

A regression using the real stored-track resolver and loader reproduces the
exact error before the fix. With a cold cache, the fixed page uses stored
names for Country Road and Safari Circuit, fetches the two distinct records
in one batch, and leaves an unrelated stored track unloaded. All 53 focused
tests across analytics storage, challenge catalog and stored catalog pass.
The full `npm test` passes typecheck and reports 4,291 passed / two failed
(4,293 total), with only the two untouched medal-data failures remaining.
Production build passes with the existing Campaign JSON import warning;
`git diff --check` passes.
Evidence: `/private/tmp/dailygp-challenge-analytics-live-logs.jsonl`,
`/private/tmp/dailygp-challenge-cold-catalog-before.log`, and
`/private/tmp/dailygp-challenge-cold-catalog-fixed.log`, and
`/private/tmp/dailygp-challenge-cold-catalog-full.log`. Reading hosted logs
confirmed the cause; the fixed behavior has not yet been verified on Reddit.

## Validation of track aggregation — 2026-10-05

Focused server, migration, poster and UI coverage passes, including UTC rollover,
viewer deduplication across posts/days, author ownership, fixed expiry, import
union/idempotency/concurrency/recovery and the real stored-track cold-cache path.
Before the final legacy upgrade-reconciliation follow-up, the full serial
`npm test -- --maxWorkers=1` passes typecheck and reports
4,316 passed / two failed across 335 passing / two failing files (4,318 tests).
The two failures are the deliberately untouched Dirty Dancing / Lapin Loop
medal gaps in `tests/medals.test.js` and `tests/track-grounds.test.js`. Default
parallel and four-worker runs also hit five-second geometry-heavy timeouts;
all 65 tests in those five files pass serially. No test timeout was changed.

Chromium fixtures pass poster visible episodes, reload/resize/edge behavior,
repeat Accept and author taps, expansion during pending analytics, track-only
rows, Today/Lifetime values, 1440/390/360px layouts, pagination Retry/deduplication
and day-changing refetch failure/recovery. Screenshots and the standard game
client's author-poster state were inspected; zero page errors. Evidence:
`/private/tmp/dailygp-track-analytics-browser`,
`/private/tmp/dailygp-track-analytics-game-client`, and
`/private/tmp/dailygp-track-analytics-full-serial.log`.

Review then identified old-version writes finishing after initial import.
The final reconciliation preserves late raw deltas, identities and timestamps,
including zero-count posts, concurrent requests and lost EXEC acknowledgements.
A conditional WATCH protects an earlier live tracking timestamp. Unchanged
receipts avoid viewer scans and extra watches on active v2 totals. Oversized
HSCAN COUNT-hint results are explicitly chunked.

Final typecheck and production build pass; the existing Campaign JSON import
warning remains. The focused server checks pass all 119 tests, including
17 migration regressions. The final combined server/poster/UI run passes
all 181 tests across 11 files. Evidence:
`/private/tmp/dailygp-track-analytics-final-focused.log` and
`/private/tmp/dailygp-track-analytics-final-build.log`. Diff checks pass.

No implementation TODO remains. Hosted Reddit/Redis verification of this
version and physical-device visibility remain release checks. No deployment,
merge or push was performed.


## Commit scope — 2026-10-05

The local commit contains the challenge analytics implementation, focused
analytics regressions, this document and the Issued Challenge Analytics section
of the system change map. Existing Campaign/track/Mapmaker work stays outside
this commit. The earlier non-medal expectation/snapshot refreshes depend on
that uncommitted Campaign/track work and stay with it. The full-suite validation
above describes the existing working tree, including those changes.


The isolated HEAD-plus-staged-overlay snapshot also passes typecheck, all
181 focused tests across 11 files, and the production build. This confirms the
analytics commit does not depend on the excluded working changes. Evidence:
`/private/tmp/dailygp-challenge-analytics-commit-qa-20261005`.
