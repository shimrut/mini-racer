# Creator tracks in Redis: plan

Date: 2026-09-30. Branch: `ingame-mapmaker`. Status: all stages built and
tested locally. The checks on a real Reddit post are still open (see the end).

## Goal

The owner makes tracks and Campaign series in the Reddit Creator, on any device.
The owner adds tracks to the Daily list and to new Campaign series. No app
release is necessary for a new track or a new series.

## Scope

- **Stays in the app, with no change:** the live Campaign (Numbers) and every
  played or in-play track.
- **Goes to Redis:** new tracks with their medal times, the Daily list,
  unplayed built-in tracks (future Daily tracks and stages of unpublished
  series), and new Campaign series.
- **Not visible to players:** Community maps.
- **Skipped:** Daily post share pictures. A Daily post without a picture works.

## Rules

1. Redis is per subreddit install. Each install has its own stored tracks.
2. The game and the server look up a track in Redis first, then in the app.
3. A stored track is locked when it becomes a Daily, when its series is
   published, or when a race result exists. The server refuses edits to a
   locked track and refuses to delete it.
4. A copy of a built-in track must have the same fingerprint as the app copy.
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
