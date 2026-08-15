const SUMMARY_URL = '/api/analytics/summary';

function setText(node, value) {
    if (node) node.textContent = value;
}

function formatCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? String(Math.max(0, Math.trunc(count))) : '0';
}

export function createMetric(doc, label, value, extraClass = '') {
    const metric = doc.createElement('div');
    metric.className = extraClass ? `analytics-metric ${extraClass}` : 'analytics-metric';
    const labelNode = doc.createElement('p');
    labelNode.className = 'analytics-metric__label';
    labelNode.textContent = label;
    const valueNode = doc.createElement('p');
    valueNode.className = 'analytics-metric__value';
    valueNode.textContent = formatCount(value);
    metric.append(labelNode, valueNode);
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

export function renderTrackList(doc, title, tracks) {
    const list = doc.createElement('div');
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
    for (const track of tracks) {
        const name = typeof track?.trackName === 'string' && track.trackName.trim()
            ? track.trackName.trim()
            : 'Unknown track';
        list.append(createCountRow(doc, name, track?.count, 'analytics-track-row'));
    }
    return list;
}

export function renderAnalyticsSummary(root, summary) {
    const status = root.getElementById('analytics-status');
    const range = root.getElementById('analytics-range');
    const windows = root.getElementById('analytics-windows');
    const todayNode = root.getElementById('analytics-today');
    const tracksNode = root.getElementById('analytics-tracks');
    const daysNode = root.getElementById('analytics-days');
    const today = summary?.today && typeof summary.today === 'object' ? summary.today : {};
    const windowRows = Array.isArray(summary?.windows) ? summary.windows : [];

    setText(range, summary?.from && summary?.to ? `${summary.from} to ${summary.to}` : 'Last 45 days');
    setText(status, '');
    status?.removeAttribute('data-state');

    windows.replaceChildren(
        createMetric(root, 'Today unique', today.uniquePlayers, 'analytics-metric--today'),
        ...windowRows.map((windowRow) => (
            createMetric(
                root,
                `${formatCount(windowRow?.days)}-day unique`,
                windowRow?.uniquePlayers,
            )
        )),
    );
    windows.hidden = false;

    const todayGrid = root.createElement('div');
    todayGrid.className = 'analytics-today-grid';
    const people = root.createElement('div');
    const peopleTitle = root.createElement('h2');
    peopleTitle.className = 'analytics-section-title';
    peopleTitle.textContent = 'Today';
    people.append(
        peopleTitle,
        createCountRow(root, 'New', today.newPlayers, 'analytics-stat-row'),
        createCountRow(root, 'Returning', today.returningPlayers, 'analytics-stat-row'),
    );
    const plays = root.createElement('div');
    const playsTitle = root.createElement('h2');
    playsTitle.className = 'analytics-section-title';
    playsTitle.textContent = 'Plays today';
    plays.append(
        playsTitle,
        createCountRow(root, 'Daily finishes', today.dailyFinishes, 'analytics-stat-row'),
        createCountRow(root, 'Campaign starts', today.campaignStarts, 'analytics-stat-row'),
        createCountRow(root, 'Challenges created', today.challengeCreates, 'analytics-stat-row'),
        createCountRow(root, 'Challenges finished', today.challengeFinishes, 'analytics-stat-row'),
    );
    todayGrid.append(people, plays);
    todayNode.replaceChildren(todayGrid);
    todayNode.hidden = false;

    const trackLists = root.createElement('div');
    trackLists.className = 'analytics-track-lists';
    trackLists.append(
        renderTrackList(root, 'Daily tracks', summary?.tracks?.daily),
        renderTrackList(root, 'Campaign tracks', summary?.tracks?.campaign),
        renderTrackList(root, 'Challenge tracks', summary?.tracks?.challenge),
    );
    tracksNode.replaceChildren(trackLists);
    tracksNode.hidden = false;

    const dayHeading = root.createElement('h2');
    dayHeading.className = 'analytics-section-title';
    dayHeading.textContent = 'Each day';
    const dayRows = root.createElement('div');
    const sourceDays = Array.isArray(summary?.days) ? [...summary.days].reverse() : [];
    if (sourceDays.length === 0) {
        const empty = root.createElement('p');
        empty.className = 'analytics-note';
        empty.textContent = 'No stored days yet';
        daysNode.replaceChildren(dayHeading, empty);
        daysNode.hidden = false;
        return;
    }
    for (const day of sourceDays) {
        const row = root.createElement('div');
        row.className = 'analytics-day-row';
        const date = root.createElement('span');
        date.className = 'analytics-day-row__date';
        date.textContent = typeof day?.date === 'string' ? day.date : 'Unknown';
        const counts = root.createElement('span');
        counts.className = 'analytics-day-row__counts';
        counts.textContent = [
            `${formatCount(day?.uniquePlayers)} unique`,
            `${formatCount(day?.newPlayers)} new`,
            `${formatCount(day?.returningPlayers)} returning`,
        ].join(' · ');
        row.append(date, counts);
        dayRows.append(row);
    }
    daysNode.replaceChildren(dayHeading, dayRows);
    daysNode.hidden = false;
}

export function renderAnalyticsMessage(root, message, state = 'error') {
    const status = root.getElementById('analytics-status');
    setText(status, message);
    if (state) status?.setAttribute('data-state', state);
    for (const id of ['analytics-windows', 'analytics-today', 'analytics-tracks', 'analytics-days']) {
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
