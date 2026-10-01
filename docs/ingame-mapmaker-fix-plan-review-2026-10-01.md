# In-game Mapmaker fix plan review

Date: 2026-10-01. Branch: `ingame-mapmaker`, reviewed at `784fb905`.
Source: the user-pasted four-stage fix plan. This is a plan review; no
application code, existing tests, or the original review report were changed.

The four-stage structure and the requested conflict choices are reasonable.
The plan needs the corrections below before implementation. In particular,
Stage 2 as written still permits the original wrong-layout response.

## 1. Validate snapshots, not only their revision ordering

The proposed `current.revision > revision` guard prevents one older revision
from replacing a newer one, but does not ensure that records belong to the
revision read at the start. Track loading reads revision, index and records
separately (`src/server/tracks/track-store.ts:197-215`); series loading does
the same (`src/server/campaign/series-store.ts:135-158`).

A temporary reproduction ran the actual track loader with the proposed guard
injected by a Vite transform, without editing repository source:

1. Refresh A reads revision 1 and captures the old track; its `mGet` waits.
2. Refresh B also reads revision 1, then waits before reading the index.
3. The real save and Campaign publication functions write edited revision 2
   and locked revision 3. These writers do not refresh this process's cache.
4. B resumes and loads the newly locked track, but labels its cache revision 1.
5. A resumes. The guard compares `1 > 1`, returns false, and replaces the
   locked track with the old unplaced record.

The outcome was `TRACKS.smallSteps` returning the old Small Steps definition
and `describePlacedStoredTracks(['smallSteps'])` returning `[]`. Redis retained
the correct locked edited track. The proposed guard therefore does not close
finding 2.

Keep the monotonic guard, but validate the revision after reading the records.
If it changed, retry with a bounded budget and return a retryable failure if
no consistent snapshot can be read. Coordinate concurrent refreshes per
install if useful; deduplicating them alone does not validate the snapshot.

Also validate coherence between track and series loading. The middleware
loads tracks first and series second (`src/server/server-app.ts:328-329`).
Code inspection shows that a Campaign publication can commit between those
loads: the response can see a newly published series while its track cache
still describes its tracks as unplaced. Reading each store consistently in
isolation does not prevent this. Recheck the combined revisions or read the
response's authoritative placed tracks from a consistent snapshot. This
cross-store case is code-derived, rather than a hosted reproduction.

Add tests for equal initial revisions, a write during a single refresh, and
publication between track and series loads. The proposed unequal-revision
test alone is insufficient. Do not assert that sticky client confirmation is
safe until these response paths are covered.

## 2. Keep locked dirty drafts recoverable

The plan says a refresh keeps old metadata for dirty tracks, allowing the
next Save to open conflict recovery. That has an exception:
`loadCreatorTracks()` retains newly fetched locked metadata at
`tools/mapmaker.js:3490`, while restoring the local dirty content. Save then
returns before sending any request at line 3556, and the editor is disabled
by `syncCreatorTrackState()` at lines 3372-3375. A dialog that opens only after
a 409 is unreachable in this state.

Provide a recovery action for a dirty track that becomes locked, including
after refresh. Keep both and Load theirs must remain available; changing the
locked original must remain forbidden. Check locking before automatically
retrying a recovered lost acknowledgement too: matching an earlier submission
does not make newer edits to a now-locked original writable.

Test: edit locally, place/publish the server version, refresh, then preserve
the local draft as a copy. Also test locking between the conflict read and
the attempted retry.

## 3. Preserve raw field edits and their ownership

Stage 3's numeric, focused-field comparison covers the reproduced Gold
overwrite but is not a complete typed-text contract. `Number('')` is zero;
different raw text can have the same numeric value. Moving Campaign's
`Number(input.value)` conversion to `input` still turns a deliberately blank
medals-needed field into 0, which the next rebuild paints over the blank.
Invalid author-time blur currently returns without storing the edit
(`tools/mapmaker.js:1349-1355`).

Record pending text/invalid state on input, per track and tier or series and
stage, and count it as unsaved immediately. Track refresh currently retains
only dirty keys (`tools/mapmaker.js:3477`), while navigation guards inspect
model dirty state (`tools/mapmaker/creator-track-save.js:17-21`). A check only
when a save acknowledgement arrives does not cover those paths. Keep the
author-time autofill on commit, so typing a digit does not rewrite the other
medals.

Restore focus only within the same logical draft. Use stage track identity,
rather than `stage-medals-<index>`, after reorder/removal. Do not restore one
series's caret into another series. Number inputs reject selection APIs;
catching the exception avoids an error but does not promise caret restoration.
Prefer updating the active numeric field in place for nonstructural updates.

Explicit Load theirs/discard actions must clear pending local field text and
force the server values into the form. Otherwise the same-track focused-field
preservation rule can retain old Gold text after deliberately loading theirs.
Apply the pending-text guard to Stage 4 clean-adoption branches too.
`normalizeMedalRow()` returns null for both invalid rows and missing rows;
the comparator must not treat an unfinished local medal row as absent data.

Add tests for clearing/partial numeric fields, typing on a clean track during
refresh, switching tracks, stage reorder, and Load theirs when dialog close
restores field focus. Keep the proposed native first-click check.

## 4. Retain the previous uncertain submission separately

Specify the lifetime of `lastSentTrackByKey` and equivalent Daily/series
state. With submission A committed but its response lost, local edits B and
a retry sending B, storing B as the latest sent snapshot before checking the
409 loses the evidence that the server's A is the earlier uncertain write.
The Daily/series wording currently describes only the current sent snapshot.

Retain the previous uncertain submission separately from the current request,
and clear/update it only on conclusive acknowledgement or explicit discard.
Test the full A-commit/lost-response, edit-B, retry-B sequence for all three
save types. Equal current content needs no additional write; newer content
can retry once with the authoritative revision, subject to lock/validation
rules and a fresh acknowledgement comparison.

Recovery must retain the originally captured key, series id and draft identity
through the conflict read and dialog. Existing series acknowledgements check
`this.seriesDraft === draft` (`creator-panels.js:600`). Preserve that contract:
selection-bound `saveSeries()` and `renameTrackKey()` otherwise operate on the
currently selected draft (`creator-panels.js:576`, `mapmaker.js:1423`). Delayed
recovery must not mark another draft saved or replace it. Test switching while
the conflict read is pending, further edits during retry, a second conflict,
and a failed Keep both save retaining the copied draft.

Deleted app-key copies need an explicit exception. Normal Creator saves cannot
recreate a missing built-in track key (`track-store.ts:357-358`) or app series
id (`series-store.ts:286-287`). The planned base-0 resurrection would return
400 for those migrated copies. Offer creation under a new allowed key or a
copy action instead of promising recreation under the original app key.

## 5. Make the Stage 1 availability tradeoff explicit

Returning 503 instead of acknowledging an unavailable layout is correct.
Moving telemetry before the gate is also appropriate. A load error, however,
does not establish that every other Redis operation is failing. The proposed
gate would additionally block unrelated handlers such as best-effort podium
analytics (`src/server/routes/analytics-routes.ts:43-54`) and diagnostics when
either catalog cannot load.

Prefer gating the route groups that depend on authoritative tracks/series,
with explicit dependencies and tests. If the global gate is deliberately
retained, document the wider outage behavior and test important unaffected
routes rather than justify it by assuming Redis is globally unavailable.
Keep retries bounded, avoid multiplying retries across layers, and test warm
cache failure, retry exhaustion, separate loader failures and telemetry bypass.

## 6. Tighten the verification criteria

- Compare exact failing test names, counts and assertions with the baseline.
  A new failure inside one of the three already-failing files is still a
  regression; filename-set comparison would miss it.
- Standalone client esbuild bundles do not validate the new dialog's HTML/CSS,
  Vite integration or changed server runtime bundling. Include the server
  entry and production-equivalent HTML/CSS integration validation. Respect
  the plan's build restrictions without claiming esbuild proves all of those
  checks.
- Keep real-installation native typing, first-click and conflict checks as
  completion gates. Jsdom event dispatch cannot prove native blur/pointer
  ordering. Add locked-after-refresh, Cancel/draft retention, Load theirs,
  copied-draft persistence after reload, and lost-acknowledgement checks to
  the current three manual scenarios. If deterministic browser API mocks are
  intentionally excluded, these remain explicitly pending until playtest.

## Evidence and limits

The temporary proposed-guard reproduction passed by asserting the remaining
bad outcome. It uses actual loader/save/publication code, mocked Redis, and a
test-only source transform. It is proof of a remaining interleaving, not
production Redis timing evidence. Its files are
`/private/tmp/dailygp-proposed-cache-guard-review.test.js` and
`/private/tmp/dailygp-proposed-cache-guard-vitest.config.mjs`.

Other corrections above come from current code-path inspection and the prior
native editor review. No fixes, commits, builds, deployment or production
Redis/Reddit operations were performed for this plan review. The original
review document and unrelated dirty ground/share-picture files were preserved.
