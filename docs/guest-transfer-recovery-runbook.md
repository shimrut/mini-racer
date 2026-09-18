# Guest transfer recovery — case repair runbook

For one account at a time, by hand. There is no repair UI, and there is no endpoint that changes
a transfer. Every step below is a decision a person makes with the evidence in front of them.

This procedure cannot recover a record that no longer exists. If the chosen progress cannot be
rebuilt from surviving verified evidence, leave the case protected and report what is missing.

## When a case reaches you

The player reports one of these:

- The game says **"Transfer Needs Repair"**.
- Racing stays paused, and Retry Transfer keeps failing.
- A signed-in bootstrap keeps returning `recovery_required`.

Automatic recovery has already stopped. The transfer record is protected: no automatic step
rewrites it while the case waits.

A record marked `recovery_required` does not resume on its own, and it never will. Every ordinary
retry is refused with the same answer, including one from a player whose data has since come back.
That refusal is the design: it is what stops a case looping in the background instead of waiting
for you. Only a repair takes the mark off, in step 6.

Guest Daily rows are the exception. They expire on the ordinary Daily deadline, and an open
transfer does not extend it. `expiredDailyChallengeIds` names the frozen days whose guest rows
have already gone, and that list can grow while the case waits. Capture the evidence in step 1
promptly. Campaign and Garage evidence does not expire.

## 1. Capture the evidence before you change anything

Open the moderator analytics tool for the subreddit and read the diagnostic:

```
GET /api/analytics/guest-transfer?username=<reddit-username>
```

Add `&transferId=<id>` when the player's browser reported one.

The response is read-only. It reports:

| Field | What it tells you |
|---|---|
| `reason` | Why automatic recovery stopped. Start here. |
| `record` | The raw transfer record, including `phase`, `choice`, and the checkpoints. |
| `completedDomains` / `cleanedDomains` | Which copies and which cleanups are proven done. |
| `survivingSource` | What is left of the guest's Campaign, Daily, and Garage evidence now. |
| `changedDomains` | Which domains no longer match the recorded inventory. |
| `destinationEvidence` | The same shape, for the account. |
| `pendingGuestMarker`, `guestPendingMarker` | The two markers, and which are set. |
| `promotedTo` | The Garage promotion pointer, and which account it names. |
| `expiredDailyChallengeIds` | Frozen Daily days whose guest rows are already gone. |
| `evidenceFingerprint` | One value covering all of the above. |

**Save the whole response, with its `evidenceFingerprint`, before you do anything else.** The
fingerprint is how you prove later that nothing moved under you.

The response carries guest ids and stored evidence. It goes to the moderator who asked, and
nowhere else. Do not paste it into a public thread, a ticket that others can read, or a log.

## 2. Read what the record already decided

Two things are fixed and are not yours to change:

- **The choice.** `record.choice` is what the player picked. It is immutable. If the player now
  wants the other one, that is a new decision made after this case is closed, not a repair.
- **The proven operations.** `completedDomains` and `cleanedDomains` are checkpoints that
  committed. Treat them as done. Repeating a proven copy is not safe once the source is gone.

Common reasons, and what each means:

| `reason` | Meaning |
|---|---|
| `source_changed:<domains>` | The guest's data moved after preparation recorded it. The copy stopped rather than replace the account from evidence it could not verify. |
| `legacy_guest_choice_without_inventory` | An older record chose Guest but carries no source inventory. There is nothing to check a replacement against. |
| `record_unreadable` / `record_missing` | The record cannot be parsed, or the marker has no record behind it. |
| `completed` | The transfer finished. This is a stale marker, not a repair. See step 6. |

## 3. Decide whether the selected progress can be rebuilt

Read both sides before you decide anything. Compare `survivingSource` against
`record.sourceInventory`, domain by domain, and read `destinationEvidence` for those same domains.
One side alone cannot tell you what happened. This applies to both choices.

**A checkpoint proves a copy committed. A missing checkpoint proves nothing.** The transfer writes
the destination first and its checkpoint second. A transfer that stopped between those two writes
left a copy that is done and unrecorded. `completedDomains` is a floor, not a full account of the
work, so it can never establish on its own that the account is unchanged. Only
`destinationEvidence` reports what the account holds now.

Work through the domains `record.sourceInventory` names:

- **The source still matches the inventory, and `record.status` is `pending`.** Nothing marked
  this case, so it can still resume on its own. Ask the player to retry; if it still fails, the
  reason has changed, so return to step 1.
- **The source still matches the inventory, and `record.status` is `recovery_required`.** Whatever
  stopped this transfer has since resolved, but the mark stays until you take it off. A retry
  cannot do it. Decide what remains, then hand the case back in step 6.
- **Checkpointed, and the destination holds the copy.** That copy is done. Do not repeat it.
- **Checkpointed, and the destination is empty.** This is a contradiction. Stop, and report it.
  Do not write over it.
- **Not checkpointed, and the destination holds the copy.** The copy committed and its checkpoint
  did not. The copy is done. Record the checkpoint, and repeat no part of the copy.
- **Not checkpointed, the destination is empty, and the source still matches the inventory.** This
  copy is the work that remains. This is the only case this procedure repairs.
- **Not checkpointed, the destination is empty, and the source changed or is gone.** The snapshot
  the player chose against no longer exists. The selected progress cannot be rebuilt. Go to
  step 7.

Copy only what `record.sourceInventory` named, and only from the snapshot it describes. Guest data
written after preparation froze that inventory is not part of this transfer. Copying it moves data
the player never chose into a ranked account, and it makes the result depend on when the repair
ran.

## 4. Prepare one explicit repair

Write down, before you run anything:

- The exact guest id and the exact account id. One pair, and no other.
- The exact keys you will write.
- The exact value each will hold.
- What you expect the diagnostic to say afterward.

The repair must touch only that guest and that account. There is no bulk step, no "clear all
pending" action, and no automatic conversion of a record whose meaning is uncertain. If a fix
seems to need one of those, it is not this procedure.

## 5. Re-check, then execute

Immediately before executing:

1. Re-read the diagnostic.
2. Compare its `evidenceFingerprint` to the one you saved in step 1.
3. **If it differs, stop.** Something changed while you were deciding. Start again at step 1 with
   the new evidence.

Then take the coordinator lock for the pair and the domain locks for each domain you touch, the
same locks the transfer itself uses. Without them a concurrent submission can interleave with the
repair. Execute the writes you wrote down in step 4, and nothing else.

## 6. Establish the state, then clear the markers

A marked record is the first thing to settle, because nothing resumes while the mark is on it.
`status` and `phase` both read `recovery_required`. There are two ways out, and the evidence from
step 3 says which one this case takes:

- **You finish the transfer.** Follow the order below. `completed` replaces the mark.
- **You hand the case back to the player.** Put `status` back to `pending` and `phase` back to the
  phase the transfer had reached, keeping the choice, the checkpoints, the source inventory and
  both markers. Do this only once you have established that the work left over is safe to repeat.
  The player's next retry then resumes the transfer normally.

Never take the mark off to see what happens. It is on the record because a copy could not be
proven safe, and taking it off is you saying it now is.

Order matters, and it is the same order the transfer uses:

1. Put the selected progress in place.
2. Checkpoint it in the record.
3. Mark the record `completed`, and write its receipt and index entry.
4. **Only then** clear `guest-progress-selection-pending` for the guest and
   `guest-progress-selection-account-pending` for the account.

Clearing a marker before the state behind it exists is what turns a protected case into a silent
loss. A marker is not the problem; it is the flag saying the problem is unsolved.

For a `completed` case with stale markers, there is nothing to rebuild: the player's next signed-in
request clears those markers on its own. Confirm the receipt exists, then ask the player to reload
before you touch anything.

### The two Garage keys

Two keys exist only while a transfer is open, and the diagnostic reports both:

- `miniracer:car-unlocks:transfer-baseline:v1:<account>` — `garageBaseline`. The account's Garage as
  preparation froze it. A Guest choice deletes what this names and keeps everything else.
- `miniracer:car-unlocks:transfer-journal:v1:<account>` — `garageJournalFields`. Rewards accepted
  while the transfer was open, including ones whose ordinary write was a no-op. A Guest choice keeps
  every field this names.

Both are collected when the transfer finishes. That cleanup is deliberately best-effort, because a
failed delete must never turn a committed transfer into a failed one, so either key can outlive its
transfer. A leftover key is untidy rather than dangerous: the baseline records the transfer it
belongs to, and a later transfer for the same account replaces it and clears the journal with it.

If you see either key on an account with **no** open transfer, delete it. Check `garageBaseline`'s
`transferId` against the case in front of you first: if it names this transfer, it is in use, and
deleting it makes a Guest choice keep the whole account Garage instead of replacing it.

## 7. Record the outcome

Write a recovery audit record for the case, whatever the outcome:

- The account, the transfer id, and the date.
- The `evidenceFingerprint` from step 1, and the one you re-checked in step 5.
- The recorded choice, and the operations already proven done.
- Exactly what you wrote, or that you wrote nothing.
- What the diagnostic reported afterward.

If the selected progress could not be rebuilt, say so plainly to the player: name which part is
gone, and confirm what survived. Do not close the case by clearing the markers over missing data.
A protected case the player knows about is a better outcome than a clean-looking account that
quietly lost what it was promised.
