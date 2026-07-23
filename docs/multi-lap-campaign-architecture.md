# Multi-Lap Daily GP And Campaign Architecture

## Status

Phase 1 (multi-lap Daily GP) is implemented on
`codex/multi-lap-dailies`. Campaign remains a future phase.

The intended outcome is one shared race contract used by Daily GP, Campaign,
and later modes, while each mode keeps its own selection, progression,
leaderboard, and retention rules.

## Product Summary

### Daily GP

- Each published challenge permanently records a lap count of 1, 2, or 3.
- The chosen lap count is random within the track's allowed set.
- Long tracks can be 1 or 2 laps.
- Short tracks can be 1, 2, or 3 laps.
- Medal targets are the one-lap targets multiplied by the lap count.
- At every intermediate finish-line crossing, the game flashes the medal
  earned by the player's cumulative race pace at that point.
- Daily ranking, expiry, sharing, podiums, and post history remain Daily-only.

### Campaign

- Campaign tracks are a curated, permanent set and do not rotate.
- Every campaign race declares a fixed lap count of 1, 2, or 3.
- Campaign progress and leaderboards are separate from Daily GP.
- Tracks unlock from medals earned in the campaign.
- Campaign races use the same lap, timing, replay, medal, and finish behavior
  as Daily GP.

## Confirmed Product Rule

The request uses "author time over 10.95 seconds" for both lap-count bands. The
recommended interpretation is:

| One-lap author time | Allowed Daily GP lap counts |
| --- | --- |
| `> 10.95s` | 1 or 2 |
| `<= 10.95s` | 1, 2, or 3 |

This interpretation was confirmed. Use an equal chance among the allowed lap
counts. Seed the selection from the challenge identity and track, then persist
the chosen value in the append-only challenge ledger. Players, retries, old
posts, and later app versions must never reroll a published challenge.

## What Already Exists

There is useful dormant multi-lap scaffolding:

- `game/race/run-policy.js` counts completed laps and finishes only after
  `requiredLaps`.
- `game/race/simulation.js` emits a lap-completed event on each valid
  finish-line crossing.
- `game/daily-challenge/labels.js` reads
  `objectiveParams.lapCount` for `multi_lap_total`.
- `game/daily-challenge/engine-methods.js` creates multi-lap run state and
  renders lap progress in the HUD.
- Existing simulation and run-policy tests cover a two-lap finish.

This is a head start, not a complete feature. Production challenge generation,
stored challenge parsing, server replay validation, PB identity, medals, and
several result paths still enforce or assume one lap.

## Blocking Findings

### 1. The server erases multi-lap configuration

`src/server/daily-gp-model.ts` types and creates only
`single_lap_fastest` challenges with empty objective parameters.
`src/server/daily-gp-store.ts`, `src/server/post-bound-challenge.ts`, and
`src/server/daily-gp-history-backfill.ts` also normalize stored or restored
challenges back to one lap.

The browser accepts `multi_lap_total`, but its lightweight active-challenge
cache currently drops `objectiveParams`. A reload can therefore change the
effective rule unless the cache contract is corrected.

Daily leaderboard records and snapshots also normalize `completedLaps` to
`null`. The immediate verified submission result can contain the completed lap
count, but the persisted row cannot currently reproduce it.

### 2. Server replay validation always finishes after lap one

`src/server/replay-validator.ts` hardcodes `requiredLaps: 1`. A locally
completed two- or three-lap replay would not be validated against the same race
the player saw.

The input replay limit is 3,000 simulation frames, approximately 50 seconds,
on both client and server. Current one-lap author times range from about 5 to
19.2 seconds. Multi-lap runs, especially from non-expert players, can exceed
the cap even when the medal targets do not.

The verified ghost trace has a larger time envelope, but its compatibility
identity includes track geometry and simulation revision—not lap count or race
rules.

### 3. Current medals are one-lap and keyed only by track

`getMedalForLapTime(trackKey, time)` compares against one-lap thresholds.
The current intermediate-lap handler evaluates only the just-finished lap and
writes that medal to browser storage keyed by `trackKey`. The final handler
then evaluates the total multi-lap time against the same one-lap threshold.

For this product, intermediate feedback must be based on cumulative pace:

```text
threshold at lap k = one-lap threshold * completed laps
final threshold = one-lap threshold * required laps
```

Only the terminal race medal should update durable progression. A fast first
lap must not permanently award a campaign medal if the full race is not
completed at that standard.

### 4. PBs and ghosts would mix incompatible races

PB retrieval and caching currently use challenge and/or bare track identity.
One-, two-, and three-lap versions of the same geometry must not compare times
or reuse ghosts.

Any ranked run identity must include the race rules, at minimum track, lap
count, scoring rule, and rules revision. Daily challenges and campaign races
can share geometry without sharing competition records.

### 5. Checkpoint splits currently describe only the last lap

Checkpoint times are cumulative race times in the simulation, but the client
clears the checkpoint array after each intermediate lap. A multi-lap
submission therefore contains only final-lap checkpoints with full-race clock
values.

Use one explicit full-race contract. The recommended shape is a flattened,
monotonic list with lap context derived from checkpoint count, or a structured
array per lap if the API is versioned at the same time. Server and client must
produce and validate exactly the same representation.

### 6. Finish event ordering is unsafe

On the final crossing, the engine handles the win before it handles the
lap-completed event. This can calculate and display the final result before the
last lap's progress, medal, and split state is committed.

One ordered race-progress result should describe:

- completed lap;
- cumulative elapsed time;
- completed lap time;
- completed and required lap counts;
- intermediate versus terminal state;
- cumulative checkpoint splits.

The engine should process progress first, then the terminal mode result.

### 7. Daily-only names and orchestration should not be cloned

The run policy is named `daily:*`, active run state is
`currentChallengeRun`, and the large Daily Challenge mixin owns race finish,
verification, ghosts, lobby, playlist, and share behavior.

Campaign should not copy that file. The shared race mechanics should be
extracted narrowly, while Daily and Campaign remain separate mode adapters.

## Recommended Shared Contract

Introduce a small, server-safe immutable race specification:

```js
{
  raceId,             // stable competition identity
  mode,               // "daily" or "campaign"
  trackKey,
  lapCount,           // 1, 2, or 3
  scoring: "total_time",
  medalScale: "linear_v1",
  rulesRevision
}
```

The contract should be normalized by one pure module imported by both the
browser and server. The server must validate the exact stored specification;
it must never trust a lap count sent only by the browser.

Daily GP adds dates, availability, posts, sharing, podiums, and expiring
competition records around this spec. Campaign adds order, unlock
requirements, permanent progress, and permanent per-race leaderboards.

Do not turn all persistence into one generic framework. Keep separate Daily
and Campaign stores and routes, but make both call the same race-spec,
simulation, replay-validation, split, and medal helpers.

## Shared Medal Rules

Add pure helpers beside `game/medals/medal-timing.js`:

- `getRaceMedalThresholds(trackKey, lapCount)`
- `getRaceMedalForProgress(trackKey, elapsedTimeSec, completedLaps)`
- `getRaceMedalForFinish(trackKey, elapsedTimeSec, requiredLaps)`

Every Author, Gold, Silver, and Bronze threshold scales linearly from the
existing one-lap value. Round only for display; comparisons should use the
unrounded scaled value.

At an intermediate finish, flash:

- `LAP 1 / 3`;
- cumulative race time;
- the current qualifying medal, or a clear no-medal state.

The flash should not claim a permanent unlock. Campaign progression is updated
only after the terminal server-verified finish.

## Daily GP Data Rules

Add the race specification, or its versioned fields, to the stored challenge:

```js
{
  objectiveType: "multi_lap_total",
  objectiveParams: { lapCount: 2 },
  rulesRevision: 1
}
```

Compatibility rules:

- Historical challenges without these fields mean one lap.
- Stored valid fields must be preserved, not normalized away.
- Post-bound challenges, playlist history, podium jobs, sharing, snapshots,
  caches, and local verification entries must carry the same rule identity.
- The server chooses and persists the lap count once when it publishes the
  challenge.
- Scheduled tracks without a valid Author time should fail a release test.
  Runtime fallback should conservatively choose one lap.
- Persisted leaderboard entries and snapshots should carry the verified lap
  count and rules identity rather than writing `completedLaps: null`.

Leaderboard records stay keyed by challenge ID, so different Daily dates
remain separate even when they use the same track and lap count.

## Campaign Data Rules

Create a dedicated campaign manifest that references shared geometry:

```js
{
  campaignId: "main-v1",
  races: [
    {
      raceId: "main-v1-01",
      trackKey: "campaignTrackKey",
      lapCount: 1,
      unlock: { type: "start" }
    },
    {
      raceId: "main-v1-02",
      trackKey: "anotherCampaignTrack",
      lapCount: 2,
      unlock: {
        type: "medal_on_race",
        raceId: "main-v1-01",
        minimumMedal: "bronze"
      }
    }
  ]
}
```

Campaign-only and Daily-only availability should be metadata, not duplicated
geometry. `TRACKS` remains the geometry registry. `TRACK_SCHEDULE_KEYS` remains
only the Daily publication order. The campaign manifest is the only campaign
order.

This requires a targeted registry separation. Today, integrity tests require
`TRACK_CATALOG`, `TRACK_SCHEDULE_KEYS`, and `TRACKS` to contain the same keys,
and `TRACKS` is assembled from the Daily schedule. The intended contract is:

- `TRACK_CATALOG`: every playable track;
- `TRACKS`: geometry for every catalog track;
- `TRACK_SCHEDULE_KEYS` (or `DAILY_TRACK_KEYS`): only the Daily rotation;
- Campaign manifest: only Campaign stages.

Mapmaker integration and registry fingerprint tests must preserve these
distinct sets.

Use explicit unlock requirements rather than inferring progression from array
position. This supports later branches or medal gates without rewriting the
race engine.

Campaign persistence should be server-authoritative and scoped by player plus
campaign:

- best verified result per `raceId`;
- best medal per `raceId`;
- unlocked race IDs derived from verified medals;
- separate permanent leaderboard per `raceId`;
- rules revision and track fingerprint for compatibility.

Do not use the current browser-only `last-lap-medal` map as campaign
progression. It is keyed only by track and can be edited or lost.

Do not put campaign progression inside the current player-profile/preferences
record. Those records expire after inactivity and have unrelated settings
write behavior. Permanent signed-in progression needs its own retention
contract. Guest retention or account-upgrade behavior is a product decision.

## Replay, Ghost, And Split Contract

- Replace the hardcoded one-lap validator state with the normalized race spec.
- Share an objective-aware replay limit between client and server. Set the
  final value from measured worst-case payloads; do not simply raise one side.
- Version the replay payload and bind it to the race identity/rules.
- Include lap count and rules revision in PB/ghost compatibility.
- Key caches by race identity, not track key.
- Preserve the full-race ghost timeline; playback already follows total race
  time and can cross multiple laps.
- Record cumulative splits across every lap and label them with lap context.
- Validate `completedLaps === requiredLaps` on client and server result paths.

## UI And Navigation

The home screen needs an explicit mode entry point rather than treating every
start as Daily GP:

- Daily GP card: today's track, lap count, best race time, rank, Start.
- Campaign entry: campaign progress and Continue.
- Campaign track screen: locked/unlocked state, required medal, fixed laps,
  best medal/time, and campaign leaderboard.

During a race, shared HUD and finish UI should read the active race spec.
Mode adapters supply the actions:

| Shared race UI | Daily adapter | Campaign adapter |
| --- | --- | --- |
| Restart | Retry challenge | Retry campaign race |
| Standings | Daily challenge leaderboard | Campaign race leaderboard |
| Home | Daily lobby | Campaign track screen |
| Submit | Expiring Daily competition | Permanent campaign race |
| Share/podium | Existing Daily behavior | Not included initially |

## Implementation Sequence

### Phase 1 — Shared race contract and tests

1. Add normalized `RaceSpec` and scaled medal helpers.
2. Generalize run policy names and progress output without changing current
   one-lap behavior.
3. Fix final-lap event ordering and full-race split collection.
4. Add 1/2/3-lap simulation, medal, replay, and identity tests.

This phase should be behavior-neutral for production Daily GP.

### Phase 2 — Daily GP multi-lap

1. Add deterministic lap selection and persist it in challenge history.
2. Preserve lap/rules fields through every server, client, cache, post, share,
   podium, and playlist boundary.
3. Make replay validation and PB/ghost identity race-aware.
4. Add intermediary medal flash and scaled final medals.
5. Validate 1/2/3-lap submission, Improve ghost, old posts, standings,
   sharing, expiry, and podiums.

### Phase 3 — Campaign foundation

1. Add the campaign manifest and release validation.
2. Add permanent campaign progress and leaderboard stores/routes.
3. Add server-side unlock derivation from verified medals.
4. Add Campaign navigation and track selection.
5. Reuse the Phase 1 race, replay, medal, ghost, HUD, and result contracts.

### Phase 4 — Content and rollout

1. Add campaign-only tracks and fixed lap counts.
2. Author and review unlock requirements.
3. Balance scaled medal targets through playtesting.
4. Release Campaign behind a server-controlled flag if a staged rollout is
   needed.

## Required Validation

Automated coverage must include:

- deterministic Daily lap selection at both sides of the 10.95-second rule;
- historical one-lap challenge compatibility;
- challenge cache and post-bound lap-count preservation;
- exact scaled thresholds for every medal tier and lap count;
- intermediary cumulative medal feedback;
- two- and three-lap checkpoint/finish behavior;
- final-lap event ordering;
- client/server replay parity and replay-size boundaries;
- PB/ghost separation across lap counts and modes;
- Daily and Campaign leaderboard isolation;
- permanent campaign progress and unlock derivation;
- campaign rules/track fingerprint migration behavior;
- old Daily sharing and podium behavior.

Before publication, run the full test suite and build, then complete a hosted
Devvit playtest with signed-in and guest players. Local tests cannot prove
Reddit identity, Redis persistence, post-bound challenge behavior, or hosted
leaderboards.

## Decisions Needed Before Implementation

1. Confirm that tracks at or below 10.95 seconds are the ones eligible for
   three laps.
2. Confirm equal random probability among allowed lap counts.
3. Define the first campaign's track list, fixed lap counts, and unlock graph.
4. Decide whether Campaign launches with PB ghosts.
5. Decide whether Campaign results are shareable; the recommendation is to
   keep Daily sharing/podium behavior unchanged and omit Campaign sharing from
   the first release.
6. Decide how campaign rule changes work after launch: immutable campaign
   version (recommended) or in-place migration.
7. Define campaign progress retention for guests and whether guest progress can
   be claimed by a later signed-in account.
