# Moderator Redis size decrease — 2026-10-03

The reported moderator analytics total fell from approximately 810 MB to 770 MB
overnight on October 2–3. The user confirmed this was the Mini Racer moderator
analytics page, rather than the Devvit developer portal.

The retrieved logs do not establish a deletion of approximately 40 MB. A changed
sample is a plausible explanation, but the exact cause remains unconfirmed:
neither the previous storage-family breakdown nor a stored history of estimates
was available for comparison.

## Live log evidence

Read authenticated installation logs with the installed Devvit 0.14.5 CLI:

```sh
node_modules/.bin/devvit logs <subreddit> mini-racer --since 36h --json --verbose --log-runtime
```

The installation listing reported MiniRacerGame and vector_gp_dev on v2.4.0,
and mini_racer_dev on v2.4.1.389. Inspection used local HEAD `94cba4ae`; deployed
source parity was not established.

- MiniRacerGame returned 167 records, timestamped October 1 at 20:00:57 UTC
  through October 3 at 07:27:59 UTC. None mentioned Redis storage measurement,
  cleanup, purge, retention, or compression. The overnight errors concerned
  Reddit post resolution, authorization, telemetry, and reward-lock contention.
- Two completed guest/account selections were logged at 05:07:58 and 05:44:32
  on October 3 in Europe/Bucharest. Their logs contain timings, not deleted row
  counts or byte totals, so they cannot explain the reported size delta.
- mini_racer_dev returned scheduler-registration messages for Daily posts,
  podium posts, and raced-list filling, with no Redis cleanup/storage error.
- vector_gp_dev returned no records in the requested window.

These are application logs, not a Redis command/deletion audit. Successful guest
cleanup and Redis expiry are not logged by the inspected application code.

## How the moderator estimate can fall

`src/server/moderator/storage-usage.ts` estimates named value/field sizes; it does
not measure Redis allocator usage or count every key.

- Daily families count rows for up to 60 spread stored days, estimate average
  row size from up to five populated hashes with 20 fields each, then scale to
  all stored days. Adding a day or rows can change which days/hashes/fields are
  sampled. A smaller sampled average can outweigh an increased row count.
- Player records sample up to 40 accounts and scale to the known account
  population. This sample can also change as accounts are added.
- Failed count reads return zero; failed size samples return no rows. These
  failures are caught without logging and can lower the displayed estimate.
  The partial result can remain cached for five minutes.

The current schedulers create posts and fill raced lists; there is no nightly
bulk ghost deletion or recompression job. Guest cleanup uses a 365-day retention
deadline and logs failures only. Current local Daily archive retention is 50
years, introduced in `95885286`; older documentation stating 365 days describes
an earlier policy. This local policy does not prove existing deployed key TTLs.

## Validation and limits

All 10 existing `tests/server-storage-usage.test.js` tests passed. They verify
sampling/scaling and explicitly verify that a refused ghost-key read can report
zero ghost bytes while other families still render. This validates the local
estimator behavior, not the cause of the hosted overnight change.

A before/after family breakdown, including rows and keys, is needed to distinguish
changed sampling from actual record loss. The total alone cannot establish that
40 MB of player data disappeared.
