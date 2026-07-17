const PODIUM_SIZE = 3;
const EMPTY_NAME = 'No verified finish';
const EMPTY_TIME = '—';

export function readPodiumPostData(root = globalThis) {
    const postData = root?.devvit?.context?.postData;
    return postData && typeof postData === 'object' ? postData.podium : null;
}

export function normalizePodium(value) {
    const podium = value && typeof value === 'object' ? value : {};
    const sourcePositions = Array.isArray(podium.positions) ? podium.positions : [];
    const byRank = new Map();

    for (const position of sourcePositions) {
        if (!position || typeof position !== 'object') continue;
        const rank = Number(position.rank);
        if (!Number.isInteger(rank) || rank < 1 || rank > PODIUM_SIZE || byRank.has(rank)) continue;
        byRank.set(rank, normalizePosition(position, rank));
    }

    return {
        challengeId: cleanText(podium.challengeId),
        challengeDate: cleanText(podium.challengeDate),
        trackName: cleanText(podium.trackName) || 'Daily GP',
        positions: Array.from({ length: PODIUM_SIZE }, (_, index) => (
            byRank.get(index + 1) || emptyPosition(index + 1)
        )),
    };
}

export function renderPodium(documentRef, value) {
    if (!documentRef) return normalizePodium(value);
    const podium = normalizePodium(value);
    const trackName = documentRef.getElementById('podium-title');
    const challengeDate = documentRef.getElementById('challenge-date');

    if (trackName) trackName.textContent = podium.trackName;
    if (challengeDate) challengeDate.textContent = formatChallengeDate(podium.challengeDate);

    const rows = Array.from(documentRef.querySelectorAll('[data-rank]')).slice(0, PODIUM_SIZE);
    rows.forEach((row, index) => renderPosition(row, podium.positions[index]));
    return podium;
}

function normalizePosition(position, rank) {
    const identityType = position.identityType === 'reddit'
        ? 'reddit'
        : position.identityType === 'private'
            ? 'private'
            : 'empty';
    const rawName = cleanText(position.displayName);
    const formattedTime = cleanText(position.formattedTime);

    if (identityType === 'empty' || !rawName || !formattedTime) return emptyPosition(rank);

    return {
        rank,
        displayName: identityType === 'reddit' ? formatRedditName(rawName) : rawName,
        identityType,
        formattedTime,
    };
}

function emptyPosition(rank) {
    return {
        rank,
        displayName: EMPTY_NAME,
        identityType: 'empty',
        formattedTime: EMPTY_TIME,
    };
}

function renderPosition(row, position) {
    if (!row || !position) return;
    const name = row.querySelector('.podium-row__name');
    const time = row.querySelector('.podium-row__time');

    if (name) name.textContent = position.displayName;
    if (time) {
        time.textContent = position.formattedTime;
        time.setAttribute(
            'aria-label',
            position.identityType === 'empty' ? 'No verified time' : `Time ${position.formattedTime}`
        );
    }
    row.classList.toggle('podium-row--empty', position.identityType === 'empty');
}

function formatRedditName(value) {
    const name = value.replace(/^u\//i, '');
    return name ? `u/${name}` : EMPTY_NAME;
}

function formatChallengeDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Final results';
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return 'Final results';
    return new Intl.DateTimeFormat('en', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(date).toUpperCase();
}

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function boot() {
    renderPodium(document, readPodiumPostData());
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}
