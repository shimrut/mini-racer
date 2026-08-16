const SUMMARY_URL = '/api/analytics/summary';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARK_DAYS = 14;
const TRACK_ROWS = 6;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SECTION_IDS = [
    'analytics-windows',
    'analytics-main',
    'analytics-trend',
    'analytics-reach',
    'analytics-today',
    'analytics-tracks',
    'analytics-days',
];

function setText(node, value) {
    if (node) node.textContent = value;
}

function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function formatCount(value) {
    return toCount(value).toLocaleString('en-US');
}

function formatAverage(value) {
    const average = Number(value);
    if (!Number.isFinite(average)) return '0';
    return average >= 100
        ? Math.round(average).toLocaleString('en-US')
        : String(Math.round(average * 10) / 10);
}

function percent(part, total) {
    if (!(total > 0)) return 0;
    return Math.max(0, Math.min(100, (part / total) * 100));
}

function formatShortDate(date) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
    if (!parts) return String(date ?? '');
    return `${MONTHS[Number(parts[2]) - 1] ?? ''} ${Number(parts[3])}`.trim();
}

function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function shape(doc, tag, attributes) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
}

function cardHeading(doc, title, note) {
    const header = element(doc, 'div', 'analytics-card__head');
    header.append(element(doc, 'h2', 'analytics-section-title', title));
    if (note) header.append(element(doc, 'p', 'analytics-card__note', note));
    return header;
}

// A bar whose data-end is rounded and whose baseline end stays square.
function barPath(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height));
    return [
        `M${x} ${y + height}`,
        `V${y + r}`,
        `Q${x} ${y} ${x + r} ${y}`,
        `H${x + width - r}`,
        `Q${x + width} ${y} ${x + width} ${y + r}`,
        `V${y + height}`,
        'Z',
    ].join(' ');
}

function niceStep(rough) {
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
    const scaled = rough / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
}

// Four bands of a round number, so every tick label reads clean.
function axisScale(rawMax) {
    const step = niceStep(Math.max(rawMax, 1) / 4);
    return { step, max: step * 4 };
}

function trend(current, previous) {
    const change = toCount(current) - toCount(previous);
    if (change > 0) return { direction: 'up', text: `▲ ${formatCount(change)}` };
    if (change < 0) return { direction: 'down', text: `▼ ${formatCount(-change)}` };
    return { direction: 'flat', text: '– 0' };
}

function averageTrend(current, previous) {
    const change = Math.round((current - previous) * 10) / 10;
    if (change > 0) return { direction: 'up', text: `▲ ${formatAverage(change)}` };
    if (change < 0) return { direction: 'down', text: `▼ ${formatAverage(-change)}` };
    return { direction: 'flat', text: '– 0' };
}

function mean(values) {
    if (values.length === 0) return 0;
    return values.reduce((total, value) => total + toCount(value), 0) / values.length;
}

function renderSparkline(doc, values, series) {
    const width = 128;
    const height = 34;
    const pad = 4;
    const points = values.map(toCount);
    const svg = shape(doc, 'svg', {
        class: `analytics-spark analytics-spark--${series}`,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
    });
    if (points.length < 2) return svg;

    // Sparklines read shape, not level, so they span the window's own min and max.
    const low = Math.min(...points);
    const span = Math.max(...points) - low || 1;
    const stepX = (width - pad * 2) / (points.length - 1);
    const coords = points.map((value, index) => [
        pad + index * stepX,
        height - pad - ((value - low) / span) * (height - pad * 2),
    ]);
    const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

    svg.append(shape(doc, 'path', {
        class: 'analytics-spark__area',
        d: `${line} L${width - pad} ${height} L${pad} ${height} Z`,
    }));
    svg.append(shape(doc, 'path', { class: 'analytics-spark__line', d: line }));
    // A round-capped zero-length stroke stays circular even though the box is stretched.
    const [lastX, lastY] = coords[coords.length - 1];
    svg.append(shape(doc, 'path', {
        class: 'analytics-spark__dot',
        d: `M${lastX.toFixed(1)} ${lastY.toFixed(1)} L${lastX.toFixed(1)} ${lastY.toFixed(1)}`,
    }));
    return svg;
}

function createStatTile(doc, { label, value, delta, deltaNote, hint, spark, series = 'accent', hero = false }) {
    const tile = element(doc, 'article', hero ? 'analytics-kpi analytics-kpi--hero' : 'analytics-kpi');
    tile.append(element(doc, 'p', 'analytics-kpi__label', label));
    tile.append(element(doc, 'p', 'analytics-kpi__value', value));

    if (delta) {
        const row = element(doc, 'p', 'analytics-kpi__delta');
        row.dataset.direction = delta.direction;
        row.append(element(doc, 'span', 'analytics-kpi__change', delta.text));
        if (deltaNote) row.append(element(doc, 'span', 'analytics-kpi__since', deltaNote));
        tile.append(row);
    }
    if (hint) tile.append(element(doc, 'p', 'analytics-kpi__hint', hint));
    if (Array.isArray(spark) && spark.length > 1) tile.append(renderSparkline(doc, spark, series));
    return tile;
}

function renderHeadline(doc, summary, days) {
    const today = days[days.length - 1] ?? {};
    const yesterday = days[days.length - 2] ?? {};
    const recent = days.slice(-SPARK_DAYS);
    const activeToday = toCount(today.uniquePlayers);
    const newToday = toCount(today.newPlayers);
    const weekAverage = mean(days.slice(-7).map((day) => day.uniquePlayers));
    const priorWeekAverage = mean(days.slice(-14, -7).map((day) => day.uniquePlayers));

    return [
        createStatTile(doc, {
            label: 'Active players today',
            value: formatCount(activeToday),
            delta: trend(activeToday, yesterday.uniquePlayers),
            deltaNote: 'vs yesterday',
            spark: recent.map((day) => day.uniquePlayers),
            hero: true,
        }),
        createStatTile(doc, {
            label: 'New players today',
            value: formatCount(newToday),
            delta: trend(newToday, yesterday.newPlayers),
            deltaNote: 'vs yesterday',
            hint: `${Math.round(percent(newToday, activeToday))}% of today's players`,
            spark: recent.map((day) => day.newPlayers),
            series: 'new',
        }),
        createStatTile(doc, {
            label: 'Daily race finishes',
            value: formatCount(today.dailyFinishes),
            delta: trend(today.dailyFinishes, yesterday.dailyFinishes),
            deltaNote: 'vs yesterday',
            spark: recent.map((day) => day.dailyFinishes),
        }),
        createStatTile(doc, {
            label: 'Avg players per day',
            value: formatAverage(weekAverage),
            delta: averageTrend(weekAverage, priorWeekAverage),
            deltaNote: 'vs prior 7 days',
            hint: `${formatCount(summary?.windows?.[0]?.uniquePlayers)} unique this week`,
            spark: recent.map((day) => day.uniquePlayers),
        }),
    ];
}

function chartTooltipRow(doc, label, value, series) {
    const row = element(doc, 'div', 'analytics-tip__row');
    if (series) row.append(element(doc, 'span', `analytics-tip__key analytics-tip__key--${series}`));
    row.append(element(doc, 'span', 'analytics-tip__label', label));
    row.append(element(doc, 'span', 'analytics-tip__value', formatCount(value)));
    return row;
}

function renderPlayersChart(doc, days) {
    const width = 720;
    const height = 300;
    const pad = { top: 16, right: 10, bottom: 32, left: 46 };
    const innerWidth = width - pad.left - pad.right;
    const innerHeight = height - pad.top - pad.bottom;
    const baseline = height - pad.bottom;
    const totals = days.map((day) => toCount(day?.newPlayers) + toCount(day?.returningPlayers));
    const { step, max } = axisScale(Math.max(...totals, 1));
    const band = innerWidth / Math.max(days.length, 1);
    const barWidth = Math.min(22, Math.max(3, band - 2));
    const scale = (value) => (value / max) * innerHeight;

    const svg = shape(doc, 'svg', {
        class: 'analytics-chart',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `New and returning players per day, ${formatShortDate(days[0]?.date)} to ${formatShortDate(days[days.length - 1]?.date)}`,
    });

    for (let tick = 0; tick <= max; tick += step) {
        const y = baseline - scale(tick);
        svg.append(shape(doc, 'line', {
            class: tick === 0 ? 'analytics-chart__axis' : 'analytics-chart__grid',
            x1: pad.left,
            x2: width - pad.right,
            y1: y,
            y2: y,
        }));
        const label = shape(doc, 'text', { class: 'analytics-chart__tick', x: pad.left - 10, y: y + 3.5 });
        label.textContent = formatCount(tick);
        svg.append(label);
    }

    const hover = shape(doc, 'rect', {
        class: 'analytics-chart__hover',
        x: pad.left,
        y: pad.top,
        width: Math.max(band, 1),
        height: innerHeight,
        rx: '2',
        opacity: '0',
    });
    svg.append(hover);

    days.forEach((day, index) => {
        const returning = toCount(day?.returningPlayers);
        const fresh = toCount(day?.newPlayers);
        const x = pad.left + index * band + (band - barWidth) / 2;
        // A one-player day still needs a visible segment, so every drawn bar has a floor.
        const returningHeight = returning > 0 ? Math.max(scale(returning), 2) : 0;
        const newHeight = fresh > 0 ? Math.max(scale(fresh), 2) : 0;
        // A 2px surface gap does the separating, so no stroke is drawn around a segment.
        const gap = returning > 0 && fresh > 0 ? 2 : 0;

        if (returning > 0) {
            svg.append(shape(doc, 'path', {
                class: 'analytics-chart__bar analytics-chart__bar--returning',
                d: barPath(x, baseline - returningHeight, barWidth, returningHeight, fresh > 0 ? 0 : 4),
            }));
        }
        if (fresh > 0) {
            svg.append(shape(doc, 'path', {
                class: 'analytics-chart__bar analytics-chart__bar--new',
                d: barPath(x, baseline - returningHeight - gap - newHeight, barWidth, newHeight, 4),
            }));
        }
    });

    const labelEvery = Math.max(1, Math.ceil(days.length / 6));
    const lastIndex = days.length - 1;
    days.forEach((day, index) => {
        // Always label the newest day; drop any earlier tick that would crowd it.
        if (index !== lastIndex && (index % labelEvery !== 0 || lastIndex - index < labelEvery)) return;
        const text = shape(doc, 'text', {
            class: 'analytics-chart__label',
            x: pad.left + index * band + band / 2,
            y: baseline + 18,
            'text-anchor': 'middle',
        });
        text.textContent = formatShortDate(day?.date);
        svg.append(text);
    });

    const plot = element(doc, 'div', 'analytics-plot');
    const tip = element(doc, 'div', 'analytics-tip');
    tip.hidden = true;
    plot.append(svg, tip);

    days.forEach((day, index) => {
        const hit = shape(doc, 'rect', {
            class: 'analytics-chart__hit',
            x: pad.left + index * band,
            y: pad.top,
            width: Math.max(band, 1),
            height: innerHeight,
        });
        const show = () => {
            tip.replaceChildren(
                element(doc, 'p', 'analytics-tip__date', formatShortDate(day?.date)),
                chartTooltipRow(doc, 'New', day?.newPlayers, 'new'),
                chartTooltipRow(doc, 'Returning', day?.returningPlayers, 'returning'),
                chartTooltipRow(doc, 'Active', day?.uniquePlayers),
            );
            const center = percent(pad.left + index * band + band / 2, width);
            tip.hidden = false;
            tip.style.left = `${center}%`;
            // Anchor the near edge at the ends so the readout never leaves the card.
            tip.dataset.align = center < 12 ? 'start' : center > 88 ? 'end' : 'middle';
            hover.setAttribute('x', String(pad.left + index * band));
            hover.setAttribute('opacity', '1');
        };
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointermove', show);
        svg.append(hit);
    });

    plot.addEventListener('pointerleave', () => {
        tip.hidden = true;
        hover.setAttribute('opacity', '0');
    });
    return plot;
}

function chartLegend(doc) {
    const legend = element(doc, 'div', 'analytics-legend');
    for (const [series, label] of [['new', 'New'], ['returning', 'Returning']]) {
        const entry = element(doc, 'span', 'analytics-legend__item');
        entry.append(
            element(doc, 'span', `analytics-legend__swatch analytics-legend__swatch--${series}`),
            element(doc, 'span', undefined, label),
        );
        legend.append(entry);
    }
    return legend;
}

function renderReach(doc, windows) {
    const nodes = [cardHeading(doc, 'Unique reach', 'Players seen at least once')];
    if (windows.length === 0) {
        nodes.push(element(doc, 'p', 'analytics-note', 'No windows yet'));
        return nodes;
    }
    const max = Math.max(...windows.map((row) => toCount(row?.uniquePlayers)), 1);
    const list = element(doc, 'div', 'analytics-reach');
    for (const row of windows) {
        const unique = toCount(row?.uniquePlayers);
        const playerDays = toCount(row?.playerDays);
        const item = element(doc, 'div', 'analytics-reach__row');
        const head = element(doc, 'div', 'analytics-reach__head');
        head.append(
            element(doc, 'span', 'analytics-reach__span', `${formatCount(row?.days)} days`),
            element(doc, 'span', 'analytics-count', formatCount(unique)),
        );
        const track = element(doc, 'div', 'analytics-bar');
        const fill = element(doc, 'div', 'analytics-bar__fill');
        fill.style.width = `${percent(unique, max)}%`;
        track.append(fill);
        item.append(
            head,
            track,
            element(doc, 'p', 'analytics-reach__hint', unique > 0
                ? `${formatAverage(playerDays / unique)} days played per player`
                : 'No players yet'),
        );
        list.append(item);
    }
    nodes.push(list);
    return nodes;
}

function renderPlays(doc, days) {
    const today = days[days.length - 1] ?? {};
    const week = days.slice(-7);
    const rows = [
        ['Daily finishes', 'dailyFinishes'],
        ['Campaign starts', 'campaignStarts'],
        ['Challenges created', 'challengeCreates'],
        ['Challenges finished', 'challengeFinishes'],
    ];
    const max = Math.max(...rows.map(([, key]) => toCount(today[key])), 1);
    const list = element(doc, 'div', 'analytics-plays');

    for (const [label, key] of rows) {
        const count = toCount(today[key]);
        const average = mean(week.map((day) => day[key]));
        const row = element(doc, 'div', 'analytics-plays__row');
        const head = element(doc, 'div', 'analytics-plays__head');
        head.append(
            element(doc, 'span', 'analytics-plays__label', label),
            element(doc, 'span', 'analytics-count', formatCount(count)),
        );
        const track = element(doc, 'div', 'analytics-bar');
        const fill = element(doc, 'div', 'analytics-bar__fill');
        fill.style.width = `${percent(count, max)}%`;
        track.append(fill);
        if (average > 0) {
            const marker = element(doc, 'span', 'analytics-bar__marker');
            marker.style.left = `${percent(average, max)}%`;
            marker.title = `7-day average ${formatAverage(average)}`;
            track.append(marker);
        }
        row.append(head, track);
        list.append(row);
    }
    return [cardHeading(doc, 'Plays today', 'Marker shows the 7-day average'), list];
}

function renderTrackPanel(doc, title, tracks) {
    const panel = element(doc, 'article', 'analytics-panel');
    const list = Array.isArray(tracks) ? tracks : [];
    const total = list.reduce((sum, track) => sum + toCount(track?.count), 0);
    panel.append(cardHeading(doc, title, total > 0 ? `${formatCount(total)} plays` : undefined));

    if (list.length === 0) {
        panel.append(element(doc, 'p', 'analytics-note', 'None yet'));
        return panel;
    }

    const max = Math.max(...list.map((track) => toCount(track?.count)), 1);
    const rows = element(doc, 'ol', 'analytics-ranks');
    list.slice(0, TRACK_ROWS).forEach((track, index) => {
        const name = typeof track?.trackName === 'string' && track.trackName.trim()
            ? track.trackName.trim()
            : 'Unknown track';
        const count = toCount(track?.count);
        const row = element(doc, 'li', 'analytics-ranks__row');
        const head = element(doc, 'div', 'analytics-ranks__head');
        head.append(
            element(doc, 'span', 'analytics-ranks__place', String(index + 1)),
            element(doc, 'span', 'analytics-ranks__name', name),
            element(doc, 'span', 'analytics-count', formatCount(count)),
        );
        const track_ = element(doc, 'div', 'analytics-bar');
        const fill = element(doc, 'div', 'analytics-bar__fill');
        fill.style.width = `${percent(count, max)}%`;
        track_.append(fill);
        row.append(head, track_);
        rows.append(row);
    });
    panel.append(rows);

    if (list.length > TRACK_ROWS) {
        panel.append(element(doc, 'p', 'analytics-note', `+${formatCount(list.length - TRACK_ROWS)} more tracks`));
    }
    return panel;
}

function renderDailyTable(doc, days) {
    const table = element(doc, 'table', 'analytics-table');
    const head = element(doc, 'thead');
    const groups = element(doc, 'tr', 'analytics-table__groups');
    for (const [label, span, grouped] of [['', 1, false], ['Players', 3, false], ['Plays', 4, true]]) {
        const cell = element(doc, 'th', grouped ? 'analytics-table__divide' : undefined, label);
        cell.colSpan = span;
        cell.scope = 'colgroup';
        groups.append(cell);
    }
    const labels = element(doc, 'tr');
    for (const [label, grouped] of [
        ['Date', false], ['Active', false], ['New', false], ['Returning', false],
        ['Daily', true], ['Campaign', false], ['Created', false], ['Finished', false],
    ]) {
        const cell = element(doc, 'th', grouped ? 'analytics-table__divide' : undefined, label);
        cell.scope = 'col';
        labels.append(cell);
    }
    head.append(groups, labels);

    const body = element(doc, 'tbody');
    const latest = days[days.length - 1]?.date;
    for (const day of [...days].reverse()) {
        const row = element(doc, 'tr');
        if (day?.date && day.date === latest) row.className = 'analytics-table__today';
        const date = element(doc, 'th', undefined, formatShortDate(day?.date) || 'Unknown');
        date.scope = 'row';
        date.title = typeof day?.date === 'string' ? day.date : '';
        row.append(date);
        const cells = [
            [day?.uniquePlayers, false],
            [day?.newPlayers, false],
            [day?.returningPlayers, false],
            [day?.dailyFinishes, true],
            [day?.campaignStarts, false],
            [day?.challengeCreates, false],
            [day?.challengeFinishes, false],
        ];
        for (const [value, grouped] of cells) {
            row.append(element(doc, 'td', grouped ? 'analytics-table__divide' : undefined, formatCount(value)));
        }
        body.append(row);
    }
    table.append(head, body);

    const wrap = element(doc, 'div', 'analytics-table-wrap');
    wrap.append(table);
    return wrap;
}

function revealSections(root) {
    for (const id of SECTION_IDS) {
        const node = root.getElementById(id);
        if (node) node.hidden = false;
    }
}

export function renderAnalyticsSummary(root, summary) {
    const status = root.getElementById('analytics-status');
    const range = root.getElementById('analytics-range');
    const windows = root.getElementById('analytics-windows');
    const trendNode = root.getElementById('analytics-trend');
    const reachNode = root.getElementById('analytics-reach');
    const todayNode = root.getElementById('analytics-today');
    const tracksNode = root.getElementById('analytics-tracks');
    const daysNode = root.getElementById('analytics-days');
    const windowRows = Array.isArray(summary?.windows) ? summary.windows : [];
    const stored = Array.isArray(summary?.days) ? summary.days : [];
    const days = stored.length > 0
        ? stored
        : [summary?.today && typeof summary.today === 'object' ? summary.today : {}];

    setText(range, summary?.from && summary?.to ? `${summary.from} to ${summary.to}` : 'Last 45 days');
    setText(status, '');
    status?.removeAttribute('data-state');

    windows.replaceChildren(...renderHeadline(root, summary, days));

    const trendHead = cardHeading(root, 'Players per day', `${formatCount(stored.length)} days recorded`);
    if (stored.length < 2) {
        const empty = element(root, 'p', 'analytics-chart-empty', 'Not enough days recorded yet');
        trendNode.replaceChildren(trendHead, empty);
    } else {
        trendHead.append(chartLegend(root));
        trendNode.replaceChildren(trendHead, renderPlayersChart(root, stored));
    }

    reachNode.replaceChildren(...renderReach(root, windowRows));
    todayNode.replaceChildren(...renderPlays(root, days));

    tracksNode.replaceChildren(
        renderTrackPanel(root, 'Daily tracks', summary?.tracks?.daily),
        renderTrackPanel(root, 'Campaign tracks', summary?.tracks?.campaign),
        renderTrackPanel(root, 'Challenge tracks', summary?.tracks?.challenge),
    );

    const dayHead = cardHeading(root, 'Daily breakdown', 'Newest first');
    if (stored.length === 0) {
        daysNode.replaceChildren(dayHead, element(root, 'p', 'analytics-note', 'No stored days yet'));
    } else {
        daysNode.replaceChildren(dayHead, renderDailyTable(root, stored));
    }

    revealSections(root);
}

export function renderAnalyticsMessage(root, message, state = 'error') {
    const status = root.getElementById('analytics-status');
    setText(status, message);
    if (state) status?.setAttribute('data-state', state);
    for (const id of SECTION_IDS) {
        const node = root.getElementById(id);
        if (node) {
            if (id !== 'analytics-main') node.replaceChildren();
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
