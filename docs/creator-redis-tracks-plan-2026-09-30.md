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

## Open checks on Reddit

These need a real subreddit install. Do them in the test subreddit first.

1. The Creator post opens from the moderator menu, and **Open Creator** opens
   the full view on desktop and on a phone.
2. Save, delete and the Daily list survive a reload of the post.
3. Test Drive opens in its frame and records laps for the medal times.
4. The copy button copies the unplayed tracks and the lists, and the report
   shows no failures.
5. A stored track becomes the Daily at midnight UTC, locks, and players can
   race it and submit times.
6. A published series appears in the Campaign, with the series screen, and
   players can race and unlock its stages.
