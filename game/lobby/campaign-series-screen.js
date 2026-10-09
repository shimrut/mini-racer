import { CAMPAIGN_SERIES } from '../campaign/manifest.js';
import { DEFAULT_TRACK_KEY, hasTrack } from '../track/catalog.js';
import { getCampaignSeriesGrounds, getCampaignSeriesSurfaceLabel } from '../campaign/series-surfaces.js';
import { renderTrackPreviewCanvas, trackPreviewPixelScale } from '../ui/track-carousel.js';
import { formatSeriesMedals, MEDALS_PER_STAGE } from './campaign-series-picker.js';
import { createMedalIconSvg } from '../medals/medal-icon.js';

// One row per series: picture, name, stage count and ground, medal count and bar.

const SVG_NS = 'http://www.w3.org/2000/svg';
// The road icon of the Tracks button in the lobby header (Font Awesome Free v7.3.1).
const TRACKS_ICON_PATH = 'M287.9 96L211.7 96C182.3 96 156.6 116.1 149.6 144.6L65.4 484.5C57.9 514.7 80.8 544 112 544L287.9 544L287.9 480C287.9 462.3 302.2 448 319.9 448C337.6 448 351.9 462.3 351.9 480L351.9 544L528 544C559.2 544 582.1 514.7 574.6 484.5L490.5 144.6C483.4 116.1 457.8 96 428.3 96L351.9 96L351.9 160C351.9 177.7 337.6 192 319.9 192C302.2 192 287.9 177.7 287.9 160L287.9 96zM351.9 288L351.9 352C351.9 369.7 337.6 384 319.9 384C302.2 384 287.9 369.7 287.9 352L287.9 288C287.9 270.3 302.2 256 319.9 256C337.6 256 351.9 270.3 351.9 288z';

// A series with no stages yet shows a track of its ground, so the ground is visible.
const GROUND_PREVIEW_TRACK_KEYS = Object.freeze({
    tarmac: DEFAULT_TRACK_KEY,
    dirt: 'countryRoad',
    snow: 'snowCircuit',
    grip: 'gripCircuit',
});

const PREVIEW_CSS_WIDTH = 80;
const PREVIEW_CSS_HEIGHT = 58;

function previewTrackKeyFor(series) {
    const firstStageTrackKey = series.stages[0]?.trackKey;
    if (firstStageTrackKey && hasTrack(firstStageTrackKey)) return firstStageTrackKey;
    const groundTrackKey = GROUND_PREVIEW_TRACK_KEYS[getCampaignSeriesGrounds(series)[0]];
    return groundTrackKey && hasTrack(groundTrackKey) ? groundTrackKey : DEFAULT_TRACK_KEY;
}

// Live series in data file order; medals from the bootstrap summary.
export function buildCampaignSeriesRows(state = {}) {
    const summaries = new Map(
        (Array.isArray(state?.series) ? state.series : []).map((summary) => [summary.id, summary]),
    );
    return CAMPAIGN_SERIES.map((series) => {
        const summary = summaries.get(series.id) ?? null;
        const medalCount = summary?.medalCount ?? 0;
        const stageCount = series.stages.length;
        const medalTotal = stageCount * MEDALS_PER_STAGE;
        return {
            id: series.id,
            name: series.name,
            current: series.id === state?.seriesId,
            previewTrackKey: previewTrackKeyFor(series),
            ground: getCampaignSeriesSurfaceLabel(series),
            stageCount,
            medals: formatSeriesMedals({ medalCount, stageCount }),
            medalShare: medalTotal > 0 ? Math.min(1, medalCount / medalTotal) : 0,
        };
    });
}

function createTracksIcon() {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 640 640');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', TRACKS_ICON_PATH);
    icon.append(path);
    return icon;
}

function buildRow(row, onChoose) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'campaign-series-row';
    button.dataset.seriesId = row.id;
    button.dataset.lobbyAction = '';
    button.setAttribute('role', 'listitem');
    button.classList.toggle('is-current', row.current);
    const stages = `${row.stageCount} ${row.stageCount === 1 ? 'stage' : 'stages'}`;
    button.setAttribute('aria-label', `${row.name}. ${stages}, ${row.ground}, ${row.medals} medals`);
    button.addEventListener('click', () => onChoose?.(row.id));

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
    const stageCount = document.createElement('span');
    stageCount.className = 'campaign-series-row__stages';
    stageCount.append(String(row.stageCount), createTracksIcon());
    info.append(stageCount, row.ground);
    text.append(name, info);

    const medals = document.createElement('span');
    medals.className = 'campaign-series-row__medals';
    medals.setAttribute('aria-hidden', 'true');
    const count = document.createElement('span');
    count.className = 'campaign-series-row__count';
    const countText = document.createElement('span');
    countText.textContent = row.medals;
    count.append(createMedalIconSvg('gold', { className: 'campaign-series-row__medal-icon', showEmblem: false }), countText);
    const bar = document.createElement('span');
    bar.className = 'campaign-series-row__bar';
    bar.style.setProperty('--medal-share', String(row.medalShare));
    medals.append(count, bar);

    button.append(preview, text, medals);
    renderTrackPreviewCanvas(canvas, { trackKey: row.previewTrackKey }, {
        cacheNamespace: 'campaign-series',
    });
    return button;
}

// Draws rows only when they changed, so a repaint keeps pictures and focus.
export function renderCampaignSeriesList(container, rows, { onChoose = null } = {}) {
    if (!container) return;
    const key = JSON.stringify(rows);
    if (container.dataset.rowsKey === key) return;
    container.dataset.rowsKey = key;
    container.replaceChildren(...rows.map((row) => buildRow(row, onChoose)));
}
