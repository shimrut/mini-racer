# Garage decal settings analysis — 2026-10-03

Request: assess exposing decals in the Garage, with four designs containing body and wing details. Analysis only; no game, server, stylesheet or test changes.

## Finding

The idea fits the current drawn-car renderer. Street has four Formula skin presets (Red, Gold, Lime and Arctic), each combining colors with a body/front-wing/rear-wing paint map. Those existing maps can supply four matched decal styles. They are not four universal decals across the whole Garage: Circuit, Dirt, Snow, Water and Space each have five skin presets. There are six models and 29 drawn skins in total; four models have wheels (Formula, Circuit, Rally, Snow).

Here, a decal is a mapping of an existing painted area to `main`, `accent`, `tertiary`, a literal color or `null`. It does not mean an external sticker image. The stripe/tip geometry lives in the existing part renderer. Recoloring a channel currently keeps the skin's map fixed.

## Existing Street choices

This table describes original preset maps before the Garage's automatic tertiary fallback.

| Preset | Body details | Wing details beyond the main-colored blades |
| --- | --- | --- |
| Red | Short nose stripe using Accent | No additional painted wing details |
| Gold | The same short nose stripe using Tertiary | Accent rear flap, front tips and front edge |
| Lime | Accent center stripe | Accent rear flap and Tertiary front edge |
| Arctic | Accent center stripe and nose tip | Tertiary rear ends and front tips |

Red and Gold use the same body geometry, with different color assignments. Therefore there are four preset mappings but only three distinct body masks. Four genuinely different body shapes would require another pattern; four existing style choices do not.

## Smallest useful setting

For the literal proposal of four matched designs, add one **Decal style** row with four renderer-generated previews. Each selection applies its body and wing map together while preserving the player's three chosen colors. Save it per existing skin, consistent with paint and trails, and retain that skin's asset/unlock identity. Reuse the Garage's shared row layout, single horizontal choice row, focus handling and existing preference save/bootstrap/transfer flow.

If independent mixing is desired, expose **Body decals** and **Wing decals** instead. Four choices in each row give 16 pairings without creating 16 new skins. Wing choices can group front and rear wings for a small first version; independent front/rear settings are not required by this request. These are alternative interfaces, not three rows to add together.

Keep pattern choices separate from the existing color channels. Main currently colors both the body and the wing blades; independent wing-base color would be a separate expansion. Selecting a pattern should not silently reset colors or switch the equipped skin.

## Reuse and integration boundaries

- `game/car/drawn-car.js:75` already merges model and skin decal maps before preparing parts. Resolve the chosen existing layout into that same map, including explicit `null` entries to turn off previous stripes. No second renderer or duplicated path geometry is needed.
- `game/car/sprite.js:14` already includes resolved decals in the outer visual key. However, the inner customized-variant key at `:41` currently contains only the three colors; it must also identify the selected layout. Otherwise unchanged colors can return a stale pattern.
- `game/settings/garage-ui.js:360` already keys detail regions by resolved decals, and `findPaintDetails()` discovers areas through the part renderer. Reuse these previews and artwork caches.
- Preserve explicit ownership: Garage, the player's race/ghost and lobby previews receive saved options. Generic opponents and default post cars must keep their original art. Resolve preferences when loading the car; do not read them in the animation loop.
- Extend the existing optional per-skin preference structure, bounded normalization, owner-map replacement, save/bootstrap and field-level guest Merge. No new endpoint or Redis store is needed. Missing choices retain the skin's default layout; account choices win and guest choices fill unset fields.
- Formula, Circuit, Rally and Snow share body/front/rear-wing area names, with an extra scoop on Rally/Snow. Reusing compatible area maps is possible while keeping geometry and mud/snow details model-specific. Jet ski has no wings and needs hull/rider-compatible patterns; spaceship has additional wing/pod areas. Do not imply four identical options are already defined for every type. Legacy raster images have no separately drawn decal layers.
- The current explicit-paint fallback at `game/car/drawn-car.js:82` adds Tertiary rear-wing ends when no area uses that channel. It affects editable Red even with empty paint. An explicit plain/None layout must take precedence over that fallback; it must not silently acquire wing decals to keep the third color visible. If a chosen pattern uses fewer channels, the UI should represent that truthfully.

## Read-only evidence

Inspected the current branch `codex/garage-redesign`, model/skin catalog, body/front-wing/rear-wing parts, constructor, sprite/detail caches and saved preference contracts. An independent agent checked the catalog, body-mask distinction and cache/fallback findings without edits.

A temporary native-canvas probe combined each existing Street body map with each existing wing map, using the same three colors. All 16 combinations rendered through the unchanged `DrawnCar` constructor; all 16 output images were distinct. This proves the drawing mechanism can compose these maps, not that the proposed UI/persistence integration is implemented. The source uses three distinct body masks, with Red/Gold distinguished by color-channel assignment.

Evidence: `/tmp/dailygp-decal-analysis.mjs`, `/tmp/dailygp-decal-analysis-results.json`, and `/Users/bpopa/.codex/visualizations/2026/10/02/01a0fb29-01b7-7a61-918f-857f3c075bdb/garage-decal-analysis.png`. The comparison image was inspected. No application/test source or unrelated WIP was changed; no full-suite result is claimed for this analysis.

## Accepted implementation

The user subsequently accepted the single **Decal style** row. It is implemented on `codex/garage-redesign`: four Street choices and five same-model choices for the other drawn types, using the existing paired preset maps. No independent body/wing rows were added. Visible numbered style labels accompany previews in the current car's colors; the accessible label identifies the source pattern. Existing panel/row/palette layout and skin-button styles are shared, with compact dimensions for the new row.

The optional `carDecals` profile map and local `MiniRacerPlayerCarDecals` key save choices per drawn skin. Explicit original styles remain saved choices (only a null edit removes an override), so original/plain maps take precedence over the automatic tertiary fallback and account choices win guest Merge. Incompatible models, raster targets and unknown styles are discarded independently. Object profiles replace or clear owner maps; null retains the established local contract. Existing save/bootstrap, salvage and transfer paths carry the field.

The renderer accepts `decalStyle` and resolves the same model's complete map while retaining the original skin's livery, material colors, placements and mud/snow settings. Both cached custom variants and visual sprite keys follow the selected pattern. Garage, race, ghost and lobby pass the saved choice explicitly; generic art remains preset. Transient option thumbnails call the same DrawnCar constructor and reuse prepared PNGs without changing the animated-car cache. Missing paint channels keep their stored color and appear as unused/disabled controls with no empty thumbnail.

Implementation validation and browser evidence are recorded in `docs/garage-redesign-2026-10-02.md` under the Decal style completion entry. The earlier read-only findings above describe the starting state.
