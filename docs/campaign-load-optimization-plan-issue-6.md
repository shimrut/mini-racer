# Lighter Campaign load (A + B), issue #6

## Context
Every Campaign load (`getServerCampaignBootstrap`) runs on game open (background), every return to the lobby, after every saved result and on series switches. For Numbers it costs ~98 Redis commands and 1 transaction (Sol's measured fixture). At 100k DAU the per-community limits (40k commands/s, 20 concurrent transactions) are the risk. Goal: same player-visible results, fewer commands, no transaction.
- **A** skips the progress lock when nothing needs repair → 98 → 91 commands, 1 → 0 transactions.
- **B** runs the leaderboard-row check at most once a day per player and series → 91 → 57 on marker hits.
- **C** (shared stage counts) is **not** in this plan; decide after the timing log is live.

Design reviewed twice by Sol; all corrections are included below. Implement with Sonnet (user preference). Pull `codex/campaign-completed-poster` first (it has new commits; `campaign-store.ts` is unchanged).

## Step 0 — Timing log (own commit, deploy first for a baseline)
`src/server/routes/campaign-routes.ts`, `GET /api/campaign/bootstrap`: measure `Date.now()` around `getServerCampaignBootstrap` and, for ~5% of requests (`Math.random() < 0.05`), `console.log('Campaign load', { ms, seriesId: result.body.campaignId, status })`. Sampled to keep logs small at scale.

## Step 1 — A: skip the lock when nothing needs repair
File: `src/server/campaign/campaign-store.ts`, `repairCampaignProgressFromLeaderboard` (~line 666).
Only when `retryIfBusy` is false (callers: bootstrap ~819, `getCampaignProgressForSelection` ~589, `getCampaignResultsForSeries` ~726). The aggregate fill (~1035) and aggregate route (~1070) keep today's path.

Before the existing `try { mutateProgress(...) }`:
```ts
if (!retryIfBusy) {
    try {
        recoveredResults = await readRecoveredResults();      // 1. entries first
        const fresh = await readProgress(playerId, seriesId);  // 2. then fresh progress
        if (withRecovered(fresh) === fresh
            && !await campaignAggregateNeedsUpdate(playerId, seriesId, fresh.resultsByRaceId)) {
            return fresh;                                      // nothing to repair, no lock
        }
    } catch (error) {
        console.error('Campaign progress check failed; using the locked repair:', error);
    }
    recoveredResults = [];  // never reuse pre-check evidence in the locked path or its busy fallback
}
```
Everything after stays unchanged. Reuse: `readRecoveredResults`, `withRecovered` (same function), `readProgress` (~330), `campaignAggregateNeedsUpdate` (`campaign-aggregate-store.ts:24`, already imported).
Notes: entries-before-progress makes the returned progress at least as new as the evidence. Resetting `recoveredResults` fixes the stale-evidence case Sol reproduced (12,345 vs 11,000 ms) via line ~710 `if (!recoveredResults.length)`.

## Step 2 — B: leaderboard-row check once a day
File: `src/server/campaign/campaign-store.ts`.

1. `repairCampaignStandingsFromEntries` (~730) returns `Promise<boolean>` ("done"):
   - `false` on: transfer pending (start ~736, inside lock ~753), lock not acquired (~751), transaction null (~755), exec interrupted (~767), caught error (~770).
   - Consistent stages (`continue` at ~744 and the under-lock unwatch) are not skips.
   - At the end: re-check `isProgressTransferPending`; return `false` if pending or if the re-check throws (catch, no new error); else `true`.
   - Head to Head caller (`src/server/head-to-head/head-to-head-runtime.ts:290`) ignores the result — unchanged behaviour.
2. New helper used only by bootstrap (replace the call at ~823):
```ts
const ROWS_CHECKED_TTL_MS = 24 * 60 * 60 * 1000;
function rowsCheckedKey(playerId: string, seriesId: string) {
    return `campaign:${seriesId}:rows-checked:${playerFieldHash(playerId)}`;
}
function stageListStamp(seriesId: string) {
    return sha256Hex(getCampaignSeriesStages(seriesId)
        .map((s) => `${s.raceId}:${s.trackKey}:${s.lapCount}:${s.rulesRevision}`).join('|')).slice(0, 16);
}
async function repairCampaignStandingsOncePerDay(playerId: string, seriesId: string) {
    const key = rowsCheckedKey(playerId, seriesId);
    const stamp = stageListStamp(seriesId);
    try { if (await redis.get(key) === stamp) return; }
    catch (error) { console.error('Campaign row-check marker read failed:', error); }
    if (!await repairCampaignStandingsFromEntries(playerId, seriesId)) return;
    try { await redis.set(key, stamp, { expiration: new Date(Date.now() + ROWS_CHECKED_TTL_MS) }); }
    catch (error) { console.error('Campaign row-check marker write failed:', error); }
}
```
Reuse: `playerFieldHash` (`src/server/redis/redis-names.ts:8`), `sha256Hex` (`src/server/shared/value-guards.ts`).
Behaviour: marker read failure → normal check; marker write failure → load still succeeds; a changed stage list → stamp mismatch → check runs. Accepted trade-off: a row broken after a successful check waits until the next eligible load (≤ 24 h).

## Tests (`tests/server-campaign-store.test.js`, existing mockRedis harness)
A:
- Healthy fixture: bootstrap takes no `:progress-lock:` SET and calls no `watch`; returns stored progress.
- Faster leaderboard entry → lock taken, progress repaired (extend "repairs missing progress … on bootstrap").
- Overall score needs fixing → locked path.
- Pre-check throws → same result as today's path.
- Pre-check finds work, lock busy, newer entry lands → fallback returns the newer time (Sol's 12,345 / 11,000 case).
- `retryIfBusy: true` callers still take the lock (aggregate tests unchanged).
B:
- First load checks and writes the marker; second load skips stage reads.
- No marker when: stage lock busy, exec interrupted, error, transfer pending (start / inside / final re-check), final re-check throws (bootstrap still 200).
- Marker GET throws → check runs; marker SET throws → bootstrap 200.
- Stage-list change → check runs again.
- Head to Head path still checks every time (`tests/server-head-to-head-runtime.test.js`).
Guard: a healthy Numbers bootstrap call-count test (record measured counts: ≤ 91 after A, ≤ 57 after A+B with marker, `watch` not called).

## Docs
`docs/system-change-map.md`, Campaign section: one bullet for A (lock only when repair is needed) and B (row check once a day per player/series, marker key, stamp, failure rules, ≤ 24 h trade-off). Link commits to issue #6; close it after B ships.

## Verification
1. `npm run typecheck`.
2. Focused: `npx vitest run tests/server-campaign-store.test.js tests/server-campaign-aggregate.test.js tests/server-guest-progress-selection.test.js tests/server-head-to-head-runtime.test.js tests/server-campaign-routes.test.js tests/server-campaign-series.test.js`.
3. Full `npm test`: only the known failures (12 machine-specific race-time/replay goldens; slow "loads 100 stored tracks" test on slow machines). Compare the failure list before/after each commit.
4. After each deploy (Step 0 → 1 → 2): compare sampled "Campaign load" ms; watch logs for "Campaign progress", "standings repair", marker errors, and transaction/busy errors at peak.

## Out of scope
C (shared counts), client-side reload reduction (background load on game open, full reload on lobby return, double reload after a best, series memory), race-start lock, guest cleanup (#8).