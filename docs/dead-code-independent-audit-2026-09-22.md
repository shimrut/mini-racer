# Independent dead-code audit — 2026-09-22

## Scope and method

Audited the `racer-v2-4` checkout at `e9a578e` from current entry points and source references. The in-progress `docs/dead-code-audit-2026-09-22.md` and `.claude/settings.local.json` were left unchanged. This report is separate from that work. No runtime code was removed.

The reachability pass started at the Devvit post entry points in `devvit.json`, their HTML scripts, `src/server/index.ts`, Vite configuration, package scripts, and the separate Mapmaker/landing-page entry points. I then checked candidate names across production code and tests, and used TypeScript's `noUnusedLocals`/`noUnusedParameters` diagnostics as a second signal. A text or import-graph miss by itself is not proof of dead code: the app uses dynamic imports, generated assets, Devvit routes, and developer-only module stubs.

## Confirmed unused backend symbols

All 70 `src/server/**/*.ts` modules are reachable from `src/server/index.ts`; there is no confirmed whole-file backend orphan. The following declarations have no production or test references beyond their declarations:

| Symbol | Location | Evidence / interpretation |
| --- | --- | --- |
| `hasStoredCampaignProgress` | `src/server/campaign-store.ts:244` | Export has no caller. |
| `isRetiredGuestPlayerId` | `src/server/guest-retirement.ts:92` | Export has no caller. |
| `requiresReviewedRecovery`, `carriesCopyableData` | `src/server/guest-transfer-source-classification.ts:49,60` | Both exports have no caller; other classification helpers in this file are active. |
| `deleteHeadToHeadAccept` | `src/server/head-to-head-store.ts:151` | No caller; the corresponding write/read paths are active. |
| `classifyStoredPbRecord` | `src/server/pb-ghost-store.ts:241` | No caller; `classifyStoredPbRecordFor` is the active path. |
| `releaseSubmissionLock` | `src/server/daily-gp-store.ts:1008` | Local helper has no caller and is reported by TypeScript. |
| `emptySlot` | `src/server/daily-podium-replay.ts:54` | Local helper has no caller and is reported by TypeScript. |

TypeScript also reports the unused `releaseRedisLock` import in `src/server/head-to-head-service.ts:52`, `guestProgressLock` binding in `src/server/campaign-store.ts:1145`, and `result` binding in `src/server/daily-gp-store.ts:3030`. For the last one, the awaited `selectGuestProgress(...)` call has side effects and must remain; only its assigned variable is unused. The `playerId` destructure in `src/server/competition.ts:93` is not read inside `toCampaignCompetition`, though production callers and tests still pass it as part of the call contract. Removing the parameter needs a separate caller review.

## Client candidates

| Symbol / path | Location | Evidence / interpretation |
| --- | --- | --- |
| `openCampaignAsRedirect`, `openDailyAsRedirect` | `head-to-head.js:195,205` | Neither exported function has a caller or HTML event hook. The Head to Head accept control uses `head-to-head-accept.js` and `game/head-to-head/poster-access.js` instead. |
| `clearCachedPlayerProfiles` | `game/player/profile-cache.js:99` | No references outside its declaration. |
| `handleHardCrash` | `game/race/run-policy.js:67` | Called by old crash-policy tests but not by the current simulation. `game/race/simulation.js:18-49` only initializes/resets `challengeFailed`, `challengeFailureReason`, `crashImpact`, and `crashEndedRun`; it never sets them to a failure. This is an obsolete client path and associated event shape, but the server's `src/server/replay-validator.ts:289` crash check should be reviewed as a defensive replay contract before changing it. |

There is no confirmed whole-file client orphan. Track definition files are reached through `import.meta.glob('./definitions/*.js')` in `game/track/client-registry.js:7`, which a plain static import walk misses.

## Manifest and tooling candidate

`package.json:27` declares `@devvit/public-api` as a direct runtime dependency, but no app, tool, or test source imports it. `npm ls @devvit/public-api --all --depth=2` shows the Devvit CLI already depends on the same version transitively. This is a manifest cleanup candidate, not proof that its installed package can disappear from the toolchain. Verify install/build behavior before editing the manifest or lockfile.

The Mapmaker, Runner Lab, and TikTok Studio scripts are live manual-tool entry points through their respective HTML files. The `game/debug/*.stub.js` files are deliberate build replacements selected by `vite.config.js`, not dead files. `game/shared/daily-gp-history-backfill.js` is imported by the server through `src/server/daily-gp-history-backfill.ts` even though a JavaScript-only graph can miss that edge. The separate `LP/` site is excluded from the Devvit upload but has its own HTML entry point.

## Test-only and unresolved references

`isValidDailyGpTime`, `toBestTimeMs`, and `catalogHeadToHeadSize` are referenced only from tests; `clearAnalyticsMaintenanceMemory` is a deliberate test reset helper. Client exports currently referenced only by tests include `dailyPosterCarTravelAt` (`preview.js:32`), `createAvatarImage` (`game/ui/avatar.js:61`), `getCarAssetNameForPresetConfig` (`game/car/sprite.js:104`), `isClientTrackLoaded` (`game/track/client-registry.js:51`), `getAvailableDailyChallengeSkins` (`game/track/presentation.js:106`), `segmentsIntersect` (`game/track/geometry.js:24`), and `formatCombinedRankOutOf`, `buildModalStatsPlan`, `scheduleModalScoreboardRefresh` (`game/race/result-flow.js:259,282,443`). These are not production payload paths, but deleting them would require changing tests or test setup. Two ignored, untracked scripts under `tools/` (`backfill-track-biomes.js`, `stutter-probe.js`) are local workspace material and are outside this tracked-code audit.

No runtime or dependency cleanup was applied in this audit. The findings identify reviewable deletion candidates; production behavior and test coverage would need checking during a later cleanup change.

## Validation

`npx vitest run tests/run-policy.test.js tests/run-policy-contract.test.js tests/server-competition.test.js` passed (3 files, 20 tests). This confirms the current test baseline around the obsolete crash helper and campaign competition contract; it does not prove a removal would be safe. `git diff --check` passed, and the test setup's generated car-asset file did not introduce a working-tree diff. No full build or deletion trial was performed.
