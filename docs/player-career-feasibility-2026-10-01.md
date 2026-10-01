# Player Career profile feasibility

Status: product exploration based on the current `ingame-mapmaker` checkout on
2026-10-01. This note proposes scope; no profile feature has been implemented.
Existing unrelated work was left alone. Inspection is of local code, not hosted
player data or the deployed version.

## Selected scope: interface using existing data only

The user narrowed the scope on 2026-10-01: build an interface using existing
saved data, without adding tracking, counters, awards, transfer domains or
storage. This supersedes the broader future-tracking proposals below.

An interface can reuse the existing player bootstrap, Campaign bootstrap for
each series, Garage snapshot and current Daily snapshot APIs to show:

- Racer since and elapsed profile age from a valid `firstSeenAt`. Use the
  current saved identity's date; do not change guest/account date semantics.
- Campaign stages finished and series mastered, separately.
- Current Bronze, Silver, Gold and Author medal counts from full Campaign
  result maps, not the capped Garage progress fields.
- Campaign track list with saved PBs, medals and current standings.
- Distinct Campaign tracks completed, deduplicated by track key. Keep the
  Campaign scope explicit rather than implying every track ever played.
- Gap to the next Campaign medal, calculated from saved PB and existing
  thresholds on the same stage/race contract.
- Cars unlocked and progress toward the existing Garage requirements.
- Recorded Head to Head challenges beaten, labelled `10+` at the reward cap;
  challenge-posted track progress is similarly bounded at `5+`.
- PB and current rank for Daily challenges available through the current
  snapshots, clearly scoped to those events.

Richer all-history Daily summaries need additional server reads and exposure
of archived records: those records exist, but a lifetime player archive is not
already returned by the player-facing APIs. They are outside a strictly
interface-only first version. Current archived rank would still not mean
highest-ever rank or an immutable final position.

Attempts, retries, all finished races, historical improvements, closest wins
and lifetime streaks are excluded because existing player data cannot supply
complete values. The original broad exploration below remains for reference.

## Effort and proposed first version

A personal Career sheet is a small-to-medium feature. The presentation can reuse
the existing modal, player identity and progression infrastructure. Accurate
lifetime activity needs new per-player tracking, because current analytics and
achievement fields do not form a complete career ledger.

As a rough planning estimate, a sheet using existing data is around 1-2 developer
days; a version with durable attempts, retries, track activity and rank records
is several days of work, including identity-transfer and duplicate-event tests.
These are estimates, not a delivery commitment. Public profiles or a full race
timeline would expand the scope.

Start with a private racing licence: name/current car, Racer since, distinct
tracks completed, Campaign completion and medals, Garage collection, and a
clearly defined best result. Add activity totals as new tracking becomes
available. Keep the sheet focused on achievements and personal highlights.

## Existing data and gaps

| Metric | Availability and meaning |
| --- | --- |
| Racer since / career age | `firstSeenAt` is already returned by player bootstrap. It dates profile creation, not necessarily the first race ever. Missing legacy dates parse as the Unix epoch and must be treated as unknown. Guest-to-account date handling needs an explicit policy. |
| Campaign stages completed, medals, PBs | Full Campaign results are available by series and include race/track identity, best time, medal and update date. These are suitable for accurate progression summaries. Distinguish stages finished from series mastered: existing series completion requires Gold/Author on every stage. Count full results, because Garage medal thresholds cap their progress counts at 10. |
| Tracks completed | Can derive a known set from retained verified Daily and Campaign results and deduplicate by track key. This excludes starts without finishes and Head to Head activity that did not save an origin PB. |
| Tracks played | A complete count needs new per-track start tracking. The current start request sends mode and player identity, but no track key. |
| Daily events entered | Retained verified rows can establish entries. The per-player raced-board index helps find candidates, but its length is not a completion count: boards are also listed before submission succeeds. |
| Attempts / retries | Community analytics count observed starts, including ordinary retries, but do not retain a per-player attempt total or retry reason. Collision/quick restart resets follow a separate path. Define and instrument game retries separately from network submission retries. |
| Races finished | The Garage completion field is a boolean. Analytics finishes hang off accepted submissions; non-PB finishes are not a complete server history. Counting all finishes needs its own event. |
| Highest rank reached | No lifetime minimum-rank record exists. Persist the best server-confirmed rank together with board, date and participant context going forward. Reading an old board today cannot recover its earlier ranks. |
| Best final Daily finish / podiums | Different from peak rank. Needs a final-result snapshot or awards at Daily closure. Old-board rank can change through guest cleanup and progress transfer. Existing podium posts preserve only the top three and are not a general player result ledger. |
| Head to Head wins | Garage records distinct won challenge IDs, but stops after 10 for unlock purposes. Show milestone progress or 10+ from that data; a true lifetime win total needs independent tracking. |
| Cars unlocked | Existing unlock snapshots can supply collection progress. |

Relevant current sources:

- `src/server/competition/competition-identity.ts`: profile parsing and
  `buildPlayerProfile`, including the legacy date fallback.
- `src/server/player/player-account-store.ts`: `getServerPlayerBootstrap`
  already returns `firstSeenAt` and car unlocks.
- `src/server/campaign/campaign-store.ts`: `CampaignBestResult`,
  `getCampaignProgressSummary` and full per-series results.
- `src/server/player/raced-list.ts`: the per-player board inventory and its
  pre-submission listing behavior.
- `game/journeys/service.js`, `game/journeys/race-report.js`,
  `src/server/routes/analytics-routes.ts`,
  `src/server/moderator/analytics-store.ts`: existing attempt events,
  mode-only start payload and community aggregate counters.
- `game/race/engine-methods.js`: collision and quick restart reset path.
- `src/server/player/car-unlock-store.ts`, `game/car/car-unlock-policy.js`:
  bounded reward fields, boolean completion and capped medal progress.

Retention note: current `src/server/daily/daily-gp-model.ts` keeps Daily boards,
ghosts and challenge history for 50 years, while guest rows still have separate
inactivity cleanup. Older one-year board-retention descriptions in existing
documentation do not describe these current constants. Archived boards help
recover known results, but cannot recreate expired/deleted data, unreported
attempts, or historical peak ranks.

## Fun additions

- Medal cabinet with Bronze, Silver, Gold and Author counts.
- Track passport showing completed tracks and each track's best result.
- So close: the smallest gap to the next medal, using existing Campaign PBs
  and the stage's medal thresholds.
- Biggest improvement: first verified time versus current PB on the same race
  contract. Requires retaining a first-result baseline going forward.
- Closest verified Head to Head win, with the margin and track. Requires a new
  persistent highlight record.
- Favourite track / most retried track, using new per-track activity counts.
- Current and longest racing streak, plus total active days. Historical analytics
  presence offers only an observed, retained window; lifetime streaks need their
  own tracking.
- Daily podiums and top-10 finishes, awarded after the event closes.
- Cosmetic milestone titles such as Explorer, Gold Collector and Ghost Hunter.
- A shareable racing licence, as a later addition using the established preview
  and sharing flow.

## Implementation boundaries for a later change

Use a compact authenticated per-player summary and a distinct-track set rather
than storing every attempt. Reconstruct historical summaries in bounded batches
and cache them; opening the profile should not scan every archived Daily board.
Keep nonessential activity tracking off race-start
and ranked-save critical paths. Event identity and deduplication must prevent
network retries from becoming extra game attempts or wins. Track server-verified
achievements separately from client-reported activity.

New statistics must participate in the existing Guest/Account selection,
transfer, frozen inventory and cleanup rules. Preserve the user's selected
career consistently; choosing Account must not later resurrect discarded guest
totals. Decide whether the earliest valid profile date follows that choice.

Seed only what existing records prove. For unrecoverable historical totals, show
an explicit tracking start date instead of labelling new counts as all-time.
Record participant count alongside rank; a first place on a one-player board
should not be presented as an equivalent achievement to first among many racers.

## Validation

Evidence was traced in current local code. Existing analytics, start-reporting,
Journey lifecycle and Garage tests passed: 5 files, 54 tests. No runtime code
was changed. These tests do not establish the completeness of hosted historical
data or validate a future Career implementation.
