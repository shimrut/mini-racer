# In-game Mapmaker review

Date: 2026-10-01. Branch: `ingame-mapmaker`. Reviewed through `784fb905`.

Scope: the current moderator Creator, Redis track storage, Daily and Campaign
placement, the three copy operations, client layout confirmation, editor save
recovery, and embedded Test Drive. This was a review; no application code or
existing tests were changed. The unrelated ground settings and share pictures
were preserved.

## Findings

### 1. Redis load failure can be acknowledged as the app layout (high)

`src/server/server-app.ts:326-333` logs failures loading stored tracks or
series and continues to the routes. On a cold process,
`describePlacedStoredTracks()` has no cache and returns an empty array
(`src/server/tracks/track-store.ts:164-170`). The Campaign and Daily response
adapters attach this array as `storedTracks`.

For built-in keys, the client interprets that successful empty array as
authoritative confirmation that no Redis override exists. It removes any local
override and confirms the app definition
(`game/track/stored-track-service.js:67-69`). This bypasses the intended Retry
gate for failed layout requests. On a warm process, a failed refresh can instead
leave an older cached definition in use. If the track loader throws, the series
loader is skipped too.

Reproduced with the actual Express middleware, Campaign route adapter and
stored-track resolver, mocked Redis, and a stub bootstrap service. A stored
`circuit` override existed, but a failed revision read still produced HTTP 200
with `storedTracks: []`; `TRACKS.circuit` resolved to the app definition.
This proves the middleware/response defect, not a hosted Reddit outage.

Follow-up qualification: the wrong app geometry requires a Redis copy of an
app track whose race shape differs from the app definition. Exact locked copies
of past Dailies and live Campaign tracks have the same geometry, so falling back
to their app definition does not change the layout. Missing custom tracks
instead fail client confirmation; they have no app definition to fall back to.

Recommended correction: propagate unavailable authoritative storage as a
retryable failure for track-dependent ranked routes. An empty confirmed
overlay must mean a successful read found no override.

### 2. A late cache refresh can replace a newer placed track (medium)

`ensureStoredTracksLoaded()` reads the revision, index and track records
asynchronously, then unconditionally replaces the shared install cache at
`src/server/tracks/track-store.ts:215`. Overlapping refreshes have no ordering
guard. An older read can finish after a newer read and overwrite it.

Reproduced using the real save, schedule and Daily placement functions with
mocked Redis: make an exact editable copy of built-in `smallSteps` as revision
1 and delay a read of it; save a changed name and corner radius as revision 2;
place it as the Daily, locking revision 3 and loading it into the cache; then
release the old read. Redis retained the correct locked revision 3, but
`TRACKS.smallSteps` returned the old layout and
`describePlacedStoredTracks(['smallSteps'])` returned `[]`, because the old
record was unplaced.

This is a cache/response integrity defect; the reproduction did not corrupt the
durable Redis record. A later successful refresh can repair the cache, but
requests already running can consume the regressed state. For built-in keys,
an omitted override can also be mistaken for confirmed app geometry.

The server-cache regression can end on the next successful refresh, but its
client effect is not limited to requests already running. Once an empty
authoritative payload confirms an app key, `confirmedKeys` has no production
expiry or reset. Ranked checks return without fetching at
`game/track/stored-track-service.js:116`, and cosmetic reads skip already
confirmed overrides at line 100. Reproduced by advancing the clock 30 minutes:
a ranked check made no request; a subsequent successful cosmetic read of the
correct override did not install it; another ranked check still used the app
fallback. A fresh authoritative payload repaired the client. Daily Restart
also reuses the locally known definition without a new confirmation request
(`game/daily-challenge/engine-methods.js:1385-1409`).

Medium is a reasonable assessment of the additional overlapping-read condition,
but a guaranteed short player impact is not the reason for it. A burst of
requests at Daily placement is a plausible trigger; neither its frequency nor
its likelihood relative to moderator saves/publication was measured.

Recommended correction: coordinate refreshes per install and verify the
revision before publishing a snapshot. Prevent older snapshots from replacing
newer ones or becoming authoritative within a request.

### 3. Delayed responses erase text still being typed (medium)

Medal fields use `change` events at `tools/mapmaker.js:1046-1050`; Campaign
name/key and medal requirement fields do the same in
`tools/mapmaker/creator-panels.js:423-437,468-470`. Until blur, visible edits
have not reached the model used by the save/refresh preservation checks.

When a track Save finishes, `saveCreatorTrackSnapshot()` sees an unchanged
model, clears dirty state, and calls `syncCreatorTrackState()`, which repaints
the medal inputs. Campaign refresh/save similarly recreates inputs from its
model. The protection for newer edits therefore misses focused input text.

Native Chromium reproduced both cases at 1440x900 and touch 390x844:

- Start a delayed track Save, focus Gold and type `13`, then finish the Save.
  Gold changes back to `12.00` while still focused; the status says Saved and
  the track is clean.
- Start a delayed Campaign refresh, type `Typed New Name` without blurring,
  then finish the refresh. The field returns to `Original Name` and loses
  focus. Native blur handling can mark it dirty afterward, but does not retain
  the typed name.

Follow-up native pointer check: typing a track medal time and then clicking
Save submits that new value on the first click, whether Save started enabled
or disabled. The asynchronous overwrite concerns edits made while a server
operation is pending.

Campaign does not share the same safe first-click behavior. Its `change`
handler commits the field but calls `renderSeries()` synchronously, removing
the clicked Save node before click dispatch. A direct mouse click after typing
the name, new-series key or medals-needed value sent zero PUT requests. A
second click submitted the correct value. The first click retained the text
in the draft; it did not save it. This reproduced with a previously disabled
Save button and with an already enabled one. A normal Campaign Save is
therefore also affected, without an outstanding server request.

Recommended correction: capture input edits as they occur and preserve active
field text across asynchronous paints. Cover native focus/input/change events
in regression tests, rather than only changing the backing model directly.

### 4. Refresh retains a conflicting track revision (medium)

The server tells a conflicting save to reopen the track. However,
`loadCreatorTracks()` reloads server records and then replaces the fresh
metadata with the old record for each dirty unlocked track at
`tools/mapmaker.js:3490`. `openCreatorTrack()` only selects the existing local
track. Neither action resolves the outdated revision used for the next Save.

Reproduced with the actual editor methods and save helper: server revision 4
and local dirty revision 3; explicitly reload the tracks; local edits survive,
but local revision remains 3. The next Save still sends `baseRevision: 3` and
receives 409. This also applies when a successful HTTP save response is lost
after the server commits, leaving the client on the previous revision.

A complete page reload reads the current server version but drops newer
unsaved edits: Creator mode disables local draft recovery at
`tools/mapmaker.js:511-518`. If only the acknowledgement was lost and no later
edits were made, the submitted snapshot is already stored and reload recovers
it; that particular snapshot is not lost.

Recommended correction: provide an explicit conflict recovery path that
preserves the local draft while exposing the latest server version/revision.
Do not blindly retry the stale revision or silently overwrite another
moderator's changes.

## Verification

- `npm run typecheck`: passed.
- `npx vite build`: passed for client and server entries.
- Full `npx vitest run` with localhost permission: 3,682 passed, 3 failed
  across 302 files. All current Creator, stored-track, placement, copy and
  Mapmaker suites passed.
- Remaining failures: missing catalog medal rows (`tests/medals.test.js`),
  the pre-existing dirty dirt/snow speed ordering
  (`tests/track-grounds.test.js`), and an outdated appended-track list
  (`tests/track-runtime-integrity.test.js`). These match the previously
  recorded failures. They are separate from the four findings above.
- Initial sandbox run additionally had 45 localhost route timeouts from
  `listen EPERM`; the unrestricted rerun resolved those. They were execution
  restrictions, not product failures.
- Temporary storage reproductions: 2/2 passed. Temporary editor reproductions
  confirmed both input overwrites and the stale-revision retry.
- Browser checks used mocked Creator responses and actual served editor code.
  Desktop and phone had no page errors or horizontal overflow. Embedded Test
  Drive loaded, the car moved, touch steering changed its heading, and Close
  returned to the editor. The phone's transparent left/right hit areas worked.

No production Redis or Reddit writes were made. Real Reddit expansion,
moderator identity, hosted persistence, midnight placement and leaderboard/
ghost compatibility remain the hosted checks listed in
`docs/creator-redis-tracks-plan-2026-09-30.md`.

## Qualification recheck

The four causes still hold at the same commit. The changed-app-copy condition
and absence of stored-track corruption are confirmed. Neither "rare" nor
"most likely at midnight" is a measured production finding. Finding 4 is a
reasonable editor recovery priority, since one moderator and a lost HTTP
acknowledgement suffice; its relative frequency has not been measured.

This follow-up reran 57 existing tests across Creator fields/save, layout
confirmation and locked copies: all passed. Both temporary storage
reproductions passed again. A service-level reproduction established the
confirmation lifetime described above. Native desktop browser checks covered
ordinary first/second Save clicks and lost-response recovery; the server
responses were mocked, and the served editor code was unchanged.

Browser conflict sequence: server committed `Sent Edit` as revision 4; local
`Later Local Edit` stayed on revision 3 after picker reopen and explicit
refresh; retry returned 409; a full reload showed saved `Sent Edit` revision 4
with no dirty draft or recovery dialog. No application fixes were applied.
