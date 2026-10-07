import { setText } from '../game/ui/dom.js';
const SUMMARY_URL = '/api/analytics/summary';
const CHALLENGES_URL = '/api/analytics/challenges';
const STORAGE_URL = '/api/analytics/storage';
const GHOST_MOVE_URL = '/api/analytics/ghost-archive';
const GHOST_COMPACTION_URL = '/api/analytics/ghost-compaction';
const GHOST_MOVE_POLL_MS = 5_000;
const TABS = ['players', 'challenges', 'storage'];
const TAB_MEMORY_KEY = 'MiniRacerAnalyticsTab';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The sections of the Players tab.
const SECTION_IDS = [
    'analytics-windows',
    'analytics-main',
    'analytics-trend',
    'analytics-modes',
    'analytics-cohorts',
    'analytics-months',
    'analytics-days',
];
const MODE_LABELS = { daily: 'Daily', campaign: 'Campaign', challenge: 'Challenge' };
const ANALYTICS_CHART_DAYS = 45;

function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function formatCount(value) {
    return toCount(value).toLocaleString('en-US');
}

function formatRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0) return '—';
    return `${rate.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
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

function cardHeading(doc, title) {
    const header = element(doc, 'div', 'analytics-card__head');
    header.append(element(doc, 'h2', 'analytics-section-title', title));
    return header;
}

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

function axisScale(rawMax) {
    const step = niceStep(Math.max(rawMax, 1) / 4);
    return { step, max: step * 4 };
}

function trend(current, previous) {
    const change = toCount(current) - toCount(previous);
    if (change > 0) return { direction: 'up', text: `▲ ${formatCount(change)}` };
    if (change < 0) return { direction: 'down', text: `▼ ${formatCount(-change)}` };
    return null;
}

function createStatTile(doc, { label, value, delta, deltaNote, hero = false }) {
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
    return tile;
}

function renderHeadline(doc, days) {
    const today = days[days.length - 1] ?? {};
    const yesterday = days[days.length - 2] ?? {};
    const players = toCount(today.players);
    const heading = element(doc, 'h2', 'analytics-summary__title', 'Today');
    heading.id = 'analytics-summary-title';

    return [
        heading,
        createStatTile(doc, {
            label: 'Players',
            value: formatCount(players),
            delta: trend(players, yesterday.players),
            deltaNote: 'vs yesterday',
            hero: true,
        }),
        createStatTile(doc, {
            label: 'New',
            value: formatCount(today.newPlayers),
            delta: trend(today.newPlayers, yesterday.newPlayers),
            deltaNote: 'vs yesterday',
        }),
        createStatTile(doc, {
            label: 'Returning',
            value: formatCount(today.returningPlayers),
            delta: trend(today.returningPlayers, yesterday.returningPlayers),
            deltaNote: 'vs yesterday',
        }),
        createStatTile(doc, {
            label: 'Signed out',
            value: formatCount(today.guestPlayers),
            delta: trend(today.guestPlayers, yesterday.guestPlayers),
            deltaNote: 'vs yesterday',
        }),
        createStatTile(doc, {
            label: 'Play Now',
            value: formatCount(today.podiumPlays),
            delta: trend(today.podiumPlays, yesterday.podiumPlays),
            deltaNote: 'vs yesterday',
        }),
        createStatTile(doc, {
            label: 'View Replays',
            value: formatCount(today.podiumReplays),
            delta: trend(today.podiumReplays, yesterday.podiumReplays),
            deltaNote: 'vs yesterday',
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
        const returningHeight = returning > 0 ? Math.max(scale(returning), 2) : 0;
        const newHeight = fresh > 0 ? Math.max(scale(fresh), 2) : 0;
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

function modeRow(doc, mode) {
    const starts = toCount(mode?.starts);
    const finishes = toCount(mode?.finishes);
    const row = element(doc, 'tr');
    const name = element(doc, 'th', undefined, MODE_LABELS[mode?.mode] ?? 'Unknown');
    name.scope = 'row';
    row.append(
        name,
        element(doc, 'td', undefined, formatCount(mode?.players)),
        element(doc, 'td', undefined, formatCount(starts)),
        element(doc, 'td', undefined, formatCount(finishes)),
        element(doc, 'td', undefined, starts > 0 ? `${Math.round(percent(finishes, starts))}%` : '—'),
    );
    return row;
}

function renderModes(doc, days) {
    const today = days[days.length - 1] ?? {};
    const modes = Array.isArray(today.modes) ? today.modes : [];
    const nodes = [cardHeading(doc, 'Modes today')];
    if (modes.length === 0) {
        nodes.push(element(doc, 'p', 'analytics-note', 'No races today'));
        return nodes;
    }

    const table = element(doc, 'table', 'analytics-table');
    const head = element(doc, 'thead');
    const labels = element(doc, 'tr');
    for (const label of ['Mode', 'Players', 'Starts', 'Finishes', 'Completed']) {
        const cell = element(doc, 'th', undefined, label);
        cell.scope = 'col';
        labels.append(cell);
    }
    head.append(labels);

    const body = element(doc, 'tbody');
    for (const mode of modes) body.append(modeRow(doc, mode));
    table.append(head, body);

    const wrap = element(doc, 'div', 'analytics-table-wrap');
    wrap.append(table);
    nodes.push(wrap);
    if (toCount(today.challengeCreates) > 0) {
        const created = toCount(today.challengeCreates);
        nodes.push(element(doc, 'p', 'analytics-note', `${formatCount(created)} challenge${created === 1 ? '' : 's'} created today`));
    }
    const podiumPlays = toCount(today.podiumPlays);
    const podiumReplays = toCount(today.podiumReplays);
    if (podiumPlays > 0 || podiumReplays > 0) {
        nodes.push(element(
            doc,
            'p',
            'analytics-note',
            `${formatCount(podiumPlays)} Play Now · ${formatCount(podiumReplays)} View Replays on podium posts today`,
        ));
    }
    return nodes;
}

function cohortMetricText(metric) {
    if (metric?.retained === null || metric?.retained === undefined
        || metric?.rate === null || metric?.rate === undefined) return '—';
    return `${formatRate(metric.rate)} (${formatCount(metric.retained)})`;
}

function renderCohorts(doc, cohorts) {
    const nodes = [
        cardHeading(doc, 'Cohort retention'),
        element(doc, 'p', 'analytics-note', 'Exact UTC-day return · signed-in racers only'),
    ];
    if (cohorts.length === 0) {
        nodes.push(element(doc, 'p', 'analytics-note', 'No cohorts recorded yet'));
        return nodes;
    }

    const table = element(doc, 'table', 'analytics-table analytics-table--cohorts');
    const head = element(doc, 'thead');
    const labels = element(doc, 'tr');
    const milestones = [
        ['D1', 'd1'], ['D2', 'd2'], ['D3', 'd3'], ['D7', 'd7'], ['D14', 'd14'], ['D30', 'd30'],
    ];
    for (const [label, milestone] of [
        ['Cohort', false], ['Started', false], ...milestones.map(([label]) => [label, true]),
    ]) {
        const cell = element(doc, 'th', milestone ? 'analytics-table__milestone' : undefined, label);
        cell.scope = 'col';
        labels.append(cell);
    }
    head.append(labels);

    const body = element(doc, 'tbody');
    const latest = cohorts[cohorts.length - 1]?.date;
    for (const cohort of [...cohorts].reverse()) {
        const row = element(doc, 'tr');
        if (cohort?.date && cohort.date === latest) row.className = 'analytics-table__latest';
        const date = element(doc, 'th', undefined, formatShortDate(cohort?.date) || 'Unknown');
        date.scope = 'row';
        date.title = typeof cohort?.date === 'string' ? cohort.date : '';
        row.append(
            date,
            element(doc, 'td', undefined, formatCount(cohort?.players)),
            ...milestones.map(([, key]) => (
                element(doc, 'td', 'analytics-table__milestone', cohortMetricText(cohort?.[key]))
            )),
        );
        body.append(row);
    }
    table.append(head, body);

    const wrap = element(doc, 'div', 'analytics-table-wrap');
    wrap.append(table);
    nodes.push(wrap);
    return nodes;
}

function renderMonths(doc, months) {
    const nodes = [cardHeading(doc, 'Players per month')];
    if (months.length === 0) {
        nodes.push(element(doc, 'p', 'analytics-note', 'No months recorded yet'));
        return nodes;
    }

    const table = element(doc, 'table', 'analytics-table');
    const head = element(doc, 'thead');
    const labels = element(doc, 'tr');
    for (const [label, grouped] of [
        ['Month', false], ['Players', false], ['New', false], ['Returning', false],
        ['Daily', true], ['Campaign', false], ['Challenge', false],
    ]) {
        const cell = element(doc, 'th', grouped ? 'analytics-table__divide' : undefined, label);
        cell.scope = 'col';
        labels.append(cell);
    }
    head.append(labels);

    const body = element(doc, 'tbody');
    const latest = months[months.length - 1]?.month;
    for (const month of [...months].reverse()) {
        const row = element(doc, 'tr');
        if (month?.month && month.month === latest) row.className = 'analytics-table__today';
        const name = element(doc, 'th', undefined, month?.month ?? 'Unknown');
        name.scope = 'row';
        row.append(name);
        const byMode = new Map(
            (Array.isArray(month?.modes) ? month.modes : []).map((mode) => [mode?.mode, mode?.players]),
        );
        const cells = [
            [month?.players, false],
            [month?.newPlayers, false],
            [month?.returningPlayers, false],
            [byMode.get('daily'), true],
            [byMode.get('campaign'), false],
            [byMode.get('challenge'), false],
        ];
        for (const [value, grouped] of cells) {
            row.append(element(doc, 'td', grouped ? 'analytics-table__divide' : undefined, formatCount(value)));
        }
        body.append(row);
    }
    table.append(head, body);

    const wrap = element(doc, 'div', 'analytics-table-wrap');
    wrap.append(table);
    nodes.push(wrap);
    return nodes;
}

// The one-time walk that lists races saved before the raced lists existed.
// The Daily archive must wait until it says done.
function racedListFillText(fill) {
    if (fill?.state === 'done') return 'Old races recorded: done';
    if (fill?.state === 'working') {
        return `Old races recorded: ${formatCount(fill.boardsDone)} of ${formatCount(fill.boards)} boards`;
    }
    if (fill?.state === 'waiting') return 'Old races recorded: not started';
    return null;
}

const COMPACTION_STEPS = [
    ['expired', 'Expired Daily days'],
    ['campaign', 'Campaign stages, least played first'],
];

function progressBar(doc, label, done, total) {
    const bar = element(doc, 'div', 'analytics-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', label);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(Math.min(done, total)));
    const fill = element(doc, 'div', 'analytics-progress__fill');
    fill.style.width = `${total > 0 ? percent(done, total) : 0}%`;
    bar.append(fill);
    return bar;
}

function compactionButton(state, name) {
    const step = state?.steps?.[name] ?? {};
    if (state?.running === name) return { label: 'Pause', action: 'pause', disabled: false };
    const label = step.finishedAt ? 'Run again' : step.startedAt ? 'Resume' : 'Start';
    const order = COMPACTION_STEPS.map(([key]) => key);
    const earlierOpen = order.slice(0, order.indexOf(name)).some((key) => !state?.steps?.[key]?.finishedAt);
    return { label, action: 'start', disabled: Boolean(state?.running) || earlierOpen };
}

// Rewrites stored ghosts in the compact form, a step at a time. Progress
// counts ghosts checked out of the ghosts in the step when it started.
export function renderGhostCompaction(root, { state = null, busy = false, error = null, onAction } = {}) {
    const section = root.getElementById('analytics-ghost-compaction');
    if (!section) return;
    const nodes = [cardHeading(root, 'Compact ghosts')];
    if (state) {
        nodes.push(element(root, 'p', 'analytics-note', state.writePacked
            ? 'New best times are saved compact.'
            : 'New best times are saved compact from the first Start.'));
        for (const [name, title] of COMPACTION_STEPS) {
            const step = state.steps?.[name] ?? {};
            const row = element(root, 'div', 'analytics-step');
            const head = element(root, 'div', 'analytics-step__head');
            head.append(element(root, 'p', 'analytics-step__title', title));
            const control = compactionButton(state, name);
            const button = element(root, 'button', 'analytics-button', control.label);
            button.type = 'button';
            button.disabled = busy || control.disabled;
            button.addEventListener('click', () => { void onAction?.(control.action, name); });
            head.append(button);
            const total = toCount(step.total);
            const checked = toCount(step.checked);
            const stage = state.running === name ? 'Running'
                : step.finishedAt ? `Done ${String(step.finishedAt).slice(0, 10)}`
                    : step.startedAt ? 'Paused' : 'Not started';
            row.append(
                head,
                progressBar(root, `${title}: ghosts checked`, checked, total),
                element(root, 'p', 'analytics-note',
                    `${stage} · ${formatCount(checked)} of ${formatCount(total)} ghosts checked`
                    + ` · ${formatCount(step.packed)} compacted · ${formatBytes(step.savedBytes)} saved`),
            );
            nodes.push(row);
        }
        if (state.lastError) {
            const failed = element(root, 'p', 'analytics-status', `Last error: ${String(state.lastError).slice(0, 200)}`);
            failed.dataset.state = 'error';
            nodes.push(failed);
        }
    }
    if (error) {
        const failed = element(root, 'p', 'analytics-status', error);
        failed.dataset.state = 'error';
        nodes.push(failed);
    }
    section.replaceChildren(...nodes);
    section.hidden = false;
    section.setAttribute('aria-busy', String(busy));
}

async function readCompactionResponse(response) {
    if (response.status === 403) return { error: 'Moderator access required.' };
    if (response.status === 409) {
        // The server says why: another step runs, or an earlier one is not finished.
        const body = await response.json().catch(() => null);
        return { error: typeof body?.error === 'string' && body.error ? body.error : 'Finish the step before this one first.' };
    }
    if (!response.ok) return { error: 'Could not load ghost compaction.' };
    return { state: await response.json() };
}

export function createGhostCompactionController(root, fetchImpl = fetch, { pollMs = GHOST_MOVE_POLL_MS } = {}) {
    let state = null;
    let busy = false;
    let error = null;
    let timer = null;
    const render = () => renderGhostCompaction(root, { state, busy, error, onAction: act });
    async function refresh() {
        try {
            const result = await readCompactionResponse(await fetchImpl(GHOST_COMPACTION_URL));
            if (result.error) error = result.error;
            else {
                state = result.state;
                error = null;
            }
        } catch (_error) {
            error = 'Could not load ghost compaction.';
        }
        render();
    }
    async function act(action, step) {
        if (busy) return;
        busy = true;
        render();
        try {
            const result = await readCompactionResponse(await fetchImpl(GHOST_COMPACTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, step }),
            }));
            if (result.error) error = result.error;
            else {
                state = result.state;
                error = null;
            }
        } catch (_error) {
            error = 'Could not change the step.';
        } finally {
            busy = false;
            render();
        }
    }
    function setActive(active) {
        if (active && timer === null) {
            void refresh();
            timer = setInterval(() => { void refresh(); }, pollMs);
        } else if (!active && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }
    return { refresh, act, setActive };
}

const DAILY_GHOST_CHOICES = [
    ['off', 'Off'],
    ['trial', 'Move one day'],
    ['all', 'Move all'],
    ['restore', 'Restore'],
];

// The move of old Daily ghosts to blob storage. Blob figures come from the
// last sweep of each day; Redis figures count payload, not Redis memory.
export function renderGhostMove(root, { status = null, busy = false, error = null, onChoose } = {}) {
    const section = root.getElementById('analytics-ghost-move');
    if (!section) return;
    const heading = cardHeading(root, 'Old Daily ghosts to blob storage');
    const choices = element(root, 'div', 'analytics-periods');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', 'Ghost move choice');
    for (const [value, label] of DAILY_GHOST_CHOICES) {
        const button = element(root, 'button', 'analytics-period', label);
        button.type = 'button';
        button.disabled = busy || !status;
        button.setAttribute('aria-pressed', String(status?.choice === value));
        button.addEventListener('click', () => { void onChoose?.(value); });
        choices.append(button);
    }
    heading.append(choices);
    const nodes = [heading];
    if (status) {
        const eligible = toCount(status.eligibleDays);
        const done = toCount(status.days?.done);
        const bar = progressBar(root, 'Finished Daily days moved', done, eligible);
        const blob = status.blob ?? {};
        const touched = Object.values(status.days ?? {}).reduce((sum, count) => sum + toCount(count), 0);
        const lines = [
            `${formatCount(done)} of ${formatCount(eligible)} finished days done · ${formatCount(status.waitingDays)} waiting`,
            `Moved ${formatCount(status.moved)} runs · Redis payload removed ${formatBytes(status.freed)}`
                + (toCount(status.restored) > 0 ? ` · restored ${formatCount(status.restored)}` : ''),
            `Held ${formatCount(status.held)} runs · blob ${formatBytes(blob.bytes)} in ${formatCount(blob.objects)} objects`
                + ` (measured on ${formatCount(blob.measuredDays)} of ${formatCount(touched)} days)`,
        ];
        nodes.push(bar, ...lines.map((text) => element(root, 'p', 'analytics-note', text)));
        if (status.blobError?.message) {
            const refused = element(root, 'p', 'analytics-status', `Blob storage refused: ${String(status.blobError.message).slice(0, 200)}`);
            refused.dataset.state = 'error';
            nodes.push(refused);
        }
    }
    if (error) {
        const failed = element(root, 'p', 'analytics-status', error);
        failed.dataset.state = 'error';
        nodes.push(failed);
    }
    section.replaceChildren(...nodes);
    section.hidden = false;
    section.setAttribute('aria-busy', String(busy));
}

async function readGhostMoveResponse(response) {
    if (response.status === 403) return { error: 'Moderator access required.' };
    if (!response.ok) return { error: 'Could not load the ghost move.' };
    return { status: await response.json() };
}

export function createGhostMoveController(root, fetchImpl = fetch, { pollMs = GHOST_MOVE_POLL_MS } = {}) {
    let status = null;
    let busy = false;
    let error = null;
    let timer = null;
    const render = () => renderGhostMove(root, { status, busy, error, onChoose: choose });
    async function refresh() {
        try {
            const result = await readGhostMoveResponse(await fetchImpl(GHOST_MOVE_URL));
            if (result.error) error = result.error;
            else {
                status = result.status;
                error = null;
            }
        } catch (_error) {
            error = 'Could not load the ghost move.';
        }
        render();
    }
    async function choose(choice) {
        if (busy) return;
        busy = true;
        render();
        try {
            const result = await readGhostMoveResponse(await fetchImpl(GHOST_MOVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ choice }),
            }));
            if (result.error) error = result.error;
            else {
                status = result.status;
                error = null;
            }
        } catch (_error) {
            error = 'Could not save the choice.';
        } finally {
            busy = false;
            render();
        }
    }
    // The tab repeats the read every few seconds while it is open.
    function setActive(active) {
        if (active && timer === null) {
            void refresh();
            timer = setInterval(() => { void refresh(); }, pollMs);
        } else if (!active && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }
    return { refresh, choose, setActive };
}

function renderStorage(doc, storage, racedListFill = null) {
    const fillText = racedListFillText(racedListFill);
    const fillNode = fillText ? [element(doc, 'p', 'analytics-note', fillText)] : [];
    if (!storage || typeof storage !== 'object') {
        return [
            cardHeading(doc, 'Redis'),
            element(doc, 'p', 'analytics-note', 'Unavailable'),
            ...fillNode,
        ];
    }

    const groups = Array.isArray(storage.groups) ? storage.groups : [];
    const nodes = [cardHeading(doc, 'Redis')];
    nodes.push(element(doc, 'p', 'analytics-storage-total analytics-count', formatBytes(storage.totalBytes)));
    nodes.push(...fillNode);

    if (groups.length === 0) {
        nodes.push(element(doc, 'p', 'analytics-note', 'No named keys held data.'));
    } else {
        const table = element(doc, 'table', 'analytics-table');
        const head = element(doc, 'thead');
        const labels = element(doc, 'tr');
        for (const label of ['Family', 'Size', 'Keys', 'Rows']) {
            const cell = element(doc, 'th', undefined, label);
            cell.scope = 'col';
            labels.append(cell);
        }
        head.append(labels);

        const body = element(doc, 'tbody');
        for (const group of groups) {
            const row = element(doc, 'tr');
            const name = element(doc, 'th', undefined, group?.label || 'Unknown');
            name.scope = 'row';
            if (group?.detail) name.title = String(group.detail);
            const size = formatBytes(group?.bytes);
            row.append(
                name,
                element(doc, 'td', undefined, group?.estimated ? `~${size}` : size),
                element(doc, 'td', undefined, formatCount(group?.keys)),
                element(doc, 'td', undefined, formatCount(group?.rows)),
            );
            body.append(row);
        }
        table.append(head, body);
        const wrap = element(doc, 'div', 'analytics-table-wrap');
        wrap.append(table);
        nodes.push(wrap);
    }

    return nodes;
}

function renderDailyTable(doc, days) {
    const table = element(doc, 'table', 'analytics-table analytics-table--sticky');
    const head = element(doc, 'thead');
    const groups = element(doc, 'tr', 'analytics-table__groups');
    for (const [label, span, grouped] of [
        ['', 1, false], ['Players', 4, false], ['Races started', 3, true], ['Podium', 2, true],
    ]) {
        const cell = element(doc, 'th', grouped ? 'analytics-table__divide' : undefined, label);
        cell.colSpan = span;
        cell.scope = 'colgroup';
        groups.append(cell);
    }
    const labels = element(doc, 'tr');
    for (const [label, grouped] of [
        ['Date', false], ['Players', false], ['New', false], ['Returning', false], ['Signed out', false],
        ['Daily', true], ['Campaign', false], ['Challenge', false],
        ['Play Now', true], ['Replays', false],
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
        const byMode = new Map(
            (Array.isArray(day?.modes) ? day.modes : []).map((mode) => [mode?.mode, mode?.starts]),
        );
        const cells = [
            [day?.players, false],
            [day?.newPlayers, false],
            [day?.returningPlayers, false],
            [day?.guestPlayers, false],
            [byMode.get('daily'), true],
            [byMode.get('campaign'), false],
            [byMode.get('challenge'), false],
            [day?.podiumPlays, true],
            [day?.podiumReplays, false],
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

function challengeDate(value) {
    if (typeof value !== 'string' || !value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const isoDate = date.toISOString().slice(0, 10);
    return { isoDate, label: `${formatShortDate(isoDate)}, ${isoDate.slice(0, 4)}` };
}

function challengeTrackRow(doc, item, period) {
    const row = element(doc, 'tr');
    const track = element(doc, 'th', 'analytics-challenge-track', item?.trackName || item?.trackKey || 'Unknown track');
    track.scope = 'row';
    const tracked = challengeDate(item?.trackingStartedAt);
    track.title = tracked ? `Tracking since ${tracked.label}` : 'No events recorded yet';
    const counts = item?.[period] ?? {};
    const clicks = element(doc, 'td', undefined, formatCount(counts.clicks));
    clicks.title = `${formatCount(counts.acceptClicks)} Accept Challenge · ${formatCount(counts.ownOpens)} Open Mini Racer`;
    row.append(
        track,
        element(doc, 'td', undefined, formatCount(counts.views)),
        element(doc, 'td', undefined, formatCount(counts.uniqueViewers)),
        clicks,
    );
    return row;
}

export function renderChallengeAnalytics(root, {
    items = [], date = null, period = 'today', loading = false, loaded = false,
    error = null, nextOffset = null, onLoadMore, onRefresh, onPeriodChange,
} = {}) {
    const section = root.getElementById('analytics-challenges');
    if (!section) return;
    const selectedPeriod = period === 'lifetime' ? 'lifetime' : 'today';
    const heading = cardHeading(root, 'Challenges by track');
    const periods = element(root, 'div', 'analytics-periods');
    periods.setAttribute('role', 'group');
    periods.setAttribute('aria-label', 'Challenge count period');
    for (const [key, label] of [['today', 'Today'], ['lifetime', 'Lifetime']]) {
        const button = element(root, 'button', 'analytics-period', label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(key === selectedPeriod));
        button.addEventListener('click', () => onPeriodChange?.(key));
        periods.append(button);
    }
    heading.append(periods);
    const nodes = [
        heading,
        element(root, 'p', 'analytics-note analytics-challenges__note', selectedPeriod === 'today'
            ? `${date ? `Today · ${date} UTC` : 'Today · UTC'} · most viewed first`
            : 'Lifetime · includes today · most viewed first'),
    ];
    if (items.length > 0) {
        const table = element(root, 'table', 'analytics-table analytics-table--challenges');
        const head = element(root, 'thead');
        const labels = element(root, 'tr');
        for (const [label, hint] of [
            ['Track', 'Activity across all issued challenges for each track'],
            ['Views', 'Poster views, including repeat visits'],
            ['Unique viewers', 'Known viewer identities across this track and period; signed-out identities are approximate and unidentified views are excluded'],
            ['Clicks', 'Accept Challenge and Open Mini Racer taps, including repeats'],
        ]) {
            const cell = element(root, 'th', undefined, label);
            cell.scope = 'col';
            cell.title = hint;
            labels.append(cell);
        }
        head.append(labels);
        const body = element(root, 'tbody');
        for (const item of items) body.append(challengeTrackRow(root, item, selectedPeriod));
        table.append(head, body);
        const wrap = element(root, 'div', 'analytics-table-wrap');
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', 'Challenge counts by track');
        wrap.append(table);
        nodes.push(wrap);
    } else if (loaded && !error && !loading) {
        nodes.push(element(root, 'p', 'analytics-note', 'No challenge activity yet'));
    }

    const actions = element(root, 'div', 'analytics-challenges__actions');
    const status = element(root, 'p', 'analytics-status');
    status.setAttribute('role', 'status');
    if (loading) status.textContent = 'Loading challenges…';
    if (error) {
        status.textContent = error;
        status.dataset.state = 'error';
    }
    actions.append(status);
    if (loaded) {
        const refresh = element(root, 'button', 'analytics-button', 'Refresh');
        refresh.type = 'button';
        refresh.disabled = loading;
        refresh.addEventListener('click', () => { void onRefresh?.(); });
        actions.append(refresh);
    }
    if (error || nextOffset !== null) {
        const button = element(root, 'button', 'analytics-button', error ? 'Retry' : 'Load more');
        button.type = 'button';
        button.disabled = loading;
        button.addEventListener('click', () => { void onLoadMore?.(); });
        actions.append(button);
    }
    nodes.push(actions);
    section.replaceChildren(...nodes);
    section.hidden = false;
    section.setAttribute('aria-busy', String(loading));
}

export async function loadChallengeAnalyticsPage(fetchImpl = fetch, offset = 0, period = 'today') {
    const response = await fetchImpl(`${CHALLENGES_URL}?offset=${offset}&period=${period === 'lifetime' ? 'lifetime' : 'today'}`);
    if (response.status === 403) return { error: 'Moderator access required.' };
    if (response.status === 400) return { error: 'Challenge counts need a subreddit context.' };
    if (!response.ok) return { error: 'Could not load challenge counts.' };
    const page = await response.json();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(page?.date ?? '') || !Array.isArray(page?.items)
        || (page.nextOffset != null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) {
        return { error: 'Could not load challenge counts.' };
    }
    return { date: page.date, items: page.items, nextOffset: page.nextOffset ?? null };
}

export function createChallengeAnalyticsController(root, fetchImpl = fetch) {
    let items = [];
    let date = null;
    let period = 'today';
    let nextOffset = null;
    let loaded = false;
    let loading = false;
    let error = null;
    let pending = null;
    let retryReset = false;
    const render = () => renderChallengeAnalytics(root, {
        items, date, period, nextOffset, loaded, loading, error,
        onLoadMore: loadMore, onRefresh: refresh,
        // The server sorts by the chosen period, so a new period reloads the list.
        onPeriodChange: (value) => {
            if (value === period) return;
            period = value;
            render();
            void Promise.resolve(pending).then(() => request(true));
        },
    });
    function request(reset) {
        if (loading) return pending;
        if (!reset && loaded && nextOffset === null && !error) return Promise.resolve();
        const offset = reset || !loaded ? 0 : nextOffset;
        loading = true;
        error = null;
        render();
        const requestedPeriod = period;
        pending = (async () => {
            try {
                let page = await loadChallengeAnalyticsPage(fetchImpl, offset, requestedPeriod);
                // Pages on a new UTC day cannot append to the previous day's rows.
                if (!page.error && offset > 0 && page.date !== date) {
                    reset = true;
                    page = await loadChallengeAnalyticsPage(fetchImpl, 0, requestedPeriod);
                }
                // A period chosen during the request is loaded by the next one.
                if (requestedPeriod !== period) return;
                if (page.error) {
                    error = page.error;
                    retryReset = reset;
                    return;
                }
                const previous = reset || offset === 0 ? [] : items;
                const seen = new Set(previous.map((item) => item?.trackKey));
                const fresh = page.items.filter((item) => {
                    if (item?.trackKey && seen.has(item.trackKey)) return false;
                    if (item?.trackKey) seen.add(item.trackKey);
                    return true;
                });
                items = [...previous, ...fresh];
                date = page.date;
                nextOffset = page.nextOffset;
                loaded = true;
                retryReset = false;
            } catch (_error) {
                error = 'Could not load challenge counts.';
                retryReset = reset;
            } finally {
                loading = false;
                pending = null;
                render();
            }
        })();
        return pending;
    }
    function loadMore() { return request(error ? retryReset : false); }
    function refresh() { return request(true); }
    return { loadMore, refresh };
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
    const modesNode = root.getElementById('analytics-modes');
    const cohortsNode = root.getElementById('analytics-cohorts');
    const monthsNode = root.getElementById('analytics-months');
    const daysNode = root.getElementById('analytics-days');
    const stored = Array.isArray(summary?.days) ? summary.days : [];
    const months = Array.isArray(summary?.months) ? summary.months : [];
    const cohorts = Array.isArray(summary?.cohorts) ? summary.cohorts : [];
    const chartDays = stored.slice(-ANALYTICS_CHART_DAYS);
    const days = stored.length > 0
        ? stored
        : [summary?.today && typeof summary.today === 'object' ? summary.today : {}];

    setText(range, summary?.from && summary?.to ? `${summary.from} to ${summary.to}` : 'Last 45 days');
    setText(status, '');
    status?.removeAttribute('data-state');

    windows.replaceChildren(...renderHeadline(root, days));

    const trendTitle = stored.length > ANALYTICS_CHART_DAYS
        ? `Players per day · last ${ANALYTICS_CHART_DAYS} days`
        : 'Players per day';
    const trendHead = cardHeading(root, trendTitle);
    if (chartDays.length < 2) {
        const empty = element(root, 'p', 'analytics-chart-empty', 'Not enough days recorded yet');
        trendNode.replaceChildren(trendHead, empty);
    } else {
        trendHead.append(chartLegend(root));
        trendNode.replaceChildren(trendHead, renderPlayersChart(root, chartDays));
    }

    modesNode.replaceChildren(...renderModes(root, days));
    cohortsNode?.replaceChildren(...renderCohorts(root, cohorts));
    monthsNode.replaceChildren(...renderMonths(root, months));

    const dayHead = cardHeading(root, 'Daily breakdown');
    if (stored.length === 0) {
        daysNode.replaceChildren(dayHead, element(root, 'p', 'analytics-note', 'No stored days yet'));
    } else {
        daysNode.replaceChildren(dayHead, renderDailyTable(root, stored));
    }

    revealSections(root);
}

// The Players sections, and the other tabs' cards, which an access error
// must clear too.
const LOCKED_SECTION_IDS = [
    ...SECTION_IDS,
    'analytics-challenges',
    'analytics-storage',
    'analytics-ghost-compaction',
    'analytics-ghost-move',
];

export function renderAnalyticsMessage(root, message, state = 'error') {
    const status = root.getElementById('analytics-status');
    setText(status, message);
    if (state) status?.setAttribute('data-state', state);
    for (const id of LOCKED_SECTION_IDS) {
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

export function renderStorageSummary(root, payload) {
    const section = root.getElementById('analytics-storage');
    if (!section) return;
    section.replaceChildren(...renderStorage(root, payload?.storage, payload?.racedListFill));
    section.hidden = false;
}

export async function loadStorageSummary(fetchImpl = fetch) {
    const response = await fetchImpl(STORAGE_URL);
    if (response.status === 403) return { error: 'Moderator access required.' };
    if (response.status === 400) return { error: 'Storage needs a subreddit context.' };
    if (!response.ok) return { error: 'Could not load storage.' };
    return { payload: await response.json() };
}

export function createStorageTabController(root, fetchImpl = fetch) {
    const status = root.getElementById('analytics-storage-status');
    async function load() {
        setText(status, 'Loading storage…');
        status?.removeAttribute('data-state');
        try {
            const result = await loadStorageSummary(fetchImpl);
            if (result.error) {
                setText(status, result.error);
                status?.setAttribute('data-state', 'error');
                return;
            }
            setText(status, '');
            renderStorageSummary(root, result.payload);
        } catch (_error) {
            setText(status, 'Could not load storage.');
            status?.setAttribute('data-state', 'error');
        }
    }
    return { load };
}

function rememberedTab() {
    try {
        const saved = globalThis.localStorage?.getItem(TAB_MEMORY_KEY);
        return TABS.includes(saved) ? saved : 'players';
    } catch (_error) {
        return 'players';
    }
}

// Three tabs. Each tab's data loads the first time the tab opens, so the
// Players tab does not wait for the Redis size walk.
export function setupAnalyticsTabs(root, { onOpen } = {}) {
    const tabs = TABS.map((name) => root.getElementById(`analytics-tab-${name}`));
    function select(name, { focus = false } = {}) {
        if (!TABS.includes(name)) return;
        TABS.forEach((tabName, index) => {
            const tab = tabs[index];
            if (!tab) return;
            const selected = tabName === name;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            const panel = root.getElementById(tab.getAttribute('aria-controls'));
            if (panel) panel.hidden = !selected;
            if (selected && focus) tab.focus();
        });
        try {
            globalThis.localStorage?.setItem(TAB_MEMORY_KEY, name);
        } catch (_error) {
        }
        onOpen?.(name);
    }
    tabs.forEach((tab, index) => {
        tab?.addEventListener('click', () => select(TABS[index]));
        tab?.addEventListener('keydown', (event) => {
            const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: TABS.length - 1 - index };
            if (!(event.key in moves)) return;
            event.preventDefault();
            select(TABS[(index + moves[event.key] + TABS.length) % TABS.length], { focus: true });
        });
    });
    return { select };
}

export async function bootAnalytics(root = document, fetchImpl = fetch) {
    const challenges = createChallengeAnalyticsController(root, fetchImpl);
    const storage = createStorageTabController(root, fetchImpl);
    const ghostMove = createGhostMoveController(root, fetchImpl);
    const compaction = createGhostCompactionController(root, fetchImpl);
    const opened = new Set();
    const tabs = setupAnalyticsTabs(root, {
        onOpen: (name) => {
            compaction.setActive(name === 'storage');
            ghostMove.setActive(name === 'storage');
            if (opened.has(name)) return;
            opened.add(name);
            if (name === 'challenges') void challenges.loadMore();
            if (name === 'storage') void storage.load();
        },
    });
    tabs.select(rememberedTab());
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
    void bootAnalytics();
}
