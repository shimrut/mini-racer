const SUMMARY_URL = '/api/analytics/summary';
const SVG_NS = 'http://www.w3.org/2000/svg';

function setText(node, value) {
    if (node) node.textContent = value;
}

function formatCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? String(Math.max(0, Math.trunc(count))) : '0';
}

function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function percent(part, total) {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (part / total) * 100));
}

export function createMetric(doc, label, value, extraClass = '', hint = '') {
    const metric = doc.createElement('article');
    metric.className = extraClass ? `analytics-kpi ${extraClass}` : 'analytics-kpi';
    const labelNode = doc.createElement('p');
    labelNode.className = 'analytics-kpi__label';
    labelNode.textContent = label;
    const valueNode = doc.createElement('p');
    valueNode.className = 'analytics-kpi__value';
    valueNode.textContent = formatCount(value);
    metric.append(labelNode, valueNode);
    if (hint) {
        const hintNode = doc.createElement('p');
        hintNode.className = 'analytics-kpi__hint';
        hintNode.textContent = hint;
        metric.append(hintNode);
    }
    return metric;
}

export function createCountRow(doc, name, count, rowClass) {
    const row = doc.createElement('div');
    row.className = rowClass;
    const nameNode = doc.createElement('span');
    nameNode.textContent = name;
    const countNode = doc.createElement('span');
    countNode.className = 'analytics-count';
    countNode.textContent = formatCount(count);
    row.append(nameNode, countNode);
    return row;
}

function createPlayStat(doc, label, count) {
    const play = doc.createElement('div');
    play.className = 'analytics-play';
    const labelNode = doc.createElement('p');
    labelNode.className = 'analytics-play__label';
    labelNode.textContent = label;
    const valueNode = doc.createElement('p');
    valueNode.className = 'analytics-play__value';
    valueNode.textContent = formatCount(count);
    play.append(labelNode, valueNode);
    return play;
}

export function renderTrackList(doc, title, tracks) {
    const list = doc.createElement('article');
    list.className = 'analytics-panel';
    const heading = doc.createElement('h2');
    heading.className = 'analytics-section-title';
    heading.textContent = title;
    list.append(heading);
    if (!Array.isArray(tracks) || tracks.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'analytics-note';
        empty.textContent = 'None yet';
        list.append(empty);
        return list;
    }
    const max = Math.max(...tracks.map((track) => toCount(track?.count)), 1);
    for (const track of tracks) {
        const name = typeof track?.trackName === 'string' && track.trackName.trim()
            ? track.trackName.trim()
            : 'Unknown track';
        const count = toCount(track?.count);
        const row = doc.createElement('div');
        row.className = 'analytics-track-row';
        const meta = doc.createElement('div');
        meta.className = 'analytics-track-row__meta';
        const nameNode = doc.createElement('span');
        nameNode.textContent = name;
        const countNode = doc.createElement('span');
        countNode.className = 'analytics-count';
        countNode.textContent = formatCount(count);
        meta.append(nameNode, countNode);
        const bar = doc.createElement('div');
        bar.className = 'analytics-track-row__bar';
        const fill = doc.createElement('div');
        fill.className = 'analytics-track-row__fill';
        fill.style.width = `${percent(count, max)}%`;
        bar.append(fill);
        row.append(meta, bar);
        list.append(row);
    }
    return list;
}

export function renderUniqueChart(doc, days) {
    const width = 800;
    const height = 220;
    const pad = { top: 16, right: 12, bottom: 28, left: 36 };
    const innerWidth = width - pad.left - pad.right;
    const innerHeight = height - pad.top - pad.bottom;
    const points = Array.isArray(days) ? days : [];
    const max = Math.max(...points.map((day) => toCount(day?.uniquePlayers)), 1);
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'analytics-chart');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Unique players by day');

    const axis = doc.createElementNS(SVG_NS, 'line');
    axis.setAttribute('x1', String(pad.left));
    axis.setAttribute('x2', String(width - pad.right));
    axis.setAttribute('y1', String(height - pad.bottom));
    axis.setAttribute('y2', String(height - pad.bottom));
    axis.setAttribute('stroke', 'rgba(148, 163, 184, 0.35)');
    svg.append(axis);

    if (points.length === 0) {
        return svg;
    }

    const barWidth = Math.max(2, innerWidth / points.length - 1);
    points.forEach((day, index) => {
        const value = toCount(day?.uniquePlayers);
        const barHeight = (value / max) * innerHeight;
        const x = pad.left + (index * innerWidth) / points.length;
        const y = height - pad.bottom - barHeight;
        const rect = doc.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(barWidth));
        rect.setAttribute('height', String(Math.max(barHeight, value > 0 ? 2 : 0)));
        rect.setAttribute('rx', '1');
        rect.setAttribute('fill', index === points.length - 1 ? '#ef4444' : 'rgba(248, 250, 252, 0.55)');
        const title = doc.createElementNS(SVG_NS, 'title');
        title.textContent = `${typeof day?.date === 'string' ? day.date : 'Day'}: ${formatCount(value)} unique`;
        rect.append(title);
        svg.append(rect);
    });

    const first = typeof points[0]?.date === 'string' ? points[0].date : '';
    const last = typeof points[points.length - 1]?.date === 'string'
        ? points[points.length - 1].date
        : '';
    for (const [label, x] of [[first, pad.left], [last, width - pad.right]]) {
        if (!label) continue;
        const text = doc.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', String(x));
        text.setAttribute('y', String(height - 8));
        text.setAttribute('fill', '#94a3b8');
        text.setAttribute('font-size', '11');
        text.setAttribute('text-anchor', x === pad.left ? 'start' : 'end');
        text.textContent = label;
        svg.append(text);
    }

    const maxLabel = doc.createElementNS(SVG_NS, 'text');
    maxLabel.setAttribute('x', '8');
    maxLabel.setAttribute('y', String(pad.top + 4));
    maxLabel.setAttribute('fill', '#94a3b8');
    maxLabel.setAttribute('font-size', '11');
    maxLabel.textContent = formatCount(max);
    svg.append(maxLabel);
    return svg;
}

function renderMixPanel(doc, today) {
    const panel = doc.createElement('article');
    panel.className = 'analytics-panel';
    const heading = doc.createElement('h2');
    heading.className = 'analytics-section-title';
    heading.textContent = 'New vs returning';
    const newCount = toCount(today.newPlayers);
    const returningCount = toCount(today.returningPlayers);
    const total = newCount + returningCount;
    const bar = doc.createElement('div');
    bar.className = 'analytics-mix__bar';
    if (total > 0) {
        const newFill = doc.createElement('span');
        newFill.className = 'analytics-mix__fill analytics-mix__fill--new';
        newFill.style.width = `${percent(newCount, total)}%`;
        const returningFill = doc.createElement('span');
        returningFill.className = 'analytics-mix__fill analytics-mix__fill--returning';
        returningFill.style.width = `${percent(returningCount, total)}%`;
        bar.append(newFill, returningFill);
    }
    const legend = doc.createElement('div');
    legend.className = 'analytics-mix__legend';
    legend.append(
        createCountRow(doc, 'New', newCount, 'analytics-stat'),
        createCountRow(doc, 'Returning', returningCount, 'analytics-stat'),
    );
    panel.append(heading, bar, legend);
    return panel;
}

function renderPlaysPanel(doc, today) {
    const panel = doc.createElement('article');
    panel.className = 'analytics-panel';
    const heading = doc.createElement('h2');
    heading.className = 'analytics-section-title';
    heading.textContent = 'Plays today';
    const grid = doc.createElement('div');
    grid.className = 'analytics-plays';
    grid.append(
        createPlayStat(doc, 'Daily finishes', today.dailyFinishes),
        createPlayStat(doc, 'Campaign starts', today.campaignStarts),
        createPlayStat(doc, 'Challenges created', today.challengeCreates),
        createPlayStat(doc, 'Challenges finished', today.challengeFinishes),
    );
    panel.append(heading, grid);
    return panel;
}

export function renderAnalyticsSummary(root, summary) {
    const status = root.getElementById('analytics-status');
    const range = root.getElementById('analytics-range');
    const windows = root.getElementById('analytics-windows');
    const todayNode = root.getElementById('analytics-today');
    const trendNode = root.getElementById('analytics-trend');
    const tracksNode = root.getElementById('analytics-tracks');
    const daysNode = root.getElementById('analytics-days');
    const today = summary?.today && typeof summary.today === 'object' ? summary.today : {};
    const windowRows = Array.isArray(summary?.windows) ? summary.windows : [];
    const days = Array.isArray(summary?.days) ? summary.days : [];

    setText(range, summary?.from && summary?.to ? `${summary.from} to ${summary.to}` : 'Last 45 days');
    setText(status, '');
    status?.removeAttribute('data-state');

    windows.replaceChildren(
        createMetric(root, 'Today unique', today.uniquePlayers, 'analytics-kpi--primary'),
        ...windowRows.map((windowRow) => (
            createMetric(
                root,
                `${formatCount(windowRow?.days)}-day unique`,
                windowRow?.uniquePlayers,
                '',
                `${formatCount(windowRow?.playerDays)} player-days`,
            )
        )),
    );
    windows.hidden = false;

    todayNode.replaceChildren(renderMixPanel(root, today), renderPlaysPanel(root, today));
    todayNode.hidden = false;

    const trendTitle = root.createElement('h2');
    trendTitle.className = 'analytics-section-title';
    trendTitle.textContent = 'Unique players';
    if (days.length === 0) {
        const empty = root.createElement('p');
        empty.className = 'analytics-chart-empty';
        empty.textContent = 'No daily data yet';
        trendNode.replaceChildren(trendTitle, empty);
    } else {
        trendNode.replaceChildren(trendTitle, renderUniqueChart(root, days));
    }
    trendNode.hidden = false;

    tracksNode.replaceChildren(
        renderTrackList(root, 'Daily tracks', summary?.tracks?.daily),
        renderTrackList(root, 'Campaign tracks', summary?.tracks?.campaign),
        renderTrackList(root, 'Challenge tracks', summary?.tracks?.challenge),
    );
    tracksNode.hidden = false;

    const dayHeading = root.createElement('h2');
    dayHeading.className = 'analytics-section-title';
    dayHeading.textContent = 'Daily breakdown';
    if (days.length === 0) {
        const empty = root.createElement('p');
        empty.className = 'analytics-note';
        empty.textContent = 'No stored days yet';
        daysNode.replaceChildren(dayHeading, empty);
        daysNode.hidden = false;
        return;
    }

    const wrap = root.createElement('div');
    wrap.className = 'analytics-table-wrap';
    const table = root.createElement('table');
    table.className = 'analytics-table';
    const head = root.createElement('thead');
    const headRow = root.createElement('tr');
    for (const label of ['Date', 'Unique', 'New', 'Returning']) {
        const cell = root.createElement('th');
        cell.textContent = label;
        headRow.append(cell);
    }
    head.append(headRow);
    const body = root.createElement('tbody');
    for (const day of [...days].reverse()) {
        const row = root.createElement('tr');
        const values = [
            typeof day?.date === 'string' ? day.date : 'Unknown',
            formatCount(day?.uniquePlayers),
            formatCount(day?.newPlayers),
            formatCount(day?.returningPlayers),
        ];
        values.forEach((value) => {
            const cell = root.createElement('td');
            cell.textContent = value;
            row.append(cell);
        });
        body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    daysNode.replaceChildren(dayHeading, wrap);
    daysNode.hidden = false;
}

export function renderAnalyticsMessage(root, message, state = 'error') {
    const status = root.getElementById('analytics-status');
    setText(status, message);
    if (state) status?.setAttribute('data-state', state);
    for (const id of ['analytics-windows', 'analytics-today', 'analytics-trend', 'analytics-tracks', 'analytics-days']) {
        const node = root.getElementById(id);
        if (node) {
            node.replaceChildren();
            node.hidden = true;
        }
    }
}

export async function loadAnalyticsSummary(fetchImpl = fetch) {
    const response = await fetchImpl(SUMMARY_URL);
    if (response.status === 403) {
        return { error: 'Moderator access required.' };
    }
    if (response.status === 400) {
        return { error: 'This summary needs a subreddit context.' };
    }
    if (!response.ok) {
        return { error: 'Could not load the summary.' };
    }
    return { summary: await response.json() };
}

async function boot(root = document, fetchImpl = fetch) {
    try {
        const result = await loadAnalyticsSummary(fetchImpl);
        if (result.error) {
            renderAnalyticsMessage(root, result.error);
            return;
        }
        renderAnalyticsSummary(root, result.summary);
    } catch (_error) {
        renderAnalyticsMessage(root, 'Could not load the summary.');
    }
}

if (typeof document !== 'undefined' && document.getElementById('analytics-title')) {
    void boot();
}
