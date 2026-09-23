# Remaining cleanup work (2026-09-23)

This file lists the cleanup work that is not done yet. It starts from branch
`chore/duplicate-cleanup` at the end of 2026-09-23. The full plan is in
`docs/duplicated-code-cleanup-plan-2026-09-23.md`. The audits are in
`docs/duplicated-code-audit-2026-09-23.md` and `docs/dead-code-audit-2026-09-23.md`.

Work in the order of this file. Each section starts with the lowest risk.

## Done so far

- Dead code: all findings from the 2026-09-22 and 2026-09-23 audits are removed, with
  these exceptions: the guest-merge branches (see below), and the items the audits keep
  on purpose.
- Duplicated code: phases 1 to 3 (low-risk steps), phase 5 except 5.6, phase 6, and steps
  3.4 and 4.3.
- Unused parameters: all 16 are removed. The hidden best-time medal badge is removed.
- Packages: `@devvit/public-api` and `fflate` are out of `package.json`.
- CSS: styles that never apply, split style blocks, copied animations, and matching style
  pairs are removed or joined. The medal colours and the menu selection ring are named
  settings. The Garage and Tracks tab marker obeys "reduce motion".
- Net effect: about 3,326 lines of code are removed. The count is about 5,430 lines if you
  include the removed code comments.

## 1. Before other work

| Item | What to do |
|---|---|
| Merge the branches | `chore/duplicate-cleanup` is 62 commits after `chore/dead-code-removal`, and 536 commits after local `main`. Neither branch is in `main`. Neither branch is pushed. |
| Puppet Master | Drive the track once. Confirm the medal times: author 9.60, gold 9.81, silver 9.95, bronze 10.17. |
| Untracked file | `LP/mini_racer_analytics.png` is not part of the cleanup. Decide if it goes in a commit. |

## 2. Decision needed: CSS ownership

The plan dropped step 5.6 (one shared tab marker style). The reason: `docs/css-architecture.md`
gives each stylesheet one product area, and `tests/styles-architecture.test.js` checked each
marker rule in its own file. The CSS merge commit of 2026-09-23 did not follow this. It moved
these rules into `styles/lobby-and-garage.css`:

- the Daily/Campaign switch marker (owner: `styles/lobby-modes.css`)
- the Settings switch marker and its reduce-motion rule (owner:
  `styles/settings-and-track-shells.css`)
- the Tracks tab panel and the selected Tracks tab (owner: `styles/settings-and-track-shells.css`)

The same commit changed the architecture test to accept the shared rule. The earlier CSS commit
also moved rules across files: the `.hud-lap-cluster` pointer rule, the finish-sheet PB delta
size, and the `challengeOutcomePushIn` animation, which now uses `slideInRight` from
`styles/lobby-and-garage.css`.

Choose one:

- **Restore ownership (recommended).** Put each moved rule back in its owner file with the same
  values, and restore the per-file test checks. Keep the fixes and the named settings: the
  reduce-motion fix, `--menu-ring`, the medal colours, and the merges inside one file.
- **Keep the merge.** Update `docs/css-architecture.md` to allow shared rules across product
  areas, and say which file owns them.

## 3. Duplicated code (medium effort)

Do these one at a time. Do a playtest after each one.

| Order | Item | Risk | Where | Notes |
|---|---|---|---|---|
| 1 | Post-record reading (plan step 3.5) | Low to medium | `daily-gp-post-store.ts`, `daily-podium-post-store.ts`, `launcher-post-store.ts` | Share `normalizeSubredditName`, the key builder, and the record parse frame. The three stores need different fields, so each store keeps its own field rules. Keep all Redis keys. If this goes wrong, the game can miss a post or make a second post. |
| 2 | Daily guest clean-up (plan step 3.6) | Medium | `cleanupGuestDailyProgress` and `discardGuestDailyProgress` in `daily-gp-store.ts` | The two functions are the same 50 lines. Only the messages differ. Keep both messages. This is the guest transfer area: a mistake can delete guest progress. Run all guest transfer tests. Play-check a guest transfer. |
| 3 | Ghost check (plan step 4.2) | Medium to high | `game/ghost/pb-ghost.js` and `src/server/pb-ghost-trace.ts` | The client counts the size of a ghost in characters. The server counts it in UTF-8 bytes. Keep the server's byte rule. Add a test with non-ASCII text at the size limit first. Real ghosts contain only ASCII, so players do not see the difference today. If this goes wrong, ghosts stop loading or the server refuses to save them. Play-check: race a Daily track that has a personal-best ghost. |
| 4 | Replay data in posts (plan step 3.7) | Highest | `daily-podium-replay.ts` and `head-to-head-post.ts` | Podium and Head to Head posts on Reddit already hold this data. One wrong byte makes all old replays unreadable, and nobody can repair old posts. First add a test that decodes a saved old replay token for each format, and checks its hash. Then add round-trip tests. Only then merge the code. Keep each format's marker, check, and size limit. Play-check: open a podium replay and a Head to Head post. |

## 4. Guest transfer (needs its own change)

| Item | Risk | Notes |
|---|---|---|
| Unused "keep the best of both" merge logic | Medium to high | Every real caller of `mergeGuestCampaignProgress`, `mergeGuestDailyProgress`, and `mergeGuestCarUnlockProgress` passes `replace: true`. The Garage call also passes `preserveSource: true`. Thus the `replace: false` logic and the Garage source delete never run. The logic runs through about 30 decision points in `campaign-store.ts`, `daily-gp-store.ts`, and `car-unlock-store.ts`. 16 tests exercise it. Removing it changes the code that moves guest progress to a Reddit account. Do it as its own change, with recovery tests and a guest transfer play-check. |

## 5. Behaviour decisions (plan phase 7)

Each item changes what players see, hear, or get. Each needs your decision first.

| Item | Recommendation |
|---|---|
| Race rules | Daily still overrides five shared run methods: `applyDailyChallenge`, `applyVerifiedTrackPersonalBest`, `clearDailyChallengeRun`, `markTrackPersonalBestGhostPending`, and `prepareTrackPersonalBestGhost`. Decide each rule on its own. Keep the Daily last-played-day lobby choice for Daily only. Test the faster-best and ghost-rollback protections in Campaign and Head to Head before you use them there. `tests/daily-runtime-methods.test.js` pins this list. |
| Lost-post lookup | Make the Daily lookup check the post type. Accept Daily posts with no type, because Daily posts made before 2026-09-08 have no type. Reject a known different type, such as podium. Add a test where a podium post and a Daily post have the same challenge id. |
| Double transfer check | Keep the early check, because it gives the player a quick reply. Keep the later check inside the lock, because it stops a race. Make their rules the same only after tests for a stale identity and for a transfer that starts between the two checks. |
| Sound | Add the idle pause to the medal sounds as a small change of its own. Do not share one audio context yet: one owner must control the pause, or the car or music timer can stop the medal sounds. Test on iOS and Android. |
| Request timeouts | Campaign and Head to Head already share one request helper. For the other callers, support both a cancel signal and a deadline. Keep each caller's timeout value and response handling. |
| Time formats | Keep each screen's and post's current text. Changing the text is a separate player-facing change. |
| Page palettes | Keep them separate. Each page loads alone, so a shared file gives little gain. |

## 6. Visual issues

| Item | Notes |
|---|---|
| Track preview wedge | The full track preview shows a small dark wedge where a wall outline starts and ends. It also shows on older tracks, such as Albert Gardens. The schematic preview does not show it. The combined-path fill is a lead, but it is not a proven cause. |
| Daily/Campaign switch and "reduce motion" | The lobby's Daily/Campaign switch marker still slides for players who turn on "reduce motion". It never had its own reduce-motion rule. The Garage, Tracks, and Settings markers obey the rule. |

## 7. Leave as they are

- Four CSS style pairs match only by chance: `.lobby-subhead__text` and
  `.challenge-racer__figures`, the requirement medal host and the hero medal, the stepper
  and action button press styles, and the lap-times container and list. They belong to
  unrelated parts of the screen.
- The Tracks-screen preview canvas rules. Joining them would let a third rule take over.
- The analyzer gaps in `tools/analyze-unused-css.js`, and the older findings the audits keep
  on purpose (`RingBuffer.toArray`, `bestResultComparator`, `ghostActive`).
- Plan step 3.9 (route frame) is dropped.
