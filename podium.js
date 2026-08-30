import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';
import { CarSpriteLoader, STOCK_CAR_ASSET_NAME } from './game/car/sprite.js';
import { requestFeaturedDailyChallengeStart } from './game/daily-challenge/service.js';
import { applyAvatar, GENERIC_SNOO_URL, resolveAvatarUrl } from './game/ui/avatar.js';
import {
    createLocalPodiumPreview,
    createPodiumReplayController,
    fetchPodiumReplays,
    shouldUseLocalPodiumPreview,
} from './podium-replay-view.js';

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

    const rows = Array.from(documentRef.querySelectorAll('li[data-rank]')).slice(0, PODIUM_SIZE);
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
            ? resolveAvatarUrl(position.avatarUrl)
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
    applyAvatar(avatar, position.avatarUrl, {
        alt: position.identityType === 'reddit'
            ? `${position.displayName} Reddit avatar`
            : position.identityType === 'private'
                ? 'Official Reddit default Snoo avatar'
                : '',
        genericClass: 'podium-row__avatar--generic',
    });
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
                .map((position) => [position.rank, resolveAvatarUrl(position.avatarUrl)])
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

function syncViewReplaysButton(documentRef, controller) {
    const button = documentRef?.getElementById('podium-view-replays');
    if (!button || !controller) return;
    const available = controller.hasGhosts();
    button.hidden = !available || controller.mode === 'replay';
    button.disabled = !available;
}

function installLocalPodiumPreview(preview) {
    if (!preview || readPodiumPostData()) return;
    const existing = globalThis.devvit && typeof globalThis.devvit === 'object'
        ? globalThis.devvit
        : {};
    const context = existing.context && typeof existing.context === 'object'
        ? existing.context
        : {};
    globalThis.devvit = {
        ...existing,
        context: {
            ...context,
            postData: { podium: preview.podium },
        },
    };
}

async function boot() {
    const preview = shouldUseLocalPodiumPreview() ? createLocalPodiumPreview() : null;
    installLocalPodiumPreview(preview);
    const podium = renderPodium(document, readPodiumPostData());
    renderPodiumTrack(podium.trackName);
    bindPodiumPlayNow(document);
    const replay = bindPodiumReplay(document, {
        canvas: document.getElementById('podium-track'),
        getTrackName: () => podium.trackName,
        fetchReplays: preview
            ? async () => preview.replays
            : fetchPodiumReplays,
    });
    const hydrated = await hydrateMissingRedditAvatars(globalThis, podium);
    if (hydrated !== podium) renderPodium(document, hydrated);
    await replay?.prepareFromServer();
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
        const { requestExpandedMode } = await import('@devvit/web/client');
        await requestExpandedMode(event, 'game');
    } catch (error) {
        console.error('Failed to open today\'s featured Mini Racer track from the podium:', error);
    }
}

let trackCarPromise = null;
let activeReplay = null;

export function bindPodiumReplay(documentRef, {
    canvas = documentRef?.getElementById('podium-track'),
    getTrackName = () => '',
    fetchReplays = fetchPodiumReplays,
} = {}) {
    if (!documentRef || documentRef.documentElement?.dataset.podiumReplayBound === '1') {
        return activeReplay;
    }
    documentRef.documentElement.dataset.podiumReplayBound = '1';
    const controller = createPodiumReplayController({
        documentRef,
        canvas,
        getTrackName,
    });
    activeReplay = {
        get mode() { return controller.mode; },
        paint: () => controller.paint(),
        async prepareFromServer(root = globalThis) {
            const payload = await fetchReplays(root);
            await controller.prepare(payload, getTrackName());
            syncViewReplaysButton(documentRef, controller);
            return controller.hasGhosts();
        },
    };

    documentRef.getElementById('podium-view-replays')?.addEventListener('click', () => {
        controller.enter();
    });
    documentRef.getElementById('podium-replay-back')?.addEventListener('click', () => {
        controller.exit();
        const podium = renderPodium(documentRef, readPodiumPostData());
        renderPodiumTrack(podium.trackName, documentRef);
        syncViewReplaysButton(documentRef, controller);
        documentRef.getElementById('podium-view-replays')?.focus();
    });
    documentRef.getElementById('podium-replay-toggle')?.addEventListener('click', () => {
        controller.togglePlay();
    });
    const seek = documentRef.getElementById('podium-replay-seek');
    if (seek) {
        const endScrub = () => { delete seek.dataset.scrubbing; };
        seek.addEventListener('pointerdown', () => { seek.dataset.scrubbing = '1'; });
        seek.addEventListener('pointerup', endScrub);
        seek.addEventListener('pointercancel', endScrub);
        seek.addEventListener('change', endScrub);
        seek.addEventListener('input', () => controller.seek(seek.value));
    }
    documentRef.querySelectorAll('.podium-replay__car[data-rank]').forEach((button) => {
        button.addEventListener('click', () => {
            controller.setVisible(button.dataset.rank, !controller.isVisible(button.dataset.rank));
        });
    });
    documentRef.getElementById('podium-replay-trail')?.addEventListener('click', () => {
        controller.setShowTrail(!controller.showTrail);
    });
    return activeReplay;
}

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

function renderPodiumTrack(trackName, documentRef = typeof document !== 'undefined' ? document : null) {
    const canvas = documentRef?.getElementById('podium-track');
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
        if (activeReplay?.mode === 'replay') {
            activeReplay.paint();
            return;
        }
        const podium = normalizePodium(readPodiumPostData());
        renderPodiumTrack(podium.trackName);
    });
}
