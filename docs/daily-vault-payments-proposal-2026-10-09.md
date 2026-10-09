# Daily Vault: one purchase for the archive

Status: integration proposal, not implemented or approved for real sales.
Checked against the local working tree and Reddit's public documentation on
2026-10-09. Existing unrelated changes were preserved.

## Product contract

The user selected **one purchase for the whole archive**. Proposed product:
`daily-vault`, accounting type `DURABLE`, priced in Reddit Gold. Price remains
undecided. It unlocks the supported historical Daily library and future Dailies
as they leave the seven-day free window, without repeat purchases.

Keep the last seven Daily days free. Anyone can browse archive metadata and see
what the purchase includes. A signed-in owner can start historical Daily races,
save verified PBs, race available ghosts, and improve their rank on the **original
Daily leaderboard**. This carries forward the user's earlier same-board ranking
preference; it is not a separate practice-results system.

Identify entries by original challenge ID/date, not track key alone: the same
geometry may appear in several Daily competitions with different race contracts.
Show date, track preview/name, lap count, saved PB and current rank. Paginate the
archive; load geometry and ghosts only when needed. Search and month filters can
follow a basic date browser.

Recommended podium semantics: the original closing podium stays a historical
snapshot; the original leaderboard remains live for Vault improvements. Clearly
label both. Capture a durable closing snapshot **before** accepting post-expiry
results, including when Reddit podium publication is delayed or disabled. An
already-published podium is frozen today, but an uncreated podium can still be
built from then-current standings. Do not retroactively claim that historical
closing snapshots exist where they were never saved.

## Reddit approval issue

The [Payments overview](https://developers.reddit.com/docs/earn-money/payments/payments_overview)
describes selling premium features. However, the current
[Devvit payment rules](https://developers.reddit.com/docs/devvit_rules#pilot-devvit-goods)
say apps cannot "limit functionality behind a paywall or in-app purchase."
That wording creates an unresolved approval issue for paid archive play/ranking.
Ask Reddit for written clearance for this exact product before real sales;
keeping recent Dailies free does not establish an exception.

Developer eligibility/verification and app/product review are also required.
See [Publish payments](https://developers.reddit.com/docs/earn-money/payments/payments_publish).
Sandbox development is possible while resolving approval. No Reddit team was
contacted and no account eligibility or existing approval was checked here.

## Payment integration

The [Add Payments guide](https://developers.reddit.com/docs/earn-money/payments/payments_add)
specifies a product catalog, fulfillment/refund endpoints in `devvit.json`, and
client `purchase(sku)`. Use `DURABLE` for the permanent pass. Checkout supports
web, iOS and Android; display an allowed Gold price with the official Gold icon.

The current app uses `@devvit/web` 0.14.7. Its client/server/shared entrypoints
already export the installed `@devvit/payments` 0.14.7 APIs transitively. There
is no configured product, payment handler or Vault entitlement in this app.
Use the matching SDK version if declaring payments as a direct dependency;
avoid an unrelated Devvit upgrade.

Proposed flow:

1. Load archive metadata, the product's actual catalog price, and authenticated
   ownership from the server.
2. The priced **Unlock Daily Vault** action calls `purchase('daily-vault')`.
3. Reddit invokes the internal fulfillment endpoint. Validate the known SKU,
   paid order and trusted buyer/installation context. Persist the receipt and
   entitlement atomically and idempotently by order ID before acknowledging.
4. After checkout, reload ownership from the server. A client success flag or
   local-storage value never grants access. Cancellation grants nothing.
5. Every historical race request and submission uses server authorization.
6. A refund invalidates that receipt; ownership persists if another valid
   receipt exists. A late duplicate fulfillment cannot undo a recorded refund.
   Accepted racing results remain saved; future paid access is revoked.

Keep entitlements separate from racing progress and Garage unlocks. They belong
to the authenticated Reddit account, never a guest ID or selected save. Choosing
guest progress must not erase an account's purchase. Ownership must work across
posts and devices in the supported installation. Cross-subreddit purchase scope
is **unverified**: local Redis is installation-scoped, so do not promise an
app-wide restore until the hosted API behavior is established.

The [Manage Payments guide](https://developers.reddit.com/docs/earn-money/payments/payments_manage)
documents historical order queries and refund callbacks. Add bounded receipt
reconciliation for interrupted checkout or missing local ownership. Verify
buyer filtering and pagination in a hosted playtest before relying on them.

Important SDK differences from documentation examples:

- Installed `PaymentHandlerRequest` has ID, string status, timestamps, products
  and metadata, but **no `userId` or `postId` field**. Use its correct type and
  establish trusted purchaser context in hosted tests; do not copy the example's
  `order.userId`, trust caller-supplied buyer metadata, or assume an app/service
  callback identity is the buyer.
- Installed `payments.getOrders()` requires a `limit`; the bundled protocol
  labels several filters experimental/no-op. `getProducts()` returns a response
  containing `products`, not a bare array. Normalize responses deliberately.
- Fulfillment/refund handlers need no track catalog. Register them so the
  catalog-loading middleware cannot block an otherwise valid purchase/refund
  during a track-store outage.

SDK evidence: `node_modules/@devvit/payments/shared/paymentHandlerTypes.d.ts`,
`server/PaymentsClient.d.ts`, and
`node_modules/@devvit/protos/schema/devvit/plugin/payments/v1alpha/payments.proto`.
These discrepancies require validation, not invented request fields.

## Existing game integration and required changes

| Area | Current evidence | Vault requirement |
| --- | --- | --- |
| Availability/retention | `src/server/daily/daily-gp-model.ts:22-25,202-222`: seven-day free play; challenge/board retention deadline 50 years after start | Preserve dates and retention; add account authorization for supported expired races |
| Challenge loading | `src/server/daily/daily-gp-store.ts:1234`: playable resolver rejects expiry | Resolve published historical challenge, validate stored race contract, then check free access or entitlement |
| Submission | `src/server/daily/daily-gp-store.ts:2810`: expired challenge returns 409 | Reuse strict replay/owner/rate-limit/lock logic and original board/PB identity after authorization |
| Client state | `game/daily-challenge/`, `game/scoreboard/verification-queue.js` and helpers | Keep expired selections when authorized; update starts, restarts, resume, snapshots and retry deadlines together |
| H2H | `src/server/head-to-head/head-to-head-runtime.ts`: Daily result saving uses playable resolver | Owners' compatible expired-origin H2H results may update the original Daily; preserve existing free frozen H2H behavior |
| Podium | `src/server/podium/daily-podium-service.ts:395-404,469-481`: published post embeds snapshot and existing post is reused | Preserve published podium; establish durable closing snapshot before newly enabled historical writes |
| Ghost storage | `src/server/daily/daily-ghost-archive.ts:1293-1302`: completed archive days reopen on standings revision | Hydrate selected archived ghosts and make historical PB/ghost mutations visible to the archive, including PB-only repair |

Use one server access resolver throughout historical loading, own-PB and
opponent-ghost reads, direct submissions, sharing, and Daily-origin H2H saving.
Keep it separate from `isDailyGpChallengePlayable`, which still describes the
free window and drives scheduling/podium closure. Access is not replay validity:
match original challenge, rules revision, lap count and geometry fingerprint.
Do not silently substitute current geometry for a missing historical contract.

The archive browser must enumerate persisted published history, not generate
old challenges from today's schedule. Check hosted historical coverage and
definition availability before marketing a complete archive. Local constants
do not prove deployed data retention or historical completeness.

Existing contracts identify geometry by track key; do not assume they embed a
full historical geometry snapshot. Published stored copies are frozen, but
historical built-in versions still need an availability/compatibility check.

Vault purchases sell supported archive access and ranked persistence. Track
geometry is already available in placed-track APIs, Campaign and frozen H2H
posts; it is not secret content. There is no need to remove those existing free
routes just to implement the pass.

### Blob archive interaction

The current tree now implements Daily Blob archival; older feasibility docs
that describe it as absent are historical. However, the ordinary gameplay PB
reader in `src/server/competition/pb-ghost-store.ts:230` does not hydrate Blob
references and returns archived metadata without a ghost. Add authenticated,
bounded on-demand Blob hydration for the selected own/opponent ghost, validate
its identity/digest, and preserve PB metadata when the object cannot be read.
Reuse the existing private Blob access layer rather than bulk-restoring days.

Client expiry also extends beyond the playlist: the Daily start path redirects
expired selections, and verification queues use original closure plus six hours
(`game/daily-challenge/engine-methods.js:746`,
`game/scoreboard/engine-methods.js:533`). Historical runs need an authoritative
access state and suitable retry deadline without rewriting `availableUntil`.

`competition-submit.ts:328-340` writes standings and PB concurrently.
`competition-leaderboard.ts:266-284` increments the standings revision;
`pb-ghost-store.ts:398-410` writes PB state without that revision. A Vault PB
write can therefore complete after an archive scan associated with the board
revision, and a ghost-only repair may not change the board revision at all.

Before reopening historical submissions, atomically invalidate/reopen the
archive on historical PB mutation, reuse its source comparison/fencing, and test
submission against scan, replacement, sweep and refund interleavings. This is a
Vault integration requirement, not a reproduced data-loss finding in the
currently expiry-gated product. Do not add a synchronous Blob upload to every
finish; reuse archival after accepted PB persistence.

## Work breakdown and acceptance

1. Resolve product approval, supported library/price, purchaser identity and
   order-query/restore scope with a narrow sandbox integration.
2. Add receipt/entitlement storage and idempotent fulfillment/refund handlers;
   keep payment availability independent of track loading.
3. Add the shared historical authorization path, original-board submission,
   closing podium snapshots and archival mutation handling.
4. Add the paginated Vault browser, priced checkout, restored ownership and
   historical race/result/ghost behavior using existing game surfaces.
5. Verify duplicate/late callbacks, refund-before-fulfillment, failed persistence,
   logout/account switch, guest save selection, reload/device restore, spoofed
   access, original-board PB/rank updates, H2H, podium cutoff and Blob races.
   Run existing free Daily/Campaign/H2H suites and hosted desktop/iOS/Android
   sandbox flows before app/product review.

This investigation changes documentation only. No product/payment code, catalog,
deployment or real transaction was created. Baseline test results are recorded
below after validation; they do not test the proposed payment integration.

Local baseline: **91 tests passed across four suites**: `reddit-daily-gp-model`,
`server-head-to-head-runtime`, `server-daily-ghost-archive`, and
`server-pb-ghost-archive-ref`. No tests were modified. No hosted payment,
historical-coverage or device validation was performed.

The proposal passes its whitespace check. A broader working-tree
`git diff --check` reports a pre-existing blank line at EOF in
`tests/campaign-aggregate-ui.test.js:232`; that unrelated WIP was preserved.
