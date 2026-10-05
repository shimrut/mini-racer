# Test failures investigation — 2026-10-04

Checked the current dirty checkout at HEAD `439c4d76`. No runtime code,
test expectations or snapshots were changed during this investigation.

`npm test` passed typecheck and asset generation. The sandboxed Vitest run
also encountered `listen EPERM` because route tests bind to localhost.
Rerunning Vitest with localhost access removed those environmental failures.

The unrestricted run completed 326 files / 4,104 tests: 4,057 passed and
47 failed. It could not finish because `tests/server-track-placement.test.js`
contains a synchronous infinite loop. After stopping the full run, that file
passed its other 18 tests with the looping test excluded. Combined evidence:
4,075 passed, 47 failed, one excluded hang; not a completed green suite.

## Causes

- `tests/medals.test.js:36`, “defines ordered thresholds for every track”:
  `centralDistrict` and `lapinLoop` exist in the catalog but have no medal
  rows. `getTrackMedalThresholds()` returns null. This is missing calibration
  data, also reflected in the changelog's distinction between tracks with
  and without medal times.
- `tests/track-runtime-integrity.test.js:112`, “preserves existing track data
  while intentionally extending the registry”: the expected catalog suffix
  ends at `warpedLoop`, but the catalog includes ten more entries:
  `budapestRun`, `bucharestScramble`, `babylonRace`, `centralDistrict`,
  `smallSteps`, `lapinLoop`, `mountainPass`, `sharkTail`, `hookBend`,
  `windingLane`. This assertion stops the test before its fingerprint checks;
  those later checks are not established by this run.
- `tests/guest-transfer-recording.test.js`: 45 stale snapshots. Every diff
  changes only Daily contract fields from `lapCount: 2` /
  `multi_lap_total` to `lapCount: 1` / `single_lap_fastest`. The fixture's
  `seedDays()` creates fresh contracts under the intentional one-lap policy
  in `src/server/daily/daily-gp-model.ts:188`. No other recorded transfer
  results or persisted player data differ. The three recovery tests pass.
  Any future snapshot refresh should retain explicit historical multi-lap
  transfer coverage because published days retain their stored contract.
- `tests/server-track-placement.test.js:198`, “selects the lap contract from
  the fresh medal row that it freezes”: loops until the builder returns two
  laps. The builder now always returns one. The synchronous loop blocks
  Vitest's timeout and prevents the suite from completing. This test premise
  predates the new-Daily one-lap policy.

## Evidence

- `/tmp/dailygp-test-investigation.log`: sandboxed `npm test`.
- `/tmp/dailygp-test-unsandboxed.log`: unrestricted full Vitest run, stopped
  after identifying the infinite loop.
- `/tmp/dailygp-content-test-failures.log`: isolated medals/integrity run,
  33 passed and two failed.
- `/tmp/guest-transfer-focused-investigation.log`: isolated recording run,
  three passed and 45 failed.
- `/tmp/dailygp-placement-test-check.log`: placement file with the looping
  test excluded, 18 passed and one skipped.

## Follow-up: expected track list

Added all ten tracks to the integrity test's expected catalog suffix at the
user's request. The list assertion now passes, as do the preceding historical
subset fingerprints. The focused run reports 13 passed / one failed: the
next geometry fingerprint (`withoutReshapedOrAdded`) expects
`9ec0d85ececf610060e786f1914ca01c46b280ea1430795b531727a6c82f95c7`
but receives `dd1476c68a0d83fd9cf3e7d4dc30aa50dd9641585a5819dd1ae4999cf50aa325`.
The fingerprint expectations were left intact; they require review of existing
track reshapes rather than acceptance based only on newly appended tracks.
Evidence: `/tmp/dailygp-track-list-update.log`.

The current uncommitted reshapes inside the first failing subset are
Crooked Arrow, Hook Loop, Lightning Hook, Mountain Peak, Shark Fin,
Twisted Clover and Winding Road. All seven change boundary geometry;
several also change rounding and lap/start gates. Double Trouble also
changes geometry but is excluded from this subset and included in the
next fingerprint. A read-only reconstruction with HEAD definitions still
does not match the expected subset hashes, so the dirty reshapes alone
do not explain the entire mismatch; the expected hashes also need their
committed baseline reviewed before replacement.

## Follow-up: restoration history

Comparing all boundary points, start pose/line, checkpoints and corner radius
against each definition's Git history confirms that all eight changed tracks
restore their original shapes: Mountain Peak and Shark Fin match `0feab0e0`;
Crooked Arrow, Double Trouble, Hook Loop, Lightning Hook, Twisted Clover and
Winding Road match `0239dc89`. Calling these merely new reshapes was incomplete:
they differ from HEAD because HEAD contains the later modified layouts.
Mountain Pass, Shark Tail, Hook Bend and Winding Lane exactly preserve HEAD's
Mountain Peak, Shark Fin, Hook Loop and Winding Road shapes respectively.
These comparisons cover race-shape fields, not removed historical metadata.
The test fingerprint still describes the later layouts, rather than this
restoration plus the new keys.

## Fix: track integrity expectations

Updated the three affected registry fingerprints to the reviewed restoration
and current catalog. Kept the two earlier passing historical subset hashes.
Added individual race-shape checks for the eight originals, with expectations
derived from `0feab0e0` / `0239dc89`, and the four preserved later variants,
derived from `439c4d76`. Runtime geometry is unchanged.
The focused integrity suite now passes all 26 tests. Evidence:
`/tmp/dailygp-track-integrity-fix.log`. The other failures and hanging test
listed above remain outside this fix.

## Fix: transfer recordings and placement test

Refreshed the 45 transfer snapshots for the new-Daily one-lap policy.
Reviewed the complete snapshot diff: its only changes are 145 lap-count
values from two to one and the corresponding 145 objective types from
`multi_lap_total` to `single_lap_fastest`.

Added explicit transfer checks for published two- and three-lap Daily
contracts under both Merge and Keep account. They assert unchanged ledger
contracts and the correct account leaderboard result, completed laps and
compatible personal best after transfer.

Replaced the placement test's unbounded two-lap search with fixed-date
publication. It checks one-lap publication and stored challenge history,
and verifies that the fresh medal row is frozen despite the stale request
overlay. No runtime code changed.

The five focused suites (recordings, placement, Daily model, Daily guest
merge and guest selection) pass all 142 tests without snapshot-update mode.
Evidence: `/tmp/dailygp-daily-test-fix-verified.log`.

The full suite now completes: 325 files pass, two fail; 4,137 tests pass,
two fail (4,139 total). All transfer recordings and placement tests pass.
Remaining failures are the missing medal rows and the full-registry
fingerprint. Small Steps and Lapin Loop definitions have changed since the
earlier integrity fix; substituting their HEAD definitions in a read-only
registry reconstruction recovers the previously passing full-registry hash.
These unrelated geometry edits were left intact. Full-run evidence:
`/tmp/dailygp-suite-after-daily-test-fixes.log`.

## Follow-up: challenge analytics branch baseline

The later `codex/challenge-view-analytics` checkout includes a seventeenth
Numbers stage (`numbered-v1-16`, Endless Loop) and more track work. Its complete
run with local socket access reports 4,238 passed / 52 failed, across 329
passing / seven failing files. Comparing failing test names with the run
before analytics implementation found no new failing case.

| File | Failures | Current cause |
| --- | ---: | --- |
| `tests/guest-transfer-recording.test.js` | 45 | Every snapshot diff is confined to the new Campaign stage's lock marker and total Campaign stages changing from 26 to 27. No other recorded transfer outputs differ. |
| `tests/campaign-manifest.test.js` | 2 | Expected Numbers stage list and medal gates end at stage 16 / gate 37; actual list adds stage 17 / gate 39. |
| `tests/campaign-series-screen.test.js` | 1 | Expected 16 Numbers stages / 64 possible medals; actual UI has 17 / 68. |
| `tests/server-head-to-head.test.js` | 1 | The invalid-stage fixture uses `numbered-v1-16`, which is now valid, so preview correctly returns ready instead of 404. |
| `tests/medals.test.js` | 1 | Catalog tracks `dirtyDancing` and `lapinLoop` have no medal thresholds. |
| `tests/track-grounds.test.js` | 1 | The ground/replay-limit check encounters missing medal thresholds on `dirtyDancing`. |
| `tests/track-runtime-integrity.test.js` | 1 | The expected catalog suffix omits `grandSlam`, `dirtyDancing`, `greyHarbor`, `endlessLoop` and `crescentValley`. This assertion stops before subsequent fingerprint checks. |

The missing medal rows are content gaps, not merely stale expectations. The
other failures above reflect the current stage/catalog changes. No runtime
code, test expectation or snapshot was changed to investigate this run.

Evidence: `/private/tmp/dailygp-challenge-analytics-baseline.log` (includes
additional sandbox `listen EPERM` failures), and
`/private/tmp/dailygp-challenge-analytics-final-tests.log` (completed run with
socket access). The 132 focused challenge-analytics tests pass separately.

## Fix: non-medal failures on the challenge analytics branch

At the user's request, fixed all 50 non-medal failures and left medal
calibration data and its two failing tests untouched.

- Campaign expectations now include Endless Loop as `numbered-v1-16`, one
  lap, gate 39; the series screen expects 17 stages and 68 possible medals.
- The invalid Head to Head Campaign fixture uses `numbered-v1-99` and first
  asserts that the manifest does not contain it. Its 404 rejection remains
  required; the existing all-stage test includes the newly valid stage.
- Refreshed 45 transfer snapshots and reviewed every changed line: 90 total
  stage-count values change from 26 to 27, and 20 lock inventories gain only
  the new stage marker. No other persisted transfer output changed. Historical
  two-/three-lap and interrupted-transfer checks remain intact.
- Added the five missing catalog keys and reviewed the exposed full-registry
  mismatch. Removing those additions and substituting the earlier Dirt Valley,
  Small Steps, Lapin Loop and Central District definitions from `70587b86^`
  exactly recovers the previous hash
  `7c493f7f0648aca359740b0451a2faf49d646f5f5692e7868a4db1d115182d1e`.
  Dirt Valley was an additional committed reshape missing from the earlier
  diagnosis. The existing subset and individual restoration hashes still
  pass. A new baseline-derived subset hash protects every other track, and
  the complete fingerprint now pins the current registry. No geometry changed.

All 153 tests across the five affected files pass without snapshot-update
mode. The complete `npm test`, with localhost socket access, passes typecheck
and asset generation, then reports **4,290 passed / two failed**, across
334 passing / two failing files (4,292 tests / 336 files). The only failures
are `tests/medals.test.js` and `tests/track-grounds.test.js`, for the missing
Dirty Dancing / Lapin Loop medal thresholds. Runtime code was unchanged by
this follow-up; docs now reflect the seventeenth Campaign stage and current
integrity baseline.

Evidence: `/private/tmp/dailygp-nonmedal-focused-verified.log`,
`/private/tmp/dailygp-track-fingerprint-review.json`, and
`/private/tmp/dailygp-nonmedal-test-fixes.log`. `git diff --check` passes.


## Track analytics aggregation validation — 2026-10-05

Before the final legacy upgrade-reconciliation follow-up, the aggregate
implementation's full serial suite reports **4,316 passed / two
failed** across 335 passing / two failing files (4,318 tests / 337 files).
The remaining assertions are the same intentionally untouched medal gaps.
Default-parallel and four-worker runs additionally exceeded five-second limits
in geometry-heavy track privacy/copy/migration/integrity tests. All 65 tests in
those five files pass serially without changing timeouts or expectations.
Evidence: `/private/tmp/dailygp-track-analytics-full-serial.log` and
`/private/tmp/dailygp-track-analytics-heavy-recheck.log`.

## Full working-tree checkpoint — 2026-10-05

At the user's request, the checkpoint includes all 101 modified tracked files
and all 18 previously untracked files on `codex/campaign-finished-sharing`:
Campaign completion, fixed final stages, aggregate standings and sharing,
Mapmaker workspace/import and authoring changes, Test Drive countdowns,
track definitions, medal rows, share images, tests and documentation.

Typecheck and production build pass. The build retains the existing inconsistent
JSON import-attribute warning. `git diff --check` passes.

The complete serial test run reports 4,371 passed / 85 failed across 343 files.
Seventy-eight failures in seven HTTP route files came from blocked localhost
listeners (`listen EPERM`), including the resulting track-route timeouts.
Rerunning those seven files with localhost access passes all 78 tests. Combined
validation therefore establishes **4,449 passed / seven assertion failures**,
without claiming a green unrestricted full-suite run.

The remaining failures are four guest-transfer snapshot mismatches involving
Country Road track fingerprints and their derived Campaign stage markers, one
track-registry fingerprint mismatch, and the two documented missing-medal
assertions. Test expectations and runtime code were not changed to make this
checkpoint pass. All requested working-tree changes are preserved.

Evidence: `/private/tmp/dailygp-commit-all-tests-2026-10-05.log`,
`/private/tmp/dailygp-commit-all-route-tests-2026-10-05.log`,
`/private/tmp/dailygp-commit-all-remaining-route-tests-2026-10-05.log`, and
`/private/tmp/dailygp-commit-all-build-2026-10-05.log`.

## Remaining track edits on v250 — 2026-10-05

The follow-up checkpoint preserves the remaining Broken Road wall/checkpoint
adjustments, Dirt Valley outer-wall adjustment, Ridge Runner replacement layout,
and revised Dirt Valley/Ridge Runner medal times. The changelog records these
content changes. No test expectations were changed.

Typecheck, production build and diff checks pass. Focused runtime-integrity,
server track-shape, medal and ground suites report **84 passed / three failed**
across four files. The failing assertions are the already documented registry
fingerprint and two missing-medal checks; the new track edits change the received
registry fingerprint without introducing a new failing assertion. This focused
run does not replace the full-suite checkpoint above.

Evidence: `/private/tmp/dailygp-v250-track-commit-tests-2026-10-05.log`,
`/private/tmp/dailygp-v250-track-commit-typecheck-2026-10-05.log`, and
`/private/tmp/dailygp-v250-track-commit-build-2026-10-05.log`.
