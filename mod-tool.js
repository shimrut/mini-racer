import { requestExpandedMode } from '@devvit/web/client';
import Chart from 'chart.js/auto';
import flatpickr from 'flatpickr';
import 'flatpickr/dist/flatpickr.min.css';

const QUICK_PRESETS = ['last24h', 'last7d', 'last14d', 'last30d', 'thisMonth'];

const state = {
    activePreset: 'last7d',
};

let periodChartInstance = null;
let datePicker = null;


document.addEventListener('DOMContentLoaded', () => {
    initializeControls();
    void loadPreset(state.activePreset);
});

function initializeControls() {
    const today = getUtcIsoDate();
    const lastWeekStart = addUtcDays(today, -6);

    const dateRangeInput = document.getElementById('date-range');
    if (dateRangeInput) {
        datePicker = flatpickr(dateRangeInput, {
            mode: "range",
            dateFormat: "Y-m-d",
            defaultDate: [lastWeekStart, today]
        });
    }

    for (const button of document.querySelectorAll('[data-preset]')) {
        button.addEventListener('click', () => {
            const preset = button.getAttribute('data-preset');
            if (preset && QUICK_PRESETS.includes(preset)) {
                void loadPreset(preset);
            }
        });
    }

    document.getElementById('range-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        state.activePreset = '';
        syncActivePresetUi();
        void loadCustomRange();
    });

    const fullscreenBtn = document.getElementById('open-fullscreen-btn');
    if (fullscreenBtn) {
        if (window.innerHeight > 650 || new URLSearchParams(window.location.search).get('expanded') === 'true') {
            fullscreenBtn.style.display = 'none';
        }
        
        fullscreenBtn.addEventListener('click', async (event) => {
            try {
                await requestExpandedMode(event, 'mod-analytics');
                event.target.style.display = 'none';
            } catch (_error) {
                setStatus('Fullscreen mode is not available in this client.', true);
            }
        });
    }
}

async function loadPreset(preset) {
    state.activePreset = preset;
    syncActivePresetUi();

    if (preset === 'last24h') {
        await fetchAndRender({ query: 'range=last24h' });
        return;
    }

    const today = getUtcIsoDate();
    let from;

    if (preset === 'thisMonth') {
        const d = new Date();
        from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    } else {
        const days = preset === 'last30d' ? 29 : preset === 'last14d' ? 13 : 6;
        from = addUtcDays(today, -days);
    }

    if (datePicker) {
        datePicker.setDate([from, today]);
    }

    await fetchAndRender({
        query: `from=${encodeURIComponent(from)}&to=${encodeURIComponent(today)}`,
    });
}

async function loadCustomRange() {
    const selectedDates = datePicker ? datePicker.selectedDates : [];
    
    if (selectedDates.length === 0) {
        setStatus('Choose a date or date range before applying.', true);
        return;
    }

    const from = selectedDates[0].toISOString().slice(0, 10);
    const to = selectedDates[1] ? selectedDates[1].toISOString().slice(0, 10) : from;



    await fetchAndRender({
        query: `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
}

async function fetchAndRender({ query }) {
    setStatus('Loading analytics...', false);

    try {
        const response = await fetch(`/api/analytics/summary?${query}`);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(typeof payload?.error === 'string' ? payload.error : `Analytics request failed with ${response.status}`);
        }

        renderSummary(payload);
        const bucketLabel = payload.granularity === 'hour' ? 'hour' : 'day';
        setStatus(`Loaded ${payload.days?.length || 0} ${bucketLabel} bucket(s) from Devvit.`, false);
    } catch (error) {
        renderErrorState();
        setStatus(error instanceof Error ? error.message : 'Analytics failed to load.', true);
    }
}

function renderSummary(data) {
    const days = Array.isArray(data?.days) ? data.days : [];
    const totals = data?.totals || sumDays(days);
    const avgPlaytimeMs = totals.sessions ? totals.totalPlaytimeMs / totals.sessions : 0;
    const rangeLabel = formatRangeLabel(data);
    const granularity = data?.granularity === 'hour' ? 'hour' : 'day';

    setText('date-range-pill', rangeLabel);
    setText('metric-active-players', formatInt(totals.activePlayers));
    setText('metric-sessions', formatInt(totals.sessions));
    setText('metric-playtime', formatDuration(totals.totalPlaytimeMs));
    setText('metric-race-starts', formatInt(totals.raceStarts.total));
    setText('metric-finish-runs', formatInt(totals.raceEnds.finish));
    setText('metric-crash-runs', formatInt(totals.raceEnds.crash));
    setText('players-detail', `${formatInt(totals.activePlayers)} unique players`);
    setText('sessions-detail', `${formatInt(totals.gameOpened)} opens`);
    setText('playtime-detail', `${formatDuration(avgPlaytimeMs)} per session`);
    setText('starts-detail', `${formatDecimal(totals.activePlayers ? totals.raceStarts.total / totals.activePlayers : 0)} per player`);
    setText('finish-detail', `${formatInt(totals.raceEnds.finish)} finish exits`);
    setText('crash-detail', `${formatInt(totals.raceEnds.crash)} crash exits`);
    setText('trend-total', `${formatInt(totals.raceStarts.total)} starts`);

    renderTrend(days, granularity);
    renderBreakdown('source-breakdown', [
        { label: 'Main menu', value: totals.raceStarts.mainMenu },
        { label: 'Track modal', value: totals.raceStarts.trackModal },
        { label: 'Leaderboard modal', value: totals.raceStarts.leaderboardModal },
        { label: 'Unknown', value: totals.raceStarts.unknown },
    ]);
    renderBreakdown('restart-breakdown', [
        { label: 'Auto after collision', value: totals.restarts.autoCrash },
        { label: 'Manual after crash', value: totals.restarts.manualCrash },
        { label: 'Improve after win', value: totals.restarts.improveWin },
        { label: 'Unknown', value: totals.restarts.unknown },
    ]);
    renderBreakdown('platform-breakdown', [
        ...buildTopBreakdownRows(totals.context?.platforms, prettifyPlatformKey, 4),
        ...buildTopBreakdownRows(totals.context?.clientVersions, (value) => `Version ${prettifyClientVersionKey(value)}`, 3),
    ]);
    renderBreakdown('screen-breakdown', [
        ...buildTopBreakdownRows(totals.context?.screenBuckets, prettifyScreenBucketKey, 4),
        ...buildTopBreakdownRows(totals.context?.orientations, prettifyOrientationKey, 2),
    ]);
    renderBreakdown('language-breakdown', buildTopBreakdownRows(totals.context?.languages, prettifyLanguageKey, 6));
    renderBreakdown('timezone-breakdown', buildTopBreakdownRows(totals.context?.timezones, prettifyTimezoneKey, 6));
    renderTrackRows(totals.tracks || {});
    renderPeriodChart(days, granularity);
}

function renderErrorState() {
    setText('date-range-pill', 'No data');
    setText('metric-active-players', '--');
    setText('metric-sessions', '--');
    setText('metric-playtime', '--');
    setText('metric-race-starts', '--');
    setText('metric-finish-runs', '--');
    setText('metric-crash-runs', '--');
    setText('players-detail', 'Unique players');
    setText('sessions-detail', 'Game opens');
    setText('playtime-detail', 'Across all sessions');
    setText('starts-detail', 'Attempts started');
    setText('finish-detail', 'Successful exits');
    setText('crash-detail', 'Crash exits');
    setText('trend-total', '0 starts');
    setText('track-count-pill', '0 tracks');

    renderTrend([], 'day');
    renderBreakdown('source-breakdown', []);
    renderBreakdown('restart-breakdown', []);
    renderBreakdown('platform-breakdown', []);
    renderBreakdown('screen-breakdown', []);
    renderBreakdown('language-breakdown', []);
    renderBreakdown('timezone-breakdown', []);
    renderTrackRows({});
    renderPeriodChart([], 'day');
}

function renderTrend(days, granularity) {
    const container = document.getElementById('daily-trend');
    if (!container) return;
    container.replaceChildren();

    if (!days.length) {
        const empty = document.createElement('p');
        empty.className = 'trend-chart__empty';
        empty.textContent = 'No trend data loaded.';
        container.appendChild(empty);
        return;
    }

    const sortedDays = [...days].sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
    const maxStarts = Math.max(...sortedDays.map((day) => toNumber(day.raceStarts?.total)), 1);

    for (const day of sortedDays) {
        const starts = toNumber(day.raceStarts?.total);
        const crashes = toNumber(day.raceEnds?.crash);
        const finishes = toNumber(day.raceEnds?.finish);
        const height = starts ? Math.max(12, Math.round((starts / maxStarts) * 214)) : 0;

        const column = document.createElement('div');
        column.className = 'trend-column';
        column.title = `${formatBucketDate(day.date, granularity)}: ${formatInt(starts)} starts, ${formatInt(crashes)} crashes, ${formatInt(finishes)} finishes`;

        const barWrap = document.createElement('div');
        barWrap.className = 'trend-column__bar';

        const bar = document.createElement('div');
        bar.className = 'trend-column__fill';
        bar.style.height = `${height}px`;
        barWrap.appendChild(bar);

        const meta = document.createElement('div');
        meta.className = 'trend-column__meta';

        const total = document.createElement('strong');
        total.className = 'trend-column__value';
        total.textContent = formatInt(starts);

        const label = document.createElement('span');
        label.className = 'trend-column__label';
        label.textContent = formatAxisLabel(day.date, granularity);

        const detail = document.createElement('span');
        detail.className = 'trend-column__detail';
        detail.textContent = `${formatInt(crashes)}C / ${formatInt(finishes)}F`;

        meta.append(total, label, detail);
        column.append(barWrap, meta);
        container.appendChild(column);
    }
}

function renderBreakdown(id, rows) {
    const container = document.getElementById(id);
    if (!container) return;
    container.replaceChildren();

    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'breakdown-list__empty';
        empty.textContent = 'No analytics found for this range.';
        container.appendChild(empty);
        return;
    }

    const max = Math.max(...rows.map((row) => toNumber(row.value)), 1);
    for (const row of rows) {
        const wrapper = document.createElement('div');
        wrapper.className = 'breakdown-row';

        const label = document.createElement('span');
        label.className = 'breakdown-row__label';
        label.textContent = row.label;

        const meter = document.createElement('span');
        meter.className = 'breakdown-row__meter';

        const fill = document.createElement('i');
        fill.className = 'breakdown-row__fill';
        fill.style.width = `${(toNumber(row.value) / max) * 100}%`;
        meter.appendChild(fill);

        const value = document.createElement('strong');
        value.className = 'breakdown-row__value';
        value.textContent = formatInt(row.value);

        wrapper.append(label, meter, value);
        container.appendChild(wrapper);
    }
}

function renderTrackRows(tracks) {
    const rows = Object.entries(tracks)
        .map(([trackKey, track]) => ({ trackKey, track }))
        .sort((a, b) => toNumber(b.track?.played) - toNumber(a.track?.played));

    setText('track-count-pill', `${rows.length} ${rows.length === 1 ? 'track' : 'tracks'}`);

    const body = document.getElementById('track-table-body');
    if (!body) return;
    body.replaceChildren();

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="table-empty">No track data loaded.</td></tr>';
        return;
    }

    for (const { trackKey, track } of rows) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${prettifyTrackKey(trackKey)}</td>
            <td>${formatInt(track?.played)}</td>
            <td>${formatInt(track?.raceEnds?.finish)}</td>
            <td>${formatInt(track?.raceEnds?.crash)}</td>
            <td>${formatInt(sumValues(track?.restarts))}</td>
        `;
        body.appendChild(row);
    }
}

function renderPeriodChart(days, granularity) {
    const ctx = document.getElementById('period-line-chart');
    if (!ctx) return;

    const sortedDays = [...days].sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));

    const labels = sortedDays.map(day => formatBucketDate(day.date, granularity));
    const playersData = sortedDays.map(day => toNumber(day.activePlayers));
    const sessionsData = sortedDays.map(day => toNumber(day.sessions));
    const startsData = sortedDays.map(day => toNumber(day.raceStarts?.total));
    const finishesData = sortedDays.map(day => toNumber(day.raceEnds?.finish));
    const crashesData = sortedDays.map(day => toNumber(day.raceEnds?.crash));

    const datasets = [
        {
            label: 'Players',
            data: playersData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4,
            borderWidth: 2
        },
        {
            label: 'Sessions',
            data: sessionsData,
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.1)',
            tension: 0.4,
            borderWidth: 2
        },
        {
            label: 'Starts',
            data: startsData,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            tension: 0.4,
            borderWidth: 2
        },
        {
            label: 'Finishes',
            data: finishesData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.4,
            borderWidth: 2
        },
        {
            label: 'Crashes',
            data: crashesData,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            tension: 0.4,
            borderWidth: 2
        }
    ];

    if (periodChartInstance) {
        periodChartInstance.data.labels = labels;
        periodChartInstance.data.datasets = datasets;
        periodChartInstance.update();
    } else {
        periodChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                        }
                    },
                    tooltip: {
                        usePointStyle: true,
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }
}

function sumDays(days) {
    const totals = {
        activePlayers: 0,
        sessions: 0,
        gameOpened: 0,
        totalPlaytimeMs: 0,
        raceStarts: {
            total: 0,
            mainMenu: 0,
            trackModal: 0,
            leaderboardModal: 0,
            unknown: 0,
        },
        raceEnds: {
            finish: 0,
            crash: 0,
        },
        restarts: {
            autoCrash: 0,
            manualCrash: 0,
            improveWin: 0,
            unknown: 0,
        },
        tracks: {},
        context: {
            platforms: {},
            clientVersions: {},
            screenBuckets: {},
            orientations: {},
            languages: {},
            timezones: {},
        },
    };

    for (const day of days) {
        totals.activePlayers += toNumber(day.activePlayers);
        totals.sessions += toNumber(day.sessions);
        totals.gameOpened += toNumber(day.gameOpened);
        totals.totalPlaytimeMs += toNumber(day.totalPlaytimeMs);
        totals.raceStarts.total += toNumber(day.raceStarts?.total);
        totals.raceStarts.mainMenu += toNumber(day.raceStarts?.mainMenu);
        totals.raceStarts.trackModal += toNumber(day.raceStarts?.trackModal);
        totals.raceStarts.leaderboardModal += toNumber(day.raceStarts?.leaderboardModal);
        totals.raceStarts.unknown += toNumber(day.raceStarts?.unknown);
        totals.raceEnds.finish += toNumber(day.raceEnds?.finish);
        totals.raceEnds.crash += toNumber(day.raceEnds?.crash);
        totals.restarts.autoCrash += toNumber(day.restarts?.autoCrash);
        totals.restarts.manualCrash += toNumber(day.restarts?.manualCrash);
        totals.restarts.improveWin += toNumber(day.restarts?.improveWin);
        totals.restarts.unknown += toNumber(day.restarts?.unknown);

        for (const [trackKey, track] of Object.entries(day.tracks || {})) {
            const current = totals.tracks[trackKey] || { played: 0, raceEnds: {}, restarts: {} };
            current.played += toNumber(track.played);
            current.raceEnds.finish = toNumber(current.raceEnds.finish) + toNumber(track.raceEnds?.finish);
            current.raceEnds.crash = toNumber(current.raceEnds.crash) + toNumber(track.raceEnds?.crash);
            current.restarts = mergeNumberMaps(current.restarts, track.restarts);
            totals.tracks[trackKey] = current;
        }

        const context = day.context || day.payloadContext || {};
        totals.context.platforms = mergeNumberMaps(totals.context.platforms, context.platforms);
        totals.context.clientVersions = mergeNumberMaps(totals.context.clientVersions, context.clientVersions);
        totals.context.screenBuckets = mergeNumberMaps(totals.context.screenBuckets, context.screenBuckets);
        totals.context.orientations = mergeNumberMaps(totals.context.orientations, context.orientations);
        totals.context.languages = mergeNumberMaps(totals.context.languages, context.languages);
        totals.context.timezones = mergeNumberMaps(totals.context.timezones, context.timezones);
    }

    return totals;
}

function mergeNumberMaps(target = {}, source = {}) {
    const next = { ...target };
    for (const [key, value] of Object.entries(source || {})) {
        next[key] = toNumber(next[key]) + toNumber(value);
    }
    return next;
}

function buildTopBreakdownRows(values, formatter = (value) => value, limit = 6) {
    return Object.entries(values || {})
        .sort((a, b) => toNumber(b[1]) - toNumber(a[1]) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, limit)
        .map(([key, value]) => ({ label: formatter(key), value: toNumber(value) }));
}

function setStatus(message, isError) {
    const status = document.getElementById('status-text');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', Boolean(isError));
}

function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
}

function syncActivePresetUi() {
    for (const button of document.querySelectorAll('[data-preset]')) {
        const preset = button.getAttribute('data-preset');
        button.classList.toggle('is-active', Boolean(preset) && preset === state.activePreset);
    }
}

function getUtcIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

function addUtcDays(dateString, deltaDays) {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return date.toISOString().slice(0, 10);
}

function toNumber(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function formatInt(value) {
    return Math.round(toNumber(value)).toLocaleString('en-US');
}

function formatDecimal(value) {
    const numericValue = toNumber(value);
    return numericValue.toLocaleString('en-US', {
        maximumFractionDigits: numericValue >= 10 ? 0 : 1,
    });
}

function formatDuration(totalMs) {
    const totalMinutes = Math.round(toNumber(totalMs) / 60000);
    if (totalMinutes <= 0) return '0m';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
}

function formatRangeLabel(data) {
    if (data?.label === 'last24h') {
        return 'Last 24 hours';
    }
    const from = parseUtcDate(data?.from);
    const to = parseUtcDate(data?.to);
    if (!from || !to) return 'No data';
    if (from.toISOString().slice(0, 10) === to.toISOString().slice(0, 10)) {
        return from.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        });
    }
    return `${from.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    })} to ${to.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    })}`;
}

function formatAxisLabel(value, granularity) {
    const date = parseUtcDate(value);
    if (!date) return '--';
    if (granularity === 'hour') {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'UTC',
        });
    }
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });
}

function formatBucketDate(value, granularity) {
    const date = parseUtcDate(value);
    if (!date) return String(value || '--');
    if (granularity === 'hour') {
        return `${date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        })}, ${date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'UTC',
        })} UTC`;
    }
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });
}

function parseUtcDate(value) {
    const label = String(value || '').trim();
    if (!label) return null;
    const match = label.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::?(\d{2}))?)?$/);
    if (!match) return null;
    const [, year, month, day, hour = '00', minute = '00'] = match;
    return new Date(Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
    ));
}

function sumValues(record) {
    if (!record || typeof record !== 'object') return 0;
    return Object.values(record).reduce((sum, value) => sum + toNumber(value), 0);
}

function prettifyTrackKey(trackKey) {
    return String(trackKey || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (match) => match.toUpperCase())
        .trim() || 'Unknown track';
}

function prettifyPlatformKey(value) {
    const key = String(value || '').toLowerCase();
    if (key === 'ios') return 'iOS';
    if (key === 'android') return 'Android';
    if (key === 'web') return 'Web';
    if (key === 'unknown') return 'Unknown';
    return key.toUpperCase();
}

function prettifyClientVersionKey(value) {
    return String(value || '').replace(/_/g, '.');
}

function prettifyScreenBucketKey(value) {
    const key = String(value || '').toLowerCase();
    if (key === 'xl') return 'XL screen';
    if (key === 'lg') return 'Large screen';
    if (key === 'md') return 'Medium screen';
    if (key === 'sm') return 'Small screen';
    if (key === 'xs') return 'Compact screen';
    return String(value || 'Unknown');
}

function prettifyOrientationKey(value) {
    const key = String(value || '').toLowerCase();
    if (key === 'portrait') return 'Portrait';
    if (key === 'landscape') return 'Landscape';
    return String(value || 'Unknown');
}

function prettifyLanguageKey(value) {
    return String(value || '')
        .split(/[-_]/)
        .filter(Boolean)
        .map((part, index) => (index === 0 ? part.toLowerCase() : part.toUpperCase()))
        .join('-') || 'Unknown';
}

function prettifyTimezoneKey(value) {
    return String(value || '')
        .split('/')
        .map((part) => part.replace(/_/g, ' '))
        .join(' / ') || 'Unknown';
}
