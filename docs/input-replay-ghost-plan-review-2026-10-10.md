# Input replay ghosts — plan review, 2026-10-10

Reviewed the "Input replay ghosts" plan against `feat/campaign-ghost-blob-move`
at `ea174a0`. Plan review only. No app code changed.

## Verdict

The approach is right. It can be built once the fixes below are added.

## Confirmed in code

- **Keep record version 2.** A normal read leaves a row alone. But an old server
  that saves a personal best deletes any row whose version does not match, time
  included (`pb-ghost-store.ts:240`; `cleanupUnusable` is set only by the save
  path). Guest transfer would also mark the row obsolete.
- **A faster time replaces the whole row.** `encodeStoredPbRecord` writes the
  full new row, so the old `ghost` or `ghostPacked` field drops off.
- **The packing job already skips rows without a position list**
  (`ghost-compaction.ts:187`).
- **Guest sign-in transfer copies the row text as is** (`daily-gp-store.ts:1458`,
  `campaign-store.ts:1580`), so the button list survives.
- **Rollout and rollback are safe.** Old servers see a button row as "no ghost".
  The time stays.
- **Replays are exact.** Replaying the same buttons gives the same ghost every
  time, checked on 15 live Campaign tracks.

## Measured (autopilot runs, live Campaign tracks)

| | Redis size per ghost |
|---|---|
| Button list (compressed) | 375–967 chars |
| Packed position list | 724–2,744 chars |
| Plain position list | 1,463–5,567 chars |

Rebuilding a ghost takes 7–57 ms here. Three-lap races are the slowest.

## Must fix

1. **Head-to-head needs no change.** It builds its ghost from the run the player
   just submitted, not from a saved row (`head-to-head-runtime.ts:57`). Take it
   off the rebuild list. This holds as long as the check keeps building that
   ghost in memory.
2. **Rebuild inside the existing hook.** `resolveMovedPbGhost` runs for the Daily
   and Campaign PB replies and for the submit reply, including when the new time
   does not win. Make it rebuild button rows too. The podium freeze
   (`daily-gp-store.ts:1213`) skips this hook and needs its own call. Opponent
   races need fix 4.
3. **Submit reply when the time is not beaten.** The kept row can be a button
   row. The game installs this reply directly without asking again, so it needs
   a rebuilt ghost. Otherwise the ghost disappears until reload. Fix 2 covers this.
4. **Opponent races never reach the rebuild.** Both opponent paths first ask
   whether the row already holds a position list. They call the hook only for a
   moved row (`competition-opponent-race.ts:162,241`). A button row fails that
   question, so the race is refused. Until something is moved to blob storage,
   that is every opponent race against a new best. The standings still show the
   race icon, because it comes from the ghost built at submit time
   (`withOpponentRaceReady`). Fix:
   - `isOpponentCandidateRecord` (`competition-leaderboard.ts:143`) counts button
     rows without replaying, because standings use it.
   - Both paths send button rows through the rebuild.
   - "Next faster rival" can check up to 60 rivals. Cap rebuilds the way moved
     ghosts are capped (`NEXT_RIVAL_MOVED_READS`, 2). Without a cap, a physics
     change could cost about 1–3 s in one request.
5. **"Has a ghost" flags.** Both must count a button row:
   - Submit `trackGhostAvailable` (`competition-submit.ts:398`). When the reply
     is not the full saved row and this is false, the game skips the ghost
     refresh (`scoreboard/engine-methods.js:377`). Fix 2 covers it.
   - Daily PB summary `ghostAvailable` (`player-account-store.ts:318`). It does
     not stop the request: the game still asks for the ghost when it prepares a
     race. Keep it accurate anyway.
6. **Keep the field when reading.** `parseRecord` drops unknown fields
   (`pb-ghost-store.ts:77`). It must keep `inputReplay`, or every reader sees "no
   ghost". Remove it in `toGamePbRecord` before sending to the game.
7. **Save the cleaned segments, not the raw request.** The check ignores extra
   fields on each segment, so saving the raw request could store junk. Have the
   check return the cleaned segments. This also covers the head-to-head to submit
   path, which skips the second check (`competition-submit.ts:191`). Also save the
   rules revision and target lap, or rebuild them from the row.
8. **A failed rebuild means "no ghost", not "try again".** A rebuild failure is
   permanent. The try-again flag makes the game ask again on every attempt
   (`pb-ghost-service.js:67`), and each ask costs a replay. Keep try-again for
   failed blob reads only.
9. **Daily restore check.** `daily-ghost-archive.ts:641` has its own "must hold a
   position list" check, separate from `verifyArchivedCopy`. Without a change, a
   moved Daily button row can never be restored.
10. **Moved-row test.** `isMovedPbRecord` (`pb-ghost-archive-ref.ts:22`) must also
    require no button list.
11. **Reading a moved ghost.** `readMovedPbGhost` (`archived-ghost.ts:57`) uses the
    copy's position list. When the copy holds buttons, rebuild there.
12. **Physics changes.** Position ghosts survive a physics tweak. Button ghosts
    do not. Changing car feel or a ground's numbers without a revision bump makes
    every saved button ghost on the affected tracks unavailable. Times stay. The
    golden test pins tarmac only (`tests/tarmac-golden-times.test.js`). Add pinned
    runs for dirt, snow, grip, water and space so CI catches this.

## Minor

- **Tie rule.** Define "usable ghost" as a position list or a button list. Moved
  rows keep today's behavior and lose ties.
- **"Measured campaign laps still qualify" is unclear.** Reword it or drop it.
- **Smaller blob savings.** Rows are already small, so the blob move saves less
  per row. That is expected and not a blocker.
- **Tests to add:**
  - The same buttons give the same ghost.
  - A faster button row replaces an old ghost.
  - The tie rule.
  - Mixed rows in the first move.
  - Daily and Campaign restore of a button row.
  - An opponent race against a new button-list best.
  - A failed rebuild gives "no ghost".
  - The rival rebuild cap.
