# Campaign series plan — 2026-09-25

**Status, 2026-09-25:** built on branch `feat/campaign-series`, not committed. Phases A to D
are done. Dirt waits for its tracks. Players see one change: Campaign opens a series screen
(Numbers, and Mini Rally, Sliders and Formula Mini as Coming soon) before the stages. Numbers is the only live series,
so the series list does not open yet.

This plan replaces the first version of this file, which had a lock between series. You chose
the design below instead.

## Design

- The Campaign is a set of series. Numbers is the first. Dirt is the next.
- There is no lock between series. The first stage of every series is open to every player.
- In each series, a stage opens after any medal on the stage before it and a medal target.
  The target counts the medals of that series only. This is the Numbers rule of today.
- Medals from every series count toward the Gold and Author car skins.
- Numbers keeps its name `numbered-v1`, its stage IDs, laps and medal targets. No saved record
  moves.

## Mapmaker rules (your answers)

- A track is used for Daily or for one series, never both.
- A series is hidden until it has 1 stage. Formula Mini is hidden until it has 2. After that, new tracks go after the last stage,
  and the stages that exist are fixed.
- Author time: the Mapmaker shows the 10 best Drive Draft laps and their average. You pick one,
  or you type a time.
- Gold, silver and bronze are suggested from the author time. You can change them.
- Drive Draft uses the game camera, the game car and the game HUD.

## What is built

### Phase A: series data

- `game/campaign/series.json` holds the series and their stages. Numbers is copied from the old
  stage list. Dirt (`dirt-v1`) has no stages.
- `game/campaign/manifest.js` builds the stages from it. A stage has a `seriesId`. Only series
  that have reached their stage count are live (`CAMPAIGN_SERIES`). `CAMPAIGN_ID` and `CAMPAIGN_STAGES` still
  name Numbers.
- `game/campaign/series-rules.js` holds the stage-count rule and the medal-target rule. It has no
  imports, so the Mapmaker server can use it.

### Phase B: Mapmaker

- **Use For** lists Daily Challenge and each series. A series save removes the track from the
  Daily schedule and adds a stage to `series.json`.
- The stage panel shows the stage number, **Laps** and **Medal Target**. A series that is not
  live has **Up** and **Down** buttons. A live series is fixed.
- The **Medal Times** panel shows the Drive Draft laps, their average, and four time fields.
  **Save & Integrate** writes `medal-times.json`. A series stage needs all four times.
- Rename and remove refuse a track in a live series. A rename in a series that is not live
  changes the stage, and it moves the medal row too.
- Drive Draft uses `game/race/race-camera.js` (the race camera, moved out of the race code with
  the same numbers), the default car of the ground, and `RaceHud`. It keeps the 10 best laps
  for each layout in the browser.
- Files: `tools/mapmaker/campaign-series.js`, `tools/mapmaker/medal-times.js`,
  `tools/mapmaker/track-repository.js`, `tools/mapmaker/vite-track-authoring-plugin.js`,
  `tools/mapmaker.js`, `tools/mapmaker.html`, `tools/mapmaker.css`,
  `tools/mapmaker-playtest.js`, `tools/mapmaker-playtest.html`, `tools/mapmaker-playtest.css`.

### Phase C: server and game client

- Each series has its own progress record, `campaign:<series>:progress:<player hash>`, and its
  own progress lock. Stage keys use the series of the stage. The Numbers keys are the same as
  before. `tests/campaign-manifest.test.js` pins them.
- All series share one guest-expiry list (the old Numbers key). A guest write extends the
  expiry of the guest's other series records.
- The bootstrap takes an optional `seriesId`. It returns a summary of every live series and the
  stage details of one series only.
- Start, submit, rival race, ghost and the Head to Head checks find the series from the stage
  ID. Head to Head accepts a stage of any live series. Posts that exist keep working.
- Car skins read the results of all series.
- The sign-in transfer, guest cleanup, discard, retirement check and the storage view cover all
  series. A transfer that started before this change still compares: it ignores series it does
  not know.
- The game client takes the series from the bootstrap answer. **Next** goes to the next stage of
  the same series.
- `tests/server-campaign-series.test.js` runs the store with two live series.

### Phase D: series screen

- **Campaign** (from Home, the Daily/Campaign switch, a Head to Head win, or the launcher post)
  opens a series screen. It lists every series in `series.json`: Numbers (tarmac), Mini Rally
  (dirt), Sliders (snow) and Formula Mini (grip).
  Each row has a picture of the first track of the series, the name in the Home menu type, and
  "TARMAC · 16 STAGES · 23/64 MEDALS". A series that has not reached its stage count is dimmed and says
  its ground and Coming soon, for example "DIRT · COMING SOON". An empty series shows a track of its ground (Country Road, Snow Circuit, Grip
  Circuit).
- Choosing a series opens its stages (the carousel and Start Race). **Escape**
  goes back to the series screen. A return from a race opens the stages.
- On the series list, the mode button reads **Campaign** with a downward arrow.
  On a selected series' stages, it shows that series' full name with an upward
  arrow. The button keeps its fixed width; long names truncate visually with an
  ellipsis, with the full name available to assistive technology and on hover.
  Daily restores the **Campaign** label. It retains the normal Campaign/series-screen
  action; there is no quick-switch dropdown. Track name and laps stay on the right.
- The series screen hides the Standings and Tracks icons, because they need a stage.
- The launcher post uses **Choose your series** above **Campaign**, with general
  copy about earning medals and unlocking races through each series. It names no
  specific series and gives no count of available series.
- Files: `game/lobby/campaign-series-screen.js`, `game/lobby/campaign-series-picker.js`,
  `game/lobby/ui.js`, `pages/game.html`, `styles/lobby-modes.css`,
  `game/campaign/engine-methods.js`, `game/engine.js`, `game/campaign/series.json`.

## What is left

### Screenshot UX review — 2026-10-08

The reviewed series screen has a coherent racing identity: bold italic names,
track previews, a quiet background and readable progress hierarchy. This is a
visual assessment of the supplied screenshot, with the row semantics checked
in `game/lobby/campaign-series-screen.js`; it is not device or interaction QA.

Current finished-series rows use gold detail text and expose a separate
leaderboard button. The full row selects the series. Finishing does not require
the maximum medal total, so a finished row can still show `22/24 medals`.

Suggested refinements, not implemented or approved:

- Add an explicit Finished label or check with text so completion is not
  communicated only by gold, especially beside an incomplete medal tally.
- Give the podium action a clearer visible leaderboard cue; the current
  accessible label and hover title do not explain it in a touch screenshot.
- Make row selection more discoverable with a restrained navigation cue or
  a short Choose a series instruction.
- Increase the inactive Daily label's contrast so it reads as available.

Preserve the current visual direction. Tap accuracy, small-screen overflow,
focus behavior and scroll discoverability require interaction checks.

1. **Dirt content.** Build the dirt tracks. Set their medal times in the Mapmaker.
   Dirt goes live on the first build with 1 stage. Formula Mini needs 2.
2. **Optional:** a split of Campaign analytics by series.
