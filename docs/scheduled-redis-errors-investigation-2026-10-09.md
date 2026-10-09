# Playtest scheduled Redis errors — 2026-10-09

Investigation of `mini_racer_dev`. The initial investigation below changed no
runtime code, tests, deployment, scheduler configuration, or Redis data. The
later tracing follow-up is recorded separately at the end. Existing workspace
changes were preserved.

## Evidence and diagnosis

The pasted errors and a fresh read of the Devvit installation's server logs
identify intermittent failures in Devvit's Redis RPC transport:
`14 UNAVAILABLE: Stream refused by server`. The app receives that rejection from
`Get` or `HGet`, then its route handles the rejected promise. The logs do not
identify the platform's reason for refusing the stream or establish a Reddit-wide
incident, Redis quota exhaustion, or a playtest-specific defect.

[gRPC's status reference](https://grpc.io/docs/guides/status-codes/) classifies
code 14 as service unavailability, usually transient, for which bounded backoff
can help. This does not make arbitrary writes or Reddit publication safe to retry.

Server logs were read with:

```sh
node_modules/.bin/devvit logs mini_racer_dev mini-racer --since 18h --json --verbose --log-runtime
```

The bounded stream returned 486 records, dated 2026-10-08 14:08:24 UTC through
2026-10-09 07:23:39 UTC. Sixteen were error records: six raced-list failures, six
HTTP 500 wrapper messages for those same failures, one podium failure, and three
earlier Campaign post refresh authorization failures. Other retrieved records
were cron registration or the expected notice that Journey telemetry is not
recorded for playtest versions. This is a log sample, not proof of every scheduled
delivery or the current contents of Redis.

## Exact scheduled failures

The local `dist/server/index.cjs` and its source map match the pasted minified
stack positions. The relevant build file was last modified on 2026-10-08 at
20:29:10 UTC. These mappings identify the reads that failed:

| Pasted frame | Mapped source | Read |
| --- | --- | --- |
| `toe`, `main.js:105:74957` | `src/server/campaign/campaign-aggregate-store.ts:80` | Campaign series aggregate fill-ready key |
| `bye`, `main.js:54:53219` | `src/server/player/raced-list-fill.ts:123` | Raced-list fill-ready key |
| `o`, `main.js:107:737` | `src/server/posts/autopost-subscription-store.ts:70` | Podium subscription hash field, called from `daily-podium-service.ts:355` |

The raced-list endpoint failed at 2026-10-08 16:01 and 23:10 UTC, then
2026-10-09 01:28, 02:18, 03:46 and 07:01 UTC. The earlier 16:01 stack also
has `toe` at the same position, but its caller differs from the later build.
The 02:18 and 03:46 failures are the raced-list readiness read; the other later
failures are Campaign aggregate readiness reads.

`src/server/server-app.ts:343-346` runs raced-list fill and then Campaign aggregate
adoption through this same endpoint. A completed fill still checks its Redis
readiness key; each sealed Campaign series also checks an aggregate readiness key.
These checks explain why a finished migration can still log a scheduler error.

The mapped readiness reads run before their respective fill lock and mutations.
A raced-list read failure skips aggregate adoption for that invocation. An
aggregate read failure occurs after the raced-list step has returned. These failed
reads do not delete or corrupt player results, and the following minute's recurring
invocation can try again. Persisted fill checkpoints support continuation, but
there is no successful-run log proving that a specific later invocation recovered.

`src/server/routes/internal-routes.ts:405-413` converts the dependency rejection
to HTTP 500. Devvit's subsequent “Failed to POST” entry reports that response;
it is not a second independent failure.

## Request-stream refusal and overlapping work

The exact error text is more specific than a generic connection failure.
[gRPC-JS's HTTP/2 call implementation](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/src/subchannel-call.ts)
maps `NGHTTP2_REFUSED_STREAM` to `UNAVAILABLE` and the literal detail
`Stream refused by server`. This points to an HTTP/2 request stream being
rejected by the RPC peer. The application log is not a wire trace, and the
hosted runtime's precise dependency version and peer are not exposed here.

[HTTP/2 section 7](https://www.rfc-editor.org/rfc/rfc9113.html#section-7)
defines `REFUSED_STREAM` (0x07) as refusal before application processing at that
endpoint. It describes what happened to the request stream, not the server's
operational reason. In particular,
[section 5.1.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.1.2)
allows this error when the advertised concurrent-stream limit is exceeded.
Connection maintenance is another possible family of temporary rejection, but
the captured logs contain neither a peer/connection identifier, active stream
count, backend restart event, nor a quota-specific diagnostic. Neither overload
nor a restart has been demonstrated.

Three independent maintenance routes are scheduled every minute: raced-list
plus Campaign adoption, Daily ghost archive, and ghost compaction. Podium work
also runs at minute 01 of each hour; daily post publication runs at 00:05 UTC.
Their separate locks allow different jobs to run concurrently. Common cron
expressions establish possible coincident traffic, not measured overlap.

Archive Off reads its setting and returns (`daily-ghost-archive.ts:1331-1338`);
idle compaction reads its state and returns (`ghost-compaction.ts:484-486`).
Active archive/compaction can perform bounded batches for roughly 22 seconds.
The failing readiness/subscription reads are small admission checks; a refusal
there does not establish that a large migration was executing.

All scheduler routes also pass the stored-catalog middleware. With a warm known
installation, completed raced/one-series aggregate fills, archive Off, and
compaction idle, source inspection gives approximately seven Redis plugin read
calls across the three minute jobs per minute. This is a conditional source
calculation, not a measurement of the historical workload. Other series,
gameplay, and active maintenance can add traffic.

The log sample has no successful tick status or start/end records for archive
or compaction, so their state at each failure cannot be reconstructed. Its 255
`Cron task ... scheduled` lines are task registrations during installation or
upgrade, not executions. The installed build-pack's `blocks.template.js` also
cancels preceding managed cron jobs before registering the new jobs; these
messages do not demonstrate duplicate recurring jobs.

All seven Redis refusals were logged near the 49th second of their minute. This
is callback/error timing, not evidence that an invocation ran for 49 seconds.
No job-start timestamps were recorded for these failures. A precise backend
cause would require Devvit's accepting service/proxy logs or connection metrics
for the corresponding timestamps.

## Podium deadline

The server log timestamps the podium subscription read failure at
2026-10-09 05:01:49 UTC, or 08:01:49 in Bucharest. It precedes that invocation's
snapshot writes, creation lock, and Reddit submission.

`devvit.json:181-187` schedules podium work hourly at minute 1, and raced-list
work every minute. `daily-podium-service.ts:37-60` permits publication for six
hours after expiry midnight: 00:00 UTC inclusive through 06:00 UTC exclusive.
Thus this podium failure occurred on the last eligible scheduled attempt.

The podium route catches a per-subreddit failure and returns HTTP 200 with its
creation count (`internal-routes.ts:445-467`). After the deadline it skips the
podium entirely; no older-day backlog catch-up exists. If an earlier attempt
already published the podium, this read failure has no publication consequence.
If none did, this invocation could leave it unpublished. Successful publication
and reuse are not logged, so the retrieved logs cannot determine which happened.

## Separate earlier Campaign error

At 2026-10-08 14:16:50, 14:17:16 and 16:32:40 UTC, the logs also show
`Campaign shared post could not be refreshed` with `13 INTERNAL`, whose nested
cause is `NotAuthorizedError` while updating the same post's text fallback.
This is a Reddit post update authorization failure, distinct from the scheduled
Redis transport failures. These records alone do not identify which authorization
condition was refused or establish the behavior of later builds.

## Validation and next change

Focused existing tests passed: 36 tests across raced-list fill, raced-list names,
and Campaign aggregate coverage; 84 across podium service, subscription store,
and post store coverage. They verify normal readiness, continuation, ownership,
publication windows, and post recovery with mocks. They do not prove hosted
recovery or inject these exact transport refusals.

The two relevant route contract tests also passed: raced-list dependency failure
returns HTTP 500, while a per-subreddit podium failure is isolated under HTTP 200.
Total focused verification: 122 passed tests; no full-suite or hosted recovery
claim is made.

The logs demonstrate a transport failure rather than a new gameplay or migration
logic defect. A narrowly scoped reliability change could add bounded retries to
these idempotent Redis reads, retain failure reporting after exhaustion, and test
that final-slot podium subscription reads can recover without repeating Reddit
publication. Retrying the entire publication flow or returning success without
doing the work would need a different justification.

## Follow-up: process tracing supplied on 2026-10-09

This follow-up is diagnosis and recommendations only, as requested. The supplied
attachment contains a raced-list HTTP 500 at 2026-10-09 12:21:49 UTC (15:21:49 in
Bucharest), followed by two process summaries and three Redis call warnings.
The latter lines have no absolute timestamps, so they cannot be correlated with
the earlier 500 from this attachment alone. No fresh hosted logs or Redis state
were read, and no runtime code, tests, or deployment were changed in this
follow-up. Only this investigation document was updated.

### What the new measurements establish

All five tracing lines identify the same tracer instance, `05ecba4f`.

| Rejected call | Outstanding calls at invocation / rejection | Active requests at rejection | Measured rejection delay |
| --- | --- | --- | --- |
| Archive `mGet`, tracer age 4,373 seconds | 1 / 1 | Archive only | 7 ms |
| Compaction `mGet`, age 6,712 seconds | 1 / 1 | Compaction only | 5 ms |
| Archive `mGet`, age 7,192 seconds | 3 / 3 | Podium, raced-list, archive | 4 ms |

The first two refusals happened with no other traced Redis call or HTTP request
in flight. The third proves that scheduler work sometimes overlaps, but overlap
is not necessary for the observed failure. These are fast rejections, with no
evidence of a long application queue in these samples.

The first summary reports 2,356 Redis SDK calls over approximately 3,652 seconds,
one code-14 rejection, and a maximum of 35 outstanding calls. That maximum is
historical, not the concurrency at the rejection. The second summary covers
3,600 seconds: 553 calls, 182 requests, a maximum of three outstanding calls,
and three code-14 rejections. That is approximately 0.154 SDK calls per second
averaged over the second interval. All three detailed warnings fit that second
interval. The measured traffic does not support sustained overload in this
Node process or a conclusion that the app exhausted Redis capacity.

The labels and counters have specific limits (`playtest-redis-trace.ts:59-159`):

- The ID is a random tracer-instance label, not an OS PID or RPC connection ID.
  The detailed failures occur more than an hour after that instance started;
  they do not demonstrate app startup failures or identify backend restarts.
- Calls are unresolved promises from wrapped Redis SDK methods. `callsAtSend`
  and `waitedMs` are recorded just after invoking the original method; they are
  not wire-level stream counts or network-send timings. `callsNow` includes the
  rejecting call, which is removed after reporting.
- Request counts end on response `close`. `served` counts admitted requests,
  including unsuccessful ones. Summaries are emitted on the first request after
  an hour has elapsed, rather than on an exact hourly timer.
- `failures` counts numeric gRPC code 14 only. The tracer records calls and
  transactions on the wrapped shared Redis client, not all RPC services, other
  processes, platform-internal retries, peer load, or advertised stream limits.

The existing transport diagnosis still fits:
[gRPC-JS](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/src/subchannel-call.ts)
maps HTTP/2 `NGHTTP2_REFUSED_STREAM` to this exact error detail. The new evidence weakens
local workload saturation as the explanation; it does not identify why the
Devvit RPC peer refused a stream. Shared infrastructure pressure and connection
lifecycle behavior remain hypotheses requiring platform-side evidence.

### Call warnings are not final job outcomes

`createServerApp` runs every scheduler route through `ensureStoredCatalogLoaded`
before the route handler (`server-app.ts:390-404`). Its common revision check is
an `mGet` of the track and Campaign-series revisions (`stored-catalog.ts:40-46`).
It already retries the catalog load up to three times, waiting 50 ms and 150 ms
before subsequent attempts (`stored-catalog.ts:29-30,54-74`). If all attempts
fail, middleware logs `Stored tracks could not load` and returns HTTP 503.

The new early `mGet` warnings are consistent with this common catalog check.
However, active archive and compaction also use `mGet` later in their workers,
and the tracer records neither keys nor call site. Exact attribution is therefore
unproven. A rejected catalog attempt can recover within the same invocation;
none of these three warnings alone establishes a failed or skipped job.

The supplied raced-list message does establish a final HTTP 500. The current
local bundle/source map places `main.js:1:141201` in the SDK's `RedisClient.get`,
`main.js:105:905` in the tracer's call to the wrapped method, and
`main.js:105:337` in the tracer's `track` function. Those snippets match the
pasted frames, but there is no deployed-build identity in the attachment. In
particular, this new stack contains no business caller or Redis key: it cannot
distinguish raced-list readiness, Campaign aggregate readiness, or another
`get` in that route. The older exact readiness mappings above apply to their
older stacks, not automatically to this new stack.

Readiness, archive-setting, and initial compaction-state reads still have no
local read retry. Their failure can postpone an invocation even when the worker
is otherwise ready, Off, or Idle. The minute schedules and persisted migration
checkpoints allow subsequent invocations to continue; these logs do not prove
successful recovery of any particular invocation or actual hosted state.

### Recommendations and validation

1. Keep the current diagnosis at intermittent Redis RPC stream refusal. These
   samples do not justify a scheduler rewrite, global serialization, or cron
   staggering as a demonstrated solution.
2. Correlate future call warnings with a request ID, logical read/attempt label,
   and final response or recovery outcome. Use logical operation names rather
   than player-specific key contents. Preserve exact timestamps/build version
   when collecting evidence for Devvit support.
3. If a reliability change is authorized, add small bounded backoff with jitter
   to the unprotected idempotent readiness/setting/state reads, retaining errors
   after exhaustion. Account for the existing catalog retries instead of stacking
   another general retry wrapper. Test transient recovery and exhaustion. Avoid
   blanket retries of writes, transaction commits, or complete publication flows.

Focused existing suites passed: 110 tests across playtest tracing, raced-list
fill, Campaign aggregates, ghost compaction, and Daily ghost archive, plus 23
stored-catalog tests: **133 total**. Tracer tests inject the same code-14 refusal
shape; the worker suites validate mocked continuation and ownership contracts.
Catalog coverage includes recovery from a failed read and exhaustion after three
failed reads while preserving the cache. These are local tests, not hosted
transport recovery or full-suite proof. No tests were edited.
