import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';
import { CarSpriteLoader, STOCK_CAR_ASSET_NAME } from './game/car/sprite.js';
import { requestFeaturedDailyChallengeStart } from './game/daily-challenge/service.js';

const PODIUM_SIZE = 3;
const EMPTY_NAME = 'No verified finish';
const EMPTY_TIME = '—';
const GENERIC_SNOO_URL = 'https://www.redditstatic.com/avatars/defaults/v2/avatar_default_0.png';

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
        lapCount: podium.lapCount === 2 || podium.lapCount === 3 ? podium.lapCount : 1,
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
    const raceFormat = documentRef.getElementById('race-format');

    if (trackName) trackName.textContent = podium.trackName;
    if (challengeDate) challengeDate.textContent = formatChallengeDate(podium.challengeDate);
    if (raceFormat) {
        raceFormat.textContent = `${podium.lapCount} ${podium.lapCount === 1 ? 'LAP' : 'LAPS'}`;
    }

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
        avatarUrl: identityType === 'reddit'
            ? normalizeAvatarUrl(position.avatarUrl)
            : GENERIC_SNOO_URL,
    };
}

function emptyPosition(rank) {
    return {
        rank,
        displayName: EMPTY_NAME,
        identityType: 'empty',
        formattedTime: EMPTY_TIME,
        avatarUrl: GENERIC_SNOO_URL,
    };
}

function renderPosition(row, position) {
    if (!row || !position) return;
    const name = row.querySelector('.podium-row__name');
    const time = row.querySelector('.podium-row__time');
    const avatar = row.querySelector('.podium-row__avatar');

    if (name) name.textContent = position.displayName;
    if (avatar) {
        avatar.src = position.avatarUrl;
        avatar.alt = position.identityType === 'reddit'
            ? `${position.displayName} Reddit avatar`
            : position.identityType === 'private'
                ? 'Official Reddit default Snoo avatar'
                : '';
        avatar.classList.toggle('podium-row__avatar--generic', position.avatarUrl === GENERIC_SNOO_URL);
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = GENERIC_SNOO_URL;
            avatar.classList.add('podium-row__avatar--generic');
        };
    }
    if (time) {
        time.textContent = position.formattedTime;
        time.setAttribute(
            'aria-label',
            position.identityType === 'empty' ? 'No verified time' : `Time ${position.formattedTime}`
        );
    }
    row.classList.toggle('podium-row--empty', position.identityType === 'empty');
}

function normalizeAvatarUrl(value) {
    if (typeof value !== 'string') return GENERIC_SNOO_URL;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : GENERIC_SNOO_URL;
    } catch {
        return GENERIC_SNOO_URL;
    }
}

function formatRedditName(value) {
    return value.replace(/^u\//i, '') || EMPTY_NAME;
}

export async function hydrateMissingRedditAvatars(root, podium) {
    if (!root?.fetch || !podium?.positions?.some(
        (position) => position.identityType === 'reddit' && position.avatarUrl === GENERIC_SNOO_URL
    )) {
        return podium;
    }

    try {
        const response = await root.fetch('/api/podium/avatars');
        if (!response?.ok) return podium;
        const payload = await response.json();
        const avatarsByRank = new Map(
            (Array.isArray(payload?.positions) ? payload.positions : [])
                .filter((position) => Number.isInteger(position?.rank))
                .map((position) => [position.rank, normalizeAvatarUrl(position.avatarUrl)])
        );
        return {
            ...podium,
            positions: podium.positions.map((position) => ({
                ...position,
                avatarUrl: position.identityType === 'reddit'
                    ? avatarsByRank.get(position.rank) || position.avatarUrl
                    : position.avatarUrl,
            })),
        };
    } catch {
        return podium;
    }
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

async function boot() {
    const podium = renderPodium(document, readPodiumPostData());
    // Paint the track immediately — do not wait on avatar backfill or the car sprite.
    renderPodiumTrack(podium.trackName);
    bindPodiumPlayNow(document);
    const hydrated = await hydrateMissingRedditAvatars(globalThis, podium);
    if (hydrated !== podium) renderPodium(document, hydrated);
}

export function bindPodiumPlayNow(documentRef, openGame = openFeaturedGameFromPodium) {
    const playButton = documentRef?.getElementById('podium-play');
    if (!playButton || playButton.dataset.bound === '1') return playButton || null;
    playButton.dataset.bound = '1';
    playButton.addEventListener('click', openGame);
    return playButton;
}

export async function openFeaturedGameFromPodium(event) {
    requestFeaturedDailyChallengeStart();
    try {
        // Hosted custom posts only; local podium-test.html has no Devvit client.
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open today\'s featured Mini Racer track from the podium:', error);
    }
}

let trackCarPromise = null;

function loadTrackCar() {
    if (trackCarPromise) return trackCarPromise;
    const loader = new CarSpriteLoader();
    trackCarPromise = new Promise((resolve) => {
        loader.load(STOCK_CAR_ASSET_NAME, {
            onLoaded: resolve,
            onError: () => {
                console.warn(`Unable to load ${STOCK_CAR_ASSET_NAME} in the podium post.`);
                resolve(null);
            },
        });
    });
    return trackCarPromise;
}

function resolveTrackByName(trackName) {
    if (typeof trackName !== 'string') return null;
    const target = trackName.trim().toLowerCase();
    for (const [trackKey, track] of Object.entries(TRACKS)) {
        if (track && typeof track.name === 'string' && track.name.trim().toLowerCase() === target) {
            return { trackKey, track };
        }
    }
    return null;
}

function renderPodiumTrack(trackName) {
    const canvas = document.getElementById('podium-track');
    if (!canvas) return;
    const resolved = resolveTrackByName(trackName) || { trackKey: 'circuit', track: TRACKS.circuit };
    const { trackKey, track } = resolved;
    if (!track) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(100, Math.round(rect.width * dpr));
    canvas.height = Math.max(100, Math.round(rect.height * dpr));

    const presentation = resolveTrackPresentation(trackKey, {
        surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
    });

    const paint = (carImage = null) => {
        renderTrackPreviewCanvas(canvas, {
            trackGeometry: { outer: track.outer, inner: track.inner },
            presentation,
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle ?? 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            showSchematicCarTrail: Boolean(carImage),
            moveSchematicCarPastStartLine: true,
            schematicCarImage: carImage,
            hideSchematicStartArrow: true,
            runHistory: [],
        });
    };

    paint(null);
    loadTrackCar().then((carImage) => {
        if (carImage) paint(carImage);
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    window.addEventListener('resize', () => {
        const podium = renderPodium(document, readPodiumPostData());
        renderPodiumTrack(podium.trackName);
    });
}
