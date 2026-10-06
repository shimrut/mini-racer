# Failed Daily submission replacement — validation, 2026-10-06

Initially validated against `6a1f23cc` on `codex/campaign-completed-poster` without gameplay changes. The subsequent authorized fix and permanent regression coverage are recorded below.

## Finding

Confirmed before the fix: a terminally failed queued Daily result prevented an equal or slower eligible result from being submitted for the same challenge and owner in that browser's local storage. The result screen said `Couldn't rank this run. Try again.` A strictly faster result could replace the failed entry. Campaign already permitted replacement of a terminal entry by a slower result.

The qualification matters: a network exception or retryable HTTP response (408, 425, 429, or 5xx) retains a pending result and a retry. Those failures do not by themselves create a permanent terminal lockout. A run that fails locally before creating a queue entry also does not create this particular blocker.

## Pre-fix code evidence

- `game/scoreboard/verification-queue.js:208`: `isBetterDailyCandidate` compares only `bestTime`; it never checks whether the prior entry is terminal.
- `game/scoreboard/verification-queue.js:319`: terminal marking retains the failed time and replay, with `nextAttemptAt: null`. `getDue` at line 345 processes only pending entries.
- `game/scoreboard/engine-methods.js:463`: a non-retryable failed response marks the entry as an error and rolls back its optimistic local Daily best. The queue's failed time remains.
- `game/scoreboard/verification-queue.js:483`: refusing a replacement returns `enqueued: false` and retains the prior entry. `game/scoreboard/engine-methods.js:547` starts queue processing only when the enqueue succeeds.
- `game/daily-challenge/engine-methods.js:1302`: an eligible best whose enqueue fails is rolled back again; line 1317 supplies the reported result-screen message.
- `game/scoreboard/verification-queue.js:684`: Campaign's comparator accepts a replacement whenever the previous entry is not pending.

The queue is stored in `VectorGpVerificationQueue` and read back on reload. Daily expiry uses `availableUntil + 6 hours` (`game/scoreboard/engine-methods.js:536`). A new Daily's playable interval is seven days from its UTC start (`src/server/daily/daily-gp-model.ts:184`). The blocker can therefore last for the rest of that Daily's playable window; it is not a fresh seven-day timer starting at failure. Its stored entry lasts another six hours, then is purged on queue access (`game/scoreboard/verification-queue.js:63`).

## Reproduction and validation

A temporary Vitest reproduction exercised the real `handleDailyChallengeWin`, enqueue, queue processing, HTTP submit adapter, result handling, and finish payload. Browser storage and the HTTP response were mocked; the first request returned HTTP 400 `Replay rejected`. Finish validation was stubbed as successful so the checks isolated submission behavior. This is client behavior evidence, not hosted replay-validator or Redis evidence.

1. Finish at 10 seconds. One submit request occurs; its terminal error restores the prior local best (tested both no prior best and a 12-second prior best).
2. Finish at 11 seconds or repeat 10 seconds. Both are eligible against the restored local best. The submit count stays at one, the queue remains a 10-second error, and the finish payload contains `Couldn't rank this run. Try again.` No queue retry is scheduled for the terminal entry.
3. Enqueue 9.5 seconds. The replacement succeeds and becomes pending.
4. In Campaign, mark a 10-second entry as an error and enqueue 11 seconds. The replacement succeeds and is due for processing.
5. Reload queue and owner modules while preserving storage. The Daily error survives; it refuses a slower replacement late in the playable window and is purged exactly at `availableUntil + 6 hours`.
6. Repeat the Daily flow with HTTP 503. The original entry stays pending with a retry due in 30 seconds.

Eight temporary checks passed. Existing focused suites also passed: `verification-queue.test.js` (41), `verification-queue-wave2.test.js` (3), `scoreboard-engine-methods.test.js` (14), and `engine-daily-challenge.test.js` (60). Total: **126 passed**, across five files. The temporary reproduction file was removed after validation. No full-suite or hosted run was performed.

## Implemented fix

Added the same non-pending-state check used by Campaign to `isBetterDailyCandidate`. A new eligible Daily candidate can now replace an error or rejected entry even when its time is equal or slower. Pending entries still require a strictly faster replacement. Owner scoping, expiry, retry timing, server acceptance, and stale-response guards are unchanged.

Permanent tests in `tests/daily-submit-recovery.test.js` exercise the real finish-to-HTTP-to-result path with mocked browser storage and HTTP responses. A 400 rejection at 10 seconds is followed by an accepted eligible 11-second finish, with no prior best, with a 12-second prior best, and after reloading the modules with persisted storage. An equal 10-second replacement is also accepted. Each case verifies two submit requests, the accepted local best, cleared queue, and updated rank.

`tests/verification-queue.test.js` additionally covers equal/slower replacement of both terminal states and preservation of the better replay and retry deadline for pending entries. Before the code change, all eight new terminal-recovery checks failed and the two new pending-preservation checks passed. After the one-line fix, all **289 focused tests across nine files passed**, including Campaign, owner/transfer recovery, and stale-response coverage. `npm run typecheck` passed.

Local Chromium gameplay smoke testing loaded Daily, started the race, advanced time, and steered without runtime or console errors. The screenshot and text state were inspected; artifacts are in `/private/tmp/daily-submit-recovery-browser/`. The failure/recovery HTTP sequence is covered by the mocked integration tests, not this gameplay smoke check. Test logs: `/private/tmp/daily-submit-recovery-before.log` and `/private/tmp/daily-submit-recovery-tests.log`. No full-suite, production deployment, hosted Redis/Reddit, or physical-device validation was performed.
