# Fix the four In-game Mapmaker review findings

Updated and checked: 2026-10-01, branch `ingame-mapmaker`, code at `784fb905`.
Status: implementation plan only. Application fixes and completion checks are
pending. This workspace copy incorporates the second review of the revised
user-pasted plan; the earlier review documents remain unchanged.

## Context

The review in `docs/ingame-mapmaker-review-2026-10-01.md` found four faults on
branch `ingame-mapmaker`. We checked each one, and all four are real:

1. A stored-track load failure still gives a successful answer. For an app
   track, the game reads that answer as "use the app layout" and keeps that
   choice until a fresh authoritative mode response or page reload.
2. Overlapping cache refreshes can publish an older picture of the tracks.
3. Text typed in the Creator is lost when a save or refresh finishes. In the
   Campaign tab, the first Save click after typing does nothing.
4. After a save conflict, every later save fails.

The first plan was reviewed in
`docs/ingame-mapmaker-fix-plan-review-2026-10-01.md`. This plan applies the
correctness corrections and retains the chosen fail-closed gate with narrowly
verified exemptions. The wider outage behavior is an accepted tradeoff.

User decisions:

- Track conflict dialog: **Save mine**, **Keep both** (my draft becomes a new
  track), **Load theirs**, **Cancel**.
- The Daily list and Campaign series get the same handling, without Keep both.

Rules: one commit per stage, with no new test failures relative to the verified
baseline. Stage files by name only. Do not touch the
user's open files: `game/track/grounds.js`, `assets/share/*.jpg`, `docs/*review*`.

---

## Stage 1: Refuse answers when the stored catalog cannot load (finding 1)

`src/server/server-app.ts` `createServerApp()`:

- Mount `createTelemetryRouter()` before the gate.
- Introduce `src/server/tracks/stored-catalog.ts` with
  `ensureStoredCatalogLoaded()` and `StoredCatalogUnavailableError` in this
  stage, so Stage 1 is independently buildable. Its initial implementation
  attempts both existing loaders and reports either failure; Stage 2 replaces
  its internals with consistent snapshot loading. The middleware calls this
  coordinator, rather than keeping independent production loader calls.
- Gate: on failure, answer `503 { error: 'The tracks could not load. Try again.' }`
  and do not call `next()`. This applies on a cold process and also on a warm
  process whose refresh fails. Retries live only inside the loader (Stage 2),
  not here too.
- Scope: fail closed, with a short **exempt list** of routes we have read and
  confirmed never to read a track or series. Match exact HTTP method and path;
  start with `POST /api/analytics/race-start` and `POST /api/analytics/podium`.
  Keep `GET /api/analytics/summary` and `GET /api/analytics/guest-transfer`
  gated: their storage/evidence code reads the Campaign catalog. Do not exempt
  `/api/analytics/*` as a prefix. Add `/api/player/preferences`, `/api/player/identity` and
  `/api/podium/avatars` only after reading each handler. Why not gate a list of
  dependent routes instead: almost every route reads tracks (Daily, Campaign,
  Head to Head, scoreboard, PB ghosts, podium replays, share, Creator,
  scheduler posts). If a dependent route were left off that list, it would
  silently bring back the wrong-layout answer. An exempt route that we forget
  only fails during a load outage.

Tests (new `tests/server-stored-state-gate.test.js`, built like
`tests/server-campaign-routes.test.js` with `createServerApp` and a real
listener; mock the coordinator for gate tests and test both-loader failure
collection separately in the initial coordinator):

- Cold failure: 503, and the route service is not called.
- Warm failure, with a cache already present: 503.
- The series load fails while the track load succeeds: 503.
- Both exact exempt analytics routes and the telemetry router still answer.
- Analytics summary/guest-transfer and unknown/new routes remain gated.

## Stage 2: Publish only consistent catalog snapshots (finding 2)

The first plan's guard (`current.revision > revision`) is not enough. Two
refreshes can both read revision 1, then capture different records. All writes
change the record, the index and the revision in one transaction, so the fix
is to check the revision again **after** reading the records.

- `src/server/tracks/track-store.ts`: split the loader into
  `readTrackSnapshot(revision, cached)` (reads the index and the changed
  records, reusing cached entries) and `publishTrackSnapshot(scope, snapshot)`,
  which has no side effects until a snapshot is validated. Initialize an
  absent cache even at revision 0; for an existing cache, advance only to a
  newer revision. An equal revision reuses its existing validated snapshot.
- `src/server/campaign/series-store.ts`: the same split.
- Replace the Stage 1 coordinator internals with at most 3 attempts, covering
  transient read exceptions as well as changed revisions. Use short waits of
  50 ms and then 150 ms; do not retry at the gate too:
  1. Read both revision keys in one `mGet`. Validate that it returned the
     expected two values. Normalize an absent individual key to revision 0;
     reject malformed revision values or an unusable whole response. If both
     caches exist and match the revisions, return.
  2. Read the track snapshot, then the series snapshot.
     Validate each indexed record's presence, identity and revision; incomplete
     or unusable batch responses are failures, not evidence of no override.
     Reuse cached entries only when their indexed revision matches.
  3. Read both revision keys again. If either one changed, try again.
  4. If both are stable, publish the pair with no `await` between the two
     calls, allowing cold revision-0 initialization. Recheck the current
     pair before publication so a delayed verified pair cannot regress it.
     The coordinator is the only production publisher; remove or redirect
     independent loader publication paths. Never publish a partial pair on
     a read error or before the successful final revision check.
  5. If no attempt is stable, throw `StoredCatalogUnavailableError`. The
     Stage 1 gate turns this into a 503.
- Why this is enough: a verified snapshot matches exactly one moment in
  time, and both revisions only go up. So the newest-wins rule moves both
  caches forward together. The cache never shows a series as live while its
  tracks are still unplaced. A Campaign publication locks the tracks and
  publishes the series in the same transaction
  (`series-store.ts:377-411`). The second revision read catches a
  publication that happens between the two loads.
- The gate middleware and `placeDailyChallenge()` (`daily-gp-store.ts:792`)
  call `ensureStoredCatalogLoaded()`. Avoid import cycles by keeping the
  coordinator's store imports free of the Daily runtime and importing it
  lazily from the Daily module if necessary.
- The gate is not the final freshness boundary. A different server can commit
  today's Daily after the gate read. Existing-history returns at
  `daily-gp-store.ts:899-902` and `1114-1116` bypass `placeDailyChallenge()`.
  Refresh/validate the catalog after resolving the referenced challenge keys
  and before attaching authoritative tracks in active/playlist and other
  binding response adapters, including post-bound challenge paths. Audit
  later challenge-dependent geometry reads for the same ordering. A placed
  Redis override must not be omitted because the request's earlier cache
  still marks it unplaced. Share this response-confirmation helper rather
  than implement independent refresh logic in each route.
- Translate `StoredCatalogUnavailableError` into a retryable 503 in routes
  and internal consumers where it can arise after middleware, including
  after a placement committed. Preserve existing acknowledgement/reconciliation
  rules; a refresh failure does not roll back a committed placement.

Tests (`tests/server-track-store.test.js`, `tests/server-series-store.test.js`,
and new `tests/server-stored-catalog.test.js`):

- Equal starting revisions: the review's interleaving, with A and B both at
  revision 1 and a save and a lock between them. Afterwards
  `describePlacedStoredTracks` returns the locked entry.
- A write during one refresh: the refresh retries and publishes the newer
  snapshot.
- A Campaign publication between the track read and the series read: no
  published series is ever visible while its tracks are unplaced.
- Every attempt unstable: the loader throws, and nothing older is published.
- Older stable snapshots never replace newer ones.
- Cold revision-0 caches initialize; cache hits are scoped to the install;
  malformed revision replies never confirm an empty catalog. A transient
  track or series read error retries; exhausted errors leave the pair intact.
- Another process commits a Daily after the gate read; this request reads the
  already-created history without placing it, then returns its correct locked
  override. Repeat for playlist/post-bound responses, and assert 503 if the
  final confirmation read fails.

## Stage 3: Keep raw field text until it is committed (finding 3)

**Tracks tab** (`tools/mapmaker.js`, `tools/mapmaker/creator-track-save.js`)

- New `this.pendingMedalText: Map<trackKey, Map<tier, string>>`. Set it on
  `input` and keep the raw text, including blank or partial text. Mark the key
  unsaved right away: add it to `dirtyTrackKeys` and update the Save button
  and the status. Do not record edit history, because the medal row is not
  geometry.
- The fields stay number inputs (user decision). The browser reports
  half-typed text such as `12.` or `1e` as `''`, so a repaint at that exact
  moment can blank it. This rare loss is accepted. Blank and valid partial
  values are kept.
- On `change`, commit as today. Author time still fills the other medals only
  on commit. A successful author commit deliberately replaces the whole row
  with its suggestions and clears pending text for all four affected tiers,
  preserving the existing autofill behavior. A nonauthor commit consumes the
  named track's valid effective values and clears every pending entry actually
  incorporated, rather than only the triggering tier. Invalid values retain
  their raw text and unsaved state; never silently submit the older model.
- `syncMedalTimesPanel()`: if a tier has pending text for the shown track,
  show that text. Otherwise show the model value. This covers save repaints,
  refreshes and track switching. It needs no focus check.
- `hasCreatorUnsavedWork()` counts pending text.
  `saveCreatorTrackSnapshot()`'s `unchanged` also requires that the key has no
  pending text. Before an explicit save, commit/validate that named key's
  pending fields; unresolved invalid text prevents the request.
- `loadCreatorTracks()` explicitly captures a clone of pending text alongside
  each dirty content/history/record snapshot before calling `addCreatorRecord`
  for fetched records, then restores it with the dirty draft. A dirty flag
  alone does not preserve a map that hydration clears. Include locked and
  remotely deleted dirty drafts in this preservation path.
- Load theirs, Discard and delete explicitly clear pending text. Distinguish
  replacement hydration from refresh hydration, so `addCreatorRecord()`
  cannot inadvertently clear preserved edits. Server values show after an
  explicit replacement.

**Campaign tab** (`tools/mapmaker/creator-panels.js`)

- The name, key and medals-needed fields write the draft on `input`. The
  medals-needed field keeps its raw text in `stage.requiredMedalsText`, so a
  blank field stays blank. The value is parsed for errors and for the save,
  and the text field is dropped from the canonical server payload and
  persisted-content comparator. Keep a separate raw-edit snapshot/version
  for acknowledgement checks; a newer raw edit that parses to the same number
  still prevents clearing the draft. Blank/invalid values cannot be coerced
  into old valid values for Save or clean adoption. Each
  input sets `seriesDirty`, then calls a new `syncSeriesEditor()`. That
  function updates the heading, the derived key (only while `draft.isNew`,
  `!draft.idTouched` and `seriesSavingDraft !== draft`), the Save
  and Make live states, and each stage's error `<p>` (always rendered, hidden
  when empty) in place. Remove the `change` rebuilds, so the Save button stays
  under the pointer.
- `renderSeries()` keeps focus only for the same draft object and the same
  logical field: `series-name`, `series-id`, `stage-medals:<trackKey>`. It
  restores the caret where the browser allows it (number inputs do not).
  Updates that do not change the structure never rebuild the tab, so the
  active field is never replaced while the moderator types.
- Apply in-place updates to asynchronous `loadSeries`, `receiveViews`, and
  save start/completion/finally paths too. Merge ordinary acknowledged record
  metadata into the captured draft object, retaining newer fields when edited,
  instead of replacing its identity and losing focus. Explicit Load theirs
  and selection changes deliberately replace the draft and reset raw state.

Tests:

- `tests/creator-panels.test.js` (jsdom): input, then change: the Save button
  is still connected, and one click sends one PUT with the typed name. Do the
  same for the key and for medals-needed. A blank medals field stays blank
  through a refresh. Type during a pending `readSeries` and during a pending
  `saveSeries`. Reorder the stages, then refresh: focus follows the track.
  Load theirs replaces the typed text.
- New jsdom test for the medal panel helper, which should be extracted so it
  can be tested: blank, partial and invalid text; typing on a clean track
  during a refresh; switching tracks and back; Load theirs clears the text.
- `tests/creator-track-save.test.js`: pending text keeps the track dirty after
  a save is acknowledged.
- Author autofill clears/replaces all affected pending tiers; other medal
  commits consume the correct effective values. Refresh hydration really calls
  `addCreatorRecord` and preserves pending text. Numerically equal newer
  Campaign text survives acknowledgements. Manually chosen/in-flight series
  keys do not change while typing a name.

## Stage 4: Conflict recovery for tracks, the Daily list and series (finding 4)

**State and identity**

- Uncertain submissions: `uncertainTracksByKey: Map<key, snapshot[]>`. Add an
  immutable canonical wire snapshot when a save ends with no clear answer
  (network error, timeout, 5xx or an unusable acknowledgement body). Validate
  successful response key/id, record/revision and content shape before
  clearing entries on a confirmed 2xx for that key, or clear them on explicit
  Load theirs/Discard. A status code alone is not a usable acknowledgement.
  Deduplicate retained snapshots; do not replace earlier evidence on a retry.
  A 409
  or a 400 is a clear answer for that one request only. The Daily list and
  series keep the same state (`uncertainDailyLists`, `uncertainSeriesById`).
- Every recovery step uses the key, series id and draft object captured when
  the save started, never the current selection. A series step changes
  `this.seriesDraft` only while it is still `=== draft` (the contract at
  `creator-panels.js:600`). Keep both moves the draft with a new key-explicit
  `moveCreatorDraft(fromKey, toKey)`, not the selection-bound
  `renameTrackKey()`.
- Comparators in new `tools/mapmaker/creator-conflicts.js` compare the form
  the server stores (the trimmed name, the shape fields, `ground`,
  `draftLoop`). Compare valid medal rows after the same normalization used
  on the wire/server, including centisecond rounding: `12.345` is sent and
  stored as `12.35`. Represent absent, valid and invalid current rows
  distinctly; do not let normalization's null collapse invalid edits into
  absent data. Invalid/pending raw fields cannot enter a clean-adoption
  branch. Store uncertain submissions in canonical sent form, not the raw
  pre-normalization editor snapshot. Series comparison similarly trims names
  and projects numeric stages, excluding client-only fields; Daily comparison
  preserves key order. Use separate raw-edit acknowledgement guards for all
  three save types, through reads, dialogs and retries.

**Track save on a 409** (read the record with a new `creatorApi.readTrack(key)`):

1. The server revision equals the sent base revision: another save holds the
   write lock. Show the server message.
2. The server record is **locked**: if it equals the current content, adopt it,
   and the track is clean only if no unresolved raw edits remain. Otherwise
   go to the locked recovery (below). Never
   send newer edits automatically to a locked original.
3. The server record equals the current content: adopt the record. The track
   is clean only if no pending/invalid raw edits remain and the captured draft
   is still unchanged at adoption. Reuse the normal acknowledgement guard.
4. The server record equals an uncertain submission: adopt the revision, then
   send the save once more. Compare its answer again, with no loop.
5. Anything else: open the dialog with **Save mine** (adopt the revision, then
   save), **Keep both**, **Load theirs** or **Cancel** (no change; the next
   Save asks again). The message says who saved and when.
- 404 (deleted elsewhere): for a custom key, **Save mine** (create it again
  with base 0), **Discard mine** or **Cancel**. For an app key (a migrated
  copy, which the server refuses to recreate, `track-store.ts:357`), **Keep as
  a new track** (copy naming), **Discard mine** or **Cancel**.
- Keep both: name the copy "‹name› copy", numbered if that is taken, never a
  `TRACKS` or current Creator key, at most 40 characters. Reserve suffix room
  before truncation, derive a valid 3-to-40-character track key, and handle a
  remote name collision without losing either draft. Materialize the effective
  medal row from `medalRowByKey` or `medalTimes[fromKey]`, then move the draft
  (track, drawing, medal row, pending text, history) to the new key. The new
  key has its own original-key identity and base revision 0; original server
  metadata/revision/locks never follow it. Load theirs on the original, then
  commit/validate the copied key's raw fields before saving. If validation or
  the copy save fails, retain the copy as unsaved; do not silently save an
  older medal row while displaying newer raw text.

**Locked recovery, reachable without a save**

- A refresh that finds a dirty track locked (`mapmaker.js:3490`) keeps the
  draft visible but read-only, as today. The lock note
  (`#creator-lock-note`) then shows two buttons: **Keep my changes as a new
  track** and **Load the locked version**. They use the same functions as the
  dialog. The original stays unchangeable.
- `creatorRecords` stores metadata, not the authoritative geometry. Retain a
  separate full fetched server record or call `readTrack(key)` again before
  loading the locked version; do not mistake the visible dirty shape for
  theirs. Recovery buttons must remain enabled outside the edit-control lock,
  while pending writes/recovery disable duplicate actions.

**Daily list and series** (`saveDaily()`, `saveSeries()`)

- On a 409, read the server version (`readDaily`, `readSeries`, find by id),
  update authoritative publication metadata for series, check fixed-field
  compatibility, then apply equal-to-current with raw-edit guards ->
  equal-to-an-uncertain-submission (retry compatible newer content once) ->
  dialog with **Save mine**, **Load theirs** or **Cancel**. Daily saves have
  no publication lock, but still revalidate the latest-list constraints.
- A deleted series: **Save mine** for a custom id, or **Discard mine** or
  **Cancel**. Do not offer Save mine for an app series id, because the server
  refuses it (`series-store.ts:286`).
- A published series is partially immutable, not fully locked: its ground
  and published stage prefix stay fixed, while compatible name edits and new
  stages may be saved. Merge authoritative publication metadata into recovery
  and offer Save mine only for compatible content; incompatible fixed-field
  edits remain unsaved with a clear choice to load theirs or cancel. Do not
  categorically block saving a published series.
- If a track locks after the conflict read, a PUT can still reach the server.
  The server's atomic placement/revision/lock checks must reject it without
  durable mutation. Re-read after rejection and show locked recovery. Do not
  promise that client timing alone prevents sending the request. Repeated
  conflicts return to explicit choices; automatic retries stay bounded.

**Shared UI and text**

- `<dialog id="choice-dialog">` in `pages/map-creator.html`, using the same
  markup as `#confirm-dialog`. `chooseAction({ title, message, choices })` in
  `tools/mapmaker.js` returns the chosen value, or `'cancel'` on Escape. It is
  passed to `CreatorPanels` as `choose`. `flex-wrap: wrap` for the Creator's
  dialog actions in `pages/map-creator.css`.
- Remove "Open it again…" from the six `TrackConflictError` texts
  (`track-store.ts`, `series-store.ts`, `daily-schedule-store.ts`).

Tests (`tests/creator-track-save.test.js`, `tests/creator-panels.test.js`):

- For each of tracks, the Daily list and series: A is committed but its answer
  is lost; the moderator edits B; the retry of B gets a 409; the client adopts
  A's revision and sends B once, with no dialog.
- The server equals current -> clean. A real conflict -> each choice. Cancel
  keeps the draft. A second conflict asks again.
- The selection changes while the conflict read is pending: the right draft
  is saved, and no other draft is marked saved.
- Locked after a refresh: the lock-note actions keep the draft as a copy or
  load the locked version. The track locks between the conflict read and the
  automatic retry: no durable mutation, and the locked recovery opens. A PUT
  may have been attempted; assert the server state, not zero HTTP requests.
- Keep both, with a failed copy save: the copied draft stays.
- A deleted app-key copy: Save mine is not offered, and Keep as a new track
  works.
- Lost acknowledgement with fractional medal input recognizes its normalized
  saved content. Server-equals-model with pending raw text stays dirty. Keep
  both inherits baseline medals and saves committed raw edits; invalid raw
  edits leave the copy unsaved. Published-series recovery respects the fixed
  prefix while allowing compatible changes. An unusable 2xx body retains
  uncertain evidence instead of marking Saved.

---

## Verification (each stage)

- Baseline before Stage 1: `npx vitest run --reporter=json
  --outputFile=<scratchpad>/baseline.json`, run outside the sandbox. After each
  stage, compare the **failing test full names and their counts**, not the
  file names. Today's failures are in `tests/medals.test.js`,
  `tests/track-grounds.test.js` and `tests/track-runtime-integrity.test.js`.
  Any new failing test name, additional failure count, changed assertion/error
  details or new unhandled runtime error requires investigation as a possible
  regression; an unchanged name does not excuse a different failure.
- `npm run typecheck` stays at 0.
- Bundles: every client entry (memory: vitest-misses-build-errors), plus
  `tools/mapmaker.js` and `pages/map-creator-expand.js`, plus the server:
  `npx esbuild src/server/index.ts --bundle --platform=node --format=cjs
  --packages=external --outfile=<scratchpad>/server.cjs` (the configured
  Devvit server artifact is `index.cjs`). Do not run
  `vite build`.
- HTML/CSS integration: verify the playtest watcher is running and has logged
  a fresh successful build for the current source changes before inspecting
  `dist/client`. Do not assume an old watcher or stale artifacts prove a build.
  After each stage with UI changes, inspect the built Creator entry, script and
  stylesheet references; after Stage 4, confirm `#choice-dialog` and the wrap
  rule. Check the configured server watch output too. esbuild alone does not
  validate these integration paths. If the existing playtest watcher is
  unavailable, record this gate as pending instead of claiming completion.
- Native checks in `devvit playtest` by the user. They gate completion,
  because jsdom cannot prove the native blur and click order, and API mocks
  are not allowed:
  1. Type a series name and click Save once. It saves.
  2. Start a track Save, then type in Gold before it ends. The text stays, and
     the status says unsaved.
  3. Edit one track in two tabs and save both. The second tab gets the
     four-button dialog. Try Keep both, Load theirs and Cancel.
  4. Lock a track that has unsaved changes (place it as the Daily), then
     refresh. Use "Keep my changes as a new track". The copy is still there
     after a reload.
  5. Lost answer: interrupt the first editor's response and confirm it shows
     an unconfirmed/failed save. In a second online Creator view, verify that
     submitted A actually reached the server. Only then edit B in the first
     editor, reconnect and save. It saves B with no dialog. Going offline
     after clicking Save alone does not prove the lost-acknowledgement case.
  6. Clear or enter partial medal text during a save/refresh, switch tracks
     and return: the raw text survives and remains unsaved. Load theirs
     replaces it. Repeat with Campaign requirements and a numerically equal
     newer raw edit. Confirm ordinary author autofill still behaves as before.

## Review outcome and implementation boundaries

The combined revision-bracketing design addresses the earlier equal-revision
and cross-store publication interleavings, provided publication is centralized
and only validated complete snapshots are installed. The installed Redis
client sends a single MGet RPC, matching the design's paired-revision read.

The second review added exact analytics exemptions, final confirmation after
existing Daily resolution, post-gate 503 handling, cold-cache initialization,
explicit raw-text preservation through hydration, canonical uncertain-write
comparison, copied-draft medal materialization and server-enforced lock-race
assertions. These are requirements for implementation and its regression
tests, not claims that application fixes have already passed.

This update changes only this plan document. Existing review documents and
unrelated dirty ground/share-picture files stay untouched. No stage is
implemented, committed, pushed or deployed by this planning task. Native
playtest completion remains pending until the real installation checks run.
