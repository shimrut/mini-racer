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

Automatic recovery has already stopped. The records are intact and unchanged. Nothing is
degrading while the case waits, so there is no reason to hurry a repair.

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

Compare `survivingSource` against `record.sourceInventory`, domain by domain.

- **Every domain still matches.** The case is resumable. Ask the player to retry; if it still
  fails, the reason has changed, so return to step 1.
- **A domain changed, and the account has not been replaced yet** (`completedDomains` does not
  name it). The guest's newer data is the better source. Prepare a repair that copies what is
  there now, under the recorded choice.
- **A domain changed, and the account was already replaced** (`completedDomains` names it). That
  copy is done. Do not repeat it.
- **The source is gone and no copy was checkpointed.** The selected progress cannot be rebuilt.
  Stop here and go to step 7.

For a Guest choice, `destinationEvidence` shows what the account holds now. Check it against the
copies the record claims. A domain checkpointed as copied whose destination evidence is empty is
a contradiction: stop, and report it rather than writing over it.

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
