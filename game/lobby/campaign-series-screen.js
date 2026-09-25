import { CAMPAIGN_ALL_SERIES } from '../campaign/manifest.js';
import { DEFAULT_TRACK_KEY, hasTrack } from '../track/catalog.js';
import { renderTrackPreviewCanvas, trackPreviewPixelScale } from '../ui/track-carousel.js';
import { formatSeriesMedals, getSeriesGroundLabel } from './campaign-series-picker.js';

// The Campaign series screen: one row for each series, with a picture of its
// first track, its name in the Home menu type, and one line of detail.

// A series with no stages yet shows a track of its ground, so the ground is visible.
const GROUND_PREVIEW_TRACK_KEYS = Object.freeze({
    tarmac: DEFAULT_TRACK_KEY,
    dirt: 'countryRoad',
    snow: 'snowCircuit',
    grip: 'gripCircuit',
});

const PREVIEW_CSS_WIDTH = 104;
const PREVIEW_CSS_HEIGHT = 58;

function previewTrackKeyFor(series) {
    const firstStageTrackKey = series.stages[0]?.trackKey;
    if (firstStageTrackKey && hasTrack(firstStageTrackKey)) return firstStageTrackKey;
    const groundTrackKey = GROUND_PREVIEW_TRACK_KEYS[series.ground];
    return groundTrackKey && hasTrack(groundTrackKey) ? groundTrackKey : DEFAULT_TRACK_KEY;
}

// Every series in the data file, in its order. A series that is not live yet is
// "Coming soon". Medals come from the bootstrap summary of the live series.
export function buildCampaignSeriesRows(state = {}) {
    const summaries = new Map(
        (Array.isArray(state?.series) ? state.series : []).map((summary) => [summary.id, summary]),
    );
    return CAMPAIGN_ALL_SERIES.map((series) => {
        const summary = summaries.get(series.id) ?? null;
        const comingSoon = !series.live;
        const medals = formatSeriesMedals({
            medalCount: summary?.medalCount ?? 0,
            stageCount: series.stages.length,
        });
        return {
            id: series.id,
            name: series.name,
            ground: series.ground,
            comingSoon,
            finished: !comingSoon && summary?.finished === true,
            current: series.id === state?.seriesId,
            previewTrackKey: previewTrackKeyFor(series),
            // Parts of the detail line. A narrow screen puts each part on its own line.
            infoParts: comingSoon
                ? [getSeriesGroundLabel(series.ground), 'Coming soon']
                : [`${getSeriesGroundLabel(series.ground)} · ${series.stages.length} stages`, `${medals} medals`],
            medals,
        };
    });
}

function buildRow(row, onChoose) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'campaign-series-row';
    button.dataset.seriesId = row.id;
    button.dataset.lobbyAction = '';
    button.setAttribute('role', 'listitem');
    button.classList.toggle('is-current', row.current);
    button.classList.toggle('is-coming-soon', row.comingSoon);
    button.disabled = row.comingSoon;
    button.setAttribute('aria-label', row.comingSoon
        ? `${row.name}. Coming soon`
        : `${row.name}. ${row.infoParts.join(', ')}`);
    button.addEventListener('click', () => {
        if (!row.comingSoon) onChoose?.(row.id);
    });

    const preview = document.createElement('span');
    preview.className = 'campaign-series-row__preview';
    preview.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    const scale = trackPreviewPixelScale();
    canvas.width = PREVIEW_CSS_WIDTH * scale;
    canvas.height = PREVIEW_CSS_HEIGHT * scale;
    preview.appendChild(canvas);

    const text = document.createElement('span');
    text.className = 'campaign-series-row__text';
    const name = document.createElement('span');
    name.className = 'lobby-mode-action__label campaign-series-row__name';
    name.textContent = row.name;
    const info = document.createElement('span');
    info.className = 'campaign-series-row__info';
    info.append(...row.infoParts.map((part) => {
        const span = document.createElement('span');
        span.className = 'campaign-series-row__part';
        span.textContent = part;
        return span;
    }));
    if (row.finished) info.dataset.finished = 'true';
    text.append(name, info);

    button.append(preview, text);
    renderTrackPreviewCanvas(canvas, { trackKey: row.previewTrackKey }, {
        cacheNamespace: 'campaign-series',
    });
    return button;
}

// Draws the rows. It does nothing when the rows have not changed, so a repaint
// of the Campaign screen keeps the pictures and the keyboard cue.
export function renderCampaignSeriesList(container, rows, { onChoose = null } = {}) {
    if (!container) return;
    const key = JSON.stringify(rows);
    if (container.dataset.rowsKey === key) return;
    container.dataset.rowsKey = key;
    container.replaceChildren(...rows.map((row) => buildRow(row, onChoose)));
}
