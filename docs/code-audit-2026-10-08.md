# Dead, redundant and duplicated code audit

Date: 2026-10-08. Branch: `fix/analytics-cohort-counts`.
HEAD: `36d44bbf848bc8915b293825407bb1b425810a91`.

This audits the current working tree, including the uncommitted Campaign, ghost-watch,
modal and landing-page preview work. Application code and tests were not changed.
This report is the only added repository file. Findings are candidates for a separately
authorized cleanup; they are not a reason to remove recovery paths or unfinished work.

## Scope and method

- Consulted `README.md`, `docs/system-change-map.md`, `docs/css-architecture.md`,
  `LP/README.md`, the 09-23 duplication reports, 09-26/09-27 unused-code reports and
  `docs/dead-code-audit-2026-10-03.md`. Historical findings were rechecked against source.
- Split the review across client behavior, server stores/routes, and tools/styles.
- Built an AST import graph from tracked and non-ignored untracked JS/TS sources.
  It follows static imports/re-exports, literal dynamic imports, TS resolution of `.js`
  specifiers, the track-definition glob and HTML script URLs. Roots include 18 HTML
  entrypoints, the server boot, site Functions, configs, package-script tools and
  configured debug stubs. All **550 application/tool/config JS/TS modules** are reached.
  A separate `.cursor` documentation-skill script is outside that application inventory.
- Inspected exported-name candidates, exact function-body clones, field references,
  lazy runtime installation, caller wiring and test-only use. The graph proves module
  reachability, not that every export or method in each module is needed.
- Checked CSS against markup, dynamic producers, nested rules and actual import order.
  `tools/analyze-unused-css.js:41` only scans top-level selectors; its output alone
  cannot establish that nested or dynamically selected styles are dead.

No orphan application module or unused direct package dependency was established.
The strongest findings are obsolete state/branches and a few meaningful duplicated
contracts. This is a source audit, not proof of all possible runtime paths.

## Confirmed dead or redundant code

### 1. Daily lap implementation is bypassed in shipped gameplay

`game/daily-challenge/engine-methods.js:1064–1128` duplicates the shared lap handler at
`game/challenge-run/engine-methods.js:136–188`.

`game/modes/runtime-loader.js:20–30` includes the shared handler for every loaded mode.
`game/modes/engine-methods.js:72–78` therefore calls `handleChallengeLapCompleted` in
normal gameplay, leaving the Daily handler only as an absent-shared-method fallback.
Four direct test calls at `tests/engine-daily-challenge.test.js:41,47,94,764` still exercise
the Daily copy; `tests/mode-router.test.js:64` supplies only the fallback.
That test's title, "routes lap completions through the shared Daily handler for every
mode", is misleading: its fixture defines `handleDailyChallengeLapCompleted` at `:23`
and omits `handleChallengeLapCompleted`. It exercises the old fallback, not the shared
runtime handler.

Sensible cleanup: remove the Daily implementation and router fallback together, and
retarget those tests to the shared handler and actual runtime routing. Preserve pace
calculation, recent/best laps, intermediate lap flash and trail reset. This has a larger
maintenance benefit than most small field removals. It needs meaningful test updates.
The router test must update its fixture, assertion and title together.
The genuinely mode-specific Daily overrides remain separate.

### 2. Preparation token has no reader

`game/track/race-preparation.js:52` initializes `nextToken`, used only to populate
`state.token` at `:150`. Nothing reads the token. Stale work is already rejected by
state-object identity at `:110,116,122`.

Remove the counter and field only. Preserve the identity checks and all preparation
work. Existing `tests/race-preparation.test.js` covers replacement and cancellation.

### 3. Unused engine bookkeeping slots

The following instance properties are assigned but never consumed by application code:

| Property | Current location | What must remain |
|---|---|---|
| `carAssetPromise` | `game/engine.js:143,926` | `syncCarSpriteAsset()` and its real work |
| `fontsReadyPromise` | `game/engine.js:452` | The separate local font promise awaited at `:927,938` |
| `initialPbGhostAssetPromise` | `game/engine.js:609,948,955` | Both initial PB/ghost loading calls |
| `dailyChallengeSummaryPromise` | `game/engine.js:1180` | The complete summary/catch/finally chain |
| `_previewPresentationOpId` | `game/engine.js:327` | Nothing; this is an unused initial value |
| `trackMedalBeforeLastLapWrite`, `hasTrackMedalBeforeLastLapWrite` | `game/engine.js:223–224`, resets in shared/Daily methods | Current medal/result behavior; tests currently inspect obsolete reset values |

Removing an unused assignment must not remove the asynchronous operation on its
right-hand side. These are mostly longstanding findings, independently verified now.

### 4. Small unused client surface

- `game/settings/garage-ui.js:101`: `panelTrails` getter has no caller. The actual
  trail controls remain live through `trailGrid` at `:103` and the grid's ID.
- `game/challenge-run/engine-methods.js:375`: `applyTrackPersonalBest` has no external
  importer. Only the export is redundant; the internal implementation at `:88` remains
  live through `:345,363`.

### 5. Unused analytics guard and duplicate predicate

`src/server/moderator/challenge-analytics-store.ts:28–30` exports
`isChallengeAnalyticsPeriod`, with no caller in production or tests. The route checks
the same two accepted values inline at `src/server/routes/analytics-routes.ts:97–101`.

Delete the unused guard, or use it at the existing route boundary if the validator is
intended to own that rule. Deletion is the smaller change; either approach should leave
one validator and preserve the route's rejection behavior.

### 6. Unread archive context property

`RunContext.startMs` at `src/server/daily/daily-ghost-archive.ts:368` is assigned at
`:1421` and never read. Remove that context property and initializer only. The local
`startMs` at `:1399` remains necessary for the Blob/session and commit deadlines.

### 7. Dead and overridden game CSS

| Rule | Evidence | Cleanup boundary |
|---|---|---|
| `.hud-medal`, `styles/race-hud-and-medals.css:123–127` | No game, landing-page or tool markup/class producer uses this rule. Daily/preview consumers load their separate live rule in `pages/preview.css:180`. The LP showcase has a generated copy of the unused rule. | Remove the authoritative game rule; its LP build copy refreshes on the next site build. Keep the separate preview rule. |
| `#garage-modal .garage-trail-grid`, `styles/tracks-and-small-screens.css:152–155` | Current markup uses `id="garage-trail-grid" class="garage-color-options"` at `pages/game.html:779`. No producer assigns the old class. | Remove the obsolete class selector; keep the grid ID and workshop styles. |
| Mobile trail `min-height`, `styles/tracks-and-small-screens.css:157–159` | Buttons have both `garage-color-option` and `garage-trail-option` (`garage-ui.js:701`). Later equal-specificity `garage-workshop.css:130–138` sets `min-height: 0`; workshop is imported last (`pages/styles.css:17`). | Remove the entirely overridden declaration. |

These findings correct the earlier report's blanket clean-styles claim. This audit did
not run a browser rendering check; any later CSS cleanup should verify the affected
Garage and race/preview surfaces.
`tools/generate-lp-showcase.js:30–31` copies the game's medal stylesheet, and
`tools/build-site.js:20` refreshes that copy for the site output. The copied
`LP/showcase/ui/race-hud-and-medals.css:123` rule has no independent consumer or owner.

### 8. Unused tooling names

- `tools/mapmaker.js:5`: imported `TRACK_GROUND_KEYS` is never read in that file.
  Remove only the import specifier; the exported ground list is live elsewhere.
- Nine unused TikTok Studio locals remain at `tools/tiktok-studio.js:1900,2337,2824,
  2827,2977,2978,3164,3165,4487`. These are unused constants/destructuring or pure
  easing/preset/theme lookup results. They are optional small cleanup, not a reason to
  change the renderer or remove the manual tool.

The tools/pages/LP/site unused-name scan produced 26 diagnostics: one Mapmaker import,
21 TikTok names and four Runner/track-flow callback parameters. Of these, 16 are
parameters rather than dead operations, including positional callback placeholders and
shared renderer signatures. Do not remove parameters mechanically.

### 9. Older server payload fields still have no application reader

| Field | Current location | Necessary live behavior |
|---|---|---|
| Campaign source `entryClass` / `pbClass` | `campaign/campaign-store.ts:1301,1303,1377,1379` | Local classification and malformed-row checks remain necessary. Only stored copies are unread. |
| Guest-retirement return `promotedPlayerId` | `player/guest-retirement.ts:63,67,75,87` | The lookup and promotion handling stay. All three `resolveGuestIdentityStatus` call sites leave the field unread: `competition/competition-identity.ts:364,397` and `player/player-account-store.ts:414`. They consume `status` and/or `selectionPending`. |

Paths in this table are under `src/server/`. These removals have less value than the
items above and should retain recovery/ownership tests and any intended return contract.

## Meaningful live duplication

| Area | Current copies | Sensible consolidation and risk |
|---|---|---|
| Reddit post fallback extraction | `src/server/head-to-head/head-to-head-post.ts:97–129`; `src/server/podium/daily-podium-replay.ts:172–204` | Identical key list and recursive collector. Share that collector in the existing posts domain. Keep replay-envelope validation and surrounding `toJSON` invocation details separate. Verify legacy post recovery. |
| Installation cache scope | `src/server/campaign/series-store.ts:150–159`; `src/server/tracks/track-store.ts:195–205` | Identical scope resolution. Reuse the already exported `readStoredTrackInstallScope` in series-store's existing track-store import (`:18–22`) and delete its local copy. No new helper/module is needed. Low risk; preserve ID-first scope, lowercase-name fallback and missing-context behavior, and verify request/cache isolation. |
| Permanent race-to-challenge adapter | `game/campaign/engine-methods.js:74–91`; `game/head-to-head/engine-methods.js:127–144` | Same race contract, with intentional mode/date-fallback differences. A small existing-domain adapter could own common fields; preserve those differences and frozen rules. |
| Leaderboard row deletion | `src/server/campaign/campaign-store.ts:529–532,1710–1713`; `src/server/daily/daily-gp-store.ts:1543–1546`; `src/server/daily/daily-guest-cleanup.ts:90–93` | Four copies of entry/rank/PB/revision commands. Share only queued commands. Ownership fences, transaction runners, expiry and batching stay with callers. Medium risk; transfer/cleanup validation is essential. |

Smaller, lower-value duplication:

- `src/server/head-to-head/head-to-head-service.ts:261–270` duplicates the existing
  signed-context helper in `head-to-head-share.ts:65–73`, already used by brag/comment
  paths. Import `getSignedHeadToHeadContext` in the service and replace its local helper.
  The share file's reverse import of service names at `:3–6` is type-only and is erased
  at runtime, so this reuse does not introduce a runtime import cycle. No new abstraction
  is needed.
- `src/server/daily/daily-gp-store.ts:1553–1569`: cleanup/discard wrappers have identical
  bodies; `guestOwnsDailyDay` at `:1128–1133` only forwards to the shared row probe.
  Keeping intent-revealing names can still be reasonable; this is lower priority.
- `game/car/player-car-paint.js:24–37` and `player-car-decals.js:23–36` repeat
  authoritative cache replacement. A small shared persistence helper is optional.
  Keep normalizers/keys separate and preserve whole-map replacement and empty-map
  deletion, which prevent customization leaking across player owners.

No behavioral regression was reproduced from these duplicates. Their maintenance risk
is drift. Consolidation is worthwhile only if it makes the shared contract clearer.

## Keep and false positives

- **Community routes:** explicitly retained on 2026-10-03 because Community is intended
  to return. Hidden entrypoints are not authorization to delete their implementation.
- **Test helpers:** `lockStoredTrack`, `saveCreatorTrackSnapshot`, loader injection,
  resets, probes and `RingBuffer.toArray` have intentional test/setup use.
- **Packed-ghost test setup:** `turnOnPackedGhostWrites` at
  `src/server/competition/pb-ghost-write.ts:26–29` is now test-only following the atomic
  compaction Start change; `tests/server-ghost-compaction.test.js:590` uses it for
  plain-to-packed write behavior. Label or replace its setup deliberately before deletion.
- **Test-only list surfaces:** `listStoredTracks` at `track-store.ts:379–385` is test-only;
  the production dependency named `listStoredTracks` actually points to `listCreatorTracks`
  (`server-app.ts:181`). `CAMPAIGN_ALL_SERIES` at `game/campaign/manifest.js:165` is also
  test-facing; its underlying full list still participates in live-series filtering.
- **Migration/recovery:** raced-list fill, archive restore/sweep, legacy analytics
  reconciliation and historical replay recovery are live compatibility paths. No hosted
  completion evidence was collected that would justify their removal.
- **Geometry:** projection, intersection and clamp variants differ in tolerance, coordinate
  handling, degenerate inputs or returned fields. Do not merge them based on visual similarity,
  especially when race simulation and server replay validation share the current behavior.
- **Daily PB helpers/overrides:** Daily and shared `applyTrackPersonalBest` implementations
  differ in checkpoint normalization and unloaded-track pace baselines. Removing the unused
  export does not justify merging implementations.
- **Landing preview:** `LP/v2.*` is an intentional separate preview. Its showcase CSS and
  medal-code copies are generated by `tools/generate-lp-showcase.js:27–35` and refreshed by
  `tools/build-site.js:20`; they are not independent source owners to refactor.
- **Manual tools:** Runner Lab, TikTok Studio, Campaign Planner and local Mapmaker have
  explicit HTML/manual roots. The three authoring forwarding modules retain working
  compatibility imports and offer little benefit from removal.
- **Small independent controllers:** the two `setActive` closures at
  `pages/mod-analytics.js:633,749` own separate polling state. Their small exact overlap
  alone does not justify a new abstraction.
- **Dynamic styles:** medal outcomes and analytics/carousel/preview state variants have
  real producers. Static absence from HTML is not evidence of disuse.
- **Stall observability:** `runHadTimingAnomaly` is test-facing; actual ranking rejection
  uses `rankedSubmissionBlockedReason`. Its removal has little benefit and must retain
  outcome-based stall coverage.

Historical findings already absent from this checkout include carousel label fields,
returned lobby `goldCount`/`gapMs`, verdict `opponentName`, `_modalSecondaryAction`,
server `allowGuests`/`resultLabel`/`notCounted`, and the old duplicate PB authorization
helper. The earlier redundant Garage refresh cleanup remains applied. Do not carry
these forward as outstanding work.

## Recommended cleanup order

1. Remove the unused preparation token, unused export/getter/import, archive context field
   and analytics guard; remove unused instance slots while preserving the operations.
   Reuse the existing installation-scope and signed-context helpers directly.
2. Remove the three obsolete CSS rules/declarations and verify Garage/preview rendering.
3. Remove the bypassed Daily lap implementation/fallback while retargeting tests to the
   actual shared runtime path. Preserve each existing gameplay assertion.
4. Consolidate the fallback-text collector, then consider the permanent
   challenge adapter. Keep legacy replay and owner/cache tests.
5. Treat row-deletion/transfer consolidation as a separately scoped change with transaction,
   recovery and concurrency validation. Leave low-value abstractions and test helpers alone.

## Validation and limits

- `node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals --noUnusedParameters`
  passed with zero diagnostics. This covers the configured TypeScript source; `allowJs`
  is false, so it is not evidence that JavaScript is free of unused names.
- Full Vitest baseline: 4,680 tests across 352 files; 4,593 passed initially and 87 failed
  in seven localhost route suites inside the sandbox. The seven files were rerun with
  localhost permission: all 92 tests passed, including five that had already passed.
  Replacing those seven file results yields **4,680 passed, zero failed**. This was a full
  run plus a targeted rerun, not a second complete-suite run.
- After adding this report, five focused runtime-router, preparation, CSS-architecture
  and debug-stub suites passed: 63 tests, zero failures.
- Follow-up verification of the five Opus refinements confirmed the existing scope/helper
  reuse, all three guest-status call sites, generated LP stylesheet coverage and the
  misleading router test title/fixture. TypeScript transpilation confirms that the share
  module emits no service import. Five focused router, series-store/request-pinning,
  LP-showcase and Head-to-Head share suites passed: 90 tests, zero failures.
- The repository's existing Vitest global setup regenerated the car-assets module;
  it produced no application-code diff. The targeted rerun used a temporary config with
  that setup disabled. Test output and analysis scripts were kept under `/private/tmp`.
- `git diff --check` reports a pre-existing extra blank line at
  `tests/campaign-aggregate-ui.test.js:232`. It was left intact as unrelated WIP.
  The new report passes its own whitespace check.
- No tests were added, removed or weakened. No cleanup implementation, production build,
  browser rendering, device check, hosted Redis/Reddit inspection or deployment was performed.
  The audit does not quantify bundle or Redis storage savings.
