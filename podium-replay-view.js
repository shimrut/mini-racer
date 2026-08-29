import { EXTRA_CAR_ASSETS } from './game/car/car-unlock-policy.js';
import { CarSpriteLoader, sanitizeCarSpriteAsset } from './game/car/sprite.js';
import { interpolatePbGhostPose, normalizePbGhostRecord } from './game/ghost/pb-ghost.js';
import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';

export const PODIUM_REPLAY_RATES = Object.freeze([0.5, 1, 2]);
export const PODIUM_REPLAY_CAR_ASSETS = Object.freeze({
    1: EXTRA_CAR_ASSETS.gold,
    2: EXTRA_CAR_ASSETS.arctic,
    3: EXTRA_CAR_ASSETS.blaze,
});

const carLoader = new CarSpriteLoader();
const carImages = new Map();
let carLoadPromise = null;

export function formatPodiumReplayClock(timeMs) {
    const totalMilliseconds = Math.max(0, Math.round(Number(timeMs) || 0));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export function prefersReducedPodiumMotion(root = globalThis) {
    return Boolean(root?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

function loadReplayCars() {
    if (carLoadPromise) return carLoadPromise;
    if (typeof Image === 'undefined') {
        carLoadPromise = Promise.resolve([]);
        return carLoadPromise;
    }
    carLoadPromise = Promise.all([1, 2, 3].map((rank) => {
        const assetName = PODIUM_REPLAY_CAR_ASSETS[rank];
        const record = carLoader.prefetch(assetName);
        if (!record?.promise) return null;
        return record.promise
            .then((image) => {
                const sprite = sanitizeCarSpriteAsset(image);
                carImages.set(rank, sprite);
                return sprite;
            })
            .catch(() => null);
    }));
    return carLoadPromise;
}

export function normalizePodiumReplayGhosts(payload) {
    const slots = Array.isArray(payload?.ghosts) ? payload.ghosts : [];
    const byRank = new Map();
    for (const slot of slots) {
        const rank = Number(slot?.rank);
        if (rank !== 1 && rank !== 2 && rank !== 3) continue;
        const record = normalizePbGhostRecord({ ghost: slot.ghost });
        if (record) byRank.set(rank, record);
    }
    return {
        trackKey: typeof payload?.trackKey === 'string' ? payload.trackKey : null,
        records: byRank,
        durationMs: Math.max(0, ...Array.from(byRank.values(), (record) => record.finishTimeMs)),
    };
}

export async function fetchPodiumReplays(root = globalThis) {
    try {
        const response = await root.fetch('/api/podium/replays');
        if (!response?.ok) return normalizePodiumReplayGhosts(null);
        return normalizePodiumReplayGhosts(await response.json());
    } catch {
        return normalizePodiumReplayGhosts(null);
    }
}

function resolveTrack(trackKey, trackName) {
    if (typeof trackKey === 'string' && TRACKS[trackKey]) {
        return { trackKey, track: TRACKS[trackKey] };
    }
    if (typeof trackName === 'string') {
        const target = trackName.trim().toLowerCase();
        for (const [key, track] of Object.entries(TRACKS)) {
            if (track && typeof track.name === 'string' && track.name.trim().toLowerCase() === target) {
                return { trackKey: key, track };
            }
        }
    }
    return { trackKey: 'circuit', track: TRACKS.circuit };
}

export function createPodiumReplayController({
    documentRef,
    canvas,
    getTrackName,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    requestFrame = (callback) => (
        typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame(callback)
            : 0
    ),
    cancelFrame = (id) => {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(id);
        }
    },
} = {}) {
    const state = {
        mode: 'podium',
        playing: false,
        rate: 1,
        timeMs: 0,
        durationMs: 0,
        records: new Map(),
        trackKey: null,
        trackName: '',
        frameId: 0,
        lastTs: 0,
    };

    function syncChrome() {
        const shell = documentRef?.getElementById('podium-shell');
        const results = documentRef?.getElementById('podium-results');
        const replay = documentRef?.getElementById('podium-replay');
        const playNow = documentRef?.getElementById('podium-play');
        const back = documentRef?.getElementById('podium-replay-back');
        const clock = documentRef?.getElementById('podium-replay-time');
        const play = documentRef?.getElementById('podium-replay-play');
        const pause = documentRef?.getElementById('podium-replay-pause');
        if (shell) shell.dataset.mode = state.mode;
        results?.toggleAttribute('inert', state.mode === 'replay');
        replay?.toggleAttribute('hidden', state.mode !== 'replay');
        playNow?.toggleAttribute('hidden', state.mode === 'replay');
        back?.toggleAttribute('hidden', state.mode !== 'replay');
        if (clock) clock.textContent = formatPodiumReplayClock(state.timeMs);
        if (play) play.disabled = state.playing || state.durationMs <= 0;
        if (pause) pause.disabled = !state.playing;
        documentRef?.querySelectorAll('.podium-replay__speed').forEach((button) => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === state.rate));
        });
    }

    function paint() {
        if (!canvas || state.mode !== 'replay') return;
        const resolved = resolveTrack(state.trackKey, typeof getTrackName === 'function' ? getTrackName() : '');
        const { trackKey, track } = resolved;
        if (!track) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = globalThis.devicePixelRatio || 1;
        canvas.width = Math.max(100, Math.round(rect.width * dpr));
        canvas.height = Math.max(100, Math.round(rect.height * dpr));

        const schematicCars = [];
        for (const rank of [3, 2, 1]) {
            const record = state.records.get(rank);
            const image = carImages.get(rank);
            if (!record || !image) continue;
            const pose = interpolatePbGhostPose(record.samples, state.timeMs);
            if (!pose) continue;
            schematicCars.push({
                image,
                x: pose.x,
                y: pose.y,
                angle: pose.angle,
            });
        }

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: { outer: track.outer, inner: track.inner },
            presentation: resolveTrackPresentation(trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            }),
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle ?? 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            hideSchematicStartArrow: true,
            schematicCars,
        });
    }

    function tick(ts) {
        if (state.playing) {
            const elapsed = state.lastTs ? ts - state.lastTs : 0;
            state.timeMs = Math.min(state.durationMs, state.timeMs + elapsed * state.rate);
            if (state.timeMs >= state.durationMs) {
                state.playing = false;
                state.timeMs = state.durationMs;
            }
        }
        state.lastTs = ts;
        paint();
        syncChrome();
        if (state.playing) {
            state.frameId = requestFrame(tick);
        } else {
            state.frameId = 0;
        }
    }

    function startLoop() {
        if (state.frameId || !state.playing) return;
        state.lastTs = 0;
        state.frameId = requestFrame(tick) || 0;
    }

    function stopLoop() {
        if (!state.frameId) return;
        cancelFrame(state.frameId);
        state.frameId = 0;
        state.lastTs = 0;
    }

    return {
        get mode() { return state.mode; },
        get playing() { return state.playing; },
        get rate() { return state.rate; },
        get timeMs() { return state.timeMs; },
        hasGhosts() { return state.records.size > 0; },
        hasGhost(rank) { return state.records.has(Number(rank)); },
        async prepare(payload, trackName) {
            const normalized = normalizePodiumReplayGhosts(payload);
            state.records = normalized.records;
            state.durationMs = normalized.durationMs;
            state.trackKey = normalized.trackKey;
            state.trackName = trackName || '';
            await loadReplayCars();
            return normalized.records.size > 0;
        },
        enter() {
            if (state.records.size === 0) return false;
            state.mode = 'replay';
            state.playing = !prefersReducedPodiumMotion();
            state.timeMs = 0;
            syncChrome();
            paint();
            startLoop();
            documentRef?.getElementById(state.playing ? 'podium-replay-pause' : 'podium-replay-play')
                ?.focus();
            return true;
        },
        exit() {
            state.mode = 'podium';
            state.playing = false;
            state.timeMs = 0;
            stopLoop();
            syncChrome();
        },
        play() {
            if (state.mode !== 'replay' || state.durationMs <= 0) return;
            if (state.timeMs >= state.durationMs) state.timeMs = 0;
            state.playing = true;
            startLoop();
            syncChrome();
        },
        pause() {
            state.playing = false;
            syncChrome();
        },
        stop() {
            state.playing = false;
            state.timeMs = 0;
            paint();
            syncChrome();
        },
        setRate(rate) {
            const next = Number(rate);
            if (!PODIUM_REPLAY_RATES.includes(next)) return;
            state.rate = next;
            syncChrome();
        },
        advance(ms) {
            tick((state.lastTs || now()) + Number(ms) || 0);
        },
        paint,
        syncChrome,
    };
}
