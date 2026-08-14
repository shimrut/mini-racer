# Hosted Redis integrity validation — 2026-08-12

The audit used a temporary, subreddit-restricted harness in the `mini_racer_dev` Devvit installation. It used UUID synthetic guest and Reddit identities, called production storage functions, logged no tokens or real player identifiers, and deleted the exact synthetic records in `finally`. The temporary menu, scheduler, routes, module, and tests were removed after capture.

## Final hosted result

Final run `0a44933c-ec39-4f26-9ce1-e272c6c6f1ea` on playtest version `v2.0.1.28` reported:

- #2 reproduced through `recordCompletedRace`, `mergeGuestCarUnlockProgress`, a distinguishable late guest event, and a second-account promotion attempt. The late guest event was stored on account A and account B remained empty.
- #3 reproduced through `mergeGuestCampaignProgress` from the exact equal-entry retry state. The account hash entry survived, its sorted-set ranking member was absent, and the guest hash and ranking member were removed.
- #5 reproduced through real `upsertPlayerProfile` and `readPlayerProfile` calls. A stale full-profile write regressed newer preferences and `hasAnyData`.
- #7 behaved as designed through `claimNewGuestPlayerProfile`, `adoptExistingGuestPlayerProfile`, and internal token verification. No token was logged.
- #6's real Redis primitive probe confirmed that a later `hDel` removes a fresh same-field write. This did not invoke the production `readCompatibleRecord` path, so it is supporting evidence rather than a full production-path reproduction.
- Cleanup reported `complete`.

#1, #4, and #8 were not run because their decisive behavior belongs to the browser verification queue or bootstrap/settlement lifecycle, not Redis alone.

## Additional hosted evidence

Both isolated Campaign promotion runs emitted `exceeded max concurrency limit on redis transactions` while production `mergeGuestCampaignProgress` released its stage locks. The merge still returned and the diagnostic's exact-key cleanup completed, but the warning is a separate hosted reliability concern: normal calls can leave promotion locks until TTL expiry and produce repeated server errors.

The two isolated Campaign runs incremented the 14 Campaign standings revisions once each, for 28 development-installation-only cache invalidations. These revision counters are monotonic metadata and were not rolled back. The two one-shot scheduler marker keys expire automatically within 15 minutes. No production installation, real account progress, post, or leaderboard member was touched.

## Remediation implemented after capture

- #2: after a successful signed-in guest promotion, bootstrap instructs the browser to retire its guest ID and token. The server's short-lived promotion pointer remains available for in-flight writes, while a later signed-out session starts with a fresh guest identity instead of inheriting the old account pointer.
- #3: Campaign promotion now commits an account entry, sorted-set rank, and standings revision in one owned Redis transaction. Equal-entry retry states repair a missing rank instead of skipping it, and Campaign bootstrap repairs historical entry-without-rank records. Promotion leases are renewed sequentially as one group, avoiding the observed burst of concurrent Redis transactions.
- #5: profile writes now WATCH the profile key, rebuild from the latest stored profile, and retry a conflicted transaction. This preserves a newer explicit preference and the monotonic `hasAnyData` state.

## Follow-up remediation — 2026-08-12, branch `codex/remaining-integrity-fixes`

These close the findings the hosted run left open, plus the residual windows it exposed. They are covered by focused and full local test runs only; none of this has been exercised against hosted Redis, and the hosted concerns recorded above (promotion-lock concurrency warnings) are untouched.

- #1: queued Daily and Campaign results are stored per owner and only the confirmed owner's are processed or displayed. Submissions carry `submissionOwnerId` and the server answers a mismatch with `409 submission_identity_changed` before rate limiting or replay validation, keeping the replay. Results raced before the account was known are stamped with who this phone already is and kept. This visit's bootstrap may claim a first-time guest run; a later visit does not retag another owner's waiting run.
- #2 residual: a promoted guest credential is now refused server-side rather than trusted to rotate. The existing promotion pointer is proof the promotion committed, and leftover guest Campaign progress is proof its migration has not finished, so a pending promotion still authorizes while a completed one is rejected everywhere and cannot be claimed or adopted back.
- #4: the profile/bootstrap outage fallback no longer applies the all-locked default. It presents the last confirmed profile for that owner, writes no preference, and never rewrites the selected car; the real profile is retried at 5s, 30s, and 2m and on reconnect or resume.
- #6: the lock-free PB read no longer deletes. Cleanup of an unusable record happens only on the write path, which owns that player's PB lock, so a stale reader cannot delete a replacement committed after its own read. The hosted probe above showed the primitive behavior; this change removes the path that could reach it.
- #8: a Campaign result whose PB write reported `unavailable` keeps its replay for three background retries while its verified progress stands, matching Daily. A successful retry installs the returned record without a second request.

## Follow-up remediation — 2026-08-12, branch `fix/pressing-audit-four`

- Mode warmup prefetches other mode bundles without leaving Campaign `challenge-run` helpers on the prototype when Daily is active.
- Collision auto-restart resets multi-lap challenge progress so a crash cannot fake-finish the race.
- Campaign **Next** and lobby unlocks use verified progress only; starting the next stage waits for confirmation and aborts when verification does not settle. After the server accepts the run, the open finish sheet turns **Next** on and restores its click action.
- Reddit sign-in merges guest Daily leaderboard rows for the seven-day playlist onto the signed-in account, then deletes the guest row. Copy and delete hold both players' Daily submission locks, matching Campaign merge.

## Guest progress choice — 2026-08-13

- Automatic guest promotion was removed from both player and Campaign bootstrap. A signed-in browser with a guest credential receives a non-authoritative choice payload and must select guest progress or saved account progress before ranked state is applied.
- The selection coordinator records the first choice, retries idempotently, replaces or discards Daily/Campaign/car-unlock state as selected, and retires the guest only after all domains complete. A pending selection keeps the guest source and credential alive.
- Local tests and the production build cover the client prompt and replacement paths. Hosted Reddit/Redis validation remains outstanding; no hosted identity or data was touched by this branch.

## Local gates

Before the hosted run, 245 focused tests passed across the diagnostic, car unlock store, Campaign store, Daily store, and server route contracts. `npm run build` and `git diff --check` also passed. After capture, the normal build was restored and revalidated without the temporary diagnostic surface.
