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

## Local gates

Before the hosted run, 245 focused tests passed across the diagnostic, car unlock store, Campaign store, Daily store, and server route contracts. `npm run build` and `git diff --check` also passed. After capture, the normal build was restored and revalidated without the temporary diagnostic surface.
