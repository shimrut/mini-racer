# Daily / Campaign mode switches reload completed warmup contracts

Investigated October 3, 2026, on `codex/restore-v240-tracks`, HEAD `94cba4ae`.
Scope: current code, focused existing tests, temporary request-count probes,
and live Devvit logs. No game code or repository tests changed. Existing WIP
was preserved. This note is the only repository file added by the investigation.

The subsequent user-authorized correction is recorded below under
**Implemented correction**. The investigation sections describe the original
behavior at the stated HEAD.

## Finding

The reported loading behavior has a concrete code cause. Background warming
exists and caches track definitions/assets, but mode entry does not reuse a
completed warmup's returned race contract. Every mode-button entry also opens
the global loading screen before checking readiness.

Campaign therefore fetches its bootstrap again on each subsequent entry.
Daily normally fetches its active challenge again, even when its seven-card
playlist and track definitions are cached. A usable post-bound Daily bypasses
the active endpoint, but still passes through the unconditional mode loader.

## Causal path

1. After the opening lobby is interactive and its splash finishes dismissing,
   `loadSecondaryStartupData()` schedules the other modes' warmups
   (`game/engine.js:719-724,1064-1089`). The choice is explicit in
   `game/startup/coordinator.js:54-59`:

   | Initial mode | Background warmups |
   | --- | --- |
   | Daily | Campaign |
   | Campaign | Daily |
   | Home | Daily and Campaign |
   | Head to Head | Daily and Campaign |

2. `warmRaceMode()` puts its pending promise in `_raceModeWarmups`. Its
   `finally` removes that entry on success as well as failure
   (`game/engine.js:779-792`). Only overlapping calls share work. The map
   retains no completed contract or prepared-result bundle.

3. Every mode-button click reaches `activateMode()`
   (`game/engine.js:378,388`). That immediately calls
   `loadingScreen.begin(...)`, imports/installs the mode, and calls
   `warmRaceMode()` (`game/engine.js:939-971`). There is no ready-mode fast
   path. If the background warmup already finished, a new warmup starts.

4. `warmCampaignRaceDefinitions()` directly calls `getCampaignBootstrap()`
   (`game/campaign/engine-methods.js:591-604`). It loads definitions and
   prepares the default stage, then returns `{ bootstrap, stage, prepared }`.
   Background startup neither applies nor retains that bootstrap in the
   engine's Campaign progress state. `getCampaignBootstrap()` has no response
   cache: it requests `/api/campaign/bootstrap` every time
   (`game/campaign/service.js:126-169`).

5. Campaign already has an authoritative in-memory bootstrap reuse path in
   `ensureCampaignBootstrap()` (`game/campaign/engine-methods.js:529-579`).
   The mode warmup bypasses that path. Even after entering Campaign and
   installing a usable bootstrap, leaving and re-entering requests another.

6. `warmDailyRaceDefinitions()` calls `getActiveDailyChallenge()`
   (`game/daily-challenge/engine-methods.js:527-536`). The service reads a
   usable active cache but prefers a fresh `/api/daily/active` response; that
   cache serves as a fallback (`game/daily-challenge/service.js:745-772`).
   A usable post-bound challenge returns earlier without this GET
   (`:736-742`). The playlist independently reuses seven playable cached
   cards; fewer than seven causes a playlist request (`:810-819`).

The warmup deletion, new mode-entry loading path, and direct Campaign warmup
request are present in the current HEAD commit `94cba4ae`. The change replaced
the previous direct lobby switch with this blocking warmup path. This is code
history evidence, not verification of which client build was on the reporting
device.

## What is actually cached

| Data | Existing behavior |
| --- | --- |
| Mode JavaScript | Session runtime cache; subsequent entry reuses imported code (`game/modes/runtime-loader.js:16-34`). |
| Track definitions | Loaded/pending client registry entries are reused (`game/track/client-registry.js:100-125`). |
| Stored-track confirmation | Confirmed keys are reused in the same session (`game/track/stored-track-service.js:119-147`). |
| Track runtime and canvas | Asset caches plus retained priority preparation records (`game/track/race-preparation.js:134-162`). Mode cancellation releases Selected/Next slots, preserving Daily/Campaign priority slots (`game/track/engine-methods.js:124-133`). |
| Daily playlist | Memory and browser-storage cache; seven usable cards avoid a playlist request (`game/daily-challenge/service.js:412-435,810-819`). |
| Active Daily | Browser cache exists, but ordinary lookup is server-first (`game/daily-challenge/service.js:745-772`). |
| Campaign progress | Authoritative engine state can be reused by `ensureCampaignBootstrap`; mode entry bypasses it. Campaign localStorage saves the selected series, not a progress/bootstrap response (`game/campaign/service.js:22-39`). |
| Completed mode warmup | Not retained (`game/engine.js:788-792`). |

This is a repeated contract/bootstrap request behind an unconditional loader,
rather than a fresh download/build of every track on every switch. Background
request failures are also caught and logged; later entry can retry. Failure is
not required to reproduce the reported behavior.

## Reproduction and validation

Temporary probes call the actual `RealTimeRacer.warmRaceMode()` and
`activateMode()` methods, the actual Daily/Campaign warmup methods, and their
actual HTTP services with stubbed HTTP responses. Graphics preparation and
lobby painting are stand-ins. These probes establish request ordering/counts;
they do not measure Redis latency or physical-device rendering.

All three probes passed:

- Campaign: completed background warmup makes bootstrap GET number 1;
  entering Campaign makes GET number 2. Calling `ensureCampaignBootstrap()`
  reuses the installed authoritative state, but switching into Campaign again
  makes GET number 3. Both entries call the loader.
- Daily: with seven usable playlist cards seeded, completed background
  warming, first entry and another entry make three active GETs. There are no
  playlist or stored-track GETs in this reproduction. Both entries call the
  loader.
- Campaign: entering while background warming is still pending shares its
  single GET, while still opening the loader.

Probe files:
`/private/tmp/dailygp-mode-switch-probe.test.js` and
`/private/tmp/dailygp-mode-switch-probe.config.mjs`.

Existing focused suites also passed:

- Startup/mode/readiness/router: 5 files, 55 tests.
- Daily service/cache/hydration/concurrency: 4 files, 94 tests.
- Campaign client service, mode entry and mode priority: 3 files, 37 tests;
  the two mode files overlap the first run.

The existing mode-entry test proves pending warmup sharing but stops at
completion; it does not enter the mode afterward
(`tests/mode-entry-loading.test.js:93-111`). The Daily service suite explicitly
asserts server-before-active-cache behavior
(`tests/daily-challenge.test.js:264-293`). The standard test setup regenerated
the selectable-car asset module without producing a Git difference.

## Hosted evidence and limits

Read six hours of Devvit runtime logs for both installations using the existing
CLI. The production capture contains 43 JSON log records, from 15:05:53 to
20:52:59 Bucharest time. Development contains three records, from 16:01:26 to
16:02:02. Neither capture contains successful Daily/Campaign bootstrap request
durations or successful client warmup completion timings.

Production has one Campaign load failure at 17:05:25 Bucharest time:
`GuestProgressSelectionRetryableError: Campaign progress update is already in
progress.` This is a separate transient progress conflict. It cannot explain
the unconditional loading path or prove that this user's switch encountered
that error. Other captured messages concern sharing, Head to Head, telemetry,
or guest-transfer work; guest-transfer timings are not mode-entry timings.

Captures:
`/private/tmp/dailygp-mode-switch-prod-2026-10-03.log` and
`/private/tmp/dailygp-mode-switch-dev-2026-10-03.log`.

The current code path and local HTTP-count reproduction are confirmed. The
reported device's exact build, request duration, and browser execution have
not been verified.

## Smallest correction direction

Reuse a valid completed mode contract and its preparation when entering that
mode, and open the global loader only when required readiness is missing.
Campaign can reuse its existing authoritative bootstrap state; background
warming needs to retain a matching contract without changing the active race.
Daily can reuse a matching unexpired resolved challenge during mode entry,
with refresh handled separately.

Reuse must remain scoped to player identity, selected Campaign series, Daily
validity/post context, and current definitions/options. Progress updates,
identity/series changes, challenge expiration and failed preparation need
invalidation or a fresh load. Keeping every successful promise forever would
ignore those changes. No correction was implemented in this investigation.

## Implemented correction

Follow-up authorized October 3, 2026. Completed mode contracts and readiness
are now retained in the existing engine warmup map, including the mode used
at startup. A ready Daily/Campaign entry installs its cached runtime and shows
its lobby without reopening the splash or repeating its contract request.
An incomplete entry still shares pending work and uses loading/Retry.

Campaign warming reuses the existing bootstrap controller and installs
canonical progress into hidden Campaign state without selecting the mode.
Entry never replaces newer canonical progress with an older warm snapshot or
promotes the displayed provisional-results overlay into verified progress.
Preparation and entry recheck a newer bootstrap that arrives while they await.

Warmup and bootstrap ownership include the active owner, profile application
generation and selected Campaign series. Every profile application clears
retained mode state and fences outstanding Campaign requests, including a
same-account transfer that replaces progress. Both successful and unavailable
bootstrap replies reject stale ownership/series contexts.

Daily retention checks the UTC date and its current post context. Featured
challenges expire at `endsAt`; a valid dated post can remain playable through
`availableUntil`. The playlist rotates at UTC midnight for either launch type,
including when preparation spans midnight. A stale completion cannot become
today's retained contract.

Prepared tracks are validated through the existing definition, presentation
and asset-options matching. A local rebuild reuses a still-valid contract, and
a failed rebuild keeps that contract available for Retry. Ready-path runtime
or lobby failures reopen the loader so recovery remains visible.

Regression tests are in `tests/mode-warmup-reuse.test.js`. The existing pending
warmup test now supplies a valid Daily deadline; its coalescing assertions are
unchanged. The unrelated dirty work in this checkout remains outside this fix.

Validation artifacts:

- `/private/tmp/dailygp-mode-reuse-final-focused.log`: 190 passing tests across
  eight focused mode, Campaign, Daily, identity and player-profile suites,
  including all 20 new reuse/invalidation/interleaving regressions.
- `/private/tmp/dailygp-mode-reuse-browser-results.json`: actual button switches
  from Daily, Campaign and Home, at 1440x900 and 390x844. Each page fetches one
  active Daily and one Campaign bootstrap during preparation, then four mode
  switches add zero contract requests and zero loader openings. Race Start
  after switching adds no contract requests. No browser errors.
- `/private/tmp/dailygp-mode-reuse-skill/`: the standard web-game skill action
  loop, gameplay screenshot and state output. Lobby and race screenshots from
  the switch checks were also inspected.
- `/private/tmp/dailygp-mode-reuse-typecheck.log` and
  `/private/tmp/dailygp-mode-reuse-build.log`: TypeScript and production build
  passed; the existing Campaign JSON import-attribute warning remains.
- `/private/tmp/dailygp-mode-reuse-pre-fix-tests.json`: the pre-fix client source
  overlay reproduces 48 existing failures without resetting unrelated WIP:
  45 guest-transfer snapshots, one medal threshold, one track-registry assertion
  and one server-placement invalid-date failure.
- `/private/tmp/dailygp-mode-reuse-final-tests.json`: full suite with local HTTP
  servers allowed, 4,061 passed / 48 failed / 4,109 total. Its failed test names
  match the pre-fix overlay exactly; no new failures.

Browser checks use local HTTP fixtures and real client rendering. This fix has
not been deployed or validated on a physical Reddit/Devvit phone.
