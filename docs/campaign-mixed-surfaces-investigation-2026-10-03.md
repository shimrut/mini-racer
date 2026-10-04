# Mixed-surface Campaign investigation — 2026-10-03

Status: implemented in the working tree on 2026-10-03, not yet committed.
Steps 1–6 of the recommended implementation are in the code. The catalog now
names each non-Street track ground, and a runtime integrity test keeps it equal
to the track definition. No hosted Reddit/Redis playtest of a mixed series was
done. The rest of this note is the original investigation.

Original status: investigation complete; no runtime code or existing tests changed.
Checked the current `codex/restore-v240-tracks` working tree, including its
existing uncommitted changes. This concerns different surfaces between stages;
each track continues to have one surface for its whole race.

Scope correction from the user: all new surfaces are testing-only. There are
no production results or published production contracts on Dirt, Snow, Circuit,
Water or Space to migrate or protect. The earlier risk estimate overstated
new-surface production compatibility and release concerns. The existing
production Street/Numbers contract remains the normal regression baseline.

## Conclusion

Yes. Every Campaign series can support Street, Dirt, Snow, Circuit, Water and
Space stages using the existing per-track racing model. The work belongs mainly
to series authoring, validation, publication and presentation. Physics, stage
progression and leaderboard storage do not need a new mixed-surface model.

The simpler design is unrestricted track composition for all series, with
**Mixed** derived as a display label when their tracks use multiple surfaces.
A new composition mode, fresh series IDs for testing, data migration and
versioned physics are unnecessary for this feature.

`game/track/live-grounds.js:6` currently lists only `tarmac` (Street). This is a
code setting, distinct from the user's confirmed deployment status. Surface
availability can be configured intentionally for testing. If retaining that
gate, publication and visibility should assess actual stage surfaces instead
of a series' legacy ground label.

## Current restrictions

| Path | Current behavior | Evidence |
| --- | --- | --- |
| Creator track picker | Offers ready, unassigned tracks matching the series ground. | `tools/mapmaker/creator-panels.js:572-576` |
| Creator series editor | Offers physical ground keys, marks mismatches, and describes availability using one ground. | `tools/mapmaker/creator-panels.js:678-687`, `:731`, `:758`, `:811-813` |
| Redis series save | Rejects a `mixed` ground and rejects stage tracks on another ground. | `src/server/campaign/series-store.ts:319-320`, `:345-348` |
| Redis publication | Requires the series ground to be live and rechecks that newly published tracks match it. | `src/server/campaign/series-store.ts:399-412` |
| Assigned draft track save | Rejects changing a track to a different ground from its series. | `src/server/tracks/track-store.ts:549-552`, `src/server/campaign/series-usage.ts:25-27` |
| Manifest visibility | Treats the series as live from its declared ground and stage count. | `game/campaign/series-rules.js:24-28` |
| Campaign series screen | Filters by the declared series ground and displays one ground label. | `game/lobby/campaign-series-screen.js:35`, `:50-52` |
| Quick series picker | An unknown ground label falls back to Street; its kerb artwork also assumes a physical ground. | `game/lobby/campaign-series-picker.js:10-16`, `:105-117` |

The local Campaign Planner differs from the Redis Creator: it warns about a
ground mismatch, but its repository assignment path permits it
(`tools/campaign-planner.js:221-228`, `:441-474`, `:519-534`;
`tools/mapmaker/track-repository.js:435-469`). Both authoring paths need the same
composition and release rules.

## What already follows each track

- `game/race/simulation.js:554-595` resolves handling from the active track.
  The server replay validator uses that same simulation and the stage's track
  (`src/server/competition/replay-validator.ts:190`). The fingerprint includes
  non-tarmac ground (`src/server/competition/pb-ghost-trace.ts`,
  `createTrackFingerprint`).
- `game/track/engine-methods.js:258-267` installs the new track, updates the HUD
  surface/top speed and requests the appropriate vehicle skin.
  `game/race/engine-methods.js:576-583` selects the player's saved vehicle for
  that track's ground. Lobby car previews also resolve per track
  (`game/engine.js`, `getPreviewCar`). Audio receives the active track ground.
- Campaign starts and Next load the destination stage's track
  (`game/campaign/engine-methods.js`, `startCampaignStage` and
  `startCampaignNextStage`). Stage labels already
  obtain the surface from that track (`game/lobby/ui.js:529-548`).
- Medal unlocks count stage results within the same series. Competition and
  progress keys use series ID and race ID, without the series ground
  (`game/campaign/manifest.js`, `src/server/competition/competition.ts:91-110`,
  `src/server/campaign/campaign-progress-key.ts:6-11`).

## Smallest recommended implementation

1. Allow any supported track ground in every series. Remove same-ground
   candidate filtering, stage/series equality checks on save/publication, and
   the assigned-draft surface mismatch guard. Keep completeness, ownership,
   exclusive placement and locked-track checks.
2. Remove series ground selection as a composition rule and remove mismatch
   warnings from both authoring paths. A series' stage list decides its contents.
   A stage's surface continues to come from its track definition.
3. Keep stored `series.ground` temporarily as legacy presentation metadata and
   an empty-series fallback. Existing serializers, request snapshots, copies
   and conflict recovery can retain their current shape. That field should
   stop restricting tracks or deciding their availability. This avoids an
   unnecessary storage cleanup as part of this feature.
4. Derive the visible surface label: one distinct track ground gives its normal
   label; more than one gives **Mixed**. The first-stage preview already works,
   and its actual ground can supply kerb decoration. Stage cards continue to
   show their individual surface. Supply the same summary to authoritative and
   provisional Campaign UI states.
5. Where surface availability is still gated, check each newly published stage's
   authoritative track ground. Give the lightweight series list a small surface
   summary instead of importing all track geometry merely to show menus.
   The Redis index stores only revision/creation identity, and the built-in
   catalog stores names; neither currently supplies track grounds
   (`src/server/tracks/track-store.ts:83-99`, `:166-169`,
   `game/track/catalog.js`). Compute stored-series surface information while
   publication already reads the tracks, with equivalent lightweight app-series
   metadata. Player-visible summaries must describe only the published stage
   prefix: adding a new surface to an unpublished tail must not hide the
   already playable prefix (`src/server/campaign/series-store.ts:103-109`).
6. Preserve the existing production Numbers/Street IDs, tracks, stage order,
   laps, medal targets and physics. Testing-only themed series can adopt mixed
   composition without a production migration. General publication locks and
   frozen stage contracts remain useful existing behavior.

No separate Mixed mode or physical `mixed` ground is needed. Keeping legacy
series metadata also means the current ground equality in live-series conflict
recovery can remain an ordinary metadata check; changing it is needed only if
that legacy field becomes editable (`tools/mapmaker/creator-conflicts.js:84-93`).

## Verification and remaining acceptance

### Size and risks

Revised estimate: a small-to-medium feature across about a dozen source/tool
files, plus focused tests and documentation. The file count remains similar
because selection, server validation, availability and labels have separate
owners. The corrected deployment context removes new-surface compatibility and
migration work, and unrestricted composition is simpler than adding a second
authoring mode. The earlier 1–2 focused developer day estimate is a conservative
budget for implementation and local checks, not a measured delivery time. New
track content and physics tuning are separate work.

The main risks are:

| Risk | Consequence | Containment |
| --- | --- | --- |
| Different rules in the local Planner, Creator and game | A testing series can save through one path but fail another, disappear, or be mislabelled. | Remove composition restrictions consistently and test save/reload, publication and both menus. |
| Incomplete surface switching between stages | The next test race can retain the previous vehicle, HUD, audio or effects. | Exercise Start, Next, retry and returning to the lobby across different surfaces. Existing per-track hooks reduce implementation work; the complete mixed flow still needs testing. |
| Incorrect surface summary or load ordering | An unpublished appended surface can hide a playable prefix, or menus can trigger unnecessary geometry loading. | Summarize published stages and keep menu metadata lightweight. |
| Regression in shared Street/Numbers paths | Existing Street selection, results or progression can regress from a shared-helper change. | Keep production content and race identities unchanged; run the existing Street/Numbers regressions. |
| Poor medal targets or replay acceptance on test tracks | A stage can be too hard to advance from, or a slow run can exceed replay limits. | Check track-specific medals and replay submissions as ordinary testing. |

Changing `LIVE_GROUND_KEYS` affects themed-series visibility, Daily track
admission and Garage skin eligibility in the testing build
(`game/campaign/series-rules.js:25-28`,
`src/server/daily/daily-schedule-store.ts:134-135`,
`game/car/player-car-skin.js:118`). That is an expected testing configuration
effect to check, rather than evidence of existing non-Street production risk.

Overall: low risk to production data when existing Street/Numbers content is
preserved, with moderate integration testing effort. There are no production
new-surface PBs, ghosts or queued runs requiring migration, and this feature
does not require versioned physics, fresh testing-series IDs or a staged
new-surface rollout. Persistence, publication and ranked submissions should be
checked in the test installation as part of feature acceptance.

### Checks completed

- Existing client/Campaign/surface checks: **12 files, 186 tests passed**.
  Used a temporary Vitest config outside the repository without asset-generation
  setup. Campaign recovery fixtures emitted caught mock-response warnings;
  assertions passed.
  After concurrent warmup changes appeared in the shared working tree, the
  Campaign UI/service subset was rerun: **100 tests passed**.
- Independent authoring batch: **8 files, 108 tests passed**. Backend batch:
  **4 files, 54 tests passed**. These batches overlap; their counts are not added.
- Temporary mocked-Redis checks reproduced four restrictions: mixed marker
  rejection, different-surface stage rejection, assigned-draft ground-change
  rejection, and publication's authoritative ground recheck. All passed.
- An in-memory six-stage probe constructed Street, Dirt, Snow, Circuit, Water
  and Space stages. Declaring its series `mixed` left it hidden; declaring the
  same tracks `tarmac` made the manifest consider it live and allowed a medal on
  Street to unlock the Dirt stage. This bypassed Creator validation and exposed
  why composition and series visibility need to be updated together. A separate
  local repository probe reproduced the Water/Street metadata mismatch.
- The broader `server-track-placement` run was interrupted: its existing
  `selects the lap contract from the fresh medal row that it freezes` fixture
  searches indefinitely for a two-lap fresh Daily
  (`tests/server-track-placement.test.js:197-200`), while the current dirty
  `src/server/daily/daily-gp-model.ts:188` always creates a one-lap Daily.
  No fix to this unrelated issue was made.

Implementation acceptance should cover a mixed draft surviving save/reload,
successful publication with enabled surfaces, rejection of a held-back stage,
Start and Next switching surface/vehicle/HUD/audio without stale state, and
separate per-stage replay/PB/ghost validation. Existing Numbers progress,
publication locks and copy/conflict recovery should remain covered.

No mixed-series hosted Reddit/Redis playtest was performed. Passing existing
tests and temporary probes establishes feasibility and current restrictions;
the mixed feature remains unimplemented.

Related docs: [track-authoring.md](./track-authoring.md),
[campaign-series-plan-2026-09-25.md](./campaign-series-plan-2026-09-25.md),
[system-change-map.md](./system-change-map.md), and
[multi-lap-campaign-architecture.md](./multi-lap-campaign-architecture.md).
