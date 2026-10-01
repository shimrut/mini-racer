# Creator tracks in Redis: plan

Date: 2026-09-30. Branch: `ingame-mapmaker`. Status: all stages built and
tested locally. The checks on a real Reddit post are still open (see the end).

## Goal

The owner makes tracks and Campaign series in the Reddit Creator, on any device.
The owner adds tracks to the Daily list and to new Campaign series. No app
release is necessary for a new track or a new series.

## Scope

- **Goes to Redis, editable:** new tracks with their medal times, the Daily
  list, unplayed built-in tracks (future Daily tracks and stages of
  unpublished series), and new Campaign series.
- **Goes to Redis, locked (2026-10-01):** the tracks of past Dailies, and the
  live Campaign (Numbers) with its stage tracks. A played track never
  changes, so its copy is locked when it is written. A track whose Daily
  players can still race waits for a later copy.
- **Stays in the app until a later release:** the app keeps every track and
  Numbers as a fallback. A release about a month later removes the app
  tracks (see "Removal release" below).
- **Not visible to players:** Community maps.
- **Skipped:** Daily post share pictures. A Daily post without a picture works.

## Rules

1. Redis is per subreddit install. Each install has its own stored tracks.
2. The game and the server look up a track in Redis first, then in the app.
3. A stored track is locked when it becomes a Daily, when its series is
   published, or when a race result exists. The server refuses edits to a
   locked track and refuses to delete it.
4. A copy of a built-in track must match the app track exactly: the whole
   race shape, the name and the four medal times. The ghost fingerprint is
   not enough, because it leaves out the corner rounding. A copy that does
   not match is not written.
5. Only moderators can use the Creator routes. The server checks each request.
6. Players can read a stored track only when it is placed: in the Daily
   history, today's Daily, or a published series.
7. A track must be complete before it enters the Daily list or any Campaign
   draft: finished walls, no unfinished drawing, passing geometry checks,
   and positive author/gold/silver/bronze times in that order. Assigned tracks
   must remain complete when saved. Remove an editable placement first to
   save unfinished work. Daily admission also requires a live ground;
   existing held-back app schedule entries retain their release gate.
8. Track edits and placement changes share an ownership-fenced Redis lock.
   Daily history and its stored-track lock commit together; Campaign
   publication and all its newly live track locks commit together. An
   interrupted transaction must not create a partially placed competition.
   Requests that open a new Daily together get the Daily that the first one
   commits. They wait for it; they do not make a second one.
9. Ranked starts confirm the authoritative layout, including overrides of
   built-in keys. Failure requires Retry before racing. Geometry determines
   cache identity; an active attempt keeps its walls, and a changed definition
   requires a new attempt before ranked results can save.
10. Save acknowledges the submitted snapshot, even after editing or selecting
    another track/series. Newer edits remain unsaved. A failed embedded Test
    Drive may navigate only when every track, drawing and panel is saved and
    no write is pending.

## Stages

Each stage is one commit, with the tests green.

1. Hide Community from players.
2. Shared track overlay: the catalog, the track registry, the medal times and
   the client track loader read stored tracks first. No change while the
   overlay is empty.
3. Server track store in Redis: save, list, read, lock, delete while unlocked.
   A per-request loader fills the overlay for the current install. Moderator
   routes and a player route for placed tracks.
4. Client loading of stored tracks: metadata on demand, geometry on demand,
   also in the launcher pages (preview, podium, Head to Head).
5. Daily list in Redis: the Daily pick reads the stored list when it exists,
   and locks the track that it picks. Moderator routes to read and edit it.
6. Creator: game tracks instead of Community maps. Track list, medal times,
   Daily list screen, phone layout and full-screen view.
7. Migration button: reads the live state, copies unplayed tracks with their
   medal times, the Daily list and the unpublished series, checks each
   fingerprint, and shows a report. It does nothing twice.
8. Campaign series in Redis: Campaign Planner in the Creator; the game and the
   server read published stored series next to the app series.

## Redis keys (per install)

- `dailygp:tracks:v1:track:<trackKey>`: one stored track (shape, name,
  ground, medal times, lock state, fingerprint).
- `dailygp:tracks:v1:index`: the stored track keys.
- `dailygp:tracks:v1:revision`: changes on every write; servers reload their
  cache when it changes.
- `dailygp:daily:schedule:v1`: the stored Daily list.
- `dailygp:campaign:series:v1:<seriesId>`: one stored series.
- `dailygp:tracks:v1:placement-write-lock:v1`: coordinates admission,
  authoring changes, and immutable placement commits.
- `dailygp:tracks:v1:migration-lock`: one copy runs at a time.
- `dailygp:tracks:v1:migration-report`,
  `dailygp:tracks:v1:copy-report:played-dailies:v1` and
  `dailygp:tracks:v1:copy-report:live-campaign:v1`: the last run of each copy.

## The three copies

The Creator's Copy tab has one button per copy. Each copy shows what it
would do now and the report of its last run. A second run copies only what
the first run did not copy. All three wait a few minutes around midnight UTC.

1. **Unplayed tracks:** the tracks nobody has raced, the Daily list and the
   hidden series. The Creator can change these copies.
2. **Played Dailies:** the tracks of past Dailies (the stored history and the
   fixed table of the first days), locked with the reason `daily`. A track
   whose Daily players can still race waits. A live Campaign stage goes with
   the Campaign copy.
3. **Live Campaign:** each live app series, published with all its stages,
   and its stage tracks locked with the reason `series`. One transaction
   writes the series and its tracks. The game still reads Numbers from the
   app; the Creator does not list the copy for editing.

Saved times, leaderboards, PB ghosts, podiums and Head to Head posts find a
track by its key. The server already reads a stored track first. An exact
copy therefore changes nothing for players.

## Check and undo of the copies

The Copy tab has a **Check copies** button, and each copy runs the check
when it ends. The check reads Redis again and compares each copy of an app
track and app series with the app:
- **Exact:** the copy races like the app version.
- **Changed in the Creator:** an unplayed copy that a moderator changed
  before anyone raced it. This is allowed.
- **Problem:** players raced the app version, but the copy differs from it.

The check also compares the Daily list with the app list, and lists the
raced tracks and live series that have no copy yet. The last check shows on
the Copy tab. The server logs one `[track-copy]` line for each check, and
one for each problem.

Each copy has an **Undo copy** button. While the app still has its tracks,
an undo removes only the Redis copies that are still exactly the app
version, so players race the same tracks from the app. Saved times, ghosts
and leaderboards stay valid.
- **Unplayed:** the app Daily list comes back if nobody changed the list,
  and the hidden series drafts and the exact track copies go. This includes
  a copy that a Daily locked since.
- **Played Dailies:** the locked copies go.
- **Live Campaign:** each series copy goes with its stage tracks, in one
  transaction.

A copy that changed since stays, and the undo report says why. Undo is the
only way a locked track leaves Redis, and only as an exact copy. After the
removal release, an undo keeps every copy, because no app version is left
to compare with.

## Removal release (later)

After the three copies, every track is in Redis, and every new Daily uses
its Redis copy. The release that removes the app tracks needs:

1. A "ready to remove" check in the Creator: every app track has a locked,
   exact Redis copy, and each live app series has its copy. Run it on
   r/MiniRacerGame and on every dev install just before the release.
2. An export of each install's stored tracks to a file, and a restore.
3. The removal: the track files and their medal times leave the app; a
   track missing from Redis becomes an error, not a fallback; Numbers is
   read from its Redis copy; the tests get their own track data.

## Safety fixes before first release

No Creator tracks have been created or copied in production. These fixes
prevent inconsistent new state; they do not migrate player results or repair
legacy Creator data. Existing Numbers stages and replay fingerprints remain
unchanged.

Regression coverage must delay acknowledgements while editing/switching,
interleave admission/publication with track saves, expire lock ownership,
abort transactions, lose a successful commit's response, and hydrate changed
built-in geometry on an already-open Daily post. Browser checks must include
unfinished medal input surviving refresh and other drafts surviving a failed
Test Drive frame.

Progress on 2026-09-30:

- Done in three commits: layout confirmation before ranked starts; complete
  tracks only, the placement lock, and atomic Daily and Campaign placement;
  Creator save acknowledgements and the Test Drive guard.
- The typecheck passes, and every client and server entry bundles.
- The full suite passes, except three tests outside this work: two that
  already fail on tracks without medal times, and one for a dirt speed
  change that is not committed.
- On the local server, a mock Daily starts, races and restarts on desktop
  and phone sizes. The Creator page loads without errors.
- Open: the Creator browser checks above and the Reddit checks below. They
  need the Creator routes, so they need a test subreddit install.

## Open checks on Reddit

These need a real subreddit install. Do them in the test subreddit first.

1. The Creator post opens from the moderator menu. **Open Creator** opens
   the Creator full screen, on desktop and on a phone. The post is not
   removed, because Reddit will not expand a removed post.
2. Save, delete and the Daily list survive a reload of the post.
3. Test Drive opens in its frame and records laps for the medal times.
4. The copy button copies the unplayed tracks and the lists, and the report
   shows no failures.
5. A stored track becomes the Daily at midnight UTC, locks, and players can
   race it and submit times.
6. A published series appears in the Campaign, with the series screen, and
   players can race and unlock its stages.
7. Concurrent moderator edits and midnight placement either commit a complete
   immutable version or return a retryable error. Players who open the new
   Daily together all get the same Daily. Failed layout requests block ranked
   starts until Retry confirms the correct version.
8. The three copies run on the test subreddit, and a past Daily, its podium
   and a Numbers stage still race and show their leaderboards and ghosts.
