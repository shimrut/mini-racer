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
