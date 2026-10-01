# Creator Copy check and Undo audit

Date: 2026-10-01. Branch: `ingame-mapmaker`, reviewed at `800bae66`.
Scope: `cbe425ce` (Check copies) and `800bae66` (Undo copy), against the
user-pasted completion report. This is an independent review; no application
code or existing tests were changed. Existing dirty ground, share-image and
review/plan files were preserved.

Follow-up: the three findings below are closed locally by `41cbc850`.
The original evidence is retained; fix verification is recorded at the end.

The buttons, routes, automatic checks, log prefixes and transactional removal
paths are present. Three reproduced issues remain. The existing passing tests
do not cover these cases.

## 1. Undo unplayed can delete a saved unfinished drawing (P2)

`src/server/tracks/copy-undo.ts:132-133` accepts a record for deletion when
`matchesAppTrack(record)` succeeds. That helper compares the race shape,
medal times and fingerprint, but not `draftLoop`. The Creator saves its open
drawing separately from the current walls
(`tools/mapmaker/creator-track-save.js:16-23`). Adding drawing points can
therefore save new authoring work while leaving the existing race shape equal
to the app.

Reproduced with actual store/migration/undo functions and mocked Redis:

1. Run the unplayed copy. Choose `centralDistrict`, whose app medal row is
   currently absent (`null`).
2. Save a Daily list that excludes it, removing its editable placement.
3. Save the same track and `medalRow: null`, with two new `draftLoop` points,
   through normal `saveStoredTrack`, starting from revision 1.
4. Revision 2 contains the saved drawing; `matchesAppTrack` still returns true.
5. Undo preview lists the track for removal. Actual Undo deletes it and does
   not report it as kept.

This contradicts the promise that changed copies stay. It loses moderator
authoring work; this reproduction did not change or delete player results.

Correction: keep copies with saved unfinished drawing content. Use a removal
predicate that accounts for Creator content as well as race equivalence.
Retain the exception that an otherwise unchanged copy may have been locked
since migration.

## 2. Publishing a legally edited hidden series creates false problems (P2)

`src/server/tracks/copy-check.ts:101-110` and `138-146` use
`isLiveAppSeries()` to decide which app definitions players previously raced.
That helper calls `getCampaignSeries()` (`series-store.ts:504-505`), which
reads the merged app/Redis catalog. A newly published Redis replacement can
thus make its originally hidden app definition count as previously live.

Reproduced through normal authoring APIs:

1. Copy unplayed tracks and hidden app-series drafts.
2. Remove `snowCircuit` from the `snow-v1` draft.
3. Change the track to tarmac with valid medal times.
4. Change the draft series to tarmac and re-add the track with two laps.
5. Publish the series, refresh the stored catalog, then run Check copies.

The check reports both `snow-v1` and `snowCircuit` as problems. These changes
were legal and occurred before publication; players had not raced the hidden
app version. The original app liveness must come from the immutable app
definition rather than the current merged catalog.

## 3. Equal medal values can fail exact comparison (P2)

`src/server/tracks/track-copy.ts:39` compares medal rows with raw
`JSON.stringify`. App/game normalization creates fields in the order
`gold, silver, bronze, author`; normal Creator saves create them in the order
`author, gold, silver, bronze`. The helper predates these two commits, but the
new check and Undo use it and expose the incorrect comparison.

Reproduced: migrate `snowCircuit`, then save it normally with its existing
track and medal values. Deep equality confirms unchanged geometry, medal
values and fingerprint. Check copies nevertheless labels it changed; Undo
keeps it with the explanation that it differs from the app version.

Correction: compare normalized medal values or canonicalize their property
order. Keep null-row handling explicit. After fixing this comparison, the
drawing safeguard in finding 1 is also necessary for tracks with medal rows;
the current false mismatch incidentally keeps those drawings.

## Confirmed safeguards

- Every new Creator endpoint checks moderator access before its work.
- Manual and automatic checks persist their report and log the
  `[track-copy]` prefix; each reported problem gets its own log line.
- A failed post-copy check returns the completed copy report plus a check
  error, rather than attempting an implicit rollback.
- Actual removals reread eligibility under the shared placement lock and
  use ownership-fenced Redis transactions. Series removal and its eligible
  stage-track removals commit together.
- Changed race geometry is retained. Exact locked-copy removal leaves the
  app fallback available in the current release.
- The midnight guard and shared migration lock are reused for Undo.
- A suspected unlocked resurrection path was ruled out with the production
  resolvers installed: after a new stored series is published, Undo may
  remove its exact app-track copy, but a later unplayed migration skips that
  live-series track after the catalog refresh.

The future removal-release behavior depends on the app definitions being
removed as described in the migration plan. That release is not implemented
by these commits and was not tested here.

## Verification and limits

- `npm run typecheck`: passed.
- Clean full `npx vitest run` with localhost access: **3,752 passed,
  3 failed, 307 files**. No temporary audit tests were included in this final
  run. The 57 tests across `server-copy-check`, `creator-panels` and
  `server-track-routes` all passed.
- Exact failing tests and assertions match the earlier local review log:
  - `medals > defines ordered thresholds for every track`: null threshold
    expected to be truthy, `tests/medals.test.js:36`.
  - `snow driving > is slower than dirt, which is slower than tarmac`:
    `0.85 < 0.85` fails, `tests/track-grounds.test.js:274`; the dirty ground
    change remains outside this work.
  - `track runtime integrity > preserves existing track data while
    intentionally extending the registry`: six extra catalog keys,
    `tests/track-runtime-integrity.test.js:112`.
- Five temporary diagnostic probes passed by asserting the incorrect
  outcomes above and the safe resurrection path. Their repository copies
  were removed; source is retained at
  `/private/tmp/dailygp-copy-check-review-2026-10-01.test.js` (three probes)
  and `/private/tmp/dailygp-undo-review-2026-10-01.test.js` (two probes).
  Their relative imports expect execution from the repository's `tests/`
  directory.
- Final suite JSON: `/private/tmp/dailygp-copy-review-clean.json`.
  The initial sandbox run hit `listen EPERM` on localhost; the unrestricted
  run resolved those execution failures.

These reproductions use actual application functions with mocked Redis.
They establish reachable code behavior, not production timing or hosted
persistence. No Reddit or production Redis writes were made. Native Copy-tab
browser behavior and the real-installation leaderboard/ghost checks remain
pending. The test claim is confirmed, but the work should not be considered
complete until the three findings and the hosted checks are addressed.

## Fix verification at 41cbc850

Follow-up requested on 2026-10-01. Reviewed the three-file correction and its
three new regression tests. No remaining actionable issue was found in these
fixes, and no application code or existing tests were changed by this review.

- **Saved drawings:** `matchesAppTrack()` rejects a nonempty `draftLoop`.
  Both Undo preview and the deletion-time reread use that same predicate.
  The original `centralDistrict` reproduction with a null medal row now
  lists the record as kept and preserves the saved drawing after actual Undo.
  The new committed test also covers a saved drawing with non-null medals.
- **Original app liveness:** `isLiveAppSeries()` uses the app definition's
  ground and stage-count rules rather than the merged Redis catalog.
  `copyAppSeriesDrafts()` uses the same helper. Repeating the original
  migration/edit/publication sequence for `snow-v1` and `snowCircuit` now
  reports both as allowed Creator changes, with no track or series problem.
- **Medal equality:** medal rows are canonicalized before comparison, so
  property insertion order cannot cause a mismatch. Repeating an unchanged
  normal Creator save now reports the track as exact; both the Undo preview
  and actual Undo remove that unchanged copy. The comparison still checks
  the medal values and handles null rows explicitly.

Verification:

- `npm run typecheck`: passed.
- Full suite with localhost access: **3,755 passed, 3 failed, 307 files**.
  All 60 focused Copy/Creator/route tests passed. The three failures have the
  same names and assertions recorded above; the passing count increased by
  exactly the three added regression tests.
- Independent updated original reproductions: **5/5 passed**. They cover
  original hidden-series liveness, the real `snowCircuit` authoring path,
  an unchanged normal save and actual Undo, the null-medal saved drawing,
  and the previously confirmed safe published-series recopy path.
- Existing migration and locked-copy suites: **12/12 passed**, also included
  in the full suite.

The committed hidden-series regression uses newly authored stage keys;
the independent original reproduction additionally checks the migrated
built-in `snowCircuit` branch. Temporary verification files are isolated in
`/private/tmp/dailygp-copy-fix-verification/`; no temporary tests were placed
in the repository or included in the full-suite count. Full-suite results
are at `/private/tmp/dailygp-copy-fix-verification-full.json`.

The three audit findings are resolved. Native Copy-tab browser behavior and
real Reddit/Redis persistence, leaderboard and ghost checks remain pending;
this follow-up made no production writes.
