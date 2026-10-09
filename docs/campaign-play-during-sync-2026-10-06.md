# Campaign play during local synchronization

Read-only behavior investigation, 2026-10-06. No gameplay or persistence code changed.

## Two different operations

Ordinary upload of browser-queued Campaign results is handled by
`game/scoreboard/engine-methods.js` and `game/campaign/engine-methods.js`.
An upload in flight does not itself set a transfer block or stop another attempt.
Pending results remain separate from verified server progress; a stage unlock
requires confirmation. Queue candidate rules retain the faster pending replay
for the same owner and race, and superseded-response checks prevent an older
response from settling a newer candidate.

A guest-to-account progress transfer is a separate coordinated operation.
`game/player/progress-state.js` records an owner-scoped transfer block before
selection or recovery. `startCampaignStage` checks it, and `startSequence`
checks again immediately before simulation. The player sees:
“Finishing your progress transfer. Racing continues once it is done.”
Known unresolved transfers also prevent the ordinary Continue Offline bypass.

## A race already running

The start gates do not abort an already-running simulation. An eligible finish
can enter the owner-scoped local verification queue, but the queue does not
select submissions while that owner is blocked. If a request reaches the server
during a pending transfer, server submission checks return retryable
`503 progress_transfer_pending`. Campaign progress transactions additionally
watch transfer markers, preventing a save from writing across a transfer that
started after the earlier check.

Completion reconciles captured queue entries before releasing the local block.
Entries added or changed after capture are preserved rather than blindly moved
or removed; ambiguous guest entries without a receipt may require review.
Preservation alone does not prove that every late result will automatically
appear under the account, particularly from another device or session.

## Validation

`npx vitest run tests/race-blocked-by-transfer.test.js
tests/verification-queue-transfer-pause.test.js
tests/verification-queue-transfer-recovery.test.js
tests/server-campaign-store.test.js` — 4 files, 82 tests passed.

The Campaign store fixture logs a best-effort analytics mock warning because
its Redis double lacks `hIncrBy`; the tests still pass. These checks cover local
gates, queue reconciliation, and Campaign persistence behavior. They do not
establish hosted Redis concurrency or a live cross-device finish/transfer
interleaving.
